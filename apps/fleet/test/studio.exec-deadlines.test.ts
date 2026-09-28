import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sbExec, withKillDeadline, EXEC_CLASSES, ExecDeadlineError, KILL_GRACE_SECONDS, DEADLINE_SLACK_MS,
  isDeadlineExit, SessionBusyError,
  type SandboxHandle, type SbExecOptions,
} from "../src/studio/sandbox-api";
import { runScheduledTick, TICK_DEADLINES_MS } from "../src/studio/do";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import { env } from "cloudflare:test";

const doSrc: string = env.TEST_STUDIO_DO_SRC;

// ---------------------------------------------------------------------------
// Issue #104. MEASURED 2026-09-24: 211 of 212 DO alarm 900s kills had the
// container at its memory ceiling. Every fleet exec went through ONE
// container session ('sandbox-default'), which the container serializes
// (session-manager lock.runExclusive), with NO timeout anywhere — so one
// stalled command queued every tick, inspect, wake and probe behind it, and
// Container.alarm (which awaits each due callback, then re-arms) pinned until
// the platform killed it at 900s.
// ---------------------------------------------------------------------------

type ExecResult = { success: boolean; exitCode: number; stdout: string; stderr: string };

/**
 * Models the container's per-session lock: commands to the SAME session run
 * one at a time, different sessions run in parallel. `hang` names commands
 * that never finish, like a command stalled at the memory ceiling.
 */
function serializedSandbox(hang: (cmd: string) => boolean) {
  const tails = new Map<string, Promise<unknown>>();
  const ran: { cmd: string; session: string }[] = [];
  const run = (cmd: string, session: string): Promise<ExecResult> => {
    const prev = tails.get(session) ?? Promise.resolve();
    const next = prev.then(() => {
      ran.push({ cmd, session });
      if (hang(cmd)) return new Promise<ExecResult>(() => {});
      return { success: true, exitCode: 0, stdout: "ok", stderr: "" };
    });
    tails.set(session, next);
    return next;
  };
  const sb: SandboxHandle = {
    exec: vi.fn(async (cmd: string) => run(cmd, "sandbox-default")),
    execWithSessionToken: vi.fn(async (cmd: string, session: string) => run(cmd, session)),
    writeFile: vi.fn(async () => ({ success: true })),
    setKeepAlive: vi.fn(async () => {}),
  };
  return { sb, ran };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("withKillDeadline — every exec carries its own kill", () => {
  it("wraps the command in `timeout -k` with whole seconds, run by bash", () => {
    expect(withKillDeadline("printf ok", 8_000)).toBe(`timeout -k ${KILL_GRACE_SECONDS} 8 bash -c 'printf ok'`);
  });

  it("rounds a sub-second budget UP, never to a zero (= no) timeout", () => {
    expect(withKillDeadline("true", 1)).toBe(`timeout -k ${KILL_GRACE_SECONDS} 1 bash -c 'true'`);
    expect(withKillDeadline("true", 1_500)).toBe(`timeout -k ${KILL_GRACE_SECONDS} 2 bash -c 'true'`);
  });

  it("single-quotes the command so embedded quotes survive intact", () => {
    expect(withKillDeadline(`echo 'a b' "$HOME"`, 5_000)).toBe(
      `timeout -k ${KILL_GRACE_SECONDS} 5 bash -c 'echo '\\''a b'\\'' "$HOME"'`,
    );
  });
});

describe("EXEC_CLASSES — one session per fleet call class", () => {
  it("names a distinct session for every tick class, never the SDK default", () => {
    const ids = Object.values(EXEC_CLASSES).map((c: SbExecOptions) => c.sessionId).filter((s): s is string => !!s);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).not.toMatch(/^sandbox-/);
    for (const cls of ["ship", "sync", "readiness", "inspect", "rescue", "wake", "refresh"] as const) {
      expect(EXEC_CLASSES[cls].sessionId).toBeTruthy();
    }
  });

  it("gives every class a positive deadline", () => {
    for (const c of Object.values(EXEC_CLASSES)) expect(c.timeoutMs).toBeGreaterThan(0);
  });

  it("keeps the code's own existing budgets", () => {
    expect(EXEC_CLASSES.inspect.timeoutMs).toBe(15_000);
    expect(EXEC_CLASSES.ship.timeoutMs).toBe(20_000);
    expect(EXEC_CLASSES.sync.timeoutMs).toBe(120_000);
    // The readiness check waits up to PROVISIONED_CHECK_TRIES (20) seconds
    // for claude by design; its budget must clear that wait.
    expect(EXEC_CLASSES.readiness.timeoutMs).toBeGreaterThan(20_000);
    // Large dirty-tree pushes (#110 review).
    expect(EXEC_CLASSES.rescue.timeoutMs).toBe(300_000);
  });

  it("refresh survives a cold container: the SDK waits for it INSIDE the first exec (up to ~120s)", () => {
    expect(EXEC_CLASSES.refresh.timeoutMs).toBeGreaterThanOrEqual(150_000);
  });

  it("the Worker waits past the kill grace, so it sees the container's 137, not its own deadline", () => {
    expect(DEADLINE_SLACK_MS).toBeGreaterThan(KILL_GRACE_SECONDS * 1000);
  });
});

