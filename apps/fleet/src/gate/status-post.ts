// #715 gate/verdict posts, shared by the Workflow's run-start (pending) and
// terminal (verdict / skip) steps. The Workflow passes the real GitHub calls;
// tests pass fakes.
//
// #1226: a POST that fails must never complete silently. postGateStatus makes
// ONE attempt (mint, post, confirm by reading the status back) and THROWS with
// the real cause when it cannot confirm the post landed — callers wrap this in
// a step.do with STATUS_POST_STEP_CONFIG, so Workflows' own retry (5 tries,
// real exponential backoff) re-runs this whole function on failure, never the
// old 2x-immediate-then-swallow loop that made Workflows' own retry unreachable.
// The post is idempotent (posting the same state/description again is
// harmless), so repeating the whole attempt on retry is always safe.
export const GATE_STATUS_CONTEXT = "gate/verdict";

export type GateStatusState = "pending" | "success" | "failure" | "error";

/** The two GitHub calls a status post needs, injected so tests can fake them. */
export interface StatusPort {
  mintToken(repo: string): Promise<string>;
  postCommitStatus(
    token: string, repo: string, sha: string, state: GateStatusState, context: string, description: string,
    targetUrl?: string,
  ): Promise<void>;
  /** Reads gate/verdict's current state back, right after a post (#1226): a
   *  2xx response from the POST is not proof it landed under a secondary rate
   *  limit or an eventually-consistent read. Undefined when there is no status
   *  for this context yet, OR when the read itself fails — callers never treat
   *  that as proof of absence, only as "not confirmed." */
  getCommitStatus(token: string, repo: string, sha: string): Promise<{ state: string; description?: string } | undefined>;
}

/** The status-post step's own retry (#1226): explicit, not Workflows' implicit
 *  default, so it is not a promise this file alone cannot keep. 5 tries,
 *  exponential from 10s — enough real backoff to ride out a secondary rate
 *  limit or a transient token-mint failure, which the old 2x-immediate loop
 *  never gave it. */
export const STATUS_POST_STEP_CONFIG = {
  retries: { limit: 5, delay: "10 seconds" as const, backoff: "exponential" as const },
  timeout: "5 minutes" as const,
};

/** Posts gate/verdict, then confirms it actually landed by reading it back.
 *  One attempt per call — the caller's step.do (with STATUS_POST_STEP_CONFIG)
 *  is what retries this whole function on failure, with real backoff. Throws,
 *  carrying the real cause (the POST's own error, or the read-back mismatch),
 *  so a step that exhausts its retries fails the run loudly instead of ending
 *  "successfully" with a quietly-dropped status (#1226's actual bug). */
export async function postGateStatus(
  port: StatusPort, repo: string, sha: string,
  args: { state: GateStatusState; description: string; targetUrl?: string },
): Promise<void> {
  const token = await port.mintToken(repo);
  let postErr: unknown;
  try {
    await port.postCommitStatus(token, repo, sha, args.state, GATE_STATUS_CONTEXT, args.description, args.targetUrl);
  } catch (err) {
    postErr = err;
  }
  const landed = await port.getCommitStatus(token, repo, sha).catch(() => undefined);
  if (landed?.state === args.state && landed.description === args.description) return;
  const cause = postErr instanceof Error
    ? postErr.message
    : postErr !== undefined ? String(postErr) : `read-back did not match (got ${JSON.stringify(landed)})`;
  throw new Error(`gate/verdict POST failed: ${cause}`);
}
