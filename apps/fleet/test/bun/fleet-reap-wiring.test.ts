// Issue #53: the REAL wiring of `fleet reap` (cli/fleet.ts's reapDeps) and
// the `fleet ls` idle line, against a fake Worker on localhost. Proves what
// the pure-core suite (fleet-reap.test.ts) cannot: which routes are hit, and
// that the destroy never carries force or discard-unsynced. No real fleet.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdLs, reapDeps, withReapLock, REAP_LOCK_STALE_MS } from "../../cli/fleet";
import { runReap } from "../../cli/reap";
import type { OrcaDeps } from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";
import { REAL_WEBSTUDIO_PANE } from "../fixtures/rate-limit-panes";
import { probeRefusal, rescueUnconfirmedRefusal } from "../fixtures/destroy-refusals";

const ID = "acmeclient--pilot";
const REPO = "example-org/acmeclient";
const MIN = 60_000;
const CLEAN_IDLE = REAL_WEBSTUDIO_PANE.replace(/\n[^\n]*◯ frontend-developer[^\n]*/, "")
  .replace(" · 7 shells still running", "").replace(" · 7 shells", "")
  .replace("❯\u00a0check on task 2 progress", "❯\u00a0");
const HISTORY = [{
  number: 1, url: "", title: "t1", body: "", state: "completed", labels: [], assignee: null, milestone: null,
  open: false, updatedAt: new Date().toISOString(),
}];
let slowBoardMs = 0;
/** Per test: what POST /destroy and GET /status answer. null = the defaults. */
let destroyAnswer: (() => Response) | null = null;
let statusAnswer: (() => Response) | null = null;
/** Issue #1098 (--nudge): an open task on ID, the lead type on its row, and the assign answer. */
let openTasks: unknown[] | null = null;
let leadOverride: string | null = null;
let assignAnswer: (() => Response) | null = null;
const assigns: string[] = [];
/** The studio wake the nudge posts (review #1103: a wake, not a board assign). */
let wakeAnswer: (() => Response) | null = null;
const wakes: string[] = [];

function idleActivity(forMs: number) {
  const now = Date.now();
  return {
    state: "idle", since: new Date(now - forMs).toISOString(), anchored: true,
    observedAt: new Date(now).toISOString(), source: "pane", reason: null, membersTickingAt: null,
  };
}

function row(state: StudioStatus["state"] = "running"): StudioStatus {
  return {
    id: ID, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null, burn: null,
    spawnedBy: null, spawnTokenHash: null, repoSlug: REPO,
    ...(leadOverride ? { leadType: leadOverride } : {}),
    observed: { activity: idleActivity(45 * MIN), memberAlerts: null },
  } as unknown as StudioStatus;
}

const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      seen.push(`${req.method} ${u.pathname}${u.search}`);
      if (u.pathname === "/studio/") return Response.json([row()]);
      if (u.pathname === "/studio/board/tasks") {
        const body = openTasks ?? (u.searchParams.has("assignedTo") ? [] : HISTORY);
        if (slowBoardMs > 0) return Bun.sleep(slowBoardMs).then(() => Response.json(body));
        return Response.json(body);
      }
      if (u.pathname === `/studio/${ID}/wake` && req.method === "POST") {
        return req.text().then((body) => {
          wakes.push(body);
          return wakeAnswer ? wakeAnswer() : Response.json({ ok: true });
        });
      }
      if (u.pathname === "/studio/board/tasks/7/assign" && req.method === "POST") {
        return req.text().then((body) => {
          assigns.push(body);
          return assignAnswer ? assignAnswer() : Response.json({ number: 7, wake: { woke: true, digest: "WAKE TASK ASSIGNED #7" } });
        });
      }
      if (u.pathname === `/studio/${ID}/rescue`) return Response.json({ ok: true, pushes: [] });
      if (u.pathname === `/studio/${ID}/inspect`) {
        return Response.json({
          ok: true, checkoutExists: true, paneCommand: "claude", tail: CLEAN_IDLE,
          capturedAt: Math.floor(Date.now() / 1000), observed: { activity: idleActivity(45 * MIN) },
        });
      }
      if (u.pathname === `/studio/${ID}/destroy` && destroyAnswer) return destroyAnswer();
      if (u.pathname === `/studio/${ID}/destroy`) return Response.json(row("stopped"));
      if (u.pathname === `/studio/${ID}/status` && statusAnswer) return statusAnswer();
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0; slowBoardMs = 0; destroyAnswer = null; statusAnswer = null;
  openTasks = null; leadOverride = null; assignAnswer = null; assigns.length = 0;
  wakeAnswer = null; wakes.length = 0;
});