describe("sbExec — deadline and session per call", () => {
  it("routes a classed exec to its own session, wrapped in the kill", async () => {
    const { sb } = serializedSandbox(() => false);
    const res = await sbExec(sb, "printf ok", EXEC_CLASSES.ship);
    expect(sb.execWithSessionToken).toHaveBeenCalledWith(
      withKillDeadline("printf ok", EXEC_CLASSES.ship.timeoutMs), EXEC_CLASSES.ship.sessionId,
    );
    expect(sb.exec).not.toHaveBeenCalled();
    expect(res).toEqual({ code: 0, stdout: "ok", stderr: "" });
  });

  it("forwards env alongside the session", async () => {
    const { sb } = serializedSandbox(() => false);
    await sbExec(sb, "x", { ...EXEC_CLASSES.sync, env: { A: "1" } });
    expect(sb.execWithSessionToken).toHaveBeenCalledWith(
      withKillDeadline("x", EXEC_CLASSES.sync.timeoutMs), EXEC_CLASSES.sync.sessionId, { env: { A: "1" } },
    );
  });

  it("a refresh exec whose first answer takes 60s (cold start) still succeeds", async () => {
    vi.useFakeTimers();
    const exec = vi.fn(() => new Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string }>(
      (resolve) => setTimeout(() => resolve({ success: true, exitCode: 0, stdout: "", stderr: "" }), 60_000),
    ));
    const sb = { exec, execWithSessionToken: exec, writeFile: vi.fn(), setKeepAlive: vi.fn() } as unknown as SandboxHandle;
    const p = sbExec(sb, "write-credential", EXEC_CLASSES.refresh);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("a class is required: a classless call does not compile", () => {
    const { sb } = serializedSandbox(() => false);
    // @ts-expect-error — every exec must name its class (#110 review).
    void sbExec(sb, "printf ok").catch(() => {});
  });

  it("a deadline with no session still wraps, on the default session", async () => {
    const { sb } = serializedSandbox(() => false);
    await sbExec(sb, "bringup", { timeoutMs: 600_000, env: { R: "1" } });
    expect(sb.exec).toHaveBeenCalledWith(withKillDeadline("bringup", 600_000), { env: { R: "1" } });
  });

  it("rejects with ExecDeadlineError once the deadline passes, instead of waiting forever", async () => {
    vi.useFakeTimers();
    const { sb } = serializedSandbox(() => true);
    const p = sbExec(sb, "hang", { timeoutMs: 8_000, sessionId: "fleet-readiness" });
    const settled = expect(p).rejects.toBeInstanceOf(ExecDeadlineError);
    await vi.advanceTimersByTimeAsync(8_000 + DEADLINE_SLACK_MS - 1);
    let done = false;
    void p.catch(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await settled;
  });

  it("one hung command does not block the next exec in a DIFFERENT session", async () => {
    vi.useFakeTimers();
    const { sb, ran } = serializedSandbox((cmd) => cmd.includes("hang"));
    const hung = sbExec(sb, "hang", EXEC_CLASSES.ship).catch((e) => e);
    const next = await sbExec(sb, "printf ok", EXEC_CLASSES.inspect);
    expect(next.code).toBe(0);
    expect(ran.map((r) => r.session)).toEqual([EXEC_CLASSES.ship.sessionId, EXEC_CLASSES.inspect.sessionId]);
    await vi.advanceTimersByTimeAsync(EXEC_CLASSES.ship.timeoutMs + DEADLINE_SLACK_MS);
    expect(await hung).toBeInstanceOf(ExecDeadlineError);
  });

  it("single-flight: once a session's exec is abandoned, the next one in THAT session fails fast instead of queuing", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const { sb, ran } = serializedSandbox((cmd) => cmd.includes("hang"));
    // Replace the hang with a releasable one, so the session can recover.
    const inner = sb.execWithSessionToken;
    (sb as { execWithSessionToken: SandboxHandle["execWithSessionToken"] }).execWithSessionToken = vi.fn(
      async (cmd: string, session: string, o?: { env?: Record<string, string> }) =>
        cmd.includes("stall")
          ? new Promise<ExecResult>((resolve) => { release = () => resolve({ success: false, exitCode: 137, stdout: "", stderr: "" }); })
          : inner(cmd, session, o),
    );
    const first = sbExec(sb, "stall", EXEC_CLASSES.ship).catch((e) => e);
    await vi.advanceTimersByTimeAsync(EXEC_CLASSES.ship.timeoutMs + DEADLINE_SLACK_MS);
    expect(await first).toBeInstanceOf(ExecDeadlineError);
    // Abandoned but still pending in the container: the next ship exec must not pile up.
    await expect(sbExec(sb, "printf ok", EXEC_CLASSES.ship)).rejects.toBeInstanceOf(SessionBusyError);
    // Another session is unaffected.
    expect((await sbExec(sb, "printf ok", EXEC_CLASSES.inspect)).code).toBe(0);
    // Once the abandoned exec finally lands, the session serves again.
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect((await sbExec(sb, "printf ok", EXEC_CLASSES.ship)).code).toBe(0);
    expect(ran.filter((r) => r.session === EXEC_CLASSES.ship.sessionId)).toHaveLength(1);
  });

  it("control: in the SAME session the hung command does block — which is why classes split", async () => {
    vi.useFakeTimers();
    const { sb, ran } = serializedSandbox((cmd) => cmd.includes("hang"));
    void sbExec(sb, "hang", EXEC_CLASSES.ship).catch(() => {});
    const next = sbExec(sb, "printf ok", EXEC_CLASSES.ship).catch((e) => e);
    await vi.advanceTimersByTimeAsync(EXEC_CLASSES.ship.timeoutMs + DEADLINE_SLACK_MS);
    expect(await next).toBeInstanceOf(ExecDeadlineError);
    expect(ran).toHaveLength(1);
  });
});

function runningStorage() {
  const map = new Map<string, unknown>([[STATUS_KEY, { id: "x--web", state: "running" } as StudioStatus]]);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: async (key: string, value: unknown) => { map.set(key, value); },
  };
}

