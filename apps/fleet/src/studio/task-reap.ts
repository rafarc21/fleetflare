// Board issue #8: `fleet task reap [--dry-run|--apply]` — a deterministic
// backfill for issues whose PR merged/promoted to the default branch but
// were never auto-closed. Two reasons that happens: the auto-close webhook
// missed a delivery, or — the structural case, not a bug — this repo's
// owner resolves to the TOKEN auth path (see docs/superpowers/plans/
// 2026-09-18-auto-close-on-promote.md's coverage-gap section) and NO
// webhook was ever sent for it at all. `reap` is the only coverage for that
// second case; it polls GitHub directly rather than waiting on an inbound
// delivery.
//
// Pure orchestrator, DI'd the same way src/studio/task-state.ts's
// TaskStateDeps<C> is — no Env, no live fetch baked into this file. The real
// wiring (src/board/routes.ts's new /studio/board/tasks/reap route) is
// impure glue built on top of this; every rule here is provable without a
// network.

import type { IssueCloser } from "../github/api";
// Board issue #157: imported from close-outcome.ts, NOT close-action.ts —
// see that leaf file's own header for why (a plain `import type` from
// close-action.ts itself would still drag its runtime imports, and through
// them the whole Durable Object graph, into cli/'s and test-integration/'s
// non-Workers tsconfig projects that also reach this pure orchestrator).
import type { CloseOutcome } from "../board/close-outcome";
import type { TaskState } from "../board/types";

/** One open board task, and the PR its latest §6 result envelope names —
 *  `null` when there is none. Produced by the real side via
 *  src/board/pr-landed.ts's openTasksWithLatestPr, the SAME scan
 *  src/github/promote-close.ts's push-triggered envelope cross-check walks
 *  in the other direction. */
export interface ReapTaskInput {
  taskNumber: number;
  prNumber: number | null;
  /** Board issue #138: `false` when GitHub already closed the issue. Absent
   *  reads as open. Only a closed task with no envelope PR asks
   *  `findCloser`. */
  open?: boolean;
  /** Issue #248: the task's board state. `input_required` is parked on a
   *  human; reap never closes it. */
  state?: TaskState | null;
}

/** Whether a task's PR is landed, and the sha that proves it. `sha` is
 *  `null` exactly when `landed` is `false` — there is nothing yet to close
 *  with. */
export interface LandedCheck {
  landed: boolean;
  sha: string | null;
}

export interface ReapDeps {
  /** The board repo (owner/name). A closer PR from any other repo is not
   *  this board's evidence. */
  repo: string;
  /** Every open board task, each carrying whatever PR its latest result
   *  envelope claims (or `null`). */
  listOpenTasks: () => Promise<ReapTaskInput[]>;
  /** Is this PR's merge commit now reachable from the default branch? See
   *  the real side (src/github/api.ts's getPullRequest +
   *  commitReachableFromBranch) for how that question is actually answered
   *  — this port only cares about the verdict. */
  checkLanded: (prNumber: number) => Promise<LandedCheck>;
  /** Board issue #138: who closed this (already GitHub-closed) task — the
   *  real side is src/github/api.ts's getIssueCloser. A merged PR closer
   *  stands in for the missing envelope PR. */
  findCloser: (taskNumber: number) => Promise<IssueCloser>;
  /** Issue #248: does this PR claim to close this task — its
   *  closingIssuesReferences, or a closing keyword in its title/body? A
   *  multi-PR task's first PR lands without one. Asked only for an envelope
   *  PR; a closer PR (#138) closed the task by definition. */
  prClaims: (prNumber: number, taskNumber: number) => Promise<boolean>;
  /** The shared close-action (src/board/close-action.ts's
   *  closeTaskOnPromote) — called ONLY when `apply` is true, and only for a
   *  task this run already confirmed is landed. */
  close: (taskNumber: number, sha: string) => Promise<{ ok: true; outcome: CloseOutcome } | { ok: false; message?: string }>;
}

export type ReapOutcome =
  | { taskNumber: number; prNumber: number; outcome: "would-close" | CloseOutcome; sha: string }
  | { taskNumber: number; prNumber?: number; outcome: "skipped"; reason: string };

