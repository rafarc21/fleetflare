import type { Env } from "../env";
import { agentForProject, telegramConfig } from "../agents/registry";
import { getApproval, decideApproval, finishApproval } from "./store";
import { appendEvent } from "../events/log";
import { makeEvent } from "../events/schema";
import { editCard, answerCallbackQuery, sendCard } from "../telegram/api";
import { GATE_LABELS, type GateAction } from "../tasks/types";
import { mintRepoToken } from "../github/auth";
import { mergePullRequest } from "../github/api";
import { getDeployTarget } from "../deploy/targets";
import { runDeploy } from "../deploy/do";

export type GateExecutor = (
  action: GateAction, params: Record<string, string>,
) => Promise<string>;

export interface CallbackQuery {
  id: string;
  from?: { id: number };
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

/**
 * Guards exactly one post-CAS side effect: run it, log a failure, never let
 * it escape. Once decideApproval commits (handleCallbackQuery's `first` at
 * :48), every statement below is a consequence of a decision already
 * recorded — a throw from any one of them must not stop the next from
 * running. This is the fourth appearance of that defect class in this file;
 * every post-CAS call below is routed through this instead of a fifth
 * bespoke try/catch. The one deliberate exception is execute() itself:
 * its throw IS the verdict that picks the failed/executed branch, so it is
 * never routed through step().
 */
const step = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    console.error(what, err);
  }
};

