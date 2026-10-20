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