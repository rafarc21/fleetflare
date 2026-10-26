// apps/fleet/test/bun/walk-runner.test.ts
// #1348: runSweep's control flow, against fake auth/engine/sink/log — the
// system boundaries this runner depends on (test-lies-check's own-module-mock
// exemption: these are the seams runner.ts is written against, not mocks of
// runner.ts's own code).
import { describe, it, expect } from "bun:test";
import { runSweep, type WalkAuthProvider, type WalkEngine, type WalkEvidenceSink, type WalkLog } from "../../src/walk/runner";
import type { WalkAttempt, WalkItem, WalkItemEvidence, WalkSweepEvidence } from "../../src/walk/types";

const ITEMS: WalkItem[] = [
  { id: "home", url: "https://staging.example.com/" },
  { id: "login", url: "https://staging.example.com/login" },
];

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

function presentAuth(secret: string): WalkAuthProvider {
  return { getStorageState: async () => secret };
}

function recordingEngine(byItem: Record<string, WalkAttempt | Error>) {
  const calls: { itemId: string; storageState: string }[] = [];
  const engine: WalkEngine = {
    runItem: async (item, storageState) => {
      calls.push({ itemId: item.id, storageState });
      const outcome = byItem[item.id];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return { engine, calls };
}

const clock = (() => {
  let n = 0;
  return () => `t${n++}`;
})();

describe("runSweep — missing storage state", () => {
  it("every item is did-not-run, the sweep is did-not-run, and the engine is never called", async () => {
    const { sink, writes } = fakeSink();
    const { log, lines } = fakeLog();
    const { engine, calls } = recordingEngine({});

    const sweep = await runSweep("sweep-1", ITEMS, { auth: missingAuth(), engine, sink, log, now: clock });

    expect(calls).toHaveLength(0);
    expect(sweep.state).toBe("did-not-run");
    expect(sweep.items.map((i) => i.state)).toEqual(["did-not-run", "did-not-run"]);

    const itemWrites = writes.filter((w) => w.key.includes("/items/"));
    expect(itemWrites).toHaveLength(2);
    for (const w of itemWrites) {
      const parsed = JSON.parse(w.body) as WalkItemEvidence;
      expect(parsed.state).toBe("did-not-run");
    }

    const sweepWrite = writes.find((w) => w.key === "walk/sweep-1/sweep.json");
    expect(sweepWrite).toBeDefined();
    expect((JSON.parse(sweepWrite!.body) as WalkSweepEvidence).state).toBe("did-not-run");

    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("runSweep — storage state present", () => {
  it("runs every item through the engine with the storage state, in order", async () => {
    const { sink } = fakeSink();
    const { log } = fakeLog();
    const { engine, calls } = recordingEngine({
      home: { state: "success" },
      login: { state: "failure", description: "assertion failed" },
    });

    const sweep = await runSweep("sweep-2", ITEMS, { auth: presentAuth("sekret123"), engine, sink, log, now: clock });

    expect(calls).toEqual([
      { itemId: "home", storageState: "sekret123" },
      { itemId: "login", storageState: "sekret123" },
    ]);
    expect(sweep.state).toBe("failure");
    expect(sweep.items.map((i) => i.state)).toEqual(["success", "failure"]);
  });

  it("every written item evidence body parses as stub-v0 with the required fields", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const { engine } = recordingEngine({ home: { state: "success" }, login: { state: "success" } });

    await runSweep("sweep-3", ITEMS, { auth: presentAuth("sekret123"), engine, sink, log, now: clock });

    const itemWrites = writes.filter((w) => w.key.includes("/items/"));
    expect(itemWrites).toHaveLength(2);
    for (const w of itemWrites) {
      const parsed = JSON.parse(w.body) as WalkItemEvidence;
      expect(parsed.schemaVersion).toBe("stub-v0");
      expect(typeof parsed.sweepId).toBe("string");
      expect(typeof parsed.itemId).toBe("string");
      expect(typeof parsed.url).toBe("string");
      expect(["success", "failure", "error", "did-not-run"]).toContain(parsed.state);
      expect(typeof parsed.startedAt).toBe("string");
      expect(typeof parsed.finishedAt).toBe("string");
    }
  });

  it("an engine throw becomes error evidence instead of escaping runSweep", async () => {
    const { sink, writes } = fakeSink();
    const { log } = fakeLog();
    const { engine } = recordingEngine({
      home: new Error("boom"),
      login: { state: "success" },
    });

    const sweep = await runSweep("sweep-4", ITEMS, { auth: presentAuth("sekret123"), engine, sink, log, now: clock });

    expect(sweep.state).toBe("error");
    const homeWrite = writes.find((w) => w.key === "walk/sweep-4/items/home.json");
    expect((JSON.parse(homeWrite!.body) as WalkItemEvidence).state).toBe("error");
  });
});

describe("runSweep — secret never reaches logs or evidence", () => {
  it("scrubs the live storage state out of an engine error that echoes it, on both logs and evidence", async () => {
    const secret = "sekret-abc-123";
    const { sink, writes } = fakeSink();
    const { log, lines } = fakeLog();
    const { engine } = recordingEngine({
      home: new Error(`auth rejected token ${secret}`),
      login: { state: "success" },
    });

    await runSweep("sweep-5", ITEMS, { auth: presentAuth(secret), engine, sink, log, now: clock });

    const haystacks = [
      ...writes.map((w) => w.body),
      ...lines.map((l) => JSON.stringify(l)),
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(secret);
    }
  });

  it("missing-storage-state path logs no secret (there is none to leak)", async () => {
    const { sink, writes } = fakeSink();
    const { log, lines } = fakeLog();
    const { engine } = recordingEngine({});

    await runSweep("sweep-6", ITEMS, { auth: missingAuth(), engine, sink, log, now: clock });

    for (const l of lines) expect(JSON.stringify(l)).not.toMatch(/sekret/i);
    for (const w of writes) expect(w.body).not.toMatch(/sekret/i);
  });
});
