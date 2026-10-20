// #1226 review: the real StatusPort, built from one Env. Kept apart from
// status-post.ts, which stays free of env/Workers-ambient-type imports so the
// bun-test project (test/tsconfig.json, "types": ["bun"]) can load it — the
// same reason watchdog-env.ts and auto-run-env.ts exist apart from their pure
// counterparts.
import type { Env } from "../env";
import { getCommitContextStatus, postCommitStatus } from "../github/api";
import { repoTokenMinter } from "../github/auth";
import { GATE_STATUS_CONTEXT, type StatusPort } from "./status-post";

/** The real GitHub calls behind every gate/verdict post: one place, shared by
 *  the Workflow (workflow.ts), the pre-run pending post (auto-run-env.ts) and
 *  the watchdog sweep (watchdog-env.ts) — all three built this same
 *  mintToken/postCommitStatus/getCommitStatus triple by hand before (#1226
 *  review), which let them drift apart silently. */
export function realStatusPort(env: Env): StatusPort {
  const mintToken = repoTokenMinter(env);
  return {
    mintToken, postCommitStatus,
    getCommitStatus: (token, repo, sha) => getCommitContextStatus(token, repo, sha, GATE_STATUS_CONTEXT),
  };
}