const NOT_UNDER_ORCA: OrcaDeps = {
  env: { TERM_PROGRAM: "Apple_Terminal" },
  hasBinary: () => "orca",
  registry: { get: () => undefined, set: async () => {} },
  log: () => {},
  run: async () => { throw new Error("no orca call expected"); },
  lock: (_id, fn) => fn(),
};

const creds = () => ({ workerUrl: server.url.toString(), accessClientId: "", accessClientSecret: "" });

test("reap --apply hits list, board (scoped), rescue, inspect, per-studio tasks, then a plain destroy", async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const lines: string[] = [];
  const out = await runReap(
    { apply: true, idleMs: 30 * MIN, repo: REPO },
    reapDeps(creds(), REPO, statePath, (l) => lines.push(l), NOT_UNDER_ORCA),
  );
  expect(out.exitCode).toBe(0);
  const repoQ = `repo=${encodeURIComponent(REPO)}`;
  expect(seen).toEqual([
    "GET /studio/",
    `GET /studio/board/tasks?${repoQ}`,
    `GET /studio/${ID}/inspect`,
    `POST /studio/${ID}/rescue`,
    `GET /studio/board/tasks?${repoQ}&assignedTo=${ID}`,
    `GET /studio/${ID}/inspect`,
    `POST /studio/${ID}/destroy`,
  ]);
  expect(lines.some((l) => l.startsWith(`REAPED ${ID}`))).toBe(true);
  expect(JSON.parse(readFileSync(statePath, "utf8")).boardRows[REPO]).toBe(1);
});

test("reap dry-run touches only the two reads", async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  await runReap({ apply: false, idleMs: 30 * MIN, repo: REPO }, reapDeps(creds(), REPO, statePath, () => {}, NOT_UNDER_ORCA));
  expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
});

test("fleet ls prints the IDLE line for a studio idle >= 10m", async () => {
  const out: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  try {
    await cmdLs(creds(), false, NOT_UNDER_ORCA);
  } finally {
    console.log = realLog;
  }
  expect(out.some((l) => l.startsWith("IDLE >= 10m") && l.includes(`${ID} IDLE 45m`))).toBe(true);
});

// Review F1: no reap read may hang. A board read slower than the budget
// aborts, and the poll reaps nothing.
test("a hung board read aborts at the read budget and reaps nothing", async () => {
  slowBoardMs = 3_000;
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const started = Date.now();
  const out = await runReap(
    { apply: true, idleMs: 30 * MIN, repo: REPO },
    reapDeps(creds(), REPO, statePath, () => {}, NOT_UNDER_ORCA, { readTimeoutMs: 200 }),
  );
  expect(out.exitCode).toBe(1);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(seen.some((s) => s.startsWith("POST "))).toBe(false);
});

// Issue #1117: a big repo's board listing can take 25-30 s. The default
// budget is 60 s, and every board read logs its elapsed ms, so slowness
// shows in the log before it ever fails.
test("issue #1117: a slow board read inside the budget succeeds and logs its elapsed ms", async () => {
  slowBoardMs = 400;
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const lines: string[] = [];
  const out = await runReap(
    { apply: false, idleMs: 30 * MIN, repo: REPO },
    reapDeps(creds(), REPO, statePath, (l) => lines.push(l), NOT_UNDER_ORCA, { readTimeoutMs: 2_000 }),
  );
  expect(out.exitCode).toBe(0);
  const timed = lines.filter((l) => /^fleet reap: board read \d+ ms$/.test(l));
  expect(timed.length).toBe(1);
  expect(Number(/(\d+) ms$/.exec(timed[0]!)![1])).toBeGreaterThanOrEqual(350);
});

