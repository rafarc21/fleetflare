// apps/fleet/src/github/read-repos.ts
//
// Issue #291 — a research task may READ sibling repos of its own repo's
// owner. A studio's primary token is minted for its one work repo (auth.ts's
// mintRepoToken), so every sibling answers 404 even though the App is
// installed there. The maestro opts in per task (`--read-repos`); the Worker
// then mints a SECOND token on the studio's normal refresh cycle:
// contents:read + metadata:read, scoped to exactly those repos.
//
// The grant is a Worker-held D1 record (state.ts's fleet_state), never a
// label or a line in the issue body — same reason as src/junior/authz.ts:
// a studio's own `gh` token can edit its own issue, and must not be able to
// grant itself reach into other repos. Only the operator's Access-gated board
// route writes it (board/routes.ts); the studio surface refuses the field.
//
// Lifetime: the record dies with the task. A terminal transition or a
// reassignment deletes it at the route; on every refresh the task is re-read
// and a grant whose task is closed, terminal, reopened or now held by another
// studio is deleted instead of minted — covering the paths (webhook close,
// a merge auto-completing the task) that never pass the route.
import { checkReadRepos, mintReadReposToken, resolveRepoAuthKind, READ_REPOS_MAX, READ_REPOS_PERMISSIONS } from "./auth";
import { deleteFlag, getFlag, setFlag } from "../state";
import { USER_AGENT } from "./app";
import { getStudioStub } from "../studio/profile";
import { GitHubError } from "../board/api";
import { MintTokenError } from "./mint-token-error";
import { TERMINAL_TASK_STATES, type BoardTask } from "../board/types";
import type { Env } from "../env";

export { READ_REPOS_MAX, READ_REPOS_PERMISSIONS };

const KEY_PREFIX = "read-repos:";

function grantKey(repo: string, issueNumber: number): string {
  return `${KEY_PREFIX}${repo.toLowerCase()}:${issueNumber}`;
}

/** PR #292 review item 1: the last mint error already commented on this
 *  grant's task. Its own key (outside the `read-repos:` LIKE prefix), so a
 *  grant row's shape never changes. */
function errorKey(repo: string, issueNumber: number): string {
  return `read-repos-err:${repo.toLowerCase()}:${issueNumber}`;
}

/** The wire field, as the board route receives it. Absent/null/[] = no
 *  opt-in. Anything else must be an array of strings that passes
 *  checkReadRepos against the task's own repo. */
export function parseReadRepos(
  raw: unknown, taskRepo: string,
): { ok: true; repos: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, repos: [] };
  if (!Array.isArray(raw) || !raw.every((r): r is string => typeof r === "string")) {
    return { ok: false, message: "readRepos must be an array of owner/name strings" };
  }
  return checkReadRepos(raw, taskRepo);
}

/** The board route's provider check, so a grant that could never be minted
 *  (a PAT owner, or no auth at all) is refused at filing time instead of
 *  failing every refresh afterwards. null = the App provider, fine. */
export function readReposProviderRefusal(env: Env, taskRepo: string): string | null {
  let kind: string;
  try {
    kind = resolveRepoAuthKind(env, taskRepo);
  } catch (err) {
    kind = err instanceof Error ? err.message : String(err);
  }
  return kind === "app"
    ? null
    : `read-repos needs the GitHub App provider for ${taskRepo} — a fine-grained PAT cannot be narrowed to read-only`;
}

export interface ReadReposGrant {
  repo: string;
  number: number;
  studioId: string;
  repos: string[];
}

/** Upsert: a replayed create (issue #139) or a re-assign writes the same row. */
export async function recordReadReposGrant(
  db: D1Database, repo: string, issueNumber: number, studioId: string, repos: string[], now: number,
): Promise<void> {
  await setFlag(db, grantKey(repo, issueNumber), JSON.stringify({ studioId, repos }), now);
}

/** Deletes the grant; returns the studio that held it (null = none), so the
 *  caller can revoke that studio's live token right away. */
export async function revokeReadReposGrant(db: D1Database, repo: string, issueNumber: number): Promise<string | null> {
  const raw = await getFlag(db, grantKey(repo, issueNumber));
  await deleteFlag(db, grantKey(repo, issueNumber));
  await deleteFlag(db, errorKey(repo, issueNumber));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { studioId?: unknown };
    return typeof parsed.studioId === "string" ? parsed.studioId : null;
  } catch {
    return null;
  }
}

