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
import { getFlag, setFlag } from "../state";

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