/**
 * `apply: false` (the default — bare `fleet task reap`, and its explicit
 * `--dry-run` synonym) only REPORTS: every task's outcome is `would-close`
 * or `skipped (why)`, nothing writes. `apply: true` performs the identical
 * computation, but a landed task is actually closed through the shared,
 * idempotent close-action — so a task a webhook already closed, or that a
 * PRIOR `reap --apply` run already closed, is safe to hand to this again:
 * the close-action's own dedup guard (keyed on repo+issue+sha) is what
 * makes the second call a no-op, not anything checked here.
 *
 * One outcome per task, in the order `listOpenTasks` returned them. A
 * failure anywhere for ONE task (a thrown `checkLanded`, or the
 * close-action itself answering `{ok:false}`) is reported as that task's
 * own `skipped` outcome and never stops the rest of the run.
 */
export async function runTaskReap(deps: ReapDeps, apply: boolean): Promise<ReapOutcome[]> {
  const tasks = await deps.listOpenTasks();
  const results: ReapOutcome[] = [];

  for (const t of tasks) {
    if (t.state === "input_required") {
      results.push({
        taskNumber: t.taskNumber, ...(t.prNumber !== null ? { prNumber: t.prNumber } : {}),
        outcome: "skipped", reason: "parked input_required",
      });
      continue;
    }
    let prNumber: number;
    if (t.prNumber !== null) {
      prNumber = t.prNumber;
    } else if (t.open !== false) {
      results.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: "no PR artifact found in the latest result envelope" });
      continue;
    } else {
      // Board issue #138: GitHub-closed, no envelope PR. The merged PR that
      // closed it is the evidence; anything else is left and stated.
      let found: IssueCloser;
      try {
        found = await deps.findCloser(t.taskNumber);
      } catch (err) {
        results.push({
          taskNumber: t.taskNumber, outcome: "skipped",
          reason: `finding who closed it failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const verdict = closingPr(found, deps.repo);
      if (typeof verdict === "string") {
        results.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: verdict });
        continue;
      }
      prNumber = verdict;
    }

    let landed: LandedCheck;
    try {
      landed = await deps.checkLanded(prNumber);
    } catch (err) {
      results.push({
        taskNumber: t.taskNumber, outcome: "skipped",
        reason: `checking PR #${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!landed.landed || landed.sha === null) {
      results.push({ taskNumber: t.taskNumber, prNumber, outcome: "skipped", reason: "PR not on default branch yet" });
      continue;
    }
    const sha = landed.sha;

    if (t.prNumber !== null) {
      let claims: boolean;
      try {
        claims = await deps.prClaims(prNumber, t.taskNumber);
      } catch (err) {
        results.push({
          taskNumber: t.taskNumber, prNumber, outcome: "skipped",
          reason: `checking whether PR #${prNumber} closes #${t.taskNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (!claims) {
        results.push({
          taskNumber: t.taskNumber, prNumber, outcome: "skipped",
          reason: `PR #${prNumber} landed but does not close #${t.taskNumber} (no closing keyword) — multi-PR task?`,
        });
        continue;
      }
    }

    if (!apply) {
      results.push({ taskNumber: t.taskNumber, prNumber, outcome: "would-close", sha });
      continue;
    }

    let closed: { ok: true; outcome: CloseOutcome } | { ok: false; message?: string };
    try {
      closed = await deps.close(t.taskNumber, sha);
    } catch (err) {
      results.push({
        taskNumber: t.taskNumber, outcome: "skipped",
        reason: `close failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!closed.ok) {
      results.push({ taskNumber: t.taskNumber, outcome: "skipped", reason: closed.message ?? "close failed" });
      continue;
    }
    results.push({ taskNumber: t.taskNumber, prNumber, outcome: closed.outcome, sha });
  }

  return results;
}

/** The merged PR that closed a task — the one case reap proceeds with — or
 *  the dry-run reason for leaving it. */
function closingPr(found: IssueCloser, repo: string): number | string {
  if (found.stateReason === "NOT_PLANNED" || found.stateReason === "DUPLICATE") {
    return `closed as ${found.stateReason.toLowerCase().replace("_", " ")} — left as-is`;
  }
  const c = found.closer;
  if (c === null) return "closed without a closing PR — no merge to prove it landed";
  if (c.kind === "commit") return `closed by commit ${c.sha.slice(0, 8)}, not a PR`;
  if (c.repo.toLowerCase() !== repo.toLowerCase()) return `closed by ${c.repo}#${c.number}, another repo`;
  if (!c.merged) return `closed by PR #${c.number}, which never merged`;
  return c.number;
}
