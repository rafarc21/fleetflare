// Issue #181 — stopped studio keep report old 5h bucket.
//
// rollWindow (src/studio/burn.ts) only reset the bucket INSIDE a sync tick
// (session-sync.ts). Studio that stop never tick again, so its bucket freeze
// forever and every reader of the registry hand that dead number to the
// operator. Measured 2026-09-24 19:56Z: 4.38M of 5.42M FLEET TOTALS was
// phantom — ~81% — and operator judge the shared account limit from it.
//
// Fix live at the ONE read boundary, registry.ts's listStudios: an expired
// bucket (`now - window5hStart >= BURN_WINDOW_MS`) read 0. Every reader named
// in the bug get rows through that function, so none can bypass it. Nothing
// write storage — this is display correction only. Cumulative counters
// (turns/inputTokens/outputTokens/costUsd) are LIFETIME totals and must stay
// untouched in every case.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { recordStudio, listStudios } from "../src/studio/registry";
import { computeFleetTotals } from "../src/studio/grid";
import { fleetTotals, formatFleetTotalsLine } from "../cli/fleet-totals";
import { formatBurn, BURN_LEGEND } from "../cli/burn-format";
import { BURN_WINDOW_MS } from "../src/studio/archive";
import { checkAndRecordReadiness } from "../src/studio/do";
import { STATUS_KEY, type StudioStorage } from "../src/studio/provision";
import type { SessionSyncDeps } from "../src/studio/session-sync";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import type { Env } from "../src/env";

const STOPPED_ID = "acme-os--maestro";
const LIVE_ID = "demosite-life--scratch";

// "now" every test in this file read against. Fixed so the arithmetic below
// is readable, not clock-dependent.
const NOW = new Date("2026-09-24T19:56:00.000Z");
const TEN_HOURS_AGO = new Date(NOW.getTime() - 36_000_000).toISOString();
const ONE_HOUR_AGO = new Date(NOW.getTime() - 3_600_000).toISOString();

// The real numbers from the bug report, so a regression read like the
// incident did.
function stoppedBurn(overrides: Partial<Burn> = {}): Burn {
  return {
    turns: 412, inputTokens: 9_100_000, outputTokens: 7_400_000, costUsd: 123.45,
    window5hStart: TEN_HOURS_AGO, window5hOutput: 3_805_818,
    ...overrides,
  };
}

function liveBurn(overrides: Partial<Burn> = {}): Burn {
  return {
    turns: 12, inputTokens: 40_000, outputTokens: 21_000, costUsd: 1.5,
    window5hStart: ONE_HOUR_AGO, window5hOutput: 18_004,
    ...overrides,
  };
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STOPPED_ID, state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    readiness: null,
    ...overrides,
  };
}