export async function handleCallbackQuery(
  env: Env, cq: CallbackQuery, execute: GateExecutor, now: number,
): Promise<void> {
  // The entire "an agent cannot self-approve" guarantee. A callback_query can
  // only originate from Telegram for a real tap, and only the operator's id
  // passes here. Board #334: no operator is configured → nobody passes.
  const tg = telegramConfig(env);
  if (!tg) return;
  if (String(cq.from?.id ?? "") !== tg.operatorId) {
    await answerCallbackQuery(tg.token, cq.id, "not authorised");
    return;
  }

  const [id, verdict] = (cq.data ?? "").split(":");
  if (!id || (verdict !== "yes" && verdict !== "no")) {
    await answerCallbackQuery(tg.token, cq.id, "unreadable button");
    return;
  }

  const row = await getApproval(env.DB, id);
  if (!row) {
    await answerCallbackQuery(tg.token, cq.id, "unknown approval");
    return;
  }

  const state = verdict === "yes" ? "approved" : "rejected";
  const first = await decideApproval(env.DB, id, state, tg.operatorId, now);
  if (!first) {
    await answerCallbackQuery(tg.token, cq.id, "already decided");
    return;
  }

  // Everything below this line is a consequence of the CAS above having
  // committed: no bare `await`, every side effect goes through step() so one
  // failing never stops the next — including reaching execute() itself.
  //
  // Stops the tapping device's spinner only — no downstream step depends on
  // this succeeding. The CAS above already committed the decision; a 429, a
  // 5xx, or Telegram's own very common {ok:false, "query is too old..."}
  // must not unwind it.
  await step("callback acknowledgement failed", () => answerCallbackQuery(tg.token, cq.id));

  const label = GATE_LABELS[row.action];
  const stamp = new Date(now).toISOString();

  // Strip the keyboard before doing the work: a slow merge must not leave a
  // second tappable button on screen.
  if (row.messageId !== null) {
    const messageId = row.messageId;
    await step("keyboard strip failed", () =>
      editCard(tg.token, row.chatId, messageId, `${label} — ${state} ${stamp}`));
  }

  await step("approval event failed", () =>
    appendEvent(
      env.DB,
      makeEvent(
        {
          from: tg.operatorId, to: agentForProject(row.project, env)?.id ?? "cto",
          kind: "approval", project: row.project, ref: row.id,
          body: `${label}: ${state}`,
        },
        now, crypto.randomUUID().slice(0, 8),
      ),
    ));

  if (state === "rejected") {
    // The agent stays stopped. A rejected gate never auto-starts a new turn:
    // the operator's reason for rejecting is not yet known to anyone, and
    // guessing it burns an opus turn on the wrong work.
    await step("finishApproval(rejected) failed", () =>
      finishApproval(env.DB, id, "failed", "rejected by operator"));
    await step("rejection report event failed", () =>
      appendEvent(
        env.DB,
        makeEvent(
          {
            from: tg.operatorId, to: agentForProject(row.project, env)?.id ?? "cto",
            kind: "report", project: row.project, ref: row.id,
            body: `${label} rejected by the operator. Do not retry unless told.`,
          },
          now, crypto.randomUUID().slice(0, 8),
        ),
      ));
    return;
  }

  // execute() alone decides success or failure — nothing before or after it
  // may flip that verdict. This is deliberately the one call in this
  // function NOT routed through step(): a prior guard only stopped the
  // success notification from doing this (round 1, Important 1); routing
  // execute() itself through step() would swallow the one throw this whole
  // function exists to react to, and wrapping the function in one outer
  // try/catch instead would let a failure earlier (e.g. the approval event
  // above) skip execute() entirely — the bug this fix removes, not a
  // second copy of it.
  let result: string;
  try {
    result = await execute(row.action, row.params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The "failed" state and the notice are independent best-effort steps on
    // top of a verdict execute() has already decided — finishApproval's own
    // write is just as capable of throwing (a transient D1 error) as the
    // notice is, and neither may stop the operator from being told.
    await step("finishApproval(failed) write failed", () => finishApproval(env.DB, id, "failed", msg));
    await step("failure notice failed", () =>
      sendCard(tg.token, row.chatId, `${label} FAILED — ${msg}`));
    return;
  }

  // Recording the outcome and telling the operator are each best-effort on
  // top of a success that has already happened — independent of each other
  // too, so a D1 hiccup recording "executed" doesn't also suppress the
  // notification, or vice versa. Neither may report "failed".
  await step("finishApproval(executed) failed", () => finishApproval(env.DB, id, "executed", result));
  await step("success notice failed", () =>
    sendCard(tg.token, row.chatId, `${label} done — ${result}`));
}

/**
 * merge_staging and merge_main (Task 7) mint a short-lived GitHub App
 * installation token — right here, in the Worker, never in the agent's
 * container — and merge the already-approved PR. merge_staging squashes (a
 * feature branch into the integration branch); merge_main uses a real merge
 * commit (promoting the long-lived staging branch into main must not
 * flatten history the two branches share — see src/github/api.ts). Round 1
 * review, Important 3: this used to hardcode squash for both.
 *
 * deploy_staging and deploy_prod (Task 9) look up the approved target in D1,
 * refuse an unknown one rather than substitute a default, and hand it to
 * runDeploy (src/deploy/do.ts) with a fresh installation token minted here —
 * never in any container — and the project's chat id to report to. The
 * deploy container itself never runs Claude Code and never receives
 * CLAUDE_CODE_OAUTH_TOKEN (src/deploy/do.ts, container/deploy-server.ts):
 * this is the Worker executing a command the operator already approved, not
 * a second agent deciding anything. One branch per action, not a shared
 * default, so each task's diff touches only the actions it owns.
 */
export function makeExecutor(env: Env): GateExecutor {
  return async (action: GateAction, params: Record<string, string>): Promise<string> => {
    switch (action) {
      case "merge_staging":
      case "merge_main": {
        const pr = params.pr;
        if (!pr) throw new Error("merge gate requires --pr");
        // P6a: the credential is resolved FOR the repo being merged — a gate
        // can name any repo the board works, and under a mixed config that
        // repo's owner decides which provider issues the credential.
        const repo = params.repo ?? env.AGENT_REPO;
        const token = await mintRepoToken(env, repo);
        const sha = await mergePullRequest(
          token, repo, pr, `${GATE_LABELS[action]} (PR #${pr})`,
          action === "merge_main" ? "merge" : "squash",
        );
        return `merged PR #${pr} as ${sha.slice(0, 8)}`;
      }
      case "deploy_staging":
      case "deploy_prod": {
        const targetId = params.target;
        if (!targetId) throw new Error("deploy gate requires --target");
        const target = await getDeployTarget(env.DB, targetId);
        // Refuse rather than substitute. A deploy that runs the wrong command
        // is worse than one that does not run.
        if (!target) throw new Error(`unknown deploy target: ${targetId}`);
        // Board #334: DeployDO reports to the operator's Telegram chat; with
        // Telegram off there is nobody to report to, so refuse outright.
        const tg = telegramConfig(env);
        if (!tg) throw new Error("deploy gate needs Telegram (FLEET_TELEGRAM=on)");
        const agent = agentForProject(target.project, env);
        // runDeploy's payload is the target plus the two things only the
        // Worker can supply: where to report, and a fresh clone token minted
        // here and nowhere else. "Fresh" is about lifetime, not disk
        // persistence — that half is the deploy container's own job: it
        // resets the clone URL to a tokenless one immediately after cloning
        // (container/deploy-server.ts's run(), in a finally), before the
        // operator's own command ever runs against that checkout.
        return runDeploy(
          { deploy: env.DEPLOY, chatId: agent?.chatId ?? tg.operatorId, token: await mintRepoToken(env, target.repo) },
          target,
        );
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`unknown gate action: ${exhaustive as string}`);
      }
    }
  };
}
