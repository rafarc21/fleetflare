/**
 * Issue #7: which GitHub credential a studio holds.
 *
 * "proxy" (the default): the studio gets a READ-only credential for its work
 * repo, and every push and gh write goes through the Worker's /fleet/git and
 * /fleet/gh routes, which scan the text before writing with the Worker's own
 * token. The wrapper gate (#2) cannot be the last line: container root can
 * call the real git/gh/curl with any credential it holds.
 *
 * "direct": the pre-#7 write credential. For every work repo NOT on
 * FLEET_WRITE_PROXY_REPOS (off by default: a deploy changes nothing for a
 * running studio until the operator lists its repo), and for a listed repo
 * CONFIRMED private on the App. A visibility lookup that fails reads as
 * public: fail closed.
 */
import type { Env } from "../env";
import { mintRepoToken, repoOwner, resolveRepoAuthKind } from "../github/auth";

export type WriteMode = "direct" | "proxy";

/** GitHub's `permissions` narrowing for the studio's App token in proxy mode. */
export const STUDIO_READ_PERMISSIONS: Record<string, string> = {
  contents: "read", pull_requests: "read", issues: "read",
};

/** On only for a work repo listed in FLEET_WRITE_PROXY_REPOS (comma or
 *  whitespace separated `owner/name`, case-insensitive). Unset = off. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function writeProxyOn(env: { FLEET_WRITE_PROXY_REPOS?: string }, workRepo: string): boolean {
  const list: string[] = [];
  for (const raw of (env.FLEET_WRITE_PROXY_REPOS ?? "").split(/[\s,]+/)) {
    if (raw === "") continue;
    // A URL or a `.git` suffix would silently match nothing: say so.
    if (!REPO_RE.test(raw) || raw.toLowerCase().endsWith(".git")) {
      console.error(`write proxy: FLEET_WRITE_PROXY_REPOS entry ${JSON.stringify(raw)} is not owner/name -- ignored`);
      continue;
    }
    list.push(raw.toLowerCase());
  }
  return list.includes(workRepo.toLowerCase());
}

/**
 * The mode for a known visibility. `direct` needs BOTH a confirmed-private
 * repo AND the App: its token is scoped to `repositories: [repo]`. A PAT
 * covers every repo of its owner, public ones included, so a PAT studio is
 * always proxied (the scan itself is skipped for a confirmed-private repo).
 */
export function writeModeFor(env: Env, repo: string, isPrivate: boolean): WriteMode {
  if (!writeProxyOn(env, repo)) return "direct";
  return isPrivate && resolveRepoAuthKind(env, repo) === "app" ? "direct" : "proxy";
}

export async function resolveWriteMode(
  env: Env, repo: string, isPrivate: (repo: string) => Promise<boolean>,
): Promise<WriteMode> {
  if (!writeProxyOn(env, repo)) return "direct";
  let priv = false;
  try {
    priv = (await isPrivate(repo)) === true;
  } catch (err) {
    console.error(`write proxy: visibility of ${repo} unknown, treating as public`, err instanceof Error ? err.message : String(err));
  }
  return writeModeFor(env, repo, priv);
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

/** What do.ts's refresh writes into the container for an already-resolved
 *  mode: null = clear it. In proxy mode a failed mint is null too, so a stale
 *  credential never lingers. */
export async function studioCredential(
  env: Env, repo: string, mode: WriteMode, mint: typeof mintRepoToken = mintRepoToken,
): Promise<string | null> {
  if (mode === "direct") return mint(env, repo);
  try {
    return await studioReadToken(env, repo, mint);
  } catch (err) {
    console.error(`write proxy: read token for ${repo} failed, clearing the studio credential`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Any OTHER GitHub token bound for a container (blueprint clone, memory
 * clone, rescue push). App: the repo-scoped mint, narrowed to `permissions`.
 * PAT: `permissions` cannot narrow a PAT, so only a read request is served,
 * from the read PAT; anything else is null. `workRepo` = the studio's own:
 * not on FLEET_WRITE_PROXY_REPOS = the pre-#7 mint, unchanged.
 */
export async function containerToken(
  env: Env, workRepo: string, repo: string, permissions: Record<string, string>,
  mint: typeof mintRepoToken = mintRepoToken,
): Promise<string | null> {
  if (!writeProxyOn(env, workRepo) || resolveRepoAuthKind(env, repo) === "app") return mint(env, repo, { permissions });
  if (!Object.values(permissions).every((v) => v === "read")) return null;
  return studioReadToken(env, repo, mint);
}
