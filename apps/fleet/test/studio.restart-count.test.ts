// Issue #56 — per-studio container restart count. The unit is a container
// GENERATION: a new boot-id at TRANSCRIPT_BOOT_ID_PATH (written once per
// container lifetime by studio-bringup.sh) seen by the ship tick. Every path
// that replaces a container — fleet recycle, destroy+spawn, image rollout, a
// platform restart — lands on a fresh /workspace and so a fresh boot-id, and
// the ship tick sees each generation change exactly once (the new boot-id is
// persisted atomically with the count). The bring-up that rebuilt the new
// container (`Observed.session.via`) is recorded beside it: recycle/provision
// mean the fleet replaced it, restart/heal mean it was replaced underneath.
import { describe, it, expect, vi } from "vitest";
import { runShipTickWithObservation, withObserved } from "../src/studio/do";
import { emptyObserved, OBSERVED_KEY, type BringupVia, type Observed, type ObservedStorage } from "../src/studio/observed";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { TranscriptStorage } from "../src/studio/transcript";
import { RESTARTS_KEY, recordRestart, restartsInWindow, RESTART_WINDOW_MS, type RestartLog } from "../src/studio/restarts";
import type { StudioStatus } from "../src/studio/types";
import { formatRestartCell } from "../cli/restart-format";

// Wire-format literals (markers/paths/keys are the container↔Worker protocol,
// pinned here as literals so these asserts fail when the builder drifts —
// same convention test/studio.observation-tick.test.ts:33-34 established).
const SECTION_BOOTID = "---FLEET-BOOTID---";
const SECTION_STAT = "---FLEET-STAT---";
const SECTION_INCARNATION = "---FLEET-INCARNATION---";
const SECTION_CHUNK = "---FLEET-CHUNK---";
const SECTION_TAIL = "---FLEET-TAIL---";
const TRANSCRIPT_BOOT_ID_KEY = "transcriptBootId";
const TRANSCRIPT_MANIFEST_KEY = "transcriptManifest";

const TOK = "11111111-2222-3333-4444-555555555555";
const T0 = "2026-09-29T10:00:00.000Z";

type Store = TranscriptStorage & ObservedStorage & StudioStorage & { map: Map<string, unknown> };

function fakeStorage(seed: { bootId?: string; via?: BringupVia; restarts?: RestartLog } = {}): Store {
  const map = new Map<string, unknown>();
  if (seed.bootId !== undefined) map.set(TRANSCRIPT_BOOT_ID_KEY, seed.bootId);
  if (seed.restarts !== undefined) map.set(RESTARTS_KEY, seed.restarts);
  const observed: Observed = { ...emptyObserved(), incarnation: TOK };
  if (seed.via) {
    observed.session = {
      verdict: "resumed", at: T0, via: seed.via, restore: "restored",
      snapshotAgeS: null, turnsBefore: 0, reason: null,
    };
  }
  map.set(OBSERVED_KEY, observed);
  return {
    map,
    get: (async (key: string) => map.get(key)) as unknown as Store["get"],
    put: (async (keyOrEntries: unknown, value?: unknown) => {
      if (typeof keyOrEntries === "object" && keyOrEntries !== null) {
        for (const [k, v] of Object.entries(keyOrEntries as Record<string, unknown>)) map.set(k, v);
        return;
      }
      map.set(keyOrEntries as string, value);
    }) as unknown as Store["put"],
  } as Store;
}

/** A tick where the transcript file exists (size 0) and the container's
 *  boot-id reads `bootId` — the only branch that consults the boot-id. */
function deps(bootId: string, now = T0) {
  return {
    exec: vi.fn(async (_cmd: string) => ({
      code: 0,
      stdout: [SECTION_BOOTID, bootId, SECTION_STAT, "0", SECTION_INCARNATION, TOK, SECTION_CHUNK, "", SECTION_TAIL, ""].join("\n"),
      stderr: "",
    })),
    r2Put: vi.fn(async () => {}),
    now: () => new Date(now),
  };
}

async function tick(storage: Store, bootId: string, now = T0): Promise<void> {
  await runShipTickWithObservation(deps(bootId, now), storage, "acmeclient--lead", undefined, 5000);
}

function log(storage: Store): RestartLog | undefined {
  return storage.map.get(RESTARTS_KEY) as RestartLog | undefined;
}