test("issue #1117: a board read over a --read-timeout override aborts and still logs elapsed ms", async () => {
  slowBoardMs = 1_000;
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const lines: string[] = [];
  const out = await runReap(
    { apply: true, idleMs: 30 * MIN, repo: REPO },
    reapDeps(creds(), REPO, statePath, (l) => lines.push(l), NOT_UNDER_ORCA, { readTimeoutMs: 200 }),
  );
  expect(out.exitCode).toBe(1);
  expect(lines.some((l) => /^fleet reap: board read \d+ ms \(failed\)$/.test(l))).toBe(true);
  expect(seen.some((s) => s.startsWith("POST "))).toBe(false);
});

// Review F5: a state file that cannot be trusted is kept aside, never
// silently overwritten, and the poll reaps nothing (its floor is unknown).
for (const [name, content] of [["corrupt JSON", "{not json"], ["wrong types", JSON.stringify({ backoffUntil: 5, boardRows: { x: "y" } })]]) {
  test(`state file with ${name}: kept aside, reap nothing this poll`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "reap-"));
    const statePath = join(dir, "reap-state.json");
    writeFileSync(statePath, content);
    const out = await runReap({ apply: true, idleMs: 30 * MIN, repo: REPO }, reapDeps(creds(), REPO, statePath, () => {}, NOT_UNDER_ORCA));
    expect(out.exitCode).toBe(1);
    expect(seen.some((s) => s.startsWith("POST "))).toBe(false);
    const aside = readdirSync(dir).filter((f) => f.startsWith("reap-state.json.corrupt-"));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(content);
    expect(JSON.parse(readFileSync(statePath, "utf8")).boardRows[REPO]).toBe(1);
  });
}

// Maestro review of f8edce1: a run longer than the stale threshold must keep
// its lock fresh, or a second reap takes over mid-run.
test("a long run that refreshes its lock is never taken over; a truly stale lock is", async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const lock = `${statePath}.lock`;
  const old = (Date.now() - REAP_LOCK_STALE_MS - 60_000) / 1000;
  let release!: () => void;
  const first = withReapLock(statePath, async (refresh) => {
    utimesSync(lock, old, old); // the run has now lasted past the stale threshold
    await refresh(); // one candidate later
    await new Promise<void>((r) => { release = r; });
    return 0;
  });
  await Bun.sleep(20);
  await expect(withReapLock(statePath, async () => 0)).rejects.toThrow(/another fleet reap/);
  release();
  await first;
  // A crashed run's lock, never refreshed: taken over.
  writeFileSync(lock, "1 crashed\n");
  utimesSync(lock, old, old);
  expect(await withReapLock(statePath, async () => 9)).toBe(9);
});

test("a second reap on the same state file refuses while the first holds the lock", async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  let release!: () => void;
  const first = withReapLock(statePath, () => new Promise<number>((r) => { release = () => r(0); }));
  await Bun.sleep(10);
  await expect(withReapLock(statePath, async () => 0)).rejects.toThrow(/another fleet reap/);
  release();
  expect(await first).toBe(0);
  expect(existsSync(`${statePath}.lock`)).toBe(false);
  expect(await withReapLock(statePath, async () => 7)).toBe(7);
});

