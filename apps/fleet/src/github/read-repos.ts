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
import { deleteFlag, setFlag } from "../state";
import { GitHubError } from "../board/api";
import { TERMINAL_TASK_STATES, type BoardTask } from "../board/types";
import type { Env } from "../env";

export { READ_REPOS_MAX, READ_REPOS_PERMISSIONS };

const KEY_PREFIX = "read-repos:";

function grantKey(repo: string, issueNumber: number): string {
  return `${KEY_PREFIX}${repo.toLowerCase()}:${issueNumber}`;
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

export async function revokeReadReposGrant(db: D1Database, repo: string, issueNumber: number): Promise<void> {
  await deleteFlag(db, grantKey(repo, issueNumber));
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

export interface StudioReadReposDeps {
  getTask: (repo: string, issueNumber: number) => Promise<BoardTask>;
  mint?: typeof mintReadReposToken;
  db?: D1Database;
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
  const repos = [...new Set(sameOwner.flatMap((g) => g.repos))].sort();
  const token = await mint(env, sameOwner[0]!.repo, repos);
  console.log(
    `read-repos: minted read-only token for ${studioId} ` +
    `(tasks ${sameOwner.map((g) => `${g.repo}#${g.number}`).join(", ")}) repos ${repos.join(", ")}`,
  );
  return { token, repos };
}
