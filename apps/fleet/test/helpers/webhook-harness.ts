// Sweep 43, F2 (refs #850): the PR-#720 split pair (github.webhook-core /
// github.webhook-autoclose) hand-synced this STUDIO-namespace fake and this
// POST harness byte for byte; this module owns them once. The counters they
// record into stay each suite's own state: wakes/rpcCalls are the suite's
// const arrays, getCalls/wakeOutcome/onWake/lastCtx live in the suite's
// const ctl object — both reset IN PLACE by beforeEach (wakes.length = 0,
// ctl.getCalls = 0), so the deps snapshot this module receives never goes
// stale. Same override discipline as helpers/board-api.ts: the helper owns
// the shape, the caller the state.
import { env } from "cloudflare:test";
import { handleGithubWebhook } from "../../src/github/webhook";
import { fakeCtx } from "./fake-ctx";

export interface WebhookCtl {
  // The container's answer to a wake, overridable so a test can prove a
  // FAILED wake still returns 200 — GitHub retries a non-2xx delivery, and
  // a dead tmux window is not something a retry fixes.
  wakeOutcome: { ok: boolean; error?: string };
  // Board issue #182: how many times the handler reached `STUDIO.get(...)`
  // at all — one level BEFORE wakeStudio runs, so the wakes list alone
  // (which only records a completed wake) can't prove a stopped maestro
  // never got that far.
  getCalls: number;
  // Issue #41: runs inside the maestro's wakeStudio, so a test can observe
  // what had already happened when the (possibly slow) wake began.
  onWake: (() => Promise<void>) | null;
  lastCtx: ReturnType<typeof fakeCtx> | null;
}

export interface WebhookHarnessDeps {
  wakes: [string, string][];
  rpcCalls: { name: string; method: string }[];
  ctl: WebhookCtl;
}

export function envWithStudio(secret: string, d: WebhookHarnessDeps) {
  return {
    ...env,
    GITHUB_WEBHOOK_SECRET: secret,
    STUDIO: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        d.ctl.getCalls++;
        return {
          wakeStudio: async (prompt: string) => {
            await d.ctl.onWake?.();
            d.wakes.push([name as string, prompt]);
            d.rpcCalls.push({ name: name as string, method: "wakeStudio" });
            return d.ctl.wakeOutcome;
          },
          // Board issue #236: the task-assignee wake goes through this RPC,
          // not wakeStudio — see src/studio/do.ts's own doc comment on why
          // (it does not arm the maestro's sweep). Recorded into the SAME
          // `wakes` list, distinguishable by studio id, since the maestro's
          // id is always `<repo>--maestro` and a task assignee's id never is.
          wakeStudioOnAssignment: async (prompt: string) => {
            d.wakes.push([name as string, prompt]);
            d.rpcCalls.push({ name: name as string, method: "wakeStudioOnAssignment" });
            return d.ctl.wakeOutcome;
          },
        };
      },
    },
  } as any;
}

export async function post(
  d: WebhookHarnessDeps, secret: string, body: string, sig: string | null, event = "push",
) {
  d.ctl.lastCtx = fakeCtx({ swallow: false });
  return handleGithubWebhook(
    new Request("https://x/gh", {
      method: "POST",
      headers: {
        "x-github-event": event,
        ...(sig ? { "x-hub-signature-256": sig } : {}),
      },
      body,
    }),
    envWithStudio(secret, d),
    () => 5_000_000,
    d.ctl.lastCtx,
  );
}

/** Drains whatever `ctx.waitUntil` queued on the MOST RECENT `post()` call. */
export async function drainLast(d: WebhookHarnessDeps): Promise<void> {
  await d.ctl.lastCtx?.drain();
}
