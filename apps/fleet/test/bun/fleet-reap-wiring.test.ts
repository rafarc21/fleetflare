// Issue #53: the REAL wiring of `fleet reap` (cli/fleet.ts's reapDeps) and
// the `fleet ls` idle line, against a fake Worker on localhost. Proves what
// the pure-core suite (fleet-reap.test.ts) cannot: which routes are hit, and
// that the destroy never carries force or discard-unsynced. No real fleet.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdLs, reapDeps } from "../../cli/fleet";
import { runReap } from "../../cli/reap";
import type { OrcaDeps } from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";
import { REAL_WEBSTUDIO_PANE } from "../fixtures/rate-limit-panes";

const ID = "acmeclient--pilot";
const REPO = "example-org/acmeclient";
const MIN = 60_000;
const CLEAN_IDLE = REAL_WEBSTUDIO_PANE.replace(/\n[^\n]*◯ frontend-developer[^\n]*/, "")
  .replace(" · 7 shells still running", "").replace(" · 7 shells", "");

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
      if (u.pathname === "/studio/board/tasks") return Response.json([]);
      if (u.pathname === `/studio/${ID}/rescue`) return Response.json({ ok: true, pushes: [] });
      if (u.pathname === `/studio/${ID}/inspect`) {
        return Response.json({
          ok: true, checkoutExists: true, paneCommand: "claude", tail: CLEAN_IDLE,
          capturedAt: Math.floor(Date.now() / 1000), observed: { activity: idleActivity(45 * MIN) },
        });
      }
      if (u.pathname === `/studio/${ID}/destroy`) return Response.json(row("stopped"));
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => { seen.length = 0; });

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
    `POST /studio/${ID}/rescue`,
    `GET /studio/${ID}/inspect`,
    `GET /studio/board/tasks?${repoQ}&assignedTo=${ID}`,
    `POST /studio/${ID}/destroy`,
  ]);
  expect(lines.some((l) => l.startsWith(`REAPED ${ID}`))).toBe(true);
  expect(JSON.parse(readFileSync(statePath, "utf8")).boardRows[REPO]).toBe(0);
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
