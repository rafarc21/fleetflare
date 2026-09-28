import { Container } from "@cloudflare/containers";
import type { Env } from "../env";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { sendCard } from "../telegram/api";
import { telegramConfig } from "../agents/registry";
import type { DeployTarget } from "./targets";

const POLL_SECONDS = 10;
const JOB_KEY = "job";
// advanceDeploy declares a deploy's container unreachable and gives up
// exactly when job.failedPolls reaches this. Shared (not duplicated) so the
// value fed to advanceDeploy from pollDeploy can't drift from the threshold
// advanceDeploy itself checks — same reasoning as AgentDO's MAX_FAILED_POLLS.
const MAX_FAILED_POLLS = 3;

export interface DeployJob {
  targetId: string;
  project: string;
  chatId: string;
  startedTs: number;
  /** Consecutive /status polls that failed to reach the container. Reset to
   *  0 on any successful read. Fix round 1, Important 4. */
  failedPolls: number;
}

export interface DeployStatus {
  state: "idle" | "running" | "done" | "failed";
  targetId: string | null;
  result: string | null;
  error: string | null;
}

export interface DeployDeps {
  db: D1Database;
  botToken: string;
  now: number;
  maxSeconds: number;
  maxFailedPolls: number;
}

/**
 * The result of one attempt to reach the container's /status — an ok read,
 * or the error containerFetch (or its JSON parse) threw. DeployDO.pollDeploy
 * builds this (it needs `this.containerFetch`, so that one line cannot move
 * out of the DO shell); everything it decides to DO about a failure lives
 * here in advanceDeploy instead, where it is testable. Mirrors
 * src/tasks/loop.ts's advanceTask, whose try/catch around
 * deps.runtime.status() is the identical shape for the identical reason.
 */
export type DeployPoll =
  | { ok: true; status: DeployStatus }
  | { ok: false; error: unknown };

/**
 * One deploy poll cycle, as a plain function for the same reason advanceTask is
 * one: DeployDO cannot be constructed under the test harness.
 *
 * Fix round 1, Important 4: a failed status() read used to be handled
 * entirely inside DeployDO.pollDeploy's own catch — reschedule and return,
 * unconditionally, forever. No counter, no threshold, and the budget check
 * below was never reached on that path at all, so an unreachable container
 * (a bad image, a start failure — exactly the state a brand-new container
 * class is most likely to be in) became a permanent 10s loop that
 * re-cold-starts the container every tick (containerFetch starts a stopped
 * one) and never tells the operator anything. Same wedge class f970d85
 * fixed for AgentDO via MAX_FAILED_POLLS / shouldAbortOnTerminal
 * (src/agents/do.ts). The counting and the give-up decision now live here;
 * pollDeploy is reduced to attempting the fetch and boxing the outcome.
 */
