// apps/fleet/test/junior.authz.test.ts
//
// PR #9 review, blocker B1: the maestro's per-task junior authorization must
// live somewhere a studio's own GitHub token can never write — see
// src/junior/authz.ts's own header for the full argument. This file proves
// the D1-backed record directly, isolated from the board/route wiring that
// test/junior.route.test.ts exercises end to end.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  recordJuniorAuthorization, isJuniorAuthorized, revokeJuniorAuthorization, sweepJuniorAuthorizations, JUNIOR_SWEEP_PAGE,
} from "../src/junior/authz";
import { GitHubError } from "../src/board/api";
import type { BoardTask } from "../src/board/types";

const REPO = "acme-org/websites";
const STUDIO = "websites--web-studio";
const OTHER = "websites--release-studio";

describe("junior authz (D1-backed, not a GitHub label)", () => {
  it("unauthorized when no record exists", async () => {
    expect(await isJuniorAuthorized(env.DB, REPO, 1, STUDIO)).toBe(false);
  });

  it("authorized once recorded for the exact repo/task/studio", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, REPO, 42, STUDIO)).toBe(true);
  });

  it("does not authorize a different studio for the same task", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, REPO, 42, OTHER)).toBe(false);
  });

  it("does not authorize the same studio for a different task number", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, REPO, 43, STUDIO)).toBe(false);
  });

  it("does not authorize the same task number in a different repo", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, "acme-org/other", 42, STUDIO)).toBe(false);
  });

  it("#10: revoked records stop authorizing; other tasks keep theirs", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    await recordJuniorAuthorization(env.DB, REPO, 43, STUDIO, 1000);
    await revokeJuniorAuthorization(env.DB, REPO, 42);
    expect(await isJuniorAuthorized(env.DB, REPO, 42, STUDIO)).toBe(false);
    expect(await isJuniorAuthorized(env.DB, REPO, 43, STUDIO)).toBe(true);
  });

  it("survives a hand-written record that is not valid JSON — fails closed, never throws", async () => {
    await env.DB.prepare(
      `INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`,
    ).bind(`junior-auth:${REPO}:99`, "{not json", 1000).run();
    expect(await isJuniorAuthorized(env.DB, REPO, 99, STUDIO)).toBe(false);
  });
});

// Issue #35: records written before #25 deployed may belong to tasks already
// terminal/closed. One sweep per repo deletes exactly those; dry-run default.
describe("sweepJuniorAuthorizations (issue #35)", () => {
  function t(number: number, o: Partial<BoardTask> = {}): BoardTask {
    return { number, url: "", title: "", body: "", state: "working", labels: [], assignee: STUDIO, milestone: null,
      open: true, updatedAt: "", ...o };
  }
  const tasks: Record<number, BoardTask | Error> = {
    1: t(1),
    2: t(2, { state: "completed" }),
    3: t(3, { open: false }),
    4: t(4, { reopened: true }),
    5: new GitHubError(404, "Not Found"),
    6: new Error("github 502"),
    7: t(7, { state: null }),
  };
  const getTask = async (repo: string, n: number) => {
    expect(repo).toBe(REPO);
    const v = tasks[n];
    if (v instanceof Error) throw v;
    return v;
  };
  async function seedAll() {
    await env.DB.prepare("DELETE FROM fleet_state").run();
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await recordJuniorAuthorization(env.DB, REPO, n, STUDIO, 1000);
    await recordJuniorAuthorization(env.DB, "acme-org/other", 2, STUDIO, 1000);
  }

  it("dry-run: reports, deletes nothing", async () => {
    await seedAll();
    const { results: r, next } = await sweepJuniorAuthorizations(env.DB, REPO, getTask, false);
    expect(next).toBeNull();
    expect(r.map((x) => [x.number, x.outcome])).toEqual([
      [1, "kept"], [2, "would-revoke"], [3, "would-revoke"], [4, "would-revoke"], [5, "would-revoke"], [6, "error"], [7, "kept"],
    ]);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(await isJuniorAuthorized(env.DB, REPO, n, STUDIO)).toBe(true);
  });

  it("apply: deletes terminal/closed/reopened/gone only; idempotent; other repo untouched", async () => {
    await seedAll();
    const { results: r } = await sweepJuniorAuthorizations(env.DB, REPO, getTask, true);
    expect(r.filter((x) => x.outcome === "revoked").map((x) => x.number)).toEqual([2, 3, 4, 5]);
    expect(r.find((x) => x.number === 6)!.reason).toContain("github 502");
    for (const n of [1, 6, 7]) expect(await isJuniorAuthorized(env.DB, REPO, n, STUDIO)).toBe(true);
    for (const n of [2, 3, 4, 5]) expect(await isJuniorAuthorized(env.DB, REPO, n, STUDIO)).toBe(false);
    expect(await isJuniorAuthorized(env.DB, "acme-org/other", 2, STUDIO)).toBe(true);
    const { results: again } = await sweepJuniorAuthorizations(env.DB, REPO, getTask, true);
    expect(again.map((x) => x.number)).toEqual([1, 6, 7]);
    expect(again.some((x) => x.outcome === "revoked")).toBe(false);
  });

  // Issue #41: one GitHub read per record. A big backlog must not blow the
  // Worker's per-request subrequest limit: a page, then a cursor to resume.
  it("pages: at most `limit` reads per call, `next` resumes, null when done", async () => {
    await seedAll();
    const reads: number[] = [];
    const counted = async (r: string, n: number) => { reads.push(n); return getTask(r, n); };
    const a = await sweepJuniorAuthorizations(env.DB, REPO, counted, false, { limit: 3 });
    expect(a.results.map((x) => x.number)).toEqual([1, 2, 3]);
    expect(a.next).toBe(3);
    const b = await sweepJuniorAuthorizations(env.DB, REPO, counted, false, { limit: 3, after: a.next! });
    expect(b.results.map((x) => x.number)).toEqual([4, 5, 6]);
    const c = await sweepJuniorAuthorizations(env.DB, REPO, counted, false, { limit: 3, after: b.next! });
    expect(c.results.map((x) => x.number)).toEqual([7]);
    expect(c.next).toBeNull();
    expect(reads).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("a page that lands exactly on the last record says so (next null)", async () => {
    await seedAll();
    const r = await sweepJuniorAuthorizations(env.DB, REPO, getTask, false, { limit: 7 });
    expect(r.results).toHaveLength(7);
    expect(r.next).toBeNull();
  });

  it("uncapped call is capped by default at JUNIOR_SWEEP_PAGE reads", async () => {
    await env.DB.prepare("DELETE FROM fleet_state").run();
    for (let n = 1; n <= JUNIOR_SWEEP_PAGE + 5; n++) await recordJuniorAuthorization(env.DB, REPO, n, STUDIO, 1000);
    let reads = 0;
    const r = await sweepJuniorAuthorizations(env.DB, REPO, async (_r, n) => { reads++; return t(n); }, false);
    expect(reads).toBe(JUNIOR_SWEEP_PAGE);
    expect(r.next).toBe(JUNIOR_SWEEP_PAGE);
  });
});

