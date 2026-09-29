// apps/fleet/src/junior/authz.ts
//
// PR #9 review, blocker B1: /fleet/junior's authorization used to be a
// GitHub label (board.ts's now-removed hasJuniorAuthorizedTask, which checked
// `t.labels.includes(JUNIOR_LABEL)`) — and a studio's own repo-scoped `gh`
// token can add a label to its own issue (`gh issue edit <n> --add-label
// junior`); GitHub never distinguishes who added a label from who the
// Worker's own writer is. That made a studio able to grant ITSELF the very
// permission this gate exists to withhold, which is exactly what studio.md's
// rule ("a studio can never grant itself one") promises can never happen.
//
// The fix: record the maestro's authorization Worker-side, in D1
// (state.ts's fleet_state table — the same generic key/value store other
// flags already use), at the one moment nothing but the maestro's own
// request can reach: board/routes.ts's handleBoard, mounted under
// `/studio/board/` and gated end-to-end by Cloudflare Access (verifyAccess)
// — never by a spawn token a studio holds. See routes.ts's own create-task
// branch for exactly where this gets called, and this file's own two
// functions for the read/write halves.
//
// The `junior` GitHub label keeps existing and keeps getting written
// (board.ts's createTask) — it is still what `fleet task ls`/`show`
// (cli/task-format.ts's `[junior]` marker) reads to show a human the task was
// authorized. That is a DISPLAY use, not a security one, and this file is
// deliberately the only place that decides the real thing.
import { deleteFlag, getFlag, setFlag } from "../state";
import { GitHubError } from "../board/api";
import { TERMINAL_TASK_STATES, type BoardTask } from "../board/types";

function authzKey(repo: string, issueNumber: number): string {
  return `junior-auth:${repo.toLowerCase()}:${issueNumber}`;
}

interface AuthzRecord {
  studioId: string;
}

/**
 * Written exactly once per task, immediately after board/routes.ts's
 * handleBoard successfully creates (or, on an idempotency-key replay, finds)
 * an issue the maestro filed with `junior: true` and a real assignee. Nothing
 * else in this codebase calls this — see this file's own header for why that
 * is the whole of the security property.
 *
 * An upsert (state.ts's setFlag), not an insert-only write: a replayed create
 * (issue #139's lost-response retry) reaching this a second time for the same
 * task/studio is a no-op in substance, and refusing it would need a read this
 * call has no reason to make.
 */
export async function recordJuniorAuthorization(
  db: D1Database, repo: string, issueNumber: number, studioId: string, now: number,
): Promise<void> {
  const record: AuthzRecord = { studioId };
  await setFlag(db, authzKey(repo, issueNumber), JSON.stringify(record), now);
}

/**
 * True only when `studioId` is the EXACT studio the maestro authorized for
 * this task number, in this repo — never inferred from anything a studio's
 * own token could write (a label, an issue comment, its own state).
 *
 * Fails closed on every shape of "not exactly that": no record, a record for
 * a different studio, or a record that is not valid JSON (a hand-edited row,
 * a future schema this build predates) all read as unauthorized, never as a
 * thrown error the caller would have to remember to catch.
 */
export async function isJuniorAuthorized(
  db: D1Database, repo: string, issueNumber: number, studioId: string,
): Promise<boolean> {
  const raw = await getFlag(db, authzKey(repo, issueNumber));
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<AuthzRecord>;
    return parsed.studioId === studioId;
  } catch {
    return false;
  }
}

/**
 * Issue #10: the record ends with the task the maestro authorized. Called when
 * the Worker moves the task to a terminal state (board/routes.ts) and when
 * /fleet/junior finds it reopened (route.ts). Deleting, not flagging: no later
 * relabel or reopen can bring an absent row back, and only the maestro's own
 * create writes one.
 */
export async function revokeJuniorAuthorization(
  db: D1Database, repo: string, issueNumber: number,
): Promise<void> {
  await deleteFlag(db, authzKey(repo, issueNumber));
}

/** Issue #41: records read per sweep call. Each is one GitHub read; the
 *  Worker caps subrequests per request, so a backlog goes in pages. */
export const JUNIOR_SWEEP_PAGE = 40;

/** Issue #35: one record's verdict from sweepJuniorAuthorizations. */
export interface JuniorSweepOutcome {
  number: number;
  outcome: "kept" | "would-revoke" | "revoked" | "error";
  reason: string;
}

/**
 * Issue #35: records written before #25 deployed (or while the webhook was
 * down) can belong to tasks already finished. For every record in `repo`,
 * read the task and revoke when it is closed, reopened, terminal, or gone
 * (404). Dry-run unless `apply`. Revoking is the only write, so a re-run is a
 * no-op and a wrong guess costs a maestro one re-file, never an unearned
 * grant. A read that fails any other way keeps the record and says why.
 */
export async function sweepJuniorAuthorizations(
  db: D1Database, repo: string, getTask: (repo: string, issueNumber: number) => Promise<BoardTask>, apply: boolean,
  page: { limit?: number; after?: number } = {},
): Promise<{ results: JuniorSweepOutcome[]; next: number | null }> {
  const prefix = `junior-auth:${repo.toLowerCase()}:`;
  // LIKE treats `_` as a wildcard and repo names may hold one: the exact
  // prefix check below is what actually decides.
  const rows = await db.prepare(`SELECT key FROM fleet_state WHERE key LIKE ?`).bind(`${prefix}%`).all<{ key: string }>();
  const numbers = rows.results
    .filter((r) => r.key.startsWith(prefix) && /^\d+$/.test(r.key.slice(prefix.length)))
    .map((r) => Number(r.key.slice(prefix.length)))
    .sort((a, b) => a - b);
  // Issue #41: one page past `after`; `next` = the last number read, null
  // once nothing is left. Revoked records vanish, so the cursor is a number.
  const pending = numbers.filter((n) => n > (page.after ?? 0));
  // `limit` only narrows: above the page it would buy past the subrequest cap.
  const batch = pending.slice(0, Math.min(page.limit ?? JUNIOR_SWEEP_PAGE, JUNIOR_SWEEP_PAGE));
  const next = pending.length > batch.length ? batch[batch.length - 1] : null;
  const out: JuniorSweepOutcome[] = [];
  for (const number of batch) {
    let reason: string | null;
    try {
      const task = await getTask(repo, number);
      if (!task.open) reason = "closed";
      else if (task.reopened === true) reason = "reopened";
      else if (task.state !== null && TERMINAL_TASK_STATES.includes(task.state)) reason = task.state;
      else reason = null;
      if (reason === null) {
        out.push({ number, outcome: "kept", reason: task.state === null ? "state drifted (no single state label)" : task.state });
        continue;
      }
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) {
        reason = "task not found";
      } else {
        out.push({ number, outcome: "error", reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    if (apply) {
      await revokeJuniorAuthorization(db, repo, number);
      console.log(`junior sweep: revoked ${repo}#${number} (${reason})`);
    }
    out.push({ number, outcome: apply ? "revoked" : "would-revoke", reason });
  }
  return { results: out, next };
}
