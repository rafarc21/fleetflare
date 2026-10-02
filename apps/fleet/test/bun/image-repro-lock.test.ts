import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";

/**
 * Issue #124 — `image-repro-check.sh` self-wraps under the shared gate lock
 * (`lockf -k /tmp/fleetflare-gate.lock "$0" "$@"`) unless `IMAGE_REPRO_LOCKED`
 * is already set. `lockf`'s advisory lock isn't inherited across fork+exec,
 * so a caller that already holds this exact lock and invokes this script
 * nested, without setting `IMAGE_REPRO_LOCKED` itself, deadlocks against its
 * own ancestor (itself waiting on the nested call). The fix walks this
 * process's own ancestor chain for a `lockf ... "$LOCK"` command line before
 * self-wrapping; this test exercises that `ancestor_holds_lock` logic
 * directly via the `--ancestor-holds-lock-check` test-only hook (same
 * precedent as localci.sh's `--sweep-procs-only`, added for #159), not the
 * real `lockf` binary -- this container has no `lockf` installed (only
 * `flock`), so the top-level self-wrap `if` never runs here at all; the
 * hook is defined unconditionally, outside that gate, so it's exercisable
 * regardless of whether `lockf` exists.
 *
 * The fake ancestor below is built with bash's `exec -a NAME CMD ARGS`,
 * which REPLACES the current process image (same pid, no fork) with argv[0]
 * renamed to NAME. Confirmed empirically on this container's `ps`
 * (procps-ng 3.3.17) that `ps -o command=` on such a process reports the
 * renamed argv[0] followed by the program's real remaining args --
 * `bash -c 'exec -a "lockf -k /tmp/fleetflare-gate.lock" sleep 30'` shows up
 * as `lockf -k /tmp/fleetflare-gate.lock 30`.
 *
 * The renamed process must then run the real check script as a genuinely
 * SEPARATE child (not itself) for there to be an "ancestor" at all. Bare
 * `bash -c 'cmd'` is not enough: when `cmd` is the sole/trailing simple
 * command bash is about to run with nothing left to do afterward, bash
 * optimizes by exec'ing it directly in place (no fork) -- verified
 * empirically (a debug ancestor-dump showed the "child" script's own `$$`
 * was the SAME pid as the renamed parent, with the rename itself
 * overwritten by the inner exec's own fresh argv[0]). Backgrounding the
 * real command and `wait`-ing for it (`cmd & wait $!`) forces bash to keep
 * the renamed parent alive as a distinct, live process while the real
 * command runs as an actual forked child -- verified empirically this
 * gives the child a real parent whose own command line looks exactly like
 * a real `lockf -k "$LOCK"` invocation.
 *
 * Also verified: the literal lock path must never appear directly in a
 * command string passed straight to this harness's own shell tool, only
 * inside scripts/args passed BY PATH -- the harness's own wrapper process
 * is always a real ancestor of anything spawned this way, and embedding
 * the literal text in a directly-typed command (rather than a file) makes
 * that unrelated wrapper spuriously "match" too, independent of any real
 * nested lockf process. Not a concern for the construction below, since
 * the lock path only ever appears inside bash -c argument strings handed
 * to `Bun.spawnSync`, never typed into an interactive shell.
 */
const SCRIPT = resolve(import.meta.dir, "../../scripts/image-repro-check.sh");
const LOCK = "/tmp/fleetflare-gate.lock";
setDefaultTimeout(15_000);

test("--ancestor-holds-lock-check reports 'no'/exit 1 with no lockf ancestor", () => {
  const r = Bun.spawnSync(["bash", SCRIPT, "--ancestor-holds-lock-check"]);
  expect(r.stdout.toString().trim()).toBe("no");
  expect(r.exitCode).toBe(1);
});

test('--ancestor-holds-lock-check reports \'yes\'/exit 0 when an ancestor\'s command line is a lockf "$LOCK" invocation', () => {
  // `exec -a` renames the process now running `bash -c '<inner>'`; the
  // inner script backgrounds the real check script and `wait`s for it, so
  // bash forks a genuine child instead of exec-replacing itself into it --
  // the child's real parent is exactly the renamed process. `wait $!`
  // propagates the child's exit status as this bash -c's own.
  const r = Bun.spawnSync([
    "bash",
    "-c",
    `exec -a "lockf -k ${LOCK}" bash -c 'bash "$0" --ancestor-holds-lock-check & wait $!' "${SCRIPT}"`,
  ]);
  expect(r.stdout.toString().trim()).toBe("yes");
  expect(r.exitCode).toBe(0);
});

let binDir: string;
let markerDir: string;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "image-repro-lock-bin-"));
  markerDir = mkdtempSync(join(tmpdir(), "image-repro-lock-marker-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(markerDir, { recursive: true, force: true });
});

test("the full self-wrap branch skips re-exec through a lockf shim when an ancestor already holds the lock", () => {
  // Confirms the FULL self-wrap `if` block's control flow: with a `lockf`
  // shim on PATH (so `command -v lockf` succeeds) AND a fake lockf ancestor
  // in the chain, the script must run directly -- never re-exec itself
  // through the shim -- because ancestor_holds_lock short-circuits it
  // before `command -v lockf` is even consulted for real work.
  const shimLog = join(binDir, "shim-log");
  const shim = join(binDir, "lockf");
  writeFileSync(
    shim,
    `#!/bin/bash\necho "SHIM-INVOKED" >> "${shimLog}"\nshift; shift\nexec "$@"\n`,
  );
  chmodSync(shim, 0o755);

  const r = Bun.spawnSync([
    "bash",
    "-c",
    `exec -a "lockf -k ${LOCK}" bash -c 'PATH="${binDir}:$PATH" bash "$0" --ancestor-holds-lock-check & wait $!' "${SCRIPT}"`,
  ]);

  expect(r.stdout.toString().trim()).toBe("yes");
  expect(r.exitCode).toBe(0);
  expect(existsSync(shimLog)).toBe(false);
});
