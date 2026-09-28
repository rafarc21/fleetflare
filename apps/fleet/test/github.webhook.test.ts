import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleGithubWebhook, verifySignature } from "../src/github/webhook";
import { createApproval, decideApproval, finishApproval } from "../src/approvals/store";
import { readSince } from "../src/events/log";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";

const SECRET = "hook-secret";
let sent: { body: any }[] = [];
let realFetch: typeof globalThis.fetch;

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

const push = (ref: string) => JSON.stringify({
  ref, after: "deadbeefcafe",
  repository: { full_name: "acme-org/websites" },
  sender: { login: "example-bot[bot]" },
});

// Every wake the handler asked for: [studio id, prompt]. Reset per test.
let wakes: [string, string][] = [];
// The container's answer to a wake, overridable so a test can prove a FAILED
// wake still returns 200 -- GitHub retries a non-2xx delivery, and a dead
// tmux window is not something a retry fixes.
let wakeOutcome: { ok: boolean; error?: string } = { ok: true };
// Board issue #182: how many times the handler ever reached `STUDIO.get(...)`
// at all -- one level BEFORE `wakeStudio` runs. The whole point of #182 is
// that a stopped maestro never reaches this call, so `wakes` alone (which
// only records a completed `wakeStudio`) can't prove that; this is a
// separate counter for `.get()` itself. Reset per test.
let getCalls = 0;
// Board issue #236 round 2: WHICH RPC method got called, per `.get(...)`
// call -- `wakes` alone records studio id + prompt but can't distinguish
// `wakeStudio` from `wakeStudioOnAssignment` (both push into the same list,
// same shape). They gate/arm differently (do.ts's own doc comments on each),
// so a mutant that swapped one for the other would pass every existing
// assertion here. Reset per test.
let rpcCalls: { name: string; method: string }[] = [];

function envWithStudio() {
  return {
    ...env,
    GITHUB_WEBHOOK_SECRET: SECRET,
    STUDIO: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        getCalls++;
        return {
          wakeStudio: async (prompt: string) => {
            wakes.push([name as string, prompt]);
            rpcCalls.push({ name: name as string, method: "wakeStudio" });
            return wakeOutcome;
          },
          // Board issue #236: the task-assignee wake goes through this RPC,
          // not wakeStudio -- see src/studio/do.ts's own doc comment on why
          // (it does not arm the maestro's sweep). Recorded into the SAME
          // `wakes` list, distinguishable by studio id, since the maestro's
          // id is always `<repo>--maestro` and a task assignee's id never is.
          wakeStudioOnAssignment: async (prompt: string) => {
            wakes.push([name as string, prompt]);
            rpcCalls.push({ name: name as string, method: "wakeStudioOnAssignment" });
            return wakeOutcome;
          },
        };
      },
    },
  } as any;
}

/**
 * Board issue #180: a fake Workers ExecutionContext. `waitUntil` just
 * queues the promise (never awaits it itself — that's the whole point of
 * `ctx.waitUntil`, matched here), and `drain()` is this test file's own
 * extension for waiting on everything queued so far, once a test's
 * assertions actually depend on the deferred phase (Path 2, the envelope
 * cross-check) having run. Cast rather than fully implementing the real
 * interface's `props`/`tracing` fields (@cloudflare/workers-types) — this
 * codebase's own precedent for a minimal fake here is index.test.ts's
 * `{} as any` for `scheduled`'s unused `_ctx`; this one is used, so it needs
 * real `waitUntil` behavior, but nothing past that.
 */
function fakeCtx() {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
    passThroughOnException: () => {},
    drain: () => Promise.all(tasks),
  };
  return ctx as unknown as ExecutionContext & { drain: () => Promise<unknown[]> };
}

// Board issue #236 round 2: `wakeTaskOnComment` now runs behind
// `ctx.waitUntil` (SHOULD-FIX item 4 -- it can take up to 30s and must not
// block the response inside GitHub's 10s webhook budget, same reasoning
// issue #198 already applied to the push path's own `autoCloseOnPromote`).
// `post` keeps its old fire-and-forget signature for every test that only
// cares about the synchronous response/wakeMaestro path; `lastCtx` exposes
// the fake ctx `post` built internally so a test that DOES depend on the
// deferred wake can `await drainLast()` before asserting.
let lastCtx: ReturnType<typeof fakeCtx> | null = null;

async function post(body: string, sig: string | null, event = "push") {
  lastCtx = fakeCtx();
  return handleGithubWebhook(
    new Request("https://x/gh", {
      method: "POST",
      headers: {
        "x-github-event": event,
        ...(sig ? { "x-hub-signature-256": sig } : {}),
      },
      body,
    }),
    envWithStudio(),
    () => 5_000_000,
    lastCtx,
  );
}

/** Drains whatever `ctx.waitUntil` queued on the MOST RECENT `post()` call --
 *  see `lastCtx`'s own doc comment above for why this exists. */