describe("container restart count — counted from the boot-id generation marker (#56)", () => {
  it("recycle: the new container's boot-id counts ONCE, tagged recycle — no second count for the fleet op itself", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "recycle" });
    await tick(storage, "boot-b");
    expect(log(storage)).toEqual({ total: 1, recent: [{ at: T0, via: "recycle" }] });
  });

  it("the same new boot-id on later ticks never counts again (once per generation, not per tick)", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "recycle" });
    await tick(storage, "boot-b");
    await tick(storage, "boot-b", "2026-09-29T10:00:30.000Z");
    await tick(storage, "boot-b", "2026-09-29T10:01:00.000Z");
    expect(log(storage)?.total).toBe(1);
  });

  it("restart that lands on a replaced container (image rollout underneath) counts, tagged restart", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "restart" });
    await tick(storage, "boot-b");
    expect(log(storage)).toEqual({ total: 1, recent: [{ at: T0, via: "restart" }] });
  });

  it("restart on the SAME container (boot-id unchanged) is not a container restart", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "restart", restarts: { total: 2, recent: [] } });
    await tick(storage, "boot-a");
    expect(log(storage)).toEqual({ total: 2, recent: [] });
  });

  it("first-ever boot-id observation is the baseline: seeds 0, never counts", async () => {
    const storage = fakeStorage({ via: "provision" });
    await tick(storage, "boot-a");
    expect(log(storage)).toEqual({ total: 0, recent: [] });
    expect(storage.map.get(TRANSCRIPT_BOOT_ID_KEY)).toBe("boot-a");
  });

  it("post-deploy studio (boot-id baseline stored, no log yet): same boot-id seeds 0", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "restart" });
    await tick(storage, "boot-a");
    expect(log(storage)).toEqual({ total: 0, recent: [] });
  });

  it("no baseline yet (boot-id unreadable, none stored): nothing seeded — count stays unknown", async () => {
    const storage = fakeStorage({ via: "provision" });
    await tick(storage, "");
    expect(log(storage)).toBeUndefined();
  });

  it("unreadable boot-id never counts (no false generation change)", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "heal" });
    await tick(storage, "");
    expect(log(storage)).toBeUndefined();
  });

  it("successive generations accumulate onto the stored log", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "heal" });
    await tick(storage, "boot-b");
    await tick(storage, "boot-c", "2026-09-29T11:00:00.000Z");
    expect(log(storage)?.total).toBe(2);
    expect(log(storage)?.recent.map((e) => e.at)).toEqual([T0, "2026-09-29T11:00:00.000Z"]);
  });

  it("the count lands in the SAME write as the new boot-id (a crash between them cannot lose or double it)", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "recycle" });
    const puts: unknown[] = [];
    const realPut = storage.put;
    storage.put = (async (k: unknown, v?: unknown) => { puts.push(k); return (realPut as (a: unknown, b?: unknown) => Promise<void>)(k, v); }) as Store["put"];
    await tick(storage, "boot-b");
    const atomic = puts.find((p) => typeof p === "object" && p !== null && TRANSCRIPT_BOOT_ID_KEY in (p as object));
    expect(atomic).toBeDefined();
    expect(Object.keys(atomic as object).sort()).toEqual([RESTARTS_KEY, TRANSCRIPT_BOOT_ID_KEY, TRANSCRIPT_MANIFEST_KEY].sort());
  });
});

describe("recordRestart / restartsInWindow — pure (#56)", () => {
  it("no prior log starts at 1", () => {
    expect(recordRestart(undefined, new Date(T0), "recycle")).toEqual({ total: 1, recent: [{ at: T0, via: "recycle" }] });
  });

  it("drops events older than the window from `recent`, never from `total`", () => {
    const old = new Date(Date.parse(T0) - RESTART_WINDOW_MS - 1000).toISOString();
    const out = recordRestart({ total: 4, recent: [{ at: old, via: "heal" }] }, new Date(T0), null);
    expect(out).toEqual({ total: 5, recent: [{ at: T0, via: null }] });
  });

  it("restartsInWindow counts only events inside the last 24h of `now`", () => {
    const inside = new Date(Date.parse(T0) - 60_000).toISOString();
    const outside = new Date(Date.parse(T0) - RESTART_WINDOW_MS - 60_000).toISOString();
    expect(restartsInWindow({ total: 7, recent: [{ at: outside, via: "heal" }, { at: inside, via: "recycle" }] }, new Date(T0))).toBe(1);
  });

  it("restartsInWindow survives a malformed log (hand-edited row) as 0", () => {
    expect(restartsInWindow({ total: 1, recent: [{ at: "garbage", via: null }] }, new Date(T0))).toBe(0);
    expect(restartsInWindow({ total: 1 } as unknown as RestartLog, new Date(T0))).toBe(0);
  });
});

describe("the count reaches the registry row through withObserved (#56)", () => {
  it("withObserved attaches the stored log as observed.restarts", async () => {
    const restarts: RestartLog = { total: 3, recent: [{ at: T0, via: "recycle" }] };
    const storage = fakeStorage({ restarts });
    const status = { id: "acmeclient--lead" } as StudioStatus;
    storage.map.set(STATUS_KEY, status);
    expect((await withObserved(storage, status)).observed?.restarts).toEqual(restarts);
  });

  it("no stored log leaves observed.restarts ABSENT (unknown), never a fabricated zero", async () => {
    const storage = fakeStorage();
    const out = await withObserved(storage, { id: "acmeclient--lead" } as StudioStatus);
    expect(out.observed && "restarts" in out.observed).toBe(false);
  });
});

describe("RST end to end: DO storage -> row -> cell (#56 review)", () => {
  const cell = async (storage: Store) =>
    formatRestartCell(await withObserved(storage, { id: "acmeclient--lead" } as StudioStatus), new Date(T0));

  it("right after deploy (no key yet) reads '-', not 0/0; baseline tick -> 0/0; new boot-id -> 1/1", async () => {
    const storage = fakeStorage({ bootId: "boot-a", via: "recycle" });
    expect(await cell(storage)).toBe("-");
    await tick(storage, "boot-a");
    expect(await cell(storage)).toBe("0/0");
    await tick(storage, "boot-b");
    expect(await cell(storage)).toBe("1/1");
  });
});