export async function advanceDeploy(
  deps: DeployDeps, job: DeployJob, poll: DeployPoll,
): Promise<{ done: boolean; job: DeployJob }> {
  if (!poll.ok) {
    const failedPolls = job.failedPolls + 1;
    const msg = poll.error instanceof Error ? poll.error.message : String(poll.error);
    const next = { ...job, failedPolls };
    if (failedPolls < deps.maxFailedPolls) {
      // Below threshold: still worth a queryable, self-addressed record —
      // same reasoning as advanceTask's identical branch — without ringing
      // the operator's phone over what is, so far, one blip.
      await appendEvent(
        deps.db,
        makeEvent(
          {
            from: "deploy", to: "deploy", kind: "report",
            project: job.project, ref: job.targetId,
            body: `poll ${failedPolls}/${deps.maxFailedPolls} failed: ${msg}`,
          },
          deps.now, crypto.randomUUID().slice(0, 8),
        ),
      );
      return { done: false, job: next };
    }
    // At threshold: give up. No /abort exists for the deploy container
    // (deliberately not added — see Important 5), so this must not claim to
    // have stopped anything, only that the fleet has stopped watching.
    await terminalReport(
      deps, job.project, job.targetId, job.chatId,
      `Deploy ${job.targetId} lost: container unreachable after ${failedPolls} polls. ` +
      `Last error: ${msg}. The fleet has stopped watching — if the command was still ` +
      `running, its outcome will not be reported.`,
    );
    return { done: true, job: next };
  }

  const status = poll.status;
  const next = { ...job, failedPolls: 0 };
  const overBudget = (deps.now - next.startedTs) / 1000 > deps.maxSeconds;
  if (status.state === "running" && !overBudget) return { done: false, job: next };

  const body = overBudget
    // Fix round 1, Important 5: nothing kills the container's command — the
    // deploy container has no /abort route (deliberately not added). Say
    // what actually happened, not what the old wording implied.
    ? `Deploy ${next.targetId}: budget of ${deps.maxSeconds}s expired. The fleet has stopped ` +
      `watching — the command may still be running in the container, and its outcome will not be reported.`
    : status.state === "done"
      ? `Deploy ${next.targetId} succeeded.\n${status.result ?? ""}`
      : `Deploy ${next.targetId} FAILED.\n${status.error ?? "no error reported"}`;

  await terminalReport(deps, next.project, next.targetId, next.chatId, body);
  return { done: true, job: next };
}

/** pollDeployOnce's result. Mirrors src/agents/do.ts's PollOutcome exactly. */
export interface DeployPollOutcome {
  kind: "continue" | "terminal" | "error";
  job: DeployJob;
}

/**
 * Wraps the ENTIRE advanceDeploy call, not just the containerFetch attempt
 * that produces its `poll` argument. advanceDeploy calls appendEvent
 * unguarded on two paths (the below-threshold self-report and
 * terminalReport, which every terminal branch goes through) — a real D1
 * write that can reject. Left unwrapped (fix round 1's own gap, new
 * Important 2), that throw would leave DeployDO.pollDeploy uncaught
 * entirely: the Container library's alarm() deletes the firing schedule row
 * UNCONDITIONALLY regardless of whether the callback threw, so nothing ever
 * reschedules, JOB_KEY is never cleared, and the deploy is wedged forever
 * with the operator never told. Identical shape and identical reason to
 * src/agents/do.ts's pollOnce, whose own doc comment names appendEvent as
 * the likely thrower — this is that same extraction for DeployDO.
 */
export async function pollDeployOnce(
  deps: DeployDeps, job: DeployJob, poll: DeployPoll,
  advance: (d: DeployDeps, j: DeployJob, p: DeployPoll) => Promise<{ done: boolean; job: DeployJob }> = advanceDeploy,
): Promise<DeployPollOutcome> {
  try {
    const { done, job: next } = await advance(deps, job, poll);
    return { kind: done ? "terminal" : "continue", job: next };
  } catch (err) {
    console.error("advanceDeploy threw; rescheduling instead of wedging", err);
    return { kind: "error", job };
  }
}

/** Shared tail of every terminal deploy outcome: one report event addressed
 *  to the operator, then a best-effort Telegram message that must never
 *  unwind the already-logged event (same rule as tasks/loop.ts's
 *  terminalMessage). */
async function terminalReport(
  deps: DeployDeps, project: string, targetId: string, chatId: string, body: string,
): Promise<void> {
  await appendEvent(
    deps.db,
    makeEvent(
      { from: "deploy", to: "human", kind: "report", project, ref: targetId, body },
      deps.now, crypto.randomUUID().slice(0, 8),
    ),
  );
  try {
    await sendCard(deps.botToken, chatId, body);
  } catch (err) {
    // Never unwind a logged event over a delivery failure — same rule as
    // tasks/loop.ts's terminalMessage.
    console.error("deploy notify failed", err);
  }
}

export interface RunDeployDeps {
  deploy: DurableObjectNamespace<DeployDO>;
  chatId: string;
  token: string;
}

