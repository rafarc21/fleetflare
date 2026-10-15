import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleGithubWebhook, verifySignature } from "../src/github/webhook";
import { createApproval, decideApproval, finishApproval } from "../src/approvals/store";
import { readSince } from "../src/events/log";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
import { fakeCtx } from "./helpers/fake-ctx";
import { sign } from "./helpers/webhook-sign";
import { post, drainLast } from "./helpers/webhook-harness";

const SECRET = "hook-secret";
let sent: { body: any }[] = [];
let realFetch: typeof globalThis.fetch;

const push = (ref: string) => JSON.stringify({
  ref, after: "deadbeefcafe",
  repository: { full_name: "acme-org/websites" },
  sender: { login: "example-bot[bot]" },
});

// Sweep 43 F2 (refs #850): envWithStudio/post/drainLast now live in
// helpers/webhook-harness.ts; the counters they record into are this
// suite's own state below (arrays reset in place, ctl reassigned member by
// member in beforeEach) — snapshot-safe for the harness.
const wakes: [string, string][] = [];
const rpcCalls: { name: string; method: string }[] = [];
const ctl = {
  wakeOutcome: { ok: true } as { ok: boolean; error?: string },
  getCalls: 0,
  onWake: null as (() => Promise<void>) | null,
  lastCtx: null as ReturnType<typeof fakeCtx> | null,
};
const h = { wakes, rpcCalls, ctl };
const send = (body: string, sig: string | null, event?: string) => post(h, SECRET, body, sig, event);