// #87 review: reapDeps().destroy composes requestDestroy + one status read +
// destroyRaceOutcome. A real Worker refusal on a studio still running with no
// other destroy in flight must stay a REFUSAL (back-off), never a race success.
describe("reapDeps().destroy composition — real 409s stay refused (#80/#86)", () => {
  const deps = (lines: string[]) => reapDeps(
    creds(), REPO, join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json"), (l) => lines.push(l), NOT_UNDER_ORCA,
  );
  const refusals: [string, string][] = [
    ["rescue unconfirmed", rescueUnconfirmedRefusal(ID, "rescue exec killed after 300s")],
    ["probe timeout", probeRefusal(ID)],
  ];
  for (const [name, body] of refusals) {
    test(`409 ${name}, row running, no destroy in flight -> refused, the 409 text logged and carried`, async () => {
      destroyAnswer = () => new Response(body, { status: 409 });
      statusAnswer = () => Response.json({ ...row("running"), destroyInFlight: false });
      const lines: string[] = [];
      const out = await deps(lines).destroy(ID);
      expect(out.outcome).toBe("refused");
      expect(out.outcome === "refused" && out.message).toContain("destroy refused");
      expect(lines.join("\n")).toContain("destroy refused");
      expect(seen).toContain(`GET /studio/${ID}/status`);
    });

    test(`409 ${name}, whole reap run -> backs off, never REAPED`, async () => {
      destroyAnswer = () => new Response(body, { status: 409 });
      statusAnswer = () => Response.json({ ...row("running"), destroyInFlight: false });
      const lines: string[] = [];
      await runReap({ apply: true, idleMs: 30 * MIN, repo: REPO }, deps(lines));
      expect(lines.some((l) => l.startsWith("REAPED"))).toBe(false);
      expect(lines.some((l) => l.includes("destroy refused") && l.includes("backing off"))).toBe(true);
    });
  }

  test("409, status read fails -> still refused (an unread row is never a race)", async () => {
    destroyAnswer = () => new Response(refusals[1][1], { status: 409 });
    statusAnswer = () => new Response("boom", { status: 500 });
    expect((await deps([]).destroy(ID)).outcome).toBe("refused");
  });

  test("409, row now stopped -> already-stopped", async () => {
    destroyAnswer = () => new Response(refusals[1][1], { status: 409 });
    statusAnswer = () => Response.json(row("stopped"));
    expect((await deps([]).destroy(ID)).outcome).toBe("already-stopped");
  });

  test("409, row running with a destroy in flight -> in-progress, the 409 text not logged", async () => {
    destroyAnswer = () => new Response(refusals[1][1], { status: 409 });
    statusAnswer = () => Response.json({ ...row("running"), destroyInFlight: true });
    const lines: string[] = [];
    expect((await deps(lines).destroy(ID)).outcome).toBe("in-progress");
    expect(lines.join("\n")).not.toContain("destroy refused");
  });
});

// Issue #1098: `fleet reap --nudge` wakes an OSS lead idle on an open task
// through the SAME Worker call `fleet task assign` makes (POST .../assign).
const LEAD_TASK = {
  number: 7, url: "", title: "t7", body: "", state: "working", labels: [`studio:${ID}`], assignee: ID,
  milestone: null, open: true, updatedAt: new Date().toISOString(),
};
function openLeadTask(answer: (() => Response) | null = null) {
  openTasks = [LEAD_TASK];
  leadOverride = "glm";
  wakeAnswer = answer;
}
const NUDGE_FLAGS = { apply: true, idleMs: 30 * MIN, repo: REPO, nudge: true };

test("--nudge apply: an OSS lead idle on an open task gets the assign call, and nothing is destroyed", async () => {
  openLeadTask();
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const lines: string[] = [];
  const out = await runReap(NUDGE_FLAGS, reapDeps(creds(), REPO, statePath, (l) => lines.push(l), NOT_UNDER_ORCA));
  expect(out.exitCode).toBe(0);
  expect(seen).toContain(`POST /studio/${ID}/wake`);
  expect(seen.some((s) => s.includes("/assign") || s.includes("/destroy") || s.includes("/rescue"))).toBe(false);
  expect(JSON.parse(wakes[0]!)).toEqual({ prompt: "continue task #7; check your todo list" });
  expect(lines.some((l) => l.startsWith(`NUDGED ${ID}`) && l.includes("#7"))).toBe(true);
});

test("--nudge: the cooldown survives the state file, so a second poll inside 15m wakes nothing", async () => {
  openLeadTask();
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  await runReap(NUDGE_FLAGS, reapDeps(creds(), REPO, statePath, () => {}, NOT_UNDER_ORCA));
  await runReap(NUDGE_FLAGS, reapDeps(creds(), REPO, statePath, () => {}, NOT_UNDER_ORCA));
  expect(wakes.length).toBe(1);
  expect(JSON.parse(readFileSync(statePath, "utf8")).taskNudges[`${REPO}#7`]).toHaveLength(1);
});

test("--nudge: a refusal from the Worker is logged with its reason", async () => {
  openLeadTask(() => Response.json({ ok: false, skipped: true, error: "studio is stopped" }));
  const statePath = join(mkdtempSync(join(tmpdir(), "reap-")), "reap-state.json");
  const lines: string[] = [];
  await runReap(NUDGE_FLAGS, reapDeps(creds(), REPO, statePath, (l) => lines.push(l), NOT_UNDER_ORCA));
  expect(lines.some((l) => l.startsWith(`NUDGE FAILED ${ID}`) && l.includes("studio is stopped"))).toBe(true);
});