/**
 * PR #292 review item 2: `DELETE /installation/token`, authenticated AS the
 * token being revoked — GitHub's own way to end an installation token before
 * its hour is up. 204 = revoked; 401 = already dead, which is the goal too.
 */
export async function revokeInstallationToken(token: string): Promise<void> {
  const res = await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": USER_AGENT },
  });
  if (!res.ok && res.status !== 401) throw new Error(`installation token revoke failed (${res.status})`);
}

/** Where a studio keeps its last minted read token: its own Durable Object
 *  storage (Worker-side), never the container, which the studio controls. */
export interface ReadTokenStore {
  get(): Promise<string | undefined>;
  put(token: string): Promise<void>;
  delete(): Promise<void>;
}

/**
 * Record the token now in the container (`next`, or null when none) and
 * revoke the one it replaced. Called only AFTER the container write/clear
 * succeeded, so a revoked token is never one the studio still depends on.
 * A revoke failure is logged (never the token) and swallowed: the token
 * still dies at its hour.
 */
export async function swapStoredReadToken(
  store: ReadTokenStore, next: string | null, revoke: (token: string) => Promise<void> = revokeInstallationToken,
): Promise<void> {
  const prev = await store.get();
  if (next === null) await store.delete();
  else await store.put(next);
  if (prev === undefined || prev === next) return;
  try {
    await revoke(prev);
  } catch (err) {
    console.error("read-repos: revoking the previous read token failed; it expires within the hour",
      err instanceof Error ? err.message : String(err));
  }
}

/**
 * PR #292 review item 2, route side: an un-grant tells the studio's Durable
 * Object to revoke its stored read token now. No container exec (a stopped
 * studio is not booted for this); the dead token's helper/file are cleared
 * on its next refresh. Callers kick only when the studio holds no other
 * live grant — otherwise its next refresh re-mints the narrower list.
 */
export async function revokeStudioReadToken(env: Env, studioId: string): Promise<void> {
  await (await getStudioStub(env, studioId)).revokeReadRepos();
}

/** Every grant held for `studioId`. A row that does not parse, or whose
 *  shape is off, is skipped (fail closed — no grant). */