/**
 * Dispatches an approved deploy to the DeployDO instance for this target
 * (one instance per target id, so two different targets deploy in parallel
 * while repeat deploys of the same target serialize through the container's
 * own "already running" 409) and returns once the container has accepted the
 * job — the outcome itself arrives later via advanceDeploy's own report and
 * Telegram message. A plain function, not inlined into makeExecutor's switch,
 * so the dispatch is unit-testable with a fake DEPLOY namespace: DeployDO
 * cannot be constructed under vitest-pool-workers (see this module's other
 * doc comments).
 */
export async function runDeploy(deps: RunDeployDeps, target: DeployTarget): Promise<string> {
  const stub = deps.deploy.get(deps.deploy.idFromName(target.id));
  const res = await stub.fetch("https://deploy/run", {
    method: "POST",
    body: JSON.stringify({ ...target, chatId: deps.chatId, token: deps.token }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`deploy refused (${res.status}): ${text.slice(0, 300)}`);
  return `deploy ${target.id} started`;
}

export class DeployDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "5m";

  // No CLAUDE_CODE_OAUTH_TOKEN. This container must never be able to reason,
  // only to execute one command the operator already approved.
  envVars = {
    CLOUDFLARE_DEPLOY_TOKEN: this.env.CLOUDFLARE_DEPLOY_TOKEN ?? "",
  };

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const target = (await req.json()) as {
        id: string; project: string; chatId: string;
        repo: string; ref: string; workdir: string;
        command: string; secrets: string[]; token: string;
      };
      const res = await this.containerFetch(
        new Request("http://container/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target),
        }),
        8080,
      );
      const text = await res.text();
      if (!res.ok) return new Response(text, { status: res.status });
      await this.ctx.storage.put<DeployJob>(JOB_KEY, {
        targetId: target.id, project: target.project,
        chatId: target.chatId, startedTs: Date.now(), failedPolls: 0,
      });
      await this.schedule(POLL_SECONDS, "pollDeploy", { targetId: target.id });
      return Response.json({ started: target.id });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Named schedule callback. Container owns alarm(); never override it.
   *
   * Fix round 1, Important 4: attempting the containerFetch is the one
   * DO-bound line that cannot move out of this shell. Everything about what
   * a failure MEANS — count it, decide whether to keep trying, what to tell
   * the operator once giving up — is advanceDeploy's job now, not a catch
   * block here that used to reschedule unconditionally forever.
   *
   * Fix round 2, new Important 2: advanceDeploy itself is now called through
   * pollDeployOnce, not directly — advanceDeploy's own appendEvent calls can
   * throw (a real D1 write), and calling it unwrapped left the same wedge
   * class round 1 just fixed for a failed containerFetch: an uncaught throw
   * here means the Container library's alarm() deletes the firing schedule
   * row regardless, so nothing reschedules and the deploy is stuck forever.
   */
  async pollDeploy(_payload: { targetId: string }): Promise<void> {
    const job = await this.ctx.storage.get<DeployJob>(JOB_KEY);
    if (!job) return;
    this.renewActivityTimeout();

    let poll: DeployPoll;
    try {
      const res = await this.containerFetch(new Request("http://container/status"), 8080);
      poll = { ok: true, status: (await res.json()) as DeployStatus };
    } catch (err) {
      poll = { ok: false, error: err };
    }

    const result = await pollDeployOnce(
      {
        db: this.env.DB, botToken: telegramConfig(this.env)?.token ?? "", now: Date.now(),
        maxSeconds: 1800, maxFailedPolls: MAX_FAILED_POLLS,
      },
      job, poll,
    );
    if (result.kind === "terminal") {
      await this.ctx.storage.delete(JOB_KEY);
      return;
    }
    // "continue" and "error" (advanceDeploy itself threw) both mean: not
    // resolved yet, try again — same as AgentDO's pollTask.
    await this.ctx.storage.put<DeployJob>(JOB_KEY, result.job);
    await this.schedule(POLL_SECONDS, "pollDeploy", { targetId: result.job.targetId });
  }
}
