// #1072 (refs #715): a pull_request delivery queues a gate auto-run only for a
// gated-in repo's non-draft opened / synchronize / ready_for_review. The run
// itself is ctx.waitUntil work, so these tests count what the handler queues.
// Main's board flip (#1071) also queues one task for every pull_request
// delivery, so the gate's effect is always a difference between two deliveries
// of the same action: the gate on minus the gate off, or the case minus its
// control. The pure decision is unit-tested in test/bun/gate-auto-run.test.ts.
import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { handleGithubWebhook } from "../src/github/webhook";
import { fakeCtx } from "./helpers/fake-ctx";
import { sign } from "./helpers/webhook-sign";
import { envWithStudio } from "./helpers/webhook-harness";
import { setFlag, deleteFlag } from "../src/state";
import { autoRunFromEnv } from "../src/gate/auto-run-env";
import { gateDrainQueue } from "../src/gate/drain";
import type { PullRequestAutoRun } from "../src/gate/auto-run";

const SECRET = "hook-secret";
const REPO = "acme/example";
const HEAD = "e".repeat(40);

function prBody(action: string, opts: { draft?: boolean; repo?: string } = {}): string {
  return JSON.stringify({
    action,
    number: 7,
    repository: { full_name: opts.repo ?? REPO },
    sender: { login: "example-user" },
    pull_request: {
      number: 7, title: "t", state: "open", merged: false, draft: opts.draft ?? false,
      head: { sha: HEAD }, base: { sha: "f".repeat(40), ref: "main" },
    },
  });
}

/** One signed pull_request delivery through the real handler. Returns the
 *  response status and how many tasks the handler queued via ctx.waitUntil. */
async function deliver(body: string, opts: { runner: "on" | "off"; repos: string }) {
  const d = {
    wakes: [] as [string, string][],
    rpcCalls: [] as { name: string; method: string }[],
    ctl: { wakeOutcome: { ok: true } as { ok: boolean; error?: string }, getCalls: 0, onWake: null, lastCtx: null },
  };
  const e = {
    ...envWithStudio(SECRET, d),
    FLEET_GATE_RUNNER: opts.runner,
    GATE_RUNNER_REPOS: opts.repos,
    GATE_WORKFLOW: { create: vi.fn(async () => ({ id: "unused" })) },
  } as unknown as typeof env;
  const ctx = fakeCtx({ swallow: true, drain: false });
  const req = new Request("https://x/gh", {
    method: "POST",
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": await sign(body, SECRET) },
    body,
  });
  const res = await handleGithubWebhook(req, e, () => 5_000_000, ctx);
  return { status: res.status, queued: ctx.waitUntil.mock.calls.length };
}

const ON = { runner: "on", repos: REPO } as const;
const OFF = { runner: "off", repos: REPO } as const;

describe("pull_request delivery -> gate auto-run", () => {
  it("opened on a gated-in repo queues exactly one auto-run, and answers 200", async () => {
    const gated = await deliver(prBody("opened"), ON);
    expect(gated.status).toBe(200);
    expect(gated.queued - (await deliver(prBody("opened"), OFF)).queued).toBe(1);
  });

  it("synchronize and ready_for_review on a gated-in repo each queue one auto-run", async () => {
    for (const action of ["synchronize", "ready_for_review"]) {
      const gated = await deliver(prBody(action), ON);
      expect(gated.status).toBe(200);
      expect(gated.queued - (await deliver(prBody(action), OFF)).queued).toBe(1);
    }
  });

  it("a draft queues no auto-run", async () => {
    const draft = await deliver(prBody("opened", { draft: true }), ON);
    expect(draft.queued - (await deliver(prBody("opened", { draft: true }), OFF)).queued).toBe(0);
  });

  it("a repo outside GATE_RUNNER_REPOS queues no auto-run", async () => {
    const unlisted = await deliver(prBody("opened", { repo: "acme/other" }), ON);
    expect(unlisted.queued - (await deliver(prBody("opened", { repo: "acme/other" }), OFF)).queued).toBe(0);
  });

  it("other actions queue no auto-run", async () => {
    const closed = await deliver(prBody("closed"), ON);
    expect(closed.queued - (await deliver(prBody("closed"), OFF)).queued).toBe(0);
  });
});

// #1232: while a deploy drains, the auto-run queues as pending instead of
// starting a run the deploy would kill. The enqueue happens inside
// ctx.waitUntil (drain: false), so this calls autoRunFromEnv directly and
// asserts the queue holds the entry.
describe("pull_request delivery while a deploy drains (#1232)", () => {
  it("with gate_drain set, queues the run pending and never creates", async () => {
    const create = vi.fn(async () => ({ id: "unused" }));
    const pr: PullRequestAutoRun = { repo: REPO, pr: 7, headSha: HEAD, baseSha: "f".repeat(40) };
    const e = {
      ...envWithStudio(SECRET, {
        wakes: [] as [string, string][],
        rpcCalls: [] as { name: string; method: string }[],
        ctl: { wakeOutcome: { ok: true } as { ok: boolean; error?: string }, getCalls: 0, onWake: null, lastCtx: null },
      }),
      FLEET_GATE_RUNNER: "on",
      GATE_RUNNER_REPOS: REPO,
      GATE_WORKFLOW: { create, get: vi.fn(async () => { throw new Error("instance not found"); }) },
    } as unknown as typeof env;
    await setFlag(env.DB, "gate_drain", "1", Date.now());
    try {
      await autoRunFromEnv(e, pr);
      expect(create).not.toHaveBeenCalled();
      expect(await gateDrainQueue(env.DB).peek()).toEqual([pr]);
    } finally {
      await deleteFlag(env.DB, "gate_drain");
      await deleteFlag(env.DB, "gate_drain_pending");
    }
  });
});
