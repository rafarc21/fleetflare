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
 * self-wrapping, skipping the self-wrap entirely when found.
 *
 * Tests 1-2 call the pure ancestor-walk (`ancestor_holds_lock`) directly via
 * the `--ancestor-holds-lock-check` test-only hook (same precedent as
 * localci.sh's `--sweep-procs-only`, added for #159) -- that hook exits
 * before the real self-wrap `if` block, so it can't exercise its branching.
 * Tests 3-4 close that gap: they invoke the script with NO test flag, so it
 * runs the real self-wrap `if` for real, with a `lockf` PATH shim standing
 * in for the real binary (logging to a file instead of actually locking) --
 * asserting the shim is/isn't invoked is what actually proves the self-wrap
 * does/doesn't re-exec depending on whether an ancestor holds the lock.
 * Both pass a bogus image name (`probe-noop`) so the script exits fast
 * right after the self-wrap decision (`spec()` rejects it, exit 2), never
 * reaching docker.
 *
 * The fake ancestor is built with bash's `exec -a NAME CMD ARGS`, which
 * REPLACES the current process image (same pid, no fork) with argv[0]
 * renamed to NAME; confirmed empirically that `ps -o command=` on this
 * container's ps reports the renamed argv[0] followed by the program's real
 * remaining args. The renamed process must then run the real script as a
 * genuinely separate CHILD (not itself) for there to be an ancestor at all:
 * a bare trailing `bash -c 'cmd'` isn't enough, since bash exec-replaces
 * itself into a sole/trailing simple command instead of forking, erasing
 * the rename (verified empirically). Backgrounding it and `wait`-ing
 * (`cmd & wait $!`) forces bash to keep the renamed parent alive as a
 * distinct process while the real command runs as an actual forked child.
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

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "image-repro-lock-bin-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

/** A `lockf` PATH shim: logs that it ran, then execs straight through to
 * its own real args (dropping `-k "$LOCK"`) -- stands in for the real
 * binary's locking without needing real POSIX lock semantics. Returns the
 * log file path; its existence after a run is the test's signal for
 * whether the self-wrap actually re-exec'd through `lockf`. */
function installLockfShim(dir: string): string {
  const shimLog = join(dir, "shim-log");
  const shim = join(dir, "lockf");
  writeFileSync(shim, `#!/bin/bash\necho "SHIM-INVOKED" >> "${shimLog}"\nshift; shift\nexec "$@"\n`);
  chmodSync(shim, 0o755);
  return shimLog;
}

test("the real self-wrap re-execs through lockf when no ancestor holds the lock", () => {
  // No test flag: runs the script for real through its own self-wrap `if`.
  // `probe-noop` isn't agent|deploy|studio, so `spec()` rejects it (exit 2)
  // right after the self-wrap decision, before anything touches docker.
  const shimLog = installLockfShim(binDir);
  const r = Bun.spawnSync(["bash", SCRIPT, "probe-noop"], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
  expect(r.exitCode).toBe(2);
  expect(existsSync(shimLog)).toBe(true);
});

test("the real self-wrap skips re-exec through lockf when an ancestor already holds the lock", () => {
  const shimLog = installLockfShim(binDir);
  const r = Bun.spawnSync([
    "bash",
    "-c",
    `exec -a "lockf -k ${LOCK}" bash -c 'PATH="${binDir}:$PATH" bash "$0" probe-noop & wait $!' "${SCRIPT}"`,
  ]);
  expect(r.exitCode).toBe(2);
  expect(existsSync(shimLog)).toBe(false);
});