// Narrow fake, copied from test/studio.grid.test.ts: the grid render path
// (routes.ts's renderStudioGrid) only ever call getTranscriptTail().
function envWithFakeStudio(): Env {
  const get = (() => ({ getTranscriptTail: async () => "" })) as unknown as Env["STUDIO"]["get"];
  return {
    ...env,
    STUDIO: {
      idFromName: ((name: string) => name) as unknown as Env["STUDIO"]["idFromName"],
      get,
    } as unknown as Env["STUDIO"],
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// Review round 2 — burn live in TWO stores, not one.
//
// listStudios read the D1 `fleet_state` row. But do.ts's mirrorBurnToRegistry
// also write burn into DO storage's STATUS_KEY, and destroy.ts spread that row
// into the stopped row it store. Every route that answer a DO StudioStatus
// (/status, /check, /provision, /restart, /recycle, /destroy) bypass
// listStudios completely, so the phantom bucket come straight back out.
//
// `fleet ls --fresh` (cli/fleet.ts's refreshAll) POST /check to EVERY row and
// swap the listing for those answers — so the corrected listStudios table get
// overwritten with stale DO numbers, under a BURN_LEGEND that now lie.
// MEASURED on this branch: /check answer 3805818 while listStudios answer 0.
// ---------------------------------------------------------------------------

// The DO storage the fake stub read, so a test can check no write happened.
function fakeDoStorage(seed: StudioStatus) {
  const map = new Map<string, unknown>();
  map.set(STATUS_KEY, seed);
  return {
    map,
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function checkDeps() {
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const deps = { exec, now: () => NOW } as unknown as SessionSyncDeps;
  return { exec, deps };
}

/** env whose STUDIO stub answer the REAL checkAndRecordReadiness over `storage`. */
function envWithCheckStub(storage: ReturnType<typeof fakeDoStorage>, deps: SessionSyncDeps): Env {
  const get = (() => ({
    checkNow: () => checkAndRecordReadiness(deps, storage as never, STOPPED_ID, async () => {}),
  })) as unknown as Env["STUDIO"]["get"];
  return {
    ...env,
    STUDIO: {
      idFromName: ((name: string) => name) as unknown as Env["STUDIO"]["idFromName"],
      get,
    } as unknown as Env["STUDIO"],
  } as unknown as Env;
}

/** env whose STUDIO stub answer one fixed row out of getStatusDetail. */
function envWithStatusStub(row: StudioStatus): Env {
  const get = (() => ({ getStatusDetail: async () => row })) as unknown as Env["STUDIO"]["get"];
  return {
    ...env,
    STUDIO: {
      idFromName: ((name: string) => name) as unknown as Env["STUDIO"]["idFromName"],
      get,
    } as unknown as Env["STUDIO"],
  } as unknown as Env;
}

function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("issue #181 — expired 5h burn bucket read 0 at the registry read boundary", () => {
  it("a 10h-old bucket read 0 out of listStudios; cumulative counters untouched", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));

    const row = (await listStudios(env)).find((s) => s.id === STOPPED_ID)!;

    expect(row.burn!.window5hOutput).toBe(0);
    // Lifetime totals never reset — only the bucket expire.
    expect(row.burn!.turns).toBe(412);
    expect(row.burn!.inputTokens).toBe(9_100_000);
    expect(row.burn!.outputTokens).toBe(7_400_000);
    expect(row.burn!.costUsd).toBe(123.45);
  });

  it("a fresh (1h-old) bucket is unchanged, cumulative counters included", async () => {
    await recordStudio(env, status({ id: LIVE_ID, state: "running", burn: liveBurn() }));

    const row = (await listStudios(env)).find((s) => s.id === LIVE_ID)!;

    expect(row.burn).toEqual(liveBurn());
  });

  it("exactly at BURN_WINDOW_MS the bucket is already expired, one ms before it is not — same inclusive boundary rollWindow use", async () => {
    const atBoundary = new Date(NOW.getTime() - BURN_WINDOW_MS).toISOString();
    const justInside = new Date(NOW.getTime() - BURN_WINDOW_MS + 1).toISOString();
    await recordStudio(env, status({ id: "websites--atboundary", burn: stoppedBurn({ window5hStart: atBoundary }) }));
    await recordStudio(env, status({ id: "websites--justinside", burn: stoppedBurn({ window5hStart: justInside }) }));

    const rows = await listStudios(env);

    expect(rows.find((s) => s.id === "websites--atboundary")!.burn!.window5hOutput).toBe(0);
    expect(rows.find((s) => s.id === "websites--justinside")!.burn!.window5hOutput).toBe(3_805_818);
  });

  // DECISION, not an accident: cleanBurn already fall back to
  // `new Date(0).toISOString()` for a non-string window5hStart, and epoch is
  // ALWAYS more than 5h ago, so under the new rule a malformed bucket read 0.
  // That is the right answer — a bucket with no trustworthy start time cannot
  // be proven current, and the safe display for an unprovable burn number is
  // zero, never a number the operator might size the account limit against.
  it("an epoch window5hStart (cleanBurn's malformed fallback) read 0 — unprovable bucket never show a number", async () => {
    const malformed = { ...stoppedBurn(), window5hStart: 12345 } as unknown as Burn;
    await recordStudio(env, status({ id: "websites--malformed", burn: malformed }));

    const raw = await env.DB.prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--malformed").first<{ value: string }>();
    // cleanBurn's own fallback still what land in storage — unchanged by #181.
    expect((JSON.parse(raw!.value) as StudioStatus).burn!.window5hStart).toBe(new Date(0).toISOString());

    const row = (await listStudios(env)).find((s) => s.id === "websites--malformed")!;
    expect(row.burn!.window5hOutput).toBe(0);
    expect(row.burn!.outputTokens).toBe(7_400_000); // cumulative still untouched
  });

  it("a burn-less studio (null burn, never synced) still read null, not a zeroed object", async () => {
    await recordStudio(env, status({ id: "websites--nosync", burn: null }));
    expect((await listStudios(env)).find((s) => s.id === "websites--nosync")!.burn).toBeNull();
  });

  it("nothing write storage from a read — the stored row keep its stale bucket verbatim after listStudios", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));

    const before = await env.DB.prepare(`SELECT value, ts FROM fleet_state WHERE key = ?`)
      .bind(`studio:${STOPPED_ID}`).first<{ value: string; ts: number }>();
    await listStudios(env);
    await listStudios(env);
    const after = await env.DB.prepare(`SELECT value, ts FROM fleet_state WHERE key = ?`)
      .bind(`studio:${STOPPED_ID}`).first<{ value: string; ts: number }>();

    expect(after).toEqual(before);
    expect((JSON.parse(after!.value) as StudioStatus).burn!.window5hOutput).toBe(3_805_818);
  });
});

