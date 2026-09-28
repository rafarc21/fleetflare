/**
 * Issue #7: which GitHub credential a studio holds.
 *
 * "proxy" (the default): the studio gets a READ-only credential for its work
 * repo, and every push and gh write goes through the Worker's /fleet/git and
 * /fleet/gh routes, which scan the text before writing with the Worker's own
 * token. The wrapper gate (#2) cannot be the last line: container root can
 * call the real git/gh/curl with any credential it holds.
 *
 * "direct": the pre-#7 write credential. Only for a work repo CONFIRMED
 * private (the leak gate is off there too, see provision.ts's applyLeakGate)
 * or with the operator kill switch FLEET_WRITE_PROXY=off. A visibility lookup
 * that fails reads as public: fail closed.
 */
import type { Env } from "../env";
import { mintRepoToken, repoOwner, resolveRepoAuthKind } from "../github/auth";

export type WriteMode = "direct" | "proxy";

/** GitHub's `permissions` narrowing for the studio's App token in proxy mode. */
export const STUDIO_READ_PERMISSIONS: Record<string, string> = {
  contents: "read", pull_requests: "read", issues: "read",
};

export function writeProxyOn(env: { FLEET_WRITE_PROXY?: string }): boolean {
  return env.FLEET_WRITE_PROXY !== "off";
}

export async function resolveWriteMode(
  env: { FLEET_WRITE_PROXY?: string }, repo: string, isPrivate: (repo: string) => Promise<boolean>,
): Promise<WriteMode> {
  if (!writeProxyOn(env)) return "direct";
  try {
    return (await isPrivate(repo)) === true ? "direct" : "proxy";
  } catch (err) {
    console.error(`write proxy: visibility of ${repo} unknown, treating as public`, err instanceof Error ? err.message : String(err));
    return "proxy";
  }
}

/** An owner's own read-only PAT: `example-org` -> `GITHUB_READ_TOKEN_EXAMPLE_ORG`.
 *  Same shape as auth.ts's tokenEnvName. */
export function readTokenEnvName(owner: string): string {
  return `GITHUB_READ_TOKEN_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

type DynamicEnv = Readonly<Record<string, unknown>>;

/**
 * The studio's read credential in proxy mode. App: the usual repo-scoped mint,
 * narrowed to read. PAT: the owner's read PAT, else GITHUB_READ_TOKEN, else
 * null (anonymous) -- a fine-grained PAT cannot be narrowed after issue, and
 * the write PAT must never reach the container.
 */
export async function studioReadToken(
  env: Env, repo: string, mint: typeof mintRepoToken = mintRepoToken,
): Promise<string | null> {
  if (resolveRepoAuthKind(env, repo) === "app") {
    return mint(env, repo, { permissions: STUDIO_READ_PERMISSIONS });
  }
  const dyn = env as unknown as DynamicEnv;
  for (const name of [readTokenEnvName(repoOwner(repo)), "GITHUB_READ_TOKEN"]) {
    const v = dyn[name];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/** What do.ts's refresh writes into the container: null = clear it. */
export async function studioCredential(
  env: Env, repo: string,
  deps: { isPrivate: (repo: string) => Promise<boolean>; mint?: typeof mintRepoToken },
): Promise<string | null> {
  const mint = deps.mint ?? mintRepoToken;
  if (await resolveWriteMode(env, repo, deps.isPrivate) === "direct") return mint(env, repo);
  return studioReadToken(env, repo, mint);
}
