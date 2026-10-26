// apps/fleet/test/bun/walk-runner.test.ts
// #1348 (+review r1): runSweep's control flow against fake auth/engine/sink
// — the system boundaries runner.ts depends on (test-lies-check's
// own-module-mock exemption: these are the seams runner.ts is written
// against, T5/T6's real wiring, not mocks of runner.ts's own code).
import { describe, it, expect } from "bun:test";
import { runSweep, type WalkAuthProvider, type WalkEngine, type WalkEvidenceSink, type WalkLog } from "../../src/walk/runner";
import type { WalkAttempt, WalkItem, WalkItemEvidence, WalkSweepEvidence } from "../../src/walk/types";

const ITEMS: WalkItem[] = [
  { id: "signup", role: "member", idx: 0, url: "https://staging.example.com/signup" },
  { id: "settings", role: "member", idx: 1, url: "https://staging.example.com/settings" },
];

const EMPTY_CONSOLE = {
  consoleErrors: [], consoleWarnings: [], debugLogs: [], exceptions: [], badRequests: [], canceledRequests: [],
};

function playwrightState(secretValues: string[]): string {
  return JSON.stringify({
    cookies: secretValues.map((v, i) => ({ name: `sid${i}`, value: v, domain: "x", path: "/" })),
    origins: [],
  });
}

function fakeSink() {
  const writes: { key: string; body: string }[] = [];
  const sink: WalkEvidenceSink = { putEvidence: async (key, body) => { writes.push({ key, body }); } };
  return { sink, writes };
}

function fakeLog() {
  const lines: unknown[] = [];
  const log: WalkLog = (record) => { lines.push(record); };
  return { log, lines };
}

function missingAuth(): WalkAuthProvider {
  return { getStorageState: async () => undefined };
}
function emptyAuth(): WalkAuthProvider {
  return { getStorageState: async () => "" };
}
function credentialLessAuth(): WalkAuthProvider {
  return { getStorageState: async () => JSON.stringify({ cookies: [], origins: [] }) };
}
function throwingAuth(message: string): WalkAuthProvider {
  return { getStorageState: async () => { throw new Error(message); } };
}
function presentAuth(secretValues: string[]): WalkAuthProvider {
  return { getStorageState: async () => playwrightState(secretValues) };
}

function passAttempt(overrides: Partial<WalkAttempt> = {}): WalkAttempt {
  return { result: "pass", steps: [], console: EMPTY_CONSOLE, ai: { turns: [] }, accounts: ["acct-a"], ...overrides };
}

function fakeEngine(opts: {
  runItem?: (item: WalkItem) => WalkAttempt | Error;
  sweepRoutes?: () => { routes: never[]; signatures: never[] } | Error;
} = {}) {
  const runItemCalls: { itemId: string; storageState: string }[] = [];
  let sweepRoutesCalls = 0;
  const engine: WalkEngine = {
    sweepRoutes: async () => {
      sweepRoutesCalls++;
      const r = (opts.sweepRoutes ?? (() => ({ routes: [], signatures: [] })))();
      if (r instanceof Error) throw r;
      return r;
    },
    runItem: async (item, storageState) => {
      runItemCalls.push({ itemId: item.id, storageState });
      const r = (opts.runItem ?? (() => passAttempt()))(item);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { engine, runItemCalls, get sweepRoutesCalls() { return sweepRoutesCalls; } };
}

const clock = (() => { let n = 0; return () => `t${n++}`; })();

describe("runSweep — no usable auth (missing, empty, credential-less)", () => {
  for (const [label, auth] of [
    ["missing (undefined)", missingAuth()],
    ["empty string", emptyAuth()],
    ["credential-less ({cookies:[],origins:[]})", credentialLessAuth()],
  ] as const) {
    it(`${label} -> did-not-run, no item files, engine never called`, async () => {
      const { sink, writes } = fakeSink();
      const { log } = fakeLog();
      const { engine, runItemCalls, sweepRoutesCalls } = fakeEngine();

      const result = await runSweep("build-1", ITEMS, { auth, engine, sink, log, verifier: "member-walker", now: clock });

      expect(result.state).toBe("did-not-run");
      expect(runItemCalls).toHaveLength(0);
      expect(sweepRoutesCalls).toBe(0);
      expect(writes).toHaveLength(1);
      expect(writes[0].key).toBe("walk/build-1/sweep.json");
      const sweep = JSON.parse(writes[0].body) as WalkSweepEvidence;
      expect("state" in sweep && sweep.state).toBe("did-not-run");
    });
  }
});

describe("runSweep — auth provider throws", () => {
  it("writes an error sweep.json instead of nothing, engine never called", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const { engine, runItemCalls } = fakeEngine();

    const result = await runSweep("build-2", ITEMS, {
      auth: throwingAuth("infisical unreachable"), engine, sink, log, verifier: "member-walker", now: clock,
    });

    expect(result.state).toBe("error");
    expect(runItemCalls).toHaveLength(0);
    expect(writes).toHaveLength(1);
    const sweep = JSON.parse(writes[0].body) as WalkSweepEvidence;
    expect("state" in sweep && sweep.state).toBe("error");
    expect("reason" in sweep && sweep.reason).toBe("infisical unreachable");
  });
});

describe("runSweep — usable auth present", () => {
  it("runs every item through the engine with the storage state, writes v1-shaped item evidence", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const state = playwrightState(["cookie-secret-1"]);
    const { engine, runItemCalls } = fakeEngine();

    const result = await runSweep("build-3", ITEMS, {
      auth: { getStorageState: async () => state }, engine, sink, log, verifier: "member-walker", now: clock,
    });

    expect(runItemCalls).toEqual([
      { itemId: "signup", storageState: state },
      { itemId: "settings", storageState: state },
    ]);
    expect(result.state).toBe("success");

    const itemWrite = writes.find((w) => w.key === "walk/build-3/item-member-0-signup.json");
    expect(itemWrite).toBeDefined();
    const ev = JSON.parse(itemWrite!.body) as WalkItemEvidence;
    expect(ev.fingerprint).toBe("build-3");
    expect(ev.verifier).toBe("member-walker");
    expect(ev.result).toBe("pass");
    expect(ev.accounts).toEqual(["acct-a"]);

    const sweepWrite = writes.find((w) => w.key === "walk/build-3/sweep.json");
    const sweep = JSON.parse(sweepWrite!.body) as WalkSweepEvidence;
    expect("routes" in sweep).toBe(true);
  });

  it("a failing item makes the overall state failure", async () => {
    const { sink } = fakeSink();
    const { log } = fakeLog();
    const { engine } = fakeEngine({
      runItem: (item) => (item.id === "settings" ? passAttempt({ result: "fail", failReason: "red chip" }) : passAttempt()),
    });

    const result = await runSweep("build-4", ITEMS, {
      auth: presentAuth(["s1"]), engine, sink, log, verifier: "member-walker", now: clock,
    });
    expect(result.state).toBe("failure");
  });

  it("an engine.runItem throw writes no file for that item and makes the overall state error", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const { engine } = fakeEngine({
      runItem: (item) => (item.id === "signup" ? new Error("engine crashed") : passAttempt()),
    });

    const result = await runSweep("build-5", ITEMS, {
      auth: presentAuth(["s1"]), engine, sink, log, verifier: "member-walker", now: clock,
    });

    expect(result.state).toBe("error");
    expect(writes.find((w) => w.key === "walk/build-5/item-member-0-signup.json")).toBeUndefined();
    expect(writes.find((w) => w.key === "walk/build-5/item-member-1-settings.json")).toBeDefined();
  });

  it("a sweepRoutes throw writes an abnormal sweep.json and makes the overall state error", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const { engine } = fakeEngine({ sweepRoutes: () => new Error("navigation timed out") });

    const result = await runSweep("build-6", ITEMS, {
      auth: presentAuth(["s1"]), engine, sink, log, verifier: "member-walker", now: clock,
    });

    expect(result.state).toBe("error");
    const sweep = JSON.parse(writes.find((w) => w.key === "walk/build-6/sweep.json")!.body) as WalkSweepEvidence;
    expect("state" in sweep && sweep.state).toBe("error");
  });

  it("zero items with usable auth still sweeps routes and is a success, not did-not-run", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const { engine } = fakeEngine();

    const result = await runSweep("build-7", [], {
      auth: presentAuth(["s1"]), engine, sink, log, verifier: "member-walker", now: clock,
    });

    expect(result.state).toBe("success");
    expect(writes).toHaveLength(1); // sweep.json only, no item files
  });
});

describe("runSweep — secret hygiene", () => {
  it("scrubs a secret value that leaks into a failReason, across raw/base64/url encodings, from both evidence and logs", async () => {
    const secret = "cookie-secret-xyz";
    const { sink, writes } = fakeSink();
    const { log, lines } = fakeLog();
    const { engine } = fakeEngine({
      runItem: (item) =>
        item.id === "signup"
          ? passAttempt({
              result: "fail",
              failReason: `blob leak raw:${secret} b64:${btoa(secret)} url:${encodeURIComponent(secret)}`,
            })
          : passAttempt(),
    });

    await runSweep("build-8", ITEMS, {
      auth: presentAuth([secret]), engine, sink, log, verifier: "member-walker", now: clock,
    });

    const haystacks = [...writes.map((w) => w.body), ...lines.map((l) => JSON.stringify(l))];
    for (const h of haystacks) expect(h).not.toContain(secret);
  });

  it("logs carry only structured fields, never the raw storage state", async () => {
    const secret = "cookie-secret-log-check";
    const { sink } = fakeSink();
    const { log, lines } = fakeLog();
    const { engine } = fakeEngine();

    await runSweep("build-9", ITEMS, {
      auth: presentAuth([secret]), engine, sink, log, verifier: "member-walker", now: clock,
    });

    for (const l of lines) expect(JSON.stringify(l)).not.toContain(secret);
  });
});