describe("issue #181 — every reader site named in the bug get the corrected value", () => {
  // Reader 1: src/studio/routes.ts's GET /studio/ JSON — what `fleet ls` fetch.
  it("reader 1, GET /studio/ JSON (routes.ts): expired studio serve 0, fresh one unchanged", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));
    await recordStudio(env, status({ id: LIVE_ID, state: "running", burn: liveBurn() }));

    const res = await handleStudio(
      authorizedReq("/studio/", { headers: { Accept: "application/json" } }),
      envWithFakeStudio(),
    );
    const body = (await res.json()) as StudioStatus[];

    expect(body.find((s) => s.id === STOPPED_ID)!.burn!.window5hOutput).toBe(0);
    expect(body.find((s) => s.id === STOPPED_ID)!.burn!.outputTokens).toBe(7_400_000);
    expect(body.find((s) => s.id === LIVE_ID)!.burn!.window5hOutput).toBe(18_004);
  });

  // Reader 2: cli/fleet.ts's formatBurn — the BURN column cell.
  it("reader 2, formatBurn (cli/fleet.ts): expired cell read `<cumulative>o/5h:0`", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));
    const row = (await listStudios(env)).find((s) => s.id === STOPPED_ID)!;
    expect(formatBurn(row.burn)).toBe("7400000o/5h:0");
  });

  // Reader 3: cli/fleet.ts's BURN_LEGEND — "trailing 5h window" was a lie for
  // a stopped studio. The bucket is a TUMBLING one that expire, so say so.
  it("reader 3, BURN_LEGEND (cli/fleet.ts): say `current 5h bucket`, not `trailing 5h window`", () => {
    expect(BURN_LEGEND).toContain("current 5h bucket");
    expect(BURN_LEGEND).not.toContain("trailing 5h window");
  });

  // Reader 4: cli/fleet-totals.ts's fleetTotals — the FLEET TOTALS line.
  it("reader 4, fleetTotals (cli/fleet-totals.ts): FLEET TOTALS exclude the expired bucket, keep the fresh one", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));
    await recordStudio(env, status({ id: LIVE_ID, state: "running", burn: liveBurn() }));

    const t = fleetTotals(await listStudios(env));

    expect(t.window5hOutput).toBe(18_004); // 3,805,818 phantom gone
    expect(t.turns).toBe(424); // 412 + 12, cumulative untouched
    expect(t.outputTokens).toBe(7_421_000); // 7,400,000 + 21,000, cumulative untouched
  });

  // Reader 4's own printed LABEL. The number is corrected above, but the line
  // that carry it still told the operator it was a "trailing 5h window" — the
  // same false promise BURN_LEGEND made, on the very line the 4.38M phantom
  // was read off. Corrected number under a wrong label is still a wrong
  // reading.
  it("reader 4's label: the FLEET TOTALS line say `current 5h bucket`, not `trailing 5h window`", () => {
    const line = formatFleetTotalsLine({ turns: 424, outputTokens: 7_421_000, window5hOutput: 18_004 });
    expect(line).toBe("FLEET TOTALS: 424 turns, 7421000 output tokens, 18004 in the current 5h bucket");
    expect(line).not.toContain("trailing 5h window");
  });

  // Reader 5: src/studio/grid.ts's computeFleetTotals — the grid header row,
  // fed by routes.ts's renderStudioGrid, which itself read listStudios.
  it("reader 5, grid header (grid.ts computeFleetTotals over renderStudioGrid's cards): expired bucket excluded", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));
    await recordStudio(env, status({ id: LIVE_ID, state: "running", burn: liveBurn() }));

    // The exact cards renderStudioGrid build — same listStudios rows, burn
    // copied straight across.
    const cards = (await listStudios(env)).map((s) => ({ burn: s.burn }));
    const totals = computeFleetTotals(cards);

    expect(totals.window5hOutput).toBe(18_004);
    expect(totals.turns).toBe(424);
    expect(totals.outputTokens).toBe(7_421_000);

    // And through the real HTML render path, end to end.
    const res = await handleStudio(
      authorizedReq("/studio/", { headers: { Accept: "text/html" } }),
      envWithFakeStudio(),
    );
    const html = await res.text();
    const line = html.split("\n").find((l) => l.trim().startsWith("var FLEET_TOTALS = "))!;
    const parsed = JSON.parse(line.trim().replace(/^var FLEET_TOTALS = /, "").replace(/;$/, ""));
    expect(parsed).toEqual({ turns: 424, outputTokens: 7_421_000, window5hOutput: 18_004 });
  });
});

