import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleGithubWebhook } from "../src/github/webhook";
import { parseEnvelope, renderEnvelopeComment } from "../src/board/envelope";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
import { isJuniorAuthorized, recordJuniorAuthorization } from "../src/junior/authz";

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
// Issue #41: runs inside the maestro's wakeStudio, so a test can observe
// what had already happened when the (possibly slow) wake began. Reset per test.
let onWake: (() => Promise<void>) | null = null;

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
            await onWake?.();
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
  onWake = null;
  lastCtx = null;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_i: any, init: any) => {
    sent.push({ body: JSON.parse(init.body as string) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });
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
describe("github webhook -> auto-close the board task when its PR is promoted to main", () => {
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

      // GET /repos/{o}/{r} -- getDefaultBranch, and repoIsPrivate (issue #1
      // leak gate): private, since this suite tests auto-close, not the gate.
      if (method === "GET" && path === `/repos/${REPO}`) {
        return Response.json({ default_branch: "main", private: true });
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

  // Maestro review round 1 MINOR (#249, #255): the end-to-end wiring for
  // revokeGlmLeadOnSecurityLabelEvent -- board.board.test.ts proves the pure
  // revoke function itself; this proves the real `issues` `labeled` delivery
  // actually reaches it through handleGithubWebhook, against the real
  // githubBoardApi (the fixture's own fetch mock above, not a fake BoardApi).
  it("an `issues` labeled-security delivery revokes a glm-lead studio's live assignment", async () => {
    const GLM_STUDIO = "scratch--glm-lead-studio";
    await recordStudio(env as any, {
      id: GLM_STUDIO, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, leadType: "glm",
    } as StudioStatus);
    // GitHub's `labeled` delivery reflects the issue's labels AFTER the add
    // already landed on GitHub's side -- the fixture's own `security` entry
    // mirrors that, same as the real world this webhook reacts to.
    issueState[42] = { state: "open", labels: ["working", `studio:${GLM_STUDIO}`, "security"] };

    const body = JSON.stringify({
      action: "labeled", label: { name: "security" }, issue: { number: 42 },
      repository: { full_name: REPO }, sender: { login: "someone" },
    });
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "issues", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      fakeCtx(),
    );

    expect(res.status).toBe(200);
    expect(issueState[42].labels).not.toContain(`studio:${GLM_STUDIO}`);
    expect(issueState[42].labels).toContain("submitted");
    expect(githubCalls.some((c) => c.method === "POST" && c.url.includes("/issues/42/comments"))).toBe(true);
  });

  it("the IDENTICAL delivery against a claude-lead studio's assignment: nothing revoked", async () => {
    const CLAUDE_STUDIO = "scratch--claude-lead-studio";
    await recordStudio(env as any, {
      id: CLAUDE_STUDIO, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, leadType: "claude",
    } as StudioStatus);
    issueState[43] = { state: "open", labels: ["working", `studio:${CLAUDE_STUDIO}`, "security"] };

    const body = JSON.stringify({
      action: "labeled", label: { name: "security" }, issue: { number: 43 },
      repository: { full_name: REPO }, sender: { login: "someone" },
    });
    const res = await handleGithubWebhook(
      new Request("https://x/gh", {
        method: "POST",
        headers: { "x-github-event": "issues", "x-hub-signature-256": await sign(body) },
        body,
      }),
      envWithToken(),
      () => 5_000_000,
      fakeCtx(),
    );

    expect(res.status).toBe(200);
    expect(issueState[43].labels).toEqual(["working", `studio:${CLAUDE_STUDIO}`, "security"]);
  });
});

// Issue #35: a label change made anywhere (GitHub UI, a studio's own gh
// token) is seen here. Any terminal label added OR removed, or a close,
// revokes the task's junior record: revoking only, never granting, so a
// relabel terminal -> live can no longer bring junior back.
describe("issues webhook — a terminal label or close also revokes the task's junior authorization", () => {
  const STUDIO = "websites--web-studio";
  const issues = (action: string, extra: Record<string, unknown> = {}, repo = "acme-org/websites") => JSON.stringify({
    action, issue: { number: 7 }, repository: { full_name: repo }, sender: { login: "someone" }, ...extra,
  });
  async function seed(): Promise<void> {
    await recordJuniorAuthorization(env.DB, "acme-org/websites", 7, STUDIO, 1000);
  }

  for (const [label, action] of [["canceled", "labeled"], ["completed", "unlabeled"], ["failed", "labeled"]] as const) {
    it(`${action} ${label}: record revoked`, async () => {
      await seed();
      const body = issues(action, { label: { name: label } });
      expect((await post(body, await sign(body), "issues")).status).toBe(200);
      await drainLast();
      expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 7, STUDIO)).toBe(false);
    });
  }

  // Issue #41: GitHub cancels a delivery after 10s, and the maestro wake can
  // take far longer. The revoke must already be done when the wake starts.
  it("the revoke lands BEFORE the maestro wake starts", async () => {
    await seed();
    let authorizedAtWake: boolean | null = null;
    onWake = async () => { authorizedAtWake = await isJuniorAuthorized(env.DB, "acme-org/websites", 7, STUDIO); };
    // A titled issue: the maestro wake digest needs one (wake-events.ts).
    const body = issues("labeled", { label: { name: "canceled" }, issue: { number: 7, title: "t", state: "open" } });
    expect((await post(body, await sign(body), "issues")).status).toBe(200);
    await drainLast();
    expect(wakes.map(([id]) => id)).toContain("websites--maestro");
    expect(authorizedAtWake).toBe(false);
  });

  it("closed: record revoked", async () => {
    await seed();
    const body = issues("closed");
    await post(body, await sign(body), "issues");
    await drainLast();
    expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 7, STUDIO)).toBe(false);
  });

  it("a live label added, or a non-state label: record kept", async () => {
    await seed();
    for (const name of ["working", "junior", "bug"]) {
      const body = issues("labeled", { label: { name } });
      await post(body, await sign(body), "issues");
      await drainLast();
    }
    expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 7, STUDIO)).toBe(true);
  });

  it("unsigned delivery: nothing revoked", async () => {
    await seed();
    const body = issues("labeled", { label: { name: "canceled" } });
    expect((await post(body, "sha256=nope", "issues")).status).toBe(401);
    expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 7, STUDIO)).toBe(true);
  });

  it("another repo's same issue number: untouched", async () => {
    await seed();
    const body = issues("labeled", { label: { name: "canceled" } }, "acme-org/other");
    await post(body, await sign(body), "issues");
    await drainLast();
    expect(await isJuniorAuthorized(env.DB, "acme-org/websites", 7, STUDIO)).toBe(true);
  });
});
