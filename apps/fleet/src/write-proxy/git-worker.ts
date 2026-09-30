/**
 * Issue #7: handleGitProxy's real ports. Kept apart from git-route.ts so the
 * handler itself stays loadable by the bun lane, which drives it with real
 * git against a real `git http-backend` (test/bun/write-proxy-e2e.test.ts).
 */
import type { Env } from "../env";
import { leakGuard } from "../board/leak";
import { realLeakDeps } from "../board/routes";
import { listStudios } from "../studio/registry";
import { mintRepoToken, repoOwner, repoToken, resolveRepoAuthKind } from "../github/auth";
import { defaultBranchCache, handleGitProxy } from "./git-route";
import { getDefaultBranch } from "../github/api";
import { defaultBranchPushAllowed } from "./mode";
import { workerWriteToken } from "./gh-route";

async function workerReadToken(env: Env, repo: string): Promise<string> {
  if (resolveRepoAuthKind(env, repo) === "token") return repoToken(env, repoOwner(repo)) as string;
  return mintRepoToken(env, repo, { permissions: { contents: "read" } });
}

/** Issue #34: per isolate, 5 minutes; the Worker's env is fixed per isolate. */
let branchLookup: ((repo: string) => Promise<string>) | null = null;
const DEFAULT_BRANCH_TTL_MS = 5 * 60_000;

export async function handleFleetGit(req: Request, env: Env): Promise<Response> {
  return handleGitProxy(req, {
    rows: () => listStudios(env),
    defaultRepo: env.AGENT_REPO,
    check: leakGuard(realLeakDeps(env, (repo) => workerReadToken(env, repo))),
    defaultBranch: (repo) => {
      branchLookup ??= defaultBranchCache(async (r) => getDefaultBranch(await workerReadToken(env, r), r), DEFAULT_BRANCH_TTL_MS);
      return branchLookup(repo);
    },
    allowDefaultBranch: (repo) => defaultBranchPushAllowed(env, repo),
    upstream: async (url, init, access, repo) => {
      const token = access === "write"
        // Not narrowed: a push touching .github/workflows needs the App's
        // workflows permission, and this token never leaves the Worker.
        ? await workerWriteToken(env, repo)
        : await workerReadToken(env, repo);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
      return fetch(url, { ...init, headers });
    },
  });
}