describe("issue #181 round 2 — the DO-status routes are a SECOND read boundary, and they bypassed the fix", () => {
  // `fleet ls --fresh` fan this out to every row and replace the table with
  // the answers. This is the exact 3,805,818 the incident measured.
  it("POST /studio/:id/check on a stopped studio serve a 0 bucket, cumulative untouched", async () => {
    const stored = status({ burn: stoppedBurn() });
    const storage = fakeDoStorage(stored);
    const { exec, deps } = checkDeps();

    const res = await handleStudio(
      authorizedReq(`/studio/${STOPPED_ID}/check`, { method: "POST" }),
      envWithCheckStub(storage, deps),
    );
    const body = (await res.json()) as StudioStatus;

    expect(body.burn!.window5hOutput).toBe(0);
    expect(body.burn!.outputTokens).toBe(7_400_000);
    // A stopped studio is never probed — the exec would boot the container.
    expect(exec).not.toHaveBeenCalled();
    // A READ must not write: DO storage keep the stale bucket verbatim.
    expect((storage.map.get(STATUS_KEY) as StudioStatus).burn!.window5hOutput).toBe(3_805_818);
  });

  // The whole point: refreshAll build FLEET TOTALS out of /check answers.
  it("FLEET TOTALS over a /check answer carry no phantom bucket", async () => {
    const storage = fakeDoStorage(status({ burn: stoppedBurn() }));
    const { deps } = checkDeps();

    const res = await handleStudio(
      authorizedReq(`/studio/${STOPPED_ID}/check`, { method: "POST" }),
      envWithCheckStub(storage, deps),
    );
    const body = (await res.json()) as StudioStatus;

    expect(fleetTotals([body]).window5hOutput).toBe(0);
    expect(fleetTotals([body]).outputTokens).toBe(7_400_000);
  });

  it("GET /studio/:id/status serve a 0 bucket for a stale row, cumulative untouched", async () => {
    const res = await handleStudio(
      authorizedReq(`/studio/${STOPPED_ID}/status`),
      envWithStatusStub(status({ burn: stoppedBurn() })),
    );
    const body = (await res.json()) as StudioStatus;

    expect(body.burn!.window5hOutput).toBe(0);
    expect(body.burn!.outputTokens).toBe(7_400_000);
  });

  it("GET /studio/:id/status leave a FRESH bucket alone", async () => {
    const res = await handleStudio(
      authorizedReq(`/studio/${LIVE_ID}/status`),
      envWithStatusStub(status({ id: LIVE_ID, state: "running", burn: liveBurn() })),
    );
    const body = (await res.json()) as StudioStatus;

    expect(body.burn).toEqual(liveBurn());
  });

  it("a burn-less DO row still answer null, not a zeroed object", async () => {
    const res = await handleStudio(
      authorizedReq(`/studio/${STOPPED_ID}/status`),
      envWithStatusStub(status({ burn: null })),
    );
    expect(((await res.json()) as StudioStatus).burn).toBeNull();
  });
});