describe("runScheduledTick — the alarm always re-arms", () => {
  it("re-arms after the tick deadline even when the tick body never settles", async () => {
    vi.useFakeTimers();
    const rearm = vi.fn(async () => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const done = runScheduledTick(runningStorage() as never, () => new Promise<void>(() => {}), rearm, "shipTranscript");
    await vi.advanceTimersByTimeAsync(TICK_DEADLINES_MS.shipTranscript - 1);
    expect(rearm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(rearm).toHaveBeenCalledTimes(1);
    // The log names the tick, so a Worker tail says WHICH loop overran.
    expect(errSpy.mock.calls[0]![0]).toContain("shipTranscript");
    errSpy.mockRestore();
  });

  it("every tick's deadline, summed, stays well inside the 900s alarm kill", () => {
    const total = Object.values(TICK_DEADLINES_MS).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(900_000 - 60_000);
    expect(Object.keys(TICK_DEADLINES_MS).sort()).toEqual(
      ["refreshToken", "shipTranscript", "sweepMaestro", "syncSession"],
    );
  });
});

describe("StudioDO wiring — no tick execs on the default session", () => {
  it("every sbExec(this, …) call in do.ts names an EXEC_CLASSES class", () => {
    const calls: string[] = [];
    for (let i = doSrc.indexOf("sbExec(this,"); i !== -1; i = doSrc.indexOf("sbExec(this,", i + 1)) {
      let depth = 0;
      let j = i + "sbExec".length;
      for (; j < doSrc.length; j++) {
        if (doSrc[j] === "(") depth++;
        else if (doSrc[j] === ")" && --depth === 0) break;
      }
      calls.push(doSrc.slice(i, j + 1));
    }
    expect(calls.length).toBeGreaterThan(8);
    for (const c of calls) expect(c).toContain("EXEC_CLASSES");
  });

  it("waits for a cold container before the first (refresh-class) exec of provision and restart", () => {
    for (const sig of ["  private async provisionUngated(", "  private async restartUngated("]) {
      const start = doSrc.indexOf(sig);
      expect(start).toBeGreaterThan(-1);
      const b = doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
      const wait = b.indexOf("if (!this.ctx.container?.running) await sbAwaitReady(this);");
      expect(wait).toBeGreaterThan(b.indexOf("this.envVars = "));
      expect(wait).toBeLessThan(b.indexOf("refreshWithStorage("));
    }
  });

  it("wires each deps builder to its own class", () => {
    const body = (sig: string) => {
      const start = doSrc.indexOf(sig);
      expect(start).toBeGreaterThan(-1);
      return doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
    };
    expect(body("  private shipDeps(")).toContain("EXEC_CLASSES.ship");
    expect(body("  private refreshDeps(")).toContain("EXEC_CLASSES.refresh");
    expect(body("  async inspect(")).toContain("EXEC_CLASSES.inspect");
    expect(body("  async wakeStudio(")).toContain("EXEC_CLASSES.wake");
    expect(body("  async wakeStudioOnAssignment(")).toContain("EXEC_CLASSES.wake");
    expect(body("  async syncSession(")).toContain('this.syncDeps("sync")');
    expect(body("  async checkProvisioned(")).toContain('this.syncDeps("readiness")');
    expect(body("  async destroyStudio(")).toContain('this.syncDeps("rescue")');
  });

  it("passes each tick its named deadline", () => {
    for (const tick of ["refreshToken", "shipTranscript", "syncSession", "sweepMaestro"]) {
      expect(doSrc).toMatch(new RegExp(`\\n\\s+"${tick}",\\n\\s+\\);`));
    }
  });
});

// Issue #85 review round 4 (TEST 12d) — a lightweight regression guard
// against a refactor silently dropping the `via` a heal/recycle bring-up
// passes through. Same source-pin technique as the rest of this file:
// `syncSessionCycle`'s heal closure must call `restartStudio("heal")`
// verbatim, and `recycle`'s provisionCore closure must pass `"recycle"` as
// its own `via` argument, so `recordBringupObservation`'s session verdict
// records the right `BringupVia` for each path.
describe("StudioDO wiring — heal/recycle source-pin the `via` they pass through (issue #85)", () => {
  it('the ship-tick heal closure calls restartStudio("heal") verbatim', () => {
    expect(doSrc).toContain('this.restartStudio("heal")');
  });

  it('the recycle path passes "recycle" as provisionCore\'s via argument', () => {
    // Issue #152 rebase: provisionCore also takes recycle's own shared ctx as
    // a third argument now (see provisionCore's own doc comment) — this pin
    // still confirms the "recycle" via literal survives that rebase.
    expect(doSrc).toContain('this.provisionCore(c, "recycle", ctx)');
  });
});

// Issue #85 review round 4, NIT 14 — every StudioStatus leaving a StudioDO
// bound for D1 goes through withObserved (Task 2's own D1-wiring rule) so
// `fleet ls` (D1-only reads) never renders a stale/undefined `observed`.
// `watchContainer()`'s own `record` closure (container-watch.ts's
// `observeContainer`) was the one site still passing a bare
// `recordStudio(this.env, s)` with no withObserved wrap.
describe("StudioDO wiring — watchContainer's D1 write also goes through withObserved (issue #85)", () => {
  it("watchContainer's own record closure wraps withObserved before recordStudio", () => {
    const start = doSrc.indexOf("async watchContainer(");
    expect(start).toBeGreaterThan(-1);
    const body = doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
    expect(body).toContain("withObserved(this.ctx.storage");
    expect(body).toMatch(/recordStudio\(this\.env,\s*await withObserved\(this\.ctx\.storage/);
  });
});

// Issue #85 review round 4, NIT 16(a) — the bring-up observation exec
// (recordBringupObservation's combined token-write + pane-probe) is wired
// to its own EXEC_CLASSES.inspect budget, never sbExec's own
// EXEC_CLASSES.provision (600s, sized for BRINGUP_CMD itself).
describe("StudioDO wiring — the bring-up probe runs on EXEC_CLASSES.inspect, not provision (issue #85)", () => {
  it("deps()'s observationExec field is wired to EXEC_CLASSES.inspect", () => {
    const start = doSrc.indexOf("private deps(): ProvisionDeps {");
    expect(start).toBeGreaterThan(-1);
    const body = doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
    expect(body).toMatch(/observationExec:\s*\(cmd: string\) => sbExec\(this, cmd, EXEC_CLASSES\.inspect\)/);
  });
});

// Issue #85 review round 6, MUST-FIX 10(b) — round 3's own MUST-FIX 8(b)
// wired ProvisionDeps.r2Head to `this.env.STUDIO_ARCHIVE.head` here but never
// got its own source-pin regression test, unlike r2Get/observationExec just
// above — a future refactor could silently drop this wiring (the type stays
// optional, so nothing would fail to compile) and recordBringupObservation's
// own R2-uploaded-timestamp fallback would go quiet again with no test ever
// catching it.
describe("StudioDO wiring — deps()'s r2Head is wired to STUDIO_ARCHIVE.head (issue #85 review round 3, MUST-FIX 8b)", () => {
  it("deps()'s r2Head field calls this.env.STUDIO_ARCHIVE.head", () => {
    const start = doSrc.indexOf("private deps(): ProvisionDeps {");
    expect(start).toBeGreaterThan(-1);
    const body = doSrc.slice(start, doSrc.indexOf("\n  }\n", start));
    expect(body).toMatch(/r2Head:\s*async \(key: string\) => \{[\s\S]*?this\.env\.STUDIO_ARCHIVE\.head\(key\)/);
  });
});

describe("isDeadlineExit — a killed exec is UNKNOWN, never a 'no'", () => {
  it("names timeout's 124 and SIGKILL's 137", () => {
    expect(isDeadlineExit(124)).toBe(true);
    expect(isDeadlineExit(137)).toBe(true);
    expect(isDeadlineExit(0)).toBe(false);
    expect(isDeadlineExit(1)).toBe(false);
  });
});
