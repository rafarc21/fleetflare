// Issue #1115: a reap lock held by a dead pid must not block every later reap.
// The holder pid is checked on acquire: dead → reclaimed (one log line), live
// → refused as before. Pid reuse (same pid, different process start time) →
// reclaimed. A SIGTERM/SIGINT during the run releases the lock.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withReapLock } from "../../cli/fleet";

const HOLDER = join(import.meta.dir, "fixtures/reap-lock-holder.ts");

let dir: string;
let statePath: string;
let lock: string;
let logged: string[];
const log = (line: string) => { logged.push(line); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reap-lock-"));
  statePath = join(dir, "reap-state.json");
  lock = `${statePath}.lock`;
  logged = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that is certainly dead: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

/** Spawns a real lock holder and waits until it has taken the lock. */
async function startHolder(): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, HOLDER, statePath], { stdout: "pipe", stderr: "ignore" });
  const deadline = Date.now() + 10_000;
  while (!existsSync(lock)) {
    if (Date.now() > deadline) throw new Error("holder never took the lock");
    await Bun.sleep(20);
  }
  return child;
}

describe("reap lock: holder pid checked on acquire (#1115)", () => {
  test("dead pid: lock is reclaimed and one line is logged", async () => {
    const pid = await deadPid();
    writeFileSync(lock, `${pid} ${new Date().toISOString()}\n`);

    const result = await withReapLock(statePath, async () => 42, log);

    expect(result).toBe(42);
    expect(logged).toEqual([`reclaimed reap lock from dead pid ${pid}`]);
    expect(existsSync(lock)).toBe(false);
  });

  test("live pid: a second reap is refused while the holder runs", async () => {
    const holder = await startHolder();
    try {
      await expect(withReapLock(statePath, async () => 0, log)).rejects.toThrow(/another fleet reap/);
      expect(logged).toEqual([]);
      expect(existsSync(lock)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  });

  test("holder killed with SIGKILL (no cleanup): the next reap reclaims the lock", async () => {
    const holder = await startHolder();
    const heldPid = holder.pid;
    holder.kill("SIGKILL");
    await holder.exited;
    expect(existsSync(lock)).toBe(true);

    const result = await withReapLock(statePath, async () => 7, log);

    expect(result).toBe(7);
    expect(logged).toEqual([`reclaimed reap lock from dead pid ${heldPid}`]);
  });

  test("pid reused by another process: start time differs, lock is reclaimed", async () => {
    // Our own pid is alive, but the lock records a start time it never had.
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()} Mon Jan  1 00:00:00 1990\n`);

    const result = await withReapLock(statePath, async () => 5, log);

    expect(result).toBe(5);
    expect(logged).toEqual([`reclaimed reap lock from dead pid ${process.pid}`]);
  });

  test("live holder with unreadable start time is refused (unsure → safe side)", async () => {
    // No start-time token, live pid, fresh lock: cannot prove the holder is gone.
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);

    await expect(withReapLock(statePath, async () => 0, log)).rejects.toThrow(/another fleet reap/);
    expect(logged).toEqual([]);
  });
});

describe("reap lock: released on SIGTERM / SIGINT (#1115)", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal} during the run removes the lock`, async () => {
      const holder = await startHolder();
      holder.kill(signal);
      await holder.exited;

      expect(existsSync(lock)).toBe(false);
      expect(await withReapLock(statePath, async () => 3, log)).toBe(3);
    });
  }

  test("a normal return removes the lock and leaves no signal handlers behind", async () => {
    const before = process.listenerCount("SIGTERM");
    await withReapLock(statePath, async () => 1, log);
    expect(existsSync(lock)).toBe(false);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
