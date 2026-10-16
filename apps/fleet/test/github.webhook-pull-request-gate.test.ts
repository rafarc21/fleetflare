// #1072 (refs #715): a pull_request delivery queues a gate auto-run only for a
// gated-in repo's non-draft opened / synchronize / ready_for_review. The run
// itself is ctx.waitUntil work, so these tests count what the handler queues:
// a draft, a gated-off runner, an ungated repo or another action queues nothing.
import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { handleGithubWebhook } from "../src/github/webhook";
import { fakeCtx } from "./helpers/fake-ctx";
import { sign } from "./helpers/webhook-sign";
import { envWithStudio } from "./helpers/webhook-harness";

const SECRET = "hook-secret";
const REPO = "acme/example";
const HEAD = "e".repeat(40);

function prBody(action: string, draft = false): string {
  return JSON.stringify({
    action,
    number: 7,
    repository: { full_name: REPO },
    sender: { login: "example-user" },
    pull_request: {
      number: 7, title: "t", state: "open", merged: false, draft,
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

describe("pull_request delivery -> gate auto-run", () => {
  it("opened on a gated-in repo queues one auto-run", async () => {
    expect(await deliver(prBody("opened"), ON)).toEqual({ status: 200, queued: 1 });
  });

  it("synchronize and ready_for_review on a gated-in repo queue one auto-run each", async () => {
    expect(await deliver(prBody("synchronize"), ON)).toEqual({ status: 200, queued: 1 });
    expect(await deliver(prBody("ready_for_review"), ON)).toEqual({ status: 200, queued: 1 });
  });

  it("a draft queues nothing", async () => {
    expect(await deliver(prBody("opened", true), ON)).toEqual({ status: 200, queued: 0 });
  });

  it("the gate runner off queues nothing, even for a listed repo", async () => {
    expect(await deliver(prBody("opened"), { runner: "off", repos: REPO })).toEqual({ status: 200, queued: 0 });
  });

  it("a repo outside GATE_RUNNER_REPOS queues nothing", async () => {
    expect(await deliver(prBody("opened"), { runner: "on", repos: "acme/other" })).toEqual({ status: 200, queued: 0 });
  });

  it("other actions queue nothing", async () => {
    expect(await deliver(prBody("closed"), ON)).toEqual({ status: 200, queued: 0 });
  });
});
