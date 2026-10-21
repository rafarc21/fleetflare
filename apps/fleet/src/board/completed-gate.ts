// #1247 (refs #1132, #715): the gate a `completed` transition must clear.
// A gated repo's task completes only when its latest result envelope names a
// PR that is MERGED and whose head sha carries a success gate/verdict status
// (the one context the gate Workflow posts, GATE_STATUS_CONTEXT). Pure over a
// port, same discipline as every other board policy module: the route wires
// the real GitHub calls, tests pass a fake, no rule here needs a live issue.
import type { BoardResult } from "./board";

/** The three GitHub facts a completed gate needs, injected so tests fake them. */
export interface CompletedGatePort {
  /** The PR's merged flag — the one thing that decides "landed". */
  getPullRequest: (repo: string, number: number) => Promise<{ merged: boolean }>;
  /** The PR's head sha — the sha gate/verdict was posted against. */
  getHeadSha: (repo: string, number: number) => Promise<string>;
  /** gate/verdict's current state for a sha (already context-scoped). Undefined = no status yet. */
  getCommitStatus: (repo: string, sha: string) => Promise<{ state: string } | undefined>;
  /** PRs referencing a task (search fallback when the envelope names no PR), newest first. */
  findTaskPrs: (repo: string, taskNumber: number) => Promise<number[]>;
}

/** Whether `pr` has cleared the completed gate: merged AND a success
 *  gate/verdict on its head. A 409 refusal names what is missing, so the
 *  operator sees the fix, never a bare "no". */
export async function completedGate(
  port: CompletedGatePort, repo: string, pr: number,
): Promise<BoardResult<null>> {
  const pull = await port.getPullRequest(repo, pr);
  if (!pull.merged) {
    return { ok: false, status: 409, message: `PR #${pr} is not merged — complete the task only after it merges` };
  }
  const sha = await port.getHeadSha(repo, pr);
  const status = await port.getCommitStatus(repo, sha);
  if (status?.state !== "success") {
    return {
      ok: false, status: 409,
      message: `gate/verdict is not success on PR #${pr}'s head ${sha.slice(0, 8)} — complete the task only after a green gate`,
    };
  }
  return { ok: true, value: null };
}

/** The completed gate's search fallback: when the latest result envelope names
 *  no PR (latestResultPr -> null), find the PRs that reference the task and
 *  return the first one that clears the gate. The same merged + green
 *  gate/verdict guard still applies — a fallback PR is a PR like any other,
 *  never a shortcut. The empty-candidates 409 keeps the operator guidance
 *  ("no PR in the latest result envelope"), distinct from candidates existing
 *  but none clearing the gate — so --no-pr stays visible as the escape hatch
 *  for a research/retro task. */
export async function fallbackTaskPr(
  port: CompletedGatePort, repo: string, taskNumber: number,
): Promise<BoardResult<number>> {
  const candidates = await port.findTaskPrs(repo, taskNumber);
  if (candidates.length === 0) {
    return {
      ok: false, status: 409,
      message: "no PR in the latest result envelope and no PR references this task — pass --no-pr for a research/retro task, or report a PR first",
    };
  }
  for (const pr of candidates) {
    const gate = await completedGate(port, repo, pr);
    if (gate.ok) return { ok: true, value: pr };
  }
  return { ok: false, status: 409, message: `no PR referencing task #${taskNumber} cleared the completed gate` };
}