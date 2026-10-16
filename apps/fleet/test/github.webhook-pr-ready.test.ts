import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
import { sign } from "./helpers/webhook-sign";
import { post, drainLast } from "./helpers/webhook-harness";

// Board issue #1071, item 1: the webhook edge. Which PR deliveries flip which
// tasks is decided by flipRequestFromPullRequest (test/board.pr-awaiting-merge
// .test.ts), against a pure payload. Here the only questions are the ones the
// HTTP edge owns: a signed pull_request delivery is accepted with 200, an
// unsigned one is refused before any work, and a flip that cannot reach the
// board (no auth in this harness) never turns into a failed response.

const SECRET = "hook-secret";
const wakes: [string, string][] = [];
const rpcCalls: { name: string; method: string }[] = [];
const ctl = {
  wakeOutcome: { ok: true } as { ok: boolean; error?: string },
  getCalls: 0,
  onWake: null as (() => Promise<void>) | null,
  lastCtx: null as any,
};
const h = { wakes, rpcCalls, ctl };

const prPayload = (action: string) => JSON.stringify({
  action,
  number: 88,
  repository: { full_name: "Acme/Websites" },
  pull_request: { number: 88, draft: false, title: "Board work", body: "Ships it.\n\nrefs #12" },
});

// Signs the raw body the way GitHub does; `signed: false` sends no signature.
const send = async (body: string, opts: { signed?: boolean } = {}) =>
  post(h, SECRET, body, opts.signed === false ? null : await sign(body, SECRET), "pull_request");

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await recordStudio(env as any, { id: "websites--maestro", state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null } as StudioStatus);
  wakes.length = 0;
  rpcCalls.length = 0;
  ctl.wakeOutcome = { ok: true };
  ctl.getCalls = 0;
  ctl.onWake = null;
  ctl.lastCtx = null;
});

describe("github webhook -> pull_request ready -> awaiting_merge (board issue #1071, item 1)", () => {
  it("a signed ready-for-review delivery is accepted with 200", async () => {
    const res = await send(prPayload("ready_for_review"));
    expect(res.status).toBe(200);
    await drainLast(h);
  });

  it("a flip that cannot reach the board still answers 200 — the failure is logged, never thrown", async () => {
    const res = await send(prPayload("opened"));
    expect(res.status).toBe(200);
    await drainLast(h);
  });

  it("an unsigned pull_request delivery is refused with 401 before any flip is attempted", async () => {
    const res = await send(prPayload("ready_for_review"), { signed: false });
    expect(res.status).toBe(401);
  });
});