export async function readReposGrantsForStudio(db: D1Database, studioId: string): Promise<ReadReposGrant[]> {
  const rows = await db.prepare(`SELECT key, value FROM fleet_state WHERE key LIKE ?`)
    .bind(`${KEY_PREFIX}%`).all<{ key: string; value: string }>();
  const out: ReadReposGrant[] = [];
  for (const row of rows.results) {
    if (!row.key.startsWith(KEY_PREFIX)) continue;
    const rest = row.key.slice(KEY_PREFIX.length);
    const colon = rest.lastIndexOf(":");
    const repo = rest.slice(0, colon);
    const num = rest.slice(colon + 1);
    if (colon <= 0 || !/^\d+$/.test(num)) continue;
    let parsed: { studioId?: unknown; repos?: unknown };
    try {
      parsed = JSON.parse(row.value) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.studioId !== studioId) continue;
    if (!Array.isArray(parsed.repos) || !parsed.repos.every((r) => typeof r === "string")) continue;
    out.push({ repo, number: Number(num), studioId, repos: parsed.repos as string[] });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}

function grantStillLive(task: BoardTask, studioId: string): boolean {
  if (!task.open || task.reopened === true) return false;
  if (task.state !== null && TERMINAL_TASK_STATES.includes(task.state)) return false;
  return task.assignee === studioId;
}

/** The board comment for a failed read mint. Posted on the task issue,
 *  which may be PUBLIC while the sibling repos are private: only the repo
 *  count and the HTTP status, never a repo name or GitHub's error text. */
export function readReposFailureComment(studioId: string, repoCount: number, err: unknown): string {
  const cause = err instanceof MintTokenError ? `GitHub answered HTTP ${err.status}` : "the grant was refused before reaching GitHub";
  return `read-repos: the read-only token for ${studioId} (${repoCount} ${repoCount === 1 ? "repo" : "repos"}) ` +
    `could not be minted (${cause}), so this studio has no sibling-repo access right now. ` +
    "Its main credential is unaffected. Details are in the Worker log.";
}

export interface StudioReadReposDeps {
  getTask: (repo: string, issueNumber: number) => Promise<BoardTask>;
  mint?: typeof mintReadReposToken;
  /** PR #292 review item 1: tell the granting task the read token failed.
   *  Absent = log only. */
  comment?: (repo: string, issueNumber: number, body: string) => Promise<unknown>;
  db?: D1Database;
}

/** GitHub's canonical casing, kept only when it is the same owner and a
 *  plain owner/name (defense in depth: it reaches a shell command). */
function canonicalFor(canonical: string[], taskRepo: string): string[] {
  return canonical.filter((name) => {
    const c = checkReadRepos([name], taskRepo);
    return c.ok;
  });
}

/**
 * The refresh cycle's port (studio/do.ts's refreshDeps().readRepos): null =
 * no live grant, so the container's read helper is cleared and NO token is
 * minted. Otherwise one read-only token over the union of this studio's live
 * grants, plus the repo list the helper is scoped to.
 *
 * Grants are grouped by their task repo's owner and only the FIRST owner's
 * union is minted: one token comes from one installation, and every grant
 * was already checked same-owner against its own task repo at the route. A
 * studio works one repo, so in practice there is one owner.
 *
 * Audit: one log line per mint naming the studio, each granting task and
 * the repo list. The token itself is never logged.
 */
export async function studioReadReposCredential(
  env: Env, studioId: string, deps: StudioReadReposDeps,
): Promise<{ token: string; repos: string[] } | null> {
  const db = deps.db ?? env.DB;
  const mint = deps.mint ?? mintReadReposToken;
  const live: ReadReposGrant[] = [];
  for (const grant of await readReposGrantsForStudio(db, studioId)) {
    let task: BoardTask;
    try {
      task = await deps.getTask(grant.repo, grant.number);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) {
        await revokeReadReposGrant(db, grant.repo, grant.number);
        console.log(`read-repos: revoked ${grant.repo}#${grant.number} for ${studioId} (task not found)`);
      } else {
        console.error(`read-repos: cannot confirm ${grant.repo}#${grant.number} for ${studioId}, skipped this cycle`,
          err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    if (!grantStillLive(task, studioId)) {
      await revokeReadReposGrant(db, grant.repo, grant.number);
      console.log(`read-repos: revoked ${grant.repo}#${grant.number} for ${studioId} (task no longer live for it)`);
      continue;
    }
    live.push(grant);
  }
  if (live.length === 0) return null;
  const owner = live[0]!.repo.split("/")[0];
  const sameOwner = live.filter((g) => g.repo.split("/")[0] === owner);
  const granted = [...new Set(sameOwner.flatMap((g) => g.repos))].sort();
  const tasks = sameOwner.map((g) => `${g.repo}#${g.number}`).join(", ");
  let minted: { token: string; canonical: string[] };
  try {
    minted = await mint(env, sameOwner[0]!.repo, granted);
  } catch (err) {
    // PR #292 review item 1: never fatal. The caller clears the helper and
    // the primary credential is untouched; the task hears about it once per
    // distinct error, not on every 50-minute refresh.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`read-repos: read-only token for ${studioId} (tasks ${tasks}) not minted, skipped: ${message}`);
    for (const g of sameOwner) {
      try {
        if ((await getFlag(db, errorKey(g.repo, g.number))) === message) continue;
        // PR #292 review round 2: the task issue may be public. No repo
        // name and no GitHub text — those stay in the Worker log above.
        await deps.comment?.(g.repo, g.number, readReposFailureComment(studioId, granted.length, err));
        await setFlag(db, errorKey(g.repo, g.number), message, Date.now());
      } catch (commentErr) {
        console.error(`read-repos: could not comment on ${g.repo}#${g.number}`,
          commentErr instanceof Error ? commentErr.message : String(commentErr));
      }
    }
    return null;
  }
  for (const g of sameOwner) await deleteFlag(db, errorKey(g.repo, g.number));
  const repos = [...new Set([...granted, ...canonicalFor(minted.canonical, sameOwner[0]!.repo)])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  console.log(`read-repos: minted read-only token for ${studioId} (tasks ${tasks}) repos ${repos.join(", ")}`);
  return { token: minted.token, repos };
}
