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
 * as `lockf -k /tmp/fleetflare-gate.lock 30`. Since `exec -a` replaces
 * in-place rather than forking, that renamed process can then plainly run
 * (fork a child for) the real check script, giving the check hook a real
 * parent whose own command line looks exactly like a real
 * `lockf -k "$LOCK"` invocation -- with no extra intermediate shell layer
 * whose own literal source text could spuriously contain the lock path and
 * cause a false match (verified: embedding the literal fake-ancestor
 * command text directly in an interactive shell -c string run in the SAME
 * outer shell invocation as a later unrelated check DOES cause a false
 * "yes" -- avoided here by never embedding the lock path as literal quoted
 * text anywhere except inside the one `exec -a` argument itself).
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
  // inner script runs the real check script as a plain (forked) child, so
  // the child's parent is exactly the renamed process. No `exec` on the
  // inner command, so the outer process's own exit code is the child's.
  const r = Bun.spawnSync([
    "bash",
    "-c",
    `exec -a "lockf -k ${LOCK}" bash -c 'bash "$0" --ancestor-holds-lock-check' "${SCRIPT}"`,
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
    `exec -a "lockf -k ${LOCK}" bash -c 'PATH="${binDir}:$PATH" bash "$0" --ancestor-holds-lock-check' "${SCRIPT}"`,
  ]);

  expect(r.stdout.toString().trim()).toBe("yes");
  expect(r.exitCode).toBe(0);
  expect(existsSync(shimLog)).toBe(false);
});