// fakeCtx: shared queue-drain fake — helpers/fake-ctx.ts (sweep 33 F2, #746); webhook variant passes swallow:false so a rejecting queued task stays observable through drain().

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM approvals").run();
  await env.DB.prepare("DELETE FROM events").run();
  // Board issue #100 F5: the webhook asks the registry before minting a DO,
  // so every maestro this file expects to wake has a row.
  await env.DB.prepare("DELETE FROM fleet_state").run();
  for (const id of ["websites--maestro", "demosite-life--maestro"]) {
    await recordStudio(env as any, { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null } as StudioStatus);
  }
  sent = [];
  wakes.length = 0;
  rpcCalls.length = 0;
  ctl.wakeOutcome = { ok: true };
  ctl.getCalls = 0;
  ctl.onWake = null;
  ctl.lastCtx = null;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_i: any, init: any) => {
    sent.push({ body: JSON.parse(init.body as string) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe("github webhook", () => {
  it("rejects a body signed with the wrong secret", async () => {
    const body = push("refs/heads/staging");
    // Brief's original corruption technique (`s.replace(/.$/, "0")`) is a
    // no-op whenever the real signature's last hex digit already IS "0" —
    // deterministic for this fixed secret+body, not flaky: the real
    // signature for ("hook-secret", this exact push body) genuinely ends in
    // "0", so that version signed a byte-identical string and failed
    // against a correct implementation. Flipping to whichever digit the
    // last character is NOT guarantees an actual mismatch regardless of
    // what that character happens to be.
    const bad = await sign(body, SECRET).then((s) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0"));
    expect((await send(body, bad)).status).toBe(401);
    expect(sent).toEqual([]);
    // The security requirement names three things a failed verification
    // must not do: "no event, no alert, no D1 write". sent===[] above only
    // covers the Telegram alert; this independently covers the event.
    expect(await readSince(env.DB, "human", 0)).toEqual([]);
  });

  it("rejects an unsigned body", async () => {
    const body = push("refs/heads/staging");
    expect((await send(body, null)).status).toBe(401);
    expect(sent).toEqual([]);
    expect(await readSince(env.DB, "human", 0)).toEqual([]);
  });

  it("ignores a push to a feature branch", async () => {
    const body = push("refs/heads/some-feature");
    expect((await send(body, await sign(body, SECRET))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  // Not in the brief. Added because src/github/webhook.ts's JSON.parse(body)
  // is unguarded past the signature gate — the same class of defect
  // telegram/webhook.ts's own comment names explicitly ("Everything past
  // the secret gate returns 200, and that has to include failures to
  // parse. An uncaught throw here surfaces as a runtime 500..."). A
  // corrupted-in-transit delivery, or a replay by whoever holds a leaked
  // secret, must not crash the handler.
  it("returns 200 without crashing on a validly signed body that is not JSON", async () => {
    const body = "not json at all";
    const res = await send(body, await sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  // Issue #519 (sweep 13): wakeMaestro's JSON.parse(body) catch used to drop
  // an unparseable payload with no trace at all. The swallow itself stays --
  // GitHub retries a non-2xx delivery, and a body that isn't JSON is not
  // something a retry fixes -- but one console.warn must name the skip, so a
  // corrupted-in-transit delivery is distinguishable from a silently dead
  // webhook in the tail. Event "issues" here, deliberately: the push path
  // never reaches wakeMaestro at all, and "issues" exercises the revoke
  // paths whose OWN parse failures log as console.error (not warn), leaving
  // the warn count attributable to wakeMaestro alone.
  it("logs one console.warn on a validly signed non-JSON body — still 200, still zero wakes (#519)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = "not json at all";
      const res = await send(body, await sign(body, SECRET), "issues");
      expect(res.status).toBe(200);
      expect(wakes).toEqual([]);
      expect(warns).toHaveBeenCalledTimes(1);
      expect(warns.mock.calls[0].join(" ")).toContain("not JSON");
      await drainLast(h);
      expect(wakes).toEqual([]);
    } finally {
      warns.mockRestore();
      errors.mockRestore();
    }
  });

  it("returns 200 without crashing on a validly signed JSON body of literal null", async () => {
    const body = "null";
    const res = await send(body, await sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("alerts on a write to staging with no approved gate", async () => {
    const body = push("refs/heads/staging");
    await send(body, await sign(body, SECRET));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toMatch(/UNAPPROVED WRITE/);
    expect(sent[0].body.text).toMatch(/example-bot\[bot\]/);
    expect(sent[0].body.text).toMatch(/deadbeef/);
  });

  it("stays silent when an executed approval covers the window", async () => {
    await createApproval(env.DB, {
      id: "appr_1", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 4_990_000);
    await finishApproval(env.DB, "appr_1", "executed", "merged");
    const body = push("refs/heads/staging");
    expect((await send(body, await sign(body, SECRET))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  // Fix round 1, promoted Minor: handleCallbackQuery (src/approvals/gates.ts)
  // writes "executed" only AFTER the real GitHub merge, and swallows that
  // write's own failure into a console.error. So a genuinely approved merge
  // can reach this webhook while its row is still "approved" — either
  // because the push delivery raced ahead of the terminal D1 write, or
  // because that write failed outright and the row is stuck. Deliberately
  // never calls finishApproval here to simulate exactly that.
  it("stays silent when an approved-but-not-yet-executed approval covers the window", async () => {
    await createApproval(env.DB, {
      id: "appr_5", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 4_990_000);
    await decideApproval(env.DB, "appr_5", "approved", "100000001", 4_990_500);
    const body = push("refs/heads/staging");
    expect((await send(body, await sign(body, SECRET))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("still alerts when the only approval in the window was rejected", async () => {
    await createApproval(env.DB, {
      id: "appr_2", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 4_990_000);
    await finishApproval(env.DB, "appr_2", "failed", "rejected by operator");
    const body = push("refs/heads/staging");
    await send(body, await sign(body, SECRET));
    expect(sent).toHaveLength(1);
  });

  it("alerts when the matching approval is older than the window", async () => {
    await createApproval(env.DB, {
      id: "appr_3", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 1_000_000);
    await finishApproval(env.DB, "appr_3", "executed", "merged");
    const body = push("refs/heads/staging");
    await send(body, await sign(body, SECRET));
    expect(sent).toHaveLength(1);
  });
});

// Fix round 1, Important: WebCrypto's importKey throws a DataError on a
// zero-length HMAC key. An unset GITHUB_WEBHOOK_SECRET binding reads as
// undefined, and TextEncoder.encode(undefined) yields 0 bytes — same as an
// explicit "" — so both used to throw here uncaught, all the way out of
// handleGithubWebhook and index.ts's fetch. Direct tests on the exported
// function itself, independent of the handler-level guard below.
describe("verifySignature — misconfigured secret", () => {
  it("resolves false, does not throw, for an unset secret", async () => {
    await expect(
      verifySignature(undefined as unknown as string, "body", "sha256=whatever"),
    ).resolves.toBe(false);
  });

  it("resolves false, does not throw, for an empty-string secret", async () => {
    await expect(verifySignature("", "body", "sha256=whatever")).resolves.toBe(false);
  });
});

// Handler-level: proves the whole request path returns a defined response
// (not a throw) and, per the review's recommendation, a status
// DISTINGUISHABLE from an ordinary bad signature — 503, not 401 — so
// "the alarm is dead" doesn't read identically to "someone sent a bad
// signature" in GitHub's delivery log.
describe("github webhook — misconfigured GITHUB_WEBHOOK_SECRET", () => {
  it("returns 503, not a throw, when the secret is unset", async () => {
    const body = push("refs/heads/staging");
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=whatever" },
        body,
      }),
      env, // GITHUB_WEBHOOK_SECRET is not in vitest.config.ts's shared bindings
      () => 5_000_000,
      fakeCtx({ swallow: false }),
    );
    expect(res.status).toBe(503);
    expect(sent).toEqual([]);
    expect(await readSince(env.DB, "human", 0)).toEqual([]);
  });

  it("returns 503, not a throw, when the secret is an empty string", async () => {
    const body = push("refs/heads/staging");
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=whatever" },
        body,
      }),
      { ...env, GITHUB_WEBHOOK_SECRET: "" },
      () => 5_000_000,
      fakeCtx({ swallow: false }),
    );
    expect(res.status).toBe(503);
    expect(sent).toEqual([]);
    expect(await readSince(env.DB, "human", 0)).toEqual([]);
  });
});

/**
 * The waker's webhook branch. Everything past the signature gate still
 * returns 200 -- existing contract, unchanged.
 */
describe("github webhook -> maestro wake", () => {
  const issueComment = JSON.stringify({
    action: "created",
    repository: { full_name: "acme-org/websites" },
    issue: { number: 131, title: "fleet task state verb", state: "open" },
    comment: { user: { login: "rafarc21" }, body: "ENVELOPE\nstate: done" },
  });

  it("wakes THIS repo's maestro with the delta digest", async () => {
    const res = await send(issueComment, await sign(issueComment, SECRET), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes).toEqual([[
      "websites--maestro",
      'WAKE EVENT(issue_comment.created) acme-org/websites #131 "fleet task state verb" by rafarc21: ENVELOPE state: done',
    ]]);
  });

  // Board #40, end to end: the name handed to idFromName is the whole bug.
  // An unfolded `demosite.life--maestro` is a name nothing else uses, so
  // idFromName mints a fresh empty DO and the wake lands on a phantom.
  it("wakes the FOLDED id for a dotted repo, the one fleet spawn created", async () => {
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "demositeltda/demosite.life" },
      issue: { number: 7, title: "board task", state: "open" },
      comment: { user: { login: "rafarc21" }, body: "go" },
    });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.map(([id]) => id)).toEqual(["demosite-life--maestro"]);
  });

  it("does not wake at all when the repo name folds to no valid segment", async () => {
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "o/-lead" },
      issue: { number: 7, title: "board task", state: "open" },
      comment: { user: { login: "rafarc21" }, body: "go" },
    });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  it("never wakes on an unsigned delivery", async () => {
    const res = await send(issueComment, "sha256=" + "0".repeat(64), "issue_comment");
    expect(res.status).toBe(401);
    expect(wakes).toEqual([]);
  });

  it("still returns 200 when the wake itself fails", async () => {
    ctl.wakeOutcome = { ok: false, error: "wake failed (1): can't find window: studio:claude" };
    const res = await send(issueComment, await sign(issueComment, SECRET), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes.length).toBe(1);
  });

  // Board issue #100 F5: `idFromName` on a name nothing uses mints an empty
  // Durable Object, once per GitHub event. The board path asks D1 first;
  // the webhook now does too.
  it("never touches a Durable Object for a repo with no maestro in the registry", async () => {
    await env.DB.prepare("DELETE FROM fleet_state").run();
    const res = await send(issueComment, await sign(issueComment, SECRET), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  // Board issue #100 F5: a stopped maestro's refusal is the gate WORKING, not
  // a failure — one console.error per GitHub event buried real errors.
  it("logs a deliberate skip (stopped maestro) at info level, never as an error", async () => {
    ctl.wakeOutcome = { ok: false, skipped: true, error: "refused: this studio is stopped" } as typeof ctl.wakeOutcome;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await send(issueComment, await sign(issueComment, SECRET), "issue_comment");
    expect(res.status).toBe(200);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("stopped");
    expect(infos.mock.calls.flat().join(" ")).toContain("stopped");
    errors.mockRestore();
    infos.mockRestore();
  });

  it("ignores an event nobody asked to be woken for", async () => {
    const body = JSON.stringify({ action: "created", repository: { full_name: "acme-org/websites" } });
    const res = await send(body, await sign(body, SECRET), "star");
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  it("leaves the push path alone -- a push wakes nobody", async () => {
    const body = push("refs/heads/main");
    const res = await send(body, await sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
    // ...and the UNAPPROVED WRITE alarm still fired, so the branch above did
    // not swallow push on its way past.
    expect(sent.length).toBe(1);
  });
});

/**
 * Board issue #236: an `issue_comment` delivery also wakes the commented-on
 * TASK'S OWN assignee (resolved from the issue's own `studio:` label), as an
 * ADDITIONAL, targeted wake alongside the maestro's own generic supervision
 * wake proven above -- the two are independent and this suite only asserts
 * on the assignee's own entries in `wakes` (distinguishable by studio id;
 * the maestro's id is always `<repo>--maestro`, never a bare `studio:` value).
 */
describe("github webhook -> comment wakes the task's OWN assignee, never another studio under the same label", () => {
  const ASSIGNEE = "websites--web-studio";
  const COMMENT_URL = "https://github.com/acme-org/websites/issues/231#issuecomment-1";

  async function setAssigneeState(state: "running" | "stopped") {
    await recordStudio(env as any, {
      id: ASSIGNEE, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    } as StudioStatus);
  }

  function commentPayload(opts: {
    boardState?: string; extraBoardState?: string; body?: string; login?: string; number?: number;
    title?: string; commentUrl?: string; action?: string; noAssignee?: boolean; assignees?: string[];
  } = {}) {
    const labels: { name: string }[] = [];
    if (opts.boardState) labels.push({ name: opts.boardState });
    if (opts.extraBoardState) labels.push({ name: opts.extraBoardState });
    if (!opts.noAssignee) {
      const assignees = opts.assignees ?? [ASSIGNEE];
      for (const a of assignees) labels.push({ name: `studio:${a}` });
    }
    return JSON.stringify({
      action: opts.action ?? "created",
      repository: { full_name: "acme-org/websites" },
      issue: { number: opts.number ?? 231, title: opts.title ?? "unblock me", state: "open", labels },
      comment: {
        user: { login: opts.login ?? "rafarc21" },
        body: opts.body ?? "here's the answer you asked for",
        html_url: opts.commentUrl ?? COMMENT_URL,
      },
    });
  }

  // A minimal, but genuinely valid, §6 envelope comment -- shaped exactly to
  // what parseEnvelopeComment (src/board/envelope.ts) requires: a fenced
  // ```json block, decoding to an object carrying envelope.msg_id (string),
  // envelope.task_id (number), a truthy payload, and a string notes field.
  const envelopeCommentBody =
    "status update\n```json\n" +
    JSON.stringify({ envelope: { msg_id: "m1", task_id: 231 }, payload: { status: "done" }, notes: "" }) +
    "\n```";

  beforeEach(async () => {
    await setAssigneeState("running");
  });

  it("wakes the task's own assignee -- not the maestro -- on a genuine input_required comment", async () => {
    const body = commentPayload({ boardState: "input_required" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
    expect(assigneeWakes.length).toBe(1);
    expect(assigneeWakes[0][1]).toContain("#231");
    // Round 3 (review verdict: HOLD on MUST 1): the digest APPENDS the
    // read-pointer onto the comment-URL digest, it does not replace the URL
    // with the pointer -- issue #236's own spec says the wake must name
    // "the task and the comment URL". The URL says WHICH comment is new;
    // the trailing pointer sends the lead to read the WHOLE thread via
    // `fleet task show N`, covering the case where a burst of comments got
    // an earlier one's own wake dropped (single-flight refusal, see the
    // design doc's corrected single-flight section).
    expect(assigneeWakes[0][1]).toContain(COMMENT_URL);
    expect(assigneeWakes[0][1]).toContain("| read: fleet task show 231");
    // Board #111: `ASSIGNEE` (websites--web-studio) is NOT this repo's own
    // maestro, so the task is a DIFFERENT lane's business -- the maestro's
    // own generic supervision wake now correctly stays silent here; only
    // the targeted assignee wake above fires. (Before #111, the maestro
    // wake fired unconditionally for every event regardless of who the
    // task was assigned to -- that was the exact duplicate-wake noise #111
    // was filed to remove; see board #70 ask 7's own "other lanes'
    // comments" complaint.)
    expect(wakes.some(([id]) => id === "websites--maestro")).toBe(false);
  });

  it("never wakes on the studio's own envelope comment, even on an input_required task", async () => {
    const body = commentPayload({ boardState: "input_required", body: envelopeCommentBody });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  // Round 3 mutant pin (M12): the envelope exclusion must beat an explicit
  // `/wake` marker, not the other way round -- `qualifiesForCommentWake`'s
  // own doc comment already claims this precedence is ABSOLUTE (step 1 runs
  // before step 2), but nothing proved it: a comment can carry a `/wake`
  // marker on its first line and still decode as a genuinely valid §6
  // envelope in the body that follows.
  it("mutant pin (M12): an explicit /wake marker on a genuine envelope comment still never wakes -- envelope exclusion beats the marker", async () => {
    const envelopeWithWakeMarkerBody =
      "/wake\n```json\n" +
      JSON.stringify({ envelope: { msg_id: "m2", task_id: 231 }, payload: { status: "done" }, notes: "" }) +
      "\n```";
    const body = commentPayload({ boardState: "working", body: envelopeWithWakeMarkerBody });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("never wakes on a comment authored by a [bot] login, even on an input_required task", async () => {
    const body = commentPayload({ boardState: "input_required", login: "example-bot[bot]" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("does not wake a non-input_required task on a plain comment with no explicit marker", async () => {
    const body = commentPayload({ boardState: "working" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("wakes a RUNNING studio on a comment starting with the explicit /wake marker, for a non-input_required task", async () => {
    const body = commentPayload({ boardState: "working", body: "/wake please take another look" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
    expect(assigneeWakes.length).toBe(1);
    expect(assigneeWakes[0][1]).toContain("#231");
  });

  it("an explicit /wake marker beats the [bot] exclusion -- the cloud maestro's own marker must wake", async () => {
    const body = commentPayload({ boardState: "working", login: "example-bot[bot]", body: "/wake answer" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
    expect(assigneeWakes.length).toBe(1);
  });

  it("does not wake a STOPPED studio even with the explicit marker", async () => {
    await setAssigneeState("stopped");
    const body = commentPayload({ boardState: "working", body: "/wake please take another look" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("design decision: two genuinely new input_required comments in a row BOTH wake -- no dedup suppresses the second", async () => {
    const first = commentPayload({ boardState: "input_required", body: "try again with the new token", commentUrl: `${COMMENT_URL}` });
    const second = commentPayload({
      boardState: "input_required", body: "actually here's the real fix", commentUrl: `${COMMENT_URL}-2`,
    });
    await send(first, await sign(first, SECRET), "issue_comment");
    await drainLast(h);
    await send(second, await sign(second, SECRET), "issue_comment");
    await drainLast(h);
    const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
    // Both wakes fire -- no dedup suppresses the second. Round 3: each
    // digest carries its OWN comment's URL (identifying which comment is
    // new) plus the shared `fleet task show N` pointer (covering the whole
    // thread) -- the two wakes are distinguishable by their own comment URL.
    expect(assigneeWakes.length).toBe(2);
    expect(assigneeWakes[0][1]).toContain(COMMENT_URL);
    expect(assigneeWakes[0][1]).not.toContain(`${COMMENT_URL}-2`);
    expect(assigneeWakes[0][1]).toContain("| read: fleet task show 231");
    expect(assigneeWakes[1][1]).toContain(`${COMMENT_URL}-2`);
    expect(assigneeWakes[1][1]).toContain("| read: fleet task show 231");
  });

  it("does not wake at all when the task has no single studio assignee (backlog)", async () => {
    const body = commentPayload({ boardState: "input_required", noAssignee: true });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id !== "websites--maestro")).toEqual([]);
  });

  // Issue #284 round 2: comment-wake previously did NO repo-slug validation
  // at all -- a stale, hand-edited, or legacy cross-repo `studio:` label
  // could wake the wrong studio via a comment trigger indefinitely. These two
  // prove the fix threaded all the way through the real webhook handler
  // (github/webhook.ts's `wakeTaskOnComment` -> board/comment-wake.ts's
  // `wakeOnComment`), not just at the pure-unit level (see
  // test/board.comment-wake.test.ts for that).
  describe("comment wake: the assignee's recorded repo must match the comment's own repo", () => {
    it("refuses to wake the task's own assignee when it is provisioned for a DIFFERENT repo than the comment's own", async () => {
      await recordStudio(env as any, {
        id: ASSIGNEE, state: "running", repoSlug: "other-org/other-repo",
        tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      } as StudioStatus);
      const body = commentPayload({ boardState: "input_required" });
      const res = await send(body, await sign(body, SECRET), "issue_comment");
      await drainLast(h);
      expect(res.status).toBe(200); // GitHub's delivery is still accepted -- the refusal is logged, not surfaced as an error.
      expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
      // Board #111: this task's own assignee (ASSIGNEE, websites--web-studio)
      // is not this repo's maestro, so the maestro's own generic wake stays
      // silent regardless of this repo-mismatch refusal -- both paths agree
      // on zero wakes here, for two independent reasons.
      expect(wakes.some(([id]) => id === "websites--maestro")).toBe(false);
    });

    it("still wakes the task's own assignee when its recorded repo matches the comment's own repo", async () => {
      await recordStudio(env as any, {
        id: ASSIGNEE, state: "running", repoSlug: "acme-org/websites",
        tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      } as StudioStatus);
      const body = commentPayload({ boardState: "input_required" });
      const res = await send(body, await sign(body, SECRET), "issue_comment");
      await drainLast(h);
      expect(res.status).toBe(200);
      const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
      expect(assigneeWakes.length).toBe(1);
      expect(assigneeWakes[0][1]).toContain("#231");
    });
  });

  it("ignores an edited comment -- only a NEW (created) comment can trigger", async () => {
    const body = commentPayload({ boardState: "input_required", action: "edited" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  // --- Round 2 mutant pins (review verdict: 6 of 11 new mutants survived) ---

  it("mutant pin: TWO studio: labels (ambiguous assignee) + input_required -> zero non-maestro wakes", async () => {
    const OTHER = "websites--other-studio";
    await recordStudio(env as any, {
      id: OTHER, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    } as StudioStatus);
    const body = commentPayload({ boardState: "input_required", assignees: [ASSIGNEE, OTHER] });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id !== "websites--maestro")).toEqual([]);
  });

  it("mutant pin: [working, input_required] state-label drift + plain body (no marker) -> zero assignee wakes", async () => {
    const body = commentPayload({ boardState: "working", extraBoardState: "input_required" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("mutant pin: a studio: label with NO registry row is never handed to env.STUDIO.get() (issue #40 phantom-DO hazard)", async () => {
    const PHANTOM = "websites--ghost";
    const body = commentPayload({ boardState: "input_required", assignees: [PHANTOM] });
    const before = ctl.getCalls;
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    // Board #111: PHANTOM is a single, non-maestro assignee, so this task is
    // a DIFFERENT lane's business -- the maestro's own generic wake now
    // correctly refuses (deltaDigest returns null) before ever reaching
    // listStudios/.get() at all, so `getCalls` stays flat. What must still
    // stay at zero regardless is any .get() reaching the phantom PHANTOM id
    // itself, through either wake path.
    expect(rpcCalls.some((c) => c.name === PHANTOM)).toBe(false);
    expect(ctl.getCalls).toBe(before);
  });

  it("mutant pin: the assignee wake goes through wakeStudioOnAssignment, never the plain wakeStudio RPC", async () => {
    const body = commentPayload({ boardState: "input_required" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    const assigneeCalls = rpcCalls.filter((c) => c.name === ASSIGNEE);
    expect(assigneeCalls.length).toBe(1);
    expect(assigneeCalls[0].method).toBe("wakeStudioOnAssignment");
  });

  it("mutant pin: '/wakeup now' (different word) on a working task never wakes -- no loose substring match", async () => {
    const body = commentPayload({ boardState: "working", body: "/wakeup now" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("mutant pin: '/wake' present but NOT on the first line never wakes -- first-line-only rule", async () => {
    const body = commentPayload({ boardState: "working", body: "hi\n/wake" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  // SHOULD-FIX item 5 (round 2): when the task's OWN assignee IS the repo's
  // maestro (`studio:websites--maestro`), wakeMaestro above has ALREADY woken
  // that exact studio for this SAME delivery -- without this skip, one
  // comment would land two prompts in the same tmux pane.
  it("SHOULD-FIX 5: skips the assignee wake when the assignee IS the repo's own maestro (wakeMaestro already woke it)", async () => {
    const body = commentPayload({ boardState: "input_required", assignees: ["websites--maestro"] });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    await drainLast(h);
    expect(res.status).toBe(200);
    const maestroWakes = wakes.filter(([id]) => id === "websites--maestro");
    expect(maestroWakes.length).toBe(1);
    // The one wake that DID happen went through wakeMaestro's own wakeStudio
    // RPC -- not a second, redundant wakeStudioOnAssignment call.
    expect(rpcCalls.filter((c) => c.name === "websites--maestro").map((c) => c.method)).toEqual(["wakeStudio"]);
  });

  // SHOULD-FIX item 4 (round 2): the assignee wake must run behind
  // ctx.waitUntil, not block the response -- GitHub's webhook delivery
  // budget is 10s, a wake's own exec can take up to 30s. Proven directly:
  // right after `send()` resolves (before `drainLast(h)`), the wake has NOT
  // happened yet; only after draining does it show up.
  it("SHOULD-FIX 4: the assignee wake is deferred behind ctx.waitUntil, not awaited inline", async () => {
    const body = commentPayload({ boardState: "input_required" });
    const res = await send(body, await sign(body, SECRET), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
    await drainLast(h);
    expect(wakes.filter(([id]) => id === ASSIGNEE).length).toBe(1);
  });
});

/**
 * Board issue #182: a stopped maestro's registry row is checked BEFORE the
 * Durable Object call, not just inside wakeStudio's own gate (issue #82,
 * runGatedWake's `state === "stopped"` refusal in src/studio/wake.ts, which
 * stays correct and untouched). Real production tail (2026-09-24): 22 wasted
 * wakeStudio calls in 33 minutes against a stopped demosite-life--maestro --
 * this is purely about not reaching that gate at all from a stopped studio.
 */
describe("github webhook -> maestro wake: a stopped maestro is skipped, a running one still woken", () => {
  const STUDIO_ID = "websites--maestro";

  async function setState(state: "running" | "stopped") {
    await recordStudio(env as any, {
      id: STUDIO_ID, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    } as StudioStatus);
  }

  const issuesPayload = JSON.stringify({
    action: "opened",
    repository: { full_name: "acme-org/websites" },
    issue: { number: 9, title: "some task", state: "open" },
  });

  const issueCommentPayload = JSON.stringify({
    action: "created",
    repository: { full_name: "acme-org/websites" },
    issue: { number: 131, title: "fleet task state verb", state: "open" },
    comment: { user: { login: "rafarc21" }, body: "ENVELOPE\nstate: done" },
  });

  const pullRequestPayload = JSON.stringify({
    action: "opened",
    repository: { full_name: "acme-org/websites" },
    pull_request: { number: 4, title: "some PR", state: "open", merged: false, draft: false },
  });

  it.each([
    ["issues", issuesPayload],
    ["issue_comment", issueCommentPayload],
    ["pull_request", pullRequestPayload],
  ])("never touches the Durable Object for a STOPPED maestro (%s)", async (event, body) => {
    await setState("stopped");
    const res = await send(body, await sign(body, SECRET), event);
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
    expect(ctl.getCalls).toBe(0);
  });

  it("still wakes a RUNNING maestro exactly as before", async () => {
    await setState("running");
    const res = await send(issueCommentPayload, await sign(issueCommentPayload, SECRET), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes.length).toBe(1);
    expect(ctl.getCalls).toBe(1);
  });

  it("logs the stopped-skip once per episode, not once per event", async () => {
    await setState("stopped");
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    await send(issuesPayload, await sign(issuesPayload, SECRET), "issues");
    await send(issuesPayload, await sign(issuesPayload, SECRET), "issues");
    const stoppedLogs = infos.mock.calls.filter(
      (c) => c.join(" ").includes(STUDIO_ID) && c.join(" ").toLowerCase().includes("stopped"),
    );
    expect(stoppedLogs.length).toBe(1);
    expect(ctl.getCalls).toBe(0);
    infos.mockRestore();
  });

  it("clears the flag on recovery so the NEXT stopped episode logs again", async () => {
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    await setState("stopped");
    await send(issuesPayload, await sign(issuesPayload, SECRET), "issues"); // episode 1: logs
    await setState("running");
    await send(issuesPayload, await sign(issuesPayload, SECRET), "issues"); // recovered: not stopped, no skip log
    await setState("stopped");
    await send(issuesPayload, await sign(issuesPayload, SECRET), "issues"); // episode 2: new episode, logs again
    const stoppedLogs = infos.mock.calls.filter(
      (c) => c.join(" ").includes(STUDIO_ID) && c.join(" ").toLowerCase().includes("stopped"),
    );
    expect(stoppedLogs.length).toBe(2);
    // Exactly one real wake happened -- the single running delivery in the middle.
    expect(wakes.length).toBe(1);
    infos.mockRestore();
  });
});

