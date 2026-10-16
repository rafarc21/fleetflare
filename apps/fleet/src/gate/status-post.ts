// #715 gate/verdict posts, shared by the Workflow's run-start (pending) and
// terminal (verdict / skip) steps. The Workflow passes the real GitHub calls;
// tests pass fakes. A failed POST never throws: it returns true so the caller
// can report it, and the run goes on.

export const GATE_STATUS_CONTEXT = "gate/verdict";

export type GateStatusState = "pending" | "success" | "failure" | "error";

/** The two GitHub calls a status post needs, injected so tests can fake them. */
export interface StatusPort {
  mintToken(repo: string): Promise<string>;
  postCommitStatus(
    token: string, repo: string, sha: string, state: GateStatusState, context: string, description: string,
  ): Promise<void>;
}

/** Posts gate/verdict with two attempts. Returns true when both fail (or the
 *  token mint fails), kept apart from the verdict state so a failed POST is
 *  never read as a red leg. Callers wrap this in step.do; the attempt loop sits
 *  inside the step, so Workflows' own infra retry does not re-post it. */
export async function postGateStatus(
  port: StatusPort, repo: string, sha: string,
  args: { state: GateStatusState; description: string },
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const token = await port.mintToken(repo);
      await port.postCommitStatus(token, repo, sha, args.state, GATE_STATUS_CONTEXT, args.description);
      return false;
    } catch (err) {
      console.error(`gate/verdict POST attempt ${attempt} failed`, err);
    }
  }
  return true;
}