describe("issue #181 round 2 — expireBurnWindow's own guards, pinned", () => {
  // A DO row never goes through cleanBurn, and a hand-edited D1 row can hold
  // a string that IS a string (so cleanBurn keep it) but parse to NaN. Drop
  // `!Number.isFinite(startMs)` from expireBurnWindow and this read 3,805,818:
  // NaN >= BURN_WINDOW_MS is false, so the bucket would look CURRENT.
  it("an unparseable window5hStart string read 0 — NaN must not read as a current bucket", async () => {
    await recordStudio(env, status({ id: "websites--nandate", burn: stoppedBurn({ window5hStart: "not-a-date" }) }));

    // The string survive cleanBurn untouched — that is why the finite check
    // is the only thing standing between NaN and a phantom number.
    const raw = await env.DB.prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--nandate").first<{ value: string }>();
    expect((JSON.parse(raw!.value) as StudioStatus).burn!.window5hStart).toBe("not-a-date");

    const row = (await listStudios(env)).find((s) => s.id === "websites--nandate")!;
    expect(row.burn!.window5hOutput).toBe(0);
    expect(row.burn!.outputTokens).toBe(7_400_000);
  });

  // The view CORRECT the bucket, it does not fabricate a new window. Rewrite
  // window5hStart to `now` and the next reader would think the bucket just
  // opened — and the next real sync tick's rollWindow would then not roll.
  it("an expired view keep window5hStart exactly as stored", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));

    const row = (await listStudios(env)).find((s) => s.id === STOPPED_ID)!;

    expect(row.burn!.window5hStart).toBe(TEN_HOURS_AGO);
    expect(row.burn!.window5hOutput).toBe(0);
  });

  // registry.ts's doc claim `now` is a parameter so a test can pin the clock
  // WITHOUT faking timers. Proved here, with the fake timers off.
  it("listStudios take an injected clock — no fake timers needed", async () => {
    await recordStudio(env, status({ burn: stoppedBurn() }));
    vi.useRealTimers();

    const expired = (await listStudios(env, NOW)).find((s) => s.id === STOPPED_ID)!;
    const inside = (await listStudios(env, new Date(new Date(TEN_HOURS_AGO).getTime() + 1_000)))
      .find((s) => s.id === STOPPED_ID)!;

    expect(expired.burn!.window5hOutput).toBe(0);
    expect(inside.burn!.window5hOutput).toBe(3_805_818);
  });
});