async function drainLast(): Promise<void> {
  await lastCtx?.drain();
}

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
  wakes = [];
  wakeOutcome = { ok: true };
  getCalls = 0;
  rpcCalls = [];
  lastCtx = null;
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
    const bad = await sign(body).then((s) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0"));
    expect((await post(body, bad)).status).toBe(401);
    expect(sent).toEqual([]);
    // The security requirement names three things a failed verification
    // must not do: "no event, no alert, no D1 write". sent===[] above only
    // covers the Telegram alert; this independently covers the event.
    expect(await readSince(env.DB, "human", 0)).toEqual([]);
  });

  it("rejects an unsigned body", async () => {
    const body = push("refs/heads/staging");
    expect((await post(body, null)).status).toBe(401);
    expect(sent).toEqual([]);
    expect(await readSince(env.DB, "human", 0)).toEqual([]);
  });

  it("ignores a push to a feature branch", async () => {
    const body = push("refs/heads/some-feature");
    expect((await post(body, await sign(body))).status).toBe(200);
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
    const res = await post(body, await sign(body));
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("returns 200 without crashing on a validly signed JSON body of literal null", async () => {
    const body = "null";
    const res = await post(body, await sign(body));
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("alerts on a write to staging with no approved gate", async () => {
    const body = push("refs/heads/staging");
    await post(body, await sign(body));
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
    expect((await post(body, await sign(body))).status).toBe(200);
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
    expect((await post(body, await sign(body))).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("still alerts when the only approval in the window was rejected", async () => {
    await createApproval(env.DB, {
      id: "appr_2", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 4_990_000);
    await finishApproval(env.DB, "appr_2", "failed", "rejected by operator");
    const body = push("refs/heads/staging");
    await post(body, await sign(body));
    expect(sent).toHaveLength(1);
  });

  it("alerts when the matching approval is older than the window", async () => {
    await createApproval(env.DB, {
      id: "appr_3", eventId: "e", project: "websites", action: "merge_staging",
      params: { pr: "7" }, chatId: "1",
    }, 1_000_000);
    await finishApproval(env.DB, "appr_3", "executed", "merged");
    const body = push("refs/heads/staging");
    await post(body, await sign(body));
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
      fakeCtx(),
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
      fakeCtx(),
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
    const res = await post(issueComment, await sign(issueComment), "issue_comment");
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
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
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
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  it("never wakes on an unsigned delivery", async () => {
    const res = await post(issueComment, "sha256=" + "0".repeat(64), "issue_comment");
    expect(res.status).toBe(401);
    expect(wakes).toEqual([]);
  });

  it("still returns 200 when the wake itself fails", async () => {
    wakeOutcome = { ok: false, error: "wake failed (1): can't find window: studio:claude" };
    const res = await post(issueComment, await sign(issueComment), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes.length).toBe(1);
  });

  // Board issue #100 F5: `idFromName` on a name nothing uses mints an empty
  // Durable Object, once per GitHub event. The board path asks D1 first;
  // the webhook now does too.
  it("never touches a Durable Object for a repo with no maestro in the registry", async () => {
    await env.DB.prepare("DELETE FROM fleet_state").run();
    const res = await post(issueComment, await sign(issueComment), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  // Board issue #100 F5: a stopped maestro's refusal is the gate WORKING, not
  // a failure — one console.error per GitHub event buried real errors.
  it("logs a deliberate skip (stopped maestro) at info level, never as an error", async () => {
    wakeOutcome = { ok: false, skipped: true, error: "refused: this studio is stopped" } as typeof wakeOutcome;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post(issueComment, await sign(issueComment), "issue_comment");
    expect(res.status).toBe(200);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("stopped");
    expect(infos.mock.calls.flat().join(" ")).toContain("stopped");
    errors.mockRestore();
    infos.mockRestore();
  });

  it("ignores an event nobody asked to be woken for", async () => {
    const body = JSON.stringify({ action: "created", repository: { full_name: "acme-org/websites" } });
    const res = await post(body, await sign(body), "star");
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
  });

  it("leaves the push path alone -- a push wakes nobody", async () => {
    const body = push("refs/heads/main");
    const res = await post(body, await sign(body));
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
describe("github webhook -> comment wakes the task's OWN assignee (board issue #236)", () => {
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
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
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
    // The maestro's own generic supervision wake still fires independently --
    // this is an ADDITIONAL wake, not a replacement.
    expect(wakes.some(([id]) => id === "websites--maestro")).toBe(true);
  });

  it("never wakes on the studio's own envelope comment, even on an input_required task", async () => {
    const body = commentPayload({ boardState: "input_required", body: envelopeCommentBody });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
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
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("never wakes on a comment authored by a [bot] login, even on an input_required task", async () => {
    const body = commentPayload({ boardState: "input_required", login: "example-bot[bot]" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("does not wake a non-input_required task on a plain comment with no explicit marker", async () => {
    const body = commentPayload({ boardState: "working" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("wakes a RUNNING studio on a comment starting with the explicit /wake marker, for a non-input_required task", async () => {
    const body = commentPayload({ boardState: "working", body: "/wake please take another look" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
    expect(assigneeWakes.length).toBe(1);
    expect(assigneeWakes[0][1]).toContain("#231");
  });

  it("an explicit /wake marker beats the [bot] exclusion -- the cloud maestro's own marker must wake", async () => {
    const body = commentPayload({ boardState: "working", login: "example-bot[bot]", body: "/wake answer" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
    expect(assigneeWakes.length).toBe(1);
  });

  it("does not wake a STOPPED studio even with the explicit marker", async () => {
    await setAssigneeState("stopped");
    const body = commentPayload({ boardState: "working", body: "/wake please take another look" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("design decision: two genuinely new input_required comments in a row BOTH wake -- no dedup suppresses the second", async () => {
    const first = commentPayload({ boardState: "input_required", body: "try again with the new token", commentUrl: `${COMMENT_URL}` });
    const second = commentPayload({
      boardState: "input_required", body: "actually here's the real fix", commentUrl: `${COMMENT_URL}-2`,
    });
    await post(first, await sign(first), "issue_comment");
    await drainLast();
    await post(second, await sign(second), "issue_comment");
    await drainLast();
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
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
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
  describe("issue #284 round 2: repo check threaded through the real webhook handler", () => {
    it("refuses to wake the task's own assignee when it is provisioned for a DIFFERENT repo than the comment's own", async () => {
      await recordStudio(env as any, {
        id: ASSIGNEE, state: "running", repoSlug: "other-org/other-repo",
        tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      } as StudioStatus);
      const body = commentPayload({ boardState: "input_required" });
      const res = await post(body, await sign(body), "issue_comment");
      await drainLast();
      expect(res.status).toBe(200); // GitHub's delivery is still accepted -- the refusal is logged, not surfaced as an error.
      expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
      // The maestro's own independent wake is unaffected by this refusal.
      expect(wakes.some(([id]) => id === "websites--maestro")).toBe(true);
    });

    it("still wakes the task's own assignee when its recorded repo matches the comment's own repo", async () => {
      await recordStudio(env as any, {
        id: ASSIGNEE, state: "running", repoSlug: "acme-org/websites",
        tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      } as StudioStatus);
      const body = commentPayload({ boardState: "input_required" });
      const res = await post(body, await sign(body), "issue_comment");
      await drainLast();
      expect(res.status).toBe(200);
      const assigneeWakes = wakes.filter(([id]) => id === ASSIGNEE);
      expect(assigneeWakes.length).toBe(1);
      expect(assigneeWakes[0][1]).toContain("#231");
    });
  });

  it("ignores an edited comment -- only a NEW (created) comment can trigger", async () => {
    const body = commentPayload({ boardState: "input_required", action: "edited" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
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
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id !== "websites--maestro")).toEqual([]);
  });

  it("mutant pin: [working, input_required] state-label drift + plain body (no marker) -> zero assignee wakes", async () => {
    const body = commentPayload({ boardState: "working", extraBoardState: "input_required" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("mutant pin: a studio: label with NO registry row is never handed to env.STUDIO.get() (issue #40 phantom-DO hazard)", async () => {
    const PHANTOM = "websites--ghost";
    const body = commentPayload({ boardState: "input_required", assignees: [PHANTOM] });
    const before = getCalls;
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    // The maestro wake for this same delivery legitimately calls .get() once
    // (websites--maestro IS registered) -- what must stay at zero is any
    // .get() reaching the phantom PHANTOM id itself.
    expect(rpcCalls.some((c) => c.name === PHANTOM)).toBe(false);
    expect(getCalls).toBe(before + 1);
  });

  it("mutant pin: the assignee wake goes through wakeStudioOnAssignment, never the plain wakeStudio RPC", async () => {
    const body = commentPayload({ boardState: "input_required" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    const assigneeCalls = rpcCalls.filter((c) => c.name === ASSIGNEE);
    expect(assigneeCalls.length).toBe(1);
    expect(assigneeCalls[0].method).toBe("wakeStudioOnAssignment");
  });

  it("mutant pin: '/wakeup now' (different word) on a working task never wakes -- no loose substring match", async () => {
    const body = commentPayload({ boardState: "working", body: "/wakeup now" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  it("mutant pin: '/wake' present but NOT on the first line never wakes -- first-line-only rule", async () => {
    const body = commentPayload({ boardState: "working", body: "hi\n/wake" });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
  });

  // SHOULD-FIX item 5 (round 2): when the task's OWN assignee IS the repo's
  // maestro (`studio:websites--maestro`), wakeMaestro above has ALREADY woken
  // that exact studio for this SAME delivery -- without this skip, one
  // comment would land two prompts in the same tmux pane.
  it("SHOULD-FIX 5: skips the assignee wake when the assignee IS the repo's own maestro (wakeMaestro already woke it)", async () => {
    const body = commentPayload({ boardState: "input_required", assignees: ["websites--maestro"] });
    const res = await post(body, await sign(body), "issue_comment");
    await drainLast();
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
  // right after `post()` resolves (before `drainLast()`), the wake has NOT
  // happened yet; only after draining does it show up.
  it("SHOULD-FIX 4: the assignee wake is deferred behind ctx.waitUntil, not awaited inline", async () => {
    const body = commentPayload({ boardState: "input_required" });
    const res = await post(body, await sign(body), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes.filter(([id]) => id === ASSIGNEE)).toEqual([]);
    await drainLast();
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
describe("github webhook -> maestro wake (issue #182: skip a stopped maestro)", () => {
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
    const res = await post(body, await sign(body), event);
    expect(res.status).toBe(200);
    expect(wakes).toEqual([]);
    expect(getCalls).toBe(0);
  });

  it("still wakes a RUNNING maestro exactly as before", async () => {
    await setState("running");
    const res = await post(issueCommentPayload, await sign(issueCommentPayload), "issue_comment");
    expect(res.status).toBe(200);
    expect(wakes.length).toBe(1);
    expect(getCalls).toBe(1);
  });

  it("logs the stopped-skip once per episode, not once per event", async () => {
    await setState("stopped");
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    await post(issuesPayload, await sign(issuesPayload), "issues");
    await post(issuesPayload, await sign(issuesPayload), "issues");
    const stoppedLogs = infos.mock.calls.filter(
      (c) => c.join(" ").includes(STUDIO_ID) && c.join(" ").toLowerCase().includes("stopped"),
    );
    expect(stoppedLogs.length).toBe(1);
    expect(getCalls).toBe(0);
    infos.mockRestore();
  });

  it("clears the flag on recovery so the NEXT stopped episode logs again", async () => {
    const infos = vi.spyOn(console, "log").mockImplementation(() => {});
    await setState("stopped");
    await post(issuesPayload, await sign(issuesPayload), "issues"); // episode 1: logs
    await setState("running");
    await post(issuesPayload, await sign(issuesPayload), "issues"); // recovered: not stopped, no skip log
    await setState("stopped");
    await post(issuesPayload, await sign(issuesPayload), "issues"); // episode 2: new episode, logs again
    const stoppedLogs = infos.mock.calls.filter(
      (c) => c.join(" ").includes(STUDIO_ID) && c.join(" ").toLowerCase().includes("stopped"),
    );
    expect(stoppedLogs.length).toBe(2);
    // Exactly one real wake happened -- the single running delivery in the middle.
    expect(wakes.length).toBe(1);
    infos.mockRestore();
  });
});

/**
 * Board issue #8: push to the default branch -> issue closed + task
 * transitioned + comment posted. Real D1 (env.DB, same as the dedup test
 * above), and a URL-dispatching fetch stub standing in for every real
 * GitHub call this pipeline makes -- getDefaultBranch, the commit/PR/issue
 * walk, GraphQL closingIssuesReferences, and the close-action's own writes.
 * `GITHUB_TOKEN` is set so repoTokenMinter resolves the TOKEN auth path
 * (github/auth.ts) rather than needing a signed App JWT -- irrelevant to
 * what this suite proves, and the simpler path to wire.
 */
describe("github webhook -> auto-close on promote (board issue #8)", () => {
  // Deliberately NOT acme-org/websites: wrangler.jsonc's real
  // GITHUB_REPO_AUTH pins that owner to the App provider, which would need
  // a signed JWT this suite has no reason to build. An owner absent from
  // that map falls through to the token default (github/auth.ts's
  // resolveRepoAuthKind) the moment GITHUB_TOKEN is set below -- the
  // simpler, and here irrelevant-to-what's-being-proven, path to wire.
  const REPO = "acme-test/scratch";
  let githubCalls: { method: string; url: string; body: any }[];
  /** Per-test overridable answers, keyed by what each real primitive needs
   *  to distinguish between calls of its own shape. */
  let issueState: Record<number, { state: "open" | "closed"; labels: string[] }>;
  let pullsForCommit: Record<string, { number: number; base: { ref: string }; head: { ref: string } }[]>;
  /** A bare number is this repo's issue; `{ number, repo }` another repo's (#252). */
  let closingIssues: Record<number, (number | { number: number; repo: string })[]>;
  const issueNode = (n: number | { number: number; repo: string }) =>
    typeof n === "number" ? { number: n, repository: { nameWithOwner: REPO } } : { number: n.number, repository: { nameWithOwner: n.repo } };
  let pullCommits: Record<number, string[]>;
  let pullMergeCommit: Record<number, string | null>;
  let openTaskNumbers: number[];
  /** Board issue #26: raw comment bodies GitHub would return for one issue
   *  (envelope comments, in this suite's own rendered shape), keyed by issue
   *  number -- the ONLY thing openTasksWithLatestPr (Path 2) reads besides
   *  the issues list itself. Absent for every existing test in this describe
   *  block (Path 2's candidate list is always empty there); populated only
   *  by the new envelope cross-check test below. */
  let issueComments: Record<number, { id: number; html_url: string; body: string; created_at: string; user: { login: string } }[]>;

  function envWithToken() {
    return { ...envWithStudio(), GITHUB_TOKEN: "gh-token" };
  }

  function pushWithCommits(ref: string, commits: { id: string; message?: string }[]) {
    return JSON.stringify({
      ref, after: commits.length > 0 ? commits[commits.length - 1].id : "deadbeefcafe",
      repository: { full_name: REPO },
      sender: { login: "example-bot[bot]" },
      commits,
    });
  }

  /**
   * Board issue #215: a call-counted fake `now` clock, threaded straight
   * into the push's own shared `TimeBudget` (see `AutoCloseSetup.budget`),
   * needs EVERY call to `now()` accounted for -- and a push to
   * "refs/heads/main" or "refs/heads/staging" also falls inside `WATCHED`
   * (this file's own hardcoded set for the UNAPPROVED WRITE alarm, unrelated
   * to auto-close), which reads `now()` a SECOND time of its own (line
   * ~332's `nowMs = now()`) interleaved with the deferred auto-close task.
   * The existing "returns before ANY auto-close work runs" fixture already
   * dodges this by pushing to a branch outside `WATCHED` while overriding
   * `getDefaultBranch` to match it -- reused here as a small helper so every
   * new budget-call-counting fixture below gets the same one-clock-call-per-
   * checkpoint guarantee without the alarm's own unrelated interleaving.
   */
  function pushToUnwatchedDefaultBranch(commits: { id: string; message?: string }[]) {
    const realFetchImpl = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = init.method ?? "GET";
      if (method === "GET" && new URL(url).pathname === `/repos/${REPO}`) {
        return Response.json({ default_branch: "trunk" });
      }
      return (realFetchImpl as any)(input, init);
    }) as typeof globalThis.fetch;
    return pushWithCommits("refs/heads/trunk", commits);
  }

  beforeEach(() => {
    githubCalls = [];
    issueState = {};
    pullsForCommit = {};
    closingIssues = {};
    pullCommits = {};
    pullMergeCommit = {};
    openTaskNumbers = [];
    issueComments = {};

    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = init.method ?? "GET";
      const body = init.body === undefined ? undefined : JSON.parse(init.body as string);
      githubCalls.push({ method, url, body });
      const u = new URL(url);
      const path = u.pathname;

      // GET /repos/{o}/{r} -- getDefaultBranch
      if (method === "GET" && path === `/repos/${REPO}`) {
        return Response.json({ default_branch: "main" });
      }
      // GET /repos/{o}/{r}/issues -- listIssues (listTasks, for the envelope cross-check candidate set).
      // Board issue #26: honours issueState's own open/closed rather than
      // hardcoding "open" -- needed for a candidate GitHub already closed
      // natively (state "closed") but whose board label isn't "completed".
      if (method === "GET" && path === `/repos/${REPO}/issues`) {
        return Response.json(openTaskNumbers.map((n) => ({
          number: n, title: `task ${n}`, body: "", html_url: `https://github.com/${REPO}/issues/${n}`,
          state: issueState[n]?.state ?? "open", labels: issueState[n]?.labels ?? [], updated_at: "2026-09-18T10:00:00Z",
        })));
      }
      // GET /repos/{o}/{r}/issues/{n}/comments -- listComments (openTasksWithLatestPr's envelope read)
      const listCommentsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
      if (method === "GET" && listCommentsMatch) {
        return Response.json(issueComments[Number(listCommentsMatch[1])] ?? []);
      }
      // GET /repos/{o}/{r}/pulls/{n} -- getPullRequest (resolveIssuesFromEnvelopeArtifacts' merge-commit lookup)
      const getPullMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
      if (method === "GET" && getPullMatch) {
        const n = Number(getPullMatch[1]);
        return Response.json({
          number: n, merged: true, merge_commit_sha: pullMergeCommit[n] ?? null,
          base: { ref: "staging" }, head: { ref: `feat/${n}` },
        });
      }
      // GET /repos/{o}/{r}/commits/{sha}/pulls -- listPullsForCommit
      const commitPullsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/pulls$/);
      if (method === "GET" && commitPullsMatch) {
        return Response.json(pullsForCommit[commitPullsMatch[1]] ?? []);
      }
      // POST /graphql -- pullsWithClosingIssuesForCommits (#208): one aliased
      // object(oid:) selection per commit, answered from the same REST fixtures.
      if (method === "POST" && path === "/graphql" && String(body.query).includes("object(oid:")) {
        const repository: Record<string, unknown> = {};
        for (const [, alias, sha] of String(body.query).matchAll(/(c\d+):object\(oid:"([0-9a-f]{40})"\)/g)) {
          repository[alias] = { associatedPullRequests: { nodes: (pullsForCommit[sha] ?? []).map((pr) => ({
            number: pr.number, closingIssuesReferences: { nodes: (closingIssues[pr.number] ?? []).map(issueNode) },
            commits: { nodes: (pullCommits[pr.number] ?? []).map((oid) => ({ commit: { oid } })) },
          })) } };
        }
        return Response.json({ data: { repository } });
      }
      // POST /graphql -- closingIssuesForPull
      if (method === "POST" && path === "/graphql") {
        const number = body.variables.number as number;
        return Response.json({
          data: { repository: { pullRequest: { closingIssuesReferences: { nodes: (closingIssues[number] ?? []).map(issueNode) } } } },
        });
      }
      // GET /repos/{o}/{r}/pulls/{n}/commits -- listPullCommits
      const pullCommitsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/commits$/);
      if (method === "GET" && pullCommitsMatch) {
        return Response.json((pullCommits[Number(pullCommitsMatch[1])] ?? []).map((sha) => ({ sha })));
      }
      // GET/PATCH /repos/{o}/{r}/issues/{n} -- getIssue / closeIssue
      const issueMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/);
      if (issueMatch) {
        const n = Number(issueMatch[1]);
        if (method === "PATCH") {
          issueState[n] = { ...(issueState[n] ?? { labels: [] }), state: "closed" };
          return Response.json({ number: n, state: "closed" });
        }
        const st = issueState[n] ?? { state: "open" as const, labels: [] };
        return Response.json({
          number: n, title: `task ${n}`, body: "", html_url: `https://github.com/${REPO}/issues/${n}`,
          state: st.state, labels: st.labels, updated_at: "2026-09-18T10:00:00Z",
        });
      }
      // POST /repos/{o}/{r}/issues/{n}/labels -- addLabels
      const addLabelsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/);
      if (method === "POST" && addLabelsMatch) {
        const n = Number(addLabelsMatch[1]);
        const labels: string[] = body.labels;
        issueState[n] = { state: issueState[n]?.state ?? "open", labels: [...(issueState[n]?.labels ?? []), ...labels] };
        return Response.json(labels.map((name) => ({ name })));
      }
      // DELETE /repos/{o}/{r}/issues/{n}/labels/{label} -- removeLabel
      const removeLabelMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/([^/]+)$/);
      if (method === "DELETE" && removeLabelMatch) {
        const n = Number(removeLabelMatch[1]);
        const label = decodeURIComponent(removeLabelMatch[2]);
        issueState[n] = { state: issueState[n]?.state ?? "open", labels: (issueState[n]?.labels ?? []).filter((l) => l !== label) };
        return Response.json([]);
      }
      // POST /repos/{o}/{r}/issues/{n}/comments -- createComment
      const commentsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/);
      if (method === "POST" && commentsMatch) {
        return Response.json({ id: 1, html_url: `https://github.com/${REPO}/issues/${commentsMatch[1]}#issuecomment-1` });
      }

      throw new Error(`unhandled fetch in test: ${method} ${url}`);
    }) as typeof globalThis.fetch;
  });

  it("closes the issue, transitions the board to completed, and posts the evidence comment", async () => {
    issueState[42] = { state: "open", labels: ["working"] };
    pullsForCommit["commitsha1"] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    closingIssues[7] = [42];

    const body = pushWithCommits("refs/heads/main", [{ id: "commitsha1", message: "feat: x" }]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );
    // Path 2 (the deferred envelope cross-check) has no candidates here
    // (openTaskNumbers is empty) and touches nothing this test asserts on,
    // but draining keeps its promise from bleeding into the next test's own
    // fetch stub/state -- see fakeCtx's own doc comment.
    await ctx.drain();

    expect(res.status).toBe(200);
    expect(issueState[42].state).toBe("closed");
    expect(issueState[42].labels).toEqual(["completed"]);
    const commentCall = githubCalls.find((c) => c.method === "POST" && c.url.includes("/issues/42/comments"));
    expect(commentCall?.body.body).toBe("closed by commitsh, promoted to main");
  });

  it("batches Path 1 over GraphQL for real shas: one batch call, no per-commit REST, same issue closed (#208)", async () => {
    const sha = "a".repeat(40);
    issueState[42] = { state: "open", labels: ["working"] };
    pullsForCommit[sha] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    closingIssues[7] = [42];

    const body = pushWithCommits("refs/heads/main", [{ id: sha, message: "feat: x" }]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(200);
    expect(issueState[42].state).toBe("closed");
    const batchCalls = githubCalls.filter((c) => c.url.endsWith("/graphql") && String(c.body?.query).includes("object(oid:"));
    expect(batchCalls).toHaveLength(1);
    expect(githubCalls.filter((c) => /\/commits\/[^/]+\/pulls$/.test(new URL(c.url).pathname))).toEqual([]);
  });

  // #252: "Fixes other/repo#12" on a merged PR must never close THIS repo's #12.
  for (const [path, sha] of [["REST", "commitsha1"], ["batched GraphQL", "c".repeat(40)]] as const) {
    it(`a cross-repo closing reference leaves this repo's same-numbered issue open (${path} path)`, async () => {
      issueState[12] = { state: "open", labels: ["working"] };
      issueState[13] = { state: "open", labels: ["working"] };
      pullsForCommit[sha] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
      closingIssues[7] = [{ number: 12, repo: "other/repo" }, 13];

      const body = pushWithCommits("refs/heads/main", [{ id: sha, message: "feat: x" }]);
      const ctx = fakeCtx();
      const res = await handleGithubWebhook(
        new Request("https://x/gh", {
          method: "POST",
          headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
          body,
        }),
        envWithToken(),
        () => 5_000_000,
        ctx,
      );
      await ctx.drain();

      expect(res.status).toBe(200);
      expect(issueState[12].state).toBe("open");
      expect(githubCalls.some((c) => c.method === "PATCH" && c.url.endsWith("/issues/12"))).toBe(false);
      expect(issueState[13].state).toBe("closed");
    });
  }

  it("is idempotent across a redelivered push -- the second delivery does no further writes", async () => {
    issueState[42] = { state: "open", labels: ["working"] };
    pullsForCommit["commitsha1"] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    closingIssues[7] = [42];

    const body = pushWithCommits("refs/heads/main", [{ id: "commitsha1", message: "feat: x" }]);
    const sig = await sign(body);
    const req = () => new Request("https://x/gh", {
      method: "POST",
      headers: { "x-github-event": "push", "x-hub-signature-256": sig },
      body,
    });

    const ctx1 = fakeCtx();
    await handleGithubWebhook(req(), envWithToken(), () => 5_000_000, ctx1);
    await ctx1.drain();
    const closeCallsAfterFirst = githubCalls.filter((c) => c.method === "PATCH").length;
    expect(closeCallsAfterFirst).toBe(1);

    const ctx2 = fakeCtx();
    await handleGithubWebhook(req(), envWithToken(), () => 6_000_000, ctx2);
    await ctx2.drain();
    const closeCallsAfterSecond = githubCalls.filter((c) => c.method === "PATCH").length;
    expect(closeCallsAfterSecond).toBe(1);
  });

  // Finding 2: one closable issue's closeTaskOnPromote call throwing must
  // not abort the rest of the SAME push's batch. Fails against the OLD
  // code (no per-iteration try/catch in autoCloseOnPromote's loop): issue
  // 43's PATCH would never fire because the loop stops dead the moment
  // issue 42's write throws.
  it("one closable issue failing to close does not stop the rest of the same push's batch", async () => {
    issueState[42] = { state: "open", labels: ["working"] };
    issueState[43] = { state: "open", labels: ["working"] };
    pullsForCommit["commitsha1"] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    pullsForCommit["commitsha2"] = [{ number: 8, base: { ref: "staging" }, head: { ref: "feat/y" } }];
    closingIssues[7] = [42];
    closingIssues[8] = [43];

    const realFetchImpl = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = init.method ?? "GET";
      if (method === "PATCH" && new URL(url).pathname === `/repos/${REPO}/issues/42`) {
        return new Response("server error", { status: 500 });
      }
      return (realFetchImpl as any)(input, init);
    }) as typeof globalThis.fetch;

    const body = pushWithCommits("refs/heads/main", [
      { id: "commitsha1", message: "feat: x" },
      { id: "commitsha2", message: "feat: y" },
    ]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(200);
    // Issue 42's close failed (500) -- left open, uncorrupted.
    expect(issueState[42].state).toBe("open");
    // Issue 43 in the SAME push's batch still got closed despite 42's failure.
    expect(issueState[43].state).toBe("closed");
    expect(issueState[43].labels).toEqual(["completed"]);
  });

  it("does nothing for a push to a branch other than the default", async () => {
    const body = pushWithCommits("refs/heads/some-feature", [{ id: "commitsha1", message: "wip" }]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );
    await ctx.drain();
    expect(res.status).toBe(200);
    expect(githubCalls.some((c) => c.method === "PATCH")).toBe(false);
  });

  // Board issue #26, full chain: a task GitHub already closed via a native
  // closing keyword (no closing-keyword match on THIS push's commits, so
  // Path 1 finds nothing for it -- only Path 2, the envelope cross-check,
  // can ever reconcile it), board label still "working" (closeTaskOnPromote
  // never ran). Proves candidate found -> closeTaskOnPromote called -> board
  // label transitions to completed, end to end through the real handler.
  it("reconciles a task GitHub already closed natively, once its landed PR is found via the envelope cross-check", async () => {
    openTaskNumbers = [55];
    issueState[55] = { state: "closed", labels: ["working"] };

    const doc = parseEnvelope(
      {
        sender: "websites--web-studio", intent: "result", status: "ok",
        artifacts: [{ kind: "pr", pr: "9" }],
        verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
      },
      55, "msg-1",
    );
    if (!doc.ok) throw new Error(doc.message);
    issueComments[55] = [{
      id: 1, html_url: `https://github.com/${REPO}/issues/55#issuecomment-1`,
      body: renderEnvelopeComment(doc.doc), created_at: "2026-09-18T10:00:00Z",
      user: { login: "example-bot[bot]" },
    }];
    // No merge_commit_sha on file (pullMergeCommit[9] left unset) -- forces
    // resolveIssuesFromEnvelopeArtifacts' fallback to listPullCommits, which
    // DOES carry this push's own commit.
    pullCommits[9] = ["commitsha1"];

    const body = pushWithCommits("refs/heads/main", [{ id: "commitsha1", message: "feat: y" }]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );
    expect(res.status).toBe(200);
    // Issue #180: this task is ONLY found via Path 2 (the deferred envelope
    // cross-check) -- Path 1 has nothing for commitsha1 (no PR carries a
    // closing keyword for it), so without draining the fake ctx first, the
    // assertions below would see this issue still open.
    await ctx.drain();

    expect(issueState[55].state).toBe("closed");
    expect(issueState[55].labels).toEqual(["completed"]);
    const commentCall = githubCalls.find((c) => c.method === "POST" && c.url.includes("/issues/55/comments"));
    expect(commentCall?.body.body).toBe("closed by commitsh, promoted to main");
  });

  // Board issue #180's own regression (superseded by #198, see below): a real
  // tail (2026-09-24) measured every default-branch push holding /gh 19-24s
  // before responding, because Path 2 used to run AWAITED, before the HTTP
  // response. #180's fix (Phase A awaited, Phase B deferred) turned out not
  // to go far enough: a LIVE acme-os promotion (7-57 commits) measured
  // Phase A ALONE costing 53/137/747 `PromoteCloseApi` calls = 12-217s
  // (2026-09-24) -- still past GitHub's 10s webhook timeout, on the exact
  // failure #180 was supposed to have already fixed.
  //
  // Board issue #198: the fix is to defer the WHOLE of `autoCloseOnPromote`
  // -- Phase A included, and even `prepareAutoClose`'s own token mint /
  // `getDefaultBranch` -- to `ctx.waitUntil`. 200 candidates here is issue
  // #180's own measured scale, comfortably under OPEN_TASKS_SCAN_MAX_CANDIDATES
  // (pr-landed.ts) so nothing here is truncated by THAT bound; each carries a
  // real board state label ("working") so pr-landed.ts's #198 label filter
  // does not exclude any of them either -- that filter has its own dedicated
  // tests in board.pr-landed.test.ts, this fixture is about deferral order.
  //
  // A gate blocks Path 2's OWN per-candidate read (listComments) until this
  // test explicitly releases it. Proof by deadlock, not by a timing race:
  // against code that still awaits ANYTHING in autoCloseOnPromote before the
  // response, this test would hang until vitest's own test timeout and fail
  // loudly, because the handler could never return without going through the
  // gate first.
  it("returns before ANY auto-close work runs (token mint, Path 1, and Path 2 all deferred), and both phases complete once drained (board issue #198)", async () => {
    openTaskNumbers = Array.from({ length: 200 }, (_, i) => 1000 + i);
    for (const n of openTaskNumbers) issueState[n] = { state: "open", labels: ["working"] };
    issueState[42] = { state: "open", labels: ["working"] };
    pullsForCommit["commitsha1"] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    pullsForCommit["commitsha2"] = [];
    closingIssues[7] = [42];

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let listCommentsCallsTotal = 0;

    // Board issue #180: pushes to "trunk", NOT "main" -- deliberately
    // outside WATCHED (this file's own hardcoded staging/main literal for
    // the UNAPPROVED WRITE alarm, unrelated to auto-close). That alarm's own
    // extra async work (recentApprovalsFor, sendCard) has nothing to do
    // with this fixture and would only add unrelated interleaving noise to
    // an ordering assertion that has nothing to do with it.
    const gatedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      if (method === "GET" && path === `/repos/${REPO}`) return Response.json({ default_branch: "trunk" });
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) {
        listCommentsCallsTotal++;
        await gate;
      }
      return (gatedFetch as any)(input, init);
    }) as typeof globalThis.fetch;

    const body = pushWithCommits("refs/heads/trunk", [
      { id: "commitsha1", message: "feat: x" },
      { id: "commitsha2", message: "chore: y" },
    ]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );

    // Board issue #198: `githubCalls` is still completely empty -- not even
    // `getDefaultBranch` (the very first thing `prepareAutoClose` asks for)
    // has run. Against the OLD code (Phase A awaited before the response)
    // this handler could never even reach `return` without Phase A's own
    // GitHub calls already showing up here.
    expect(res.status).toBe(200);
    expect(githubCalls).toEqual([]);
    expect(listCommentsCallsTotal).toBe(0);
    expect(issueState[42].state).toBe("open");

    releaseGate();
    await ctx.drain();

    // Once drained, Phase A closed issue 42 and Phase B ran its full scan
    // over all 200 (labelled) candidates (none carry a PR artifact, so it
    // closes nothing new -- this fixture is about ordering, not about
    // Phase B finding anything of its own).
    expect(issueState[42].state).toBe("closed");
    expect(issueState[42].labels).toEqual(["completed"]);
    expect(listCommentsCallsTotal).toBe(200);
  });

  // Board issue #198, W5: Phase B's own try/catch (autoClosePhaseB) already
  // swallows a throw and logs it -- confirmed directly here rather than only
  // inferred from other tests. `listTasks`'s own `listIssues` call is made
  // to throw; Phase A (a fully separate commit -> PR -> issue walk with no
  // dependency on Phase B) still succeeds, proving the throw is scoped to
  // Phase B alone and never propagates out of the `ctx.waitUntil`'d promise
  // as an unhandled rejection (a rejected `ctx.drain()` below would fail
  // this test outright).
  it("a Phase B throw is caught, logged, and the response is unaffected (W5)", async () => {
    issueState[42] = { state: "open", labels: ["working"] };
    pullsForCommit["commitsha1"] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    closingIssues[7] = [42];

    const realFetchImpl = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = typeof input === "string" ? input : input.url;
      const method = init.method ?? "GET";
      if (method === "GET" && new URL(url).pathname === `/repos/${REPO}/issues`) {
        throw new Error("listIssues boom");
      }
      return (realFetchImpl as any)(input, init);
    }) as typeof globalThis.fetch;

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = pushWithCommits("refs/heads/main", [{ id: "commitsha1", message: "feat: x" }]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      ctx,
    );
    expect(res.status).toBe(200);

    // Must resolve, not reject -- a rejection here means the throw escaped
    // Phase B's own try/catch and would surface as an unhandled rejection
    // out of the `waitUntil`'d promise in real Workers.
    await expect(ctx.drain()).resolves.toBeDefined();

    // Phase A, unaffected by Phase B's throw, still closed its own issue.
    expect(issueState[42].state).toBe("closed");
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("Path 2 (envelope cross-check) failed")),
    ).toBe(true);
    errors.mockRestore();
  });

  // Board issue #215, Gap 1: a real acme-os promotion measured `listTasks`
  // alone costing ~20 `listIssues` GraphQL pages (~5s) -- if Path 1 already
  // spent the whole shared budget, entering Phase B anyway runs it blind
  // past the `waitUntil` ceiling with NO trace (nothing inside `listTasks`
  // itself checks the budget). The fix checks BEFORE `listTasks` is ever
  // called. `now` is a counter-based live clock -- calls 1-4 (the budget's
  // own creation reading, autoCloseOnPromote's timestamp, Path 1's batch
  // prefetch check (#208), and Path 1's own single-commit loop check) read
  // as within-budget so Phase A runs normally and finds nothing (no PR is
  // registered for the one commit); call 5 (Phase B's own new
  // pre-`listTasks` check) reads as exceeded.
  it("Phase B skips entirely -- never calls listTasks -- when the shared budget is already exceeded (Gap 1, board issue #215)", async () => {
    const body = pushToUnwatchedDefaultBranch([{ id: "commitsha1", message: "feat: x" }]);
    let calls = 0;
    const now = () => { calls++; return calls >= 5 ? 30_000 : 0; };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      now,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(200);
    // listTasks's own endpoint (GET /repos/{repo}/issues) was never reached.
    expect(githubCalls.some((c) => c.method === "GET" && c.url.includes(`/repos/${REPO}/issues`))).toBe(false);
    // Pins the scenario: Path 1 ran to completion; the budget tripped at Phase B.
    expect(errors.mock.calls.some((call) => call.join(" ").includes("Path 1:"))).toBe(false);
    expect(
      errors.mock.calls.some((call) => {
        const msg = String(call[0]);
        return msg.includes("Path 2 skipped — budget") && msg.includes(REPO);
      }),
    ).toBe(true);
    errors.mockRestore();
  });

  // #252: listTasks costs ~5s (acme-os, 2026-09-24). Entered with less left,
  // it runs past the ~30s waitUntil ceiling and dies with no log (#215 mode).
  // Same clock as the test above, but call 5 reads 3s before the deadline.
  it("Phase B skips listTasks when less than its ~5s cost is left, with one log (#252)", async () => {
    const body = pushToUnwatchedDefaultBranch([{ id: "commitsha1", message: "feat: x" }]);
    let calls = 0;
    const now = () => { calls++; return calls >= 5 ? 22_000 : 0; };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = fakeCtx();
    await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      now,
      ctx,
    );
    await ctx.drain();

    expect(githubCalls.some((c) => c.method === "GET" && c.url.includes(`/repos/${REPO}/issues`))).toBe(false);
    const skips = errors.mock.calls.map((c) => c.join(" ")).filter((m) => m.includes("Path 2 skipped"));
    expect(skips).toEqual([
      `promote-close: Path 2 skipped — budget: 3s left for ${REPO}, under listTasks' ~5s cost, before listTasks`,
    ]);
    errors.mockRestore();
  });

  // Board issue #215, Gap 1 (second check): the budget can run out DURING
  // `listTasks` + `openTasksWithLatestPr` even though Phase B started with
  // time to spare -- this fixture is the "reconciles a task..." fixture
  // above, but with a clock engineered to trip AFTER the candidate scan
  // finds task #55's PR artifact and BEFORE the envelope cross-check's own
  // GitHub calls (`getPullRequestMergeCommit`/`listPullCommits`) start.
  it("Phase B skips the envelope cross-check when the budget runs out DURING listTasks + the candidate scan (Gap 1, board issue #215)", async () => {
    openTaskNumbers = [55];
    issueState[55] = { state: "closed", labels: ["working"] };
    const doc = parseEnvelope(
      {
        sender: "websites--web-studio", intent: "result", status: "ok",
        artifacts: [{ kind: "pr", pr: "9" }],
        verification: { url: "https://x.test", steps: ["open it"], expected: "it works" },
      },
      55, "msg-1",
    );
    if (!doc.ok) throw new Error(doc.message);
    issueComments[55] = [{
      id: 1, html_url: `https://github.com/${REPO}/issues/55#issuecomment-1`,
      body: renderEnvelopeComment(doc.doc), created_at: "2026-09-18T10:00:00Z",
      user: { login: "example-bot[bot]" },
    }];
    pullCommits[9] = ["commitsha1"];

    const body = pushToUnwatchedDefaultBranch([{ id: "commitsha1", message: "feat: y" }]);
    // Calls 1-6 (budget creation, autoCloseOnPromote's timestamp, Path 1's
    // batch prefetch check (#208), Path 1's single-commit check, Phase B's
    // first pre-listTasks check, and the candidate scan's own per-candidate
    // check for task #55) read as within-budget; call 7 (Phase B's second
    // check, right before the envelope cross-check itself) reads as exceeded.
    let calls = 0;
    const now = () => { calls++; return calls >= 7 ? 30_000 : 0; };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      now,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(200);
    // The envelope cross-check itself never ran -- neither of its own two
    // GitHub calls for PR #9 fired.
    expect(githubCalls.some((c) => c.url.includes(`/repos/${REPO}/pulls/9`))).toBe(false);
    // Left exactly as it was -- closeTaskOnPromote never got the chance to
    // transition the board label, even though GitHub itself already shows
    // the issue closed.
    expect(issueState[55].labels).toEqual(["working"]);
    expect(
      errors.mock.calls.some((call) => {
        const msg = String(call[0]);
        return msg.includes("Path 2 skipped — budget") && msg.includes(REPO);
      }),
    ).toBe(true);
    // Pins the scenario: the scan FOUND task #55's PR before the budget tripped,
    // and Path 1 was never cut off.
    expect(errors.mock.calls.some((call) => call.join(" ").includes("(1 candidates found)"))).toBe(true);
    expect(errors.mock.calls.some((call) => call.join(" ").includes("Path 1:"))).toBe(false);
    errors.mockRestore();
  });

  // Board issue #215 (BU3 / BU9): no existing test exercised closeEach's OWN
  // budget-exceeded path -- it was implemented by #209 but never proven.
  // Three closable issues, found via Path 1 (three commits, three PRs, three
  // distinct closing issues); a counter-based live clock lets the FIRST two
  // closes complete before the loop's own budget check trips on the third.
  it("the close loop itself stops partway once the shared budget runs out mid-batch, closing only the first N of M issues (BU3 / BU9, board issue #215)", async () => {
    issueState[42] = { state: "open", labels: ["working"] };
    issueState[43] = { state: "open", labels: ["working"] };
    issueState[44] = { state: "open", labels: ["working"] };
    pullsForCommit["commitsha1"] = [{ number: 7, base: { ref: "staging" }, head: { ref: "feat/x" } }];
    pullsForCommit["commitsha2"] = [{ number: 8, base: { ref: "staging" }, head: { ref: "feat/y" } }];
    pullsForCommit["commitsha3"] = [{ number: 9, base: { ref: "staging" }, head: { ref: "feat/z" } }];
    closingIssues[7] = [42];
    closingIssues[8] = [43];
    closingIssues[9] = [44];

    // Calls 1-11 read as within-budget: 1 (budget creation) + 1
    // (autoCloseOnPromote's timestamp) + 1 (Path 1's batch prefetch, #208) +
    // 6 (Path 1: one top-level-loop check plus one resolveForCommit PR-loop
    // check per commit, x3 commits) + 2 (closeEach's own check for issue #42,
    // then #43). Call 12 (closeEach's check for issue #44) reads as exceeded.
    let calls = 0;
    const now = () => { calls++; return calls >= 12 ? 30_000 : 0; };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = pushToUnwatchedDefaultBranch([
      { id: "commitsha1", message: "feat: x" },
      { id: "commitsha2", message: "feat: y" },
      { id: "commitsha3", message: "feat: z" },
    ]);
    const ctx = fakeCtx();
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      now,
      ctx,
    );
    await ctx.drain();

    expect(res.status).toBe(200);
    // The first two closables in the batch were closed...
    expect(issueState[42].state).toBe("closed");
    expect(issueState[42].labels).toEqual(["completed"]);
    expect(issueState[43].state).toBe("closed");
    expect(issueState[43].labels).toEqual(["completed"]);
    // ...but the third never got the chance -- closeTaskOnPromote's own
    // dependency (the PATCH call) was made exactly twice, not three times.
    expect(issueState[44].state).toBe("open");
    expect(githubCalls.filter((c) => c.method === "PATCH").length).toBe(2);

    // Logged exactly once for the close loop itself (Phase B's own
    // independent "Path 2 skipped" message, tripped by the same
    // already-exhausted budget, is a SEPARATE message and not counted here).
    const closeLoopErrors = errors.mock.calls.filter((call) => String(call[0]).includes("close loop"));
    expect(closeLoopErrors).toHaveLength(1);
    const [msg] = closeLoopErrors[0] as [string];
    expect(msg).toContain(REPO);
    expect(msg).toContain("2/3");
    errors.mockRestore();
  });
});
