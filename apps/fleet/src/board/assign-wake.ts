// Board issue #41, half one: the edge from "task assigned to studio X" to
// "wake studio X" — for ANY role, not just a maestro.
//
// What was missing, measured twice in one day by two coordinators: four tasks
// filed and assigned to `fleetflare--web-studio` and `fleetflare--release-
// studio` all sat at `submitted` until a human typed the brief into the
// lead's tmux by hand. `wakeMaestro` (src/github/webhook.ts) resolves
// `maestroIdFor(repo)` and wakes THAT studio only; `sweepMaestro`
// (src/studio/sweep.ts) is armed only `if (this.isMaestro())`. A web-studio or
// a release-studio has neither, so from a lead's point of view the board was
// write-only. The machinery already existed — `wakeStudio` on StudioDO. Only
// this edge did not.
//
// It lives on the WORKER side (this module is called from src/board/routes.ts)
// and not in any CLI, because `fleet task assign`, `ff <role> <n>` and
// `fleet task new --studio` all go through the same Worker routes, while a
// CLI-side wake would not fire at all for a task filed by an agent inside a
// container.
//
// Pure over two ports, no Env and no binding — same discipline
// src/board/board.ts keeps, so every rule below is proven with no Durable
// Object, no D1 row and no container.

import type { WakeOutcome } from "../studio/wake";
// The one flatten-and-cap fold, imported rather than re-typed — see that
// module's own doc comment on both exports for why: a title and a --why
// excerpt (board issue #158) are collapsed to one line and capped the exact
// same way, and typing the regex a second time is how the two drift apart.
import { oneLine, COMMENT_EXCERPT, sameRepoSlug } from "../github/wake-events";

/** The two things this edge needs from the rest of the Worker. */
export interface AssignWakeDeps {
  /**
   * The assignee's recorded state in the D1 registry (`running`, `stopped`,
   * `degraded`, ...) AND its own recorded repo (issue #278), or `null` when
   * the fleet holds no row for that id at all.
   *
   * Asked BEFORE the wake and not merged into it, for board #40/#49's reason:
   * `env.STUDIO.idFromName(id)` on a name nothing else uses MINTS A FRESH,
   * EMPTY Durable Object and the call succeeds, so a wake aimed at a studio
   * that does not exist is delivered to a phantom supervising nothing and
   * reports no error. The registry is the only thing that can say "there is
   * no such studio" before that happens. Nothing here ever COMPOSES a studio
   * id — the id arrives already written on the task's own `studio:` label,
   * which src/board/board.ts's assignTask wrote from an id the operator CLI
   * folded through `repoIdSegment` (src/studio/repo.ts). Re-deriving the fold
   * here is exactly the bug #49 fixed.
   *
   * `repoSlug` is the SAME field `StudioStatus.repoSlug` carries
   * (src/studio/types.ts): the `owner/repo` this studio's container actually
   * cloned, or `null` for a studio provisioned before that field existed.
   * Issue #278 reads it to refuse a wake into a studio for the WRONG repo —
   * see `wakeOnAssign`'s own comment for the failure this closes and the
   * fail-open decision on `null`.
   */
  studioState: (studioId: string) => Promise<{ state: string; repoSlug: string | null } | null>;
  /** RPC into that studio's own Durable Object. The DO applies its own
   *  stopped/pane gates (src/studio/wake.ts's runGatedWake) — this port never
   *  types into a container itself. */
  wake: (studioId: string, prompt: string) => Promise<WakeOutcome>;
  /**
   * Issue #284 round 2 (issue #268's own fix, reused rather than re-derived):
   * GitHub's canonical `owner/name` for `slug`, live — see
   * github/wake-events.ts's `sameRepoSlug` (the one caller) and
   * github/api.ts's `resolveCanonicalRepoName` (the one real implementation,
   * wired in routes.ts's `realAssignWake` and webhook.ts's comment-wake
   * deps) for why a live lookup, not a lexical trick, is what a rename or
   * ownership transfer actually needs.
   */
  resolveCanonicalRepo: (slug: string) => Promise<string>;
}

/** Woke it, or did not and why. Reported back to the operator on the assign
 *  response rather than only logged: "nothing happened" is precisely the
 *  failure this issue is about, and a silent non-wake would reproduce it. */
export type AssignWakeReport =
  | { woke: true; digest: string }
  | { woke: false; reason: string };

/**
 * The wake prompt: a POINTER at the task, never a copy of it.
 *
 * Same posture `deltaDigest` (src/github/wake-events.ts) already takes, and
 * for the same two reasons. ONE LINE, always: a literal newline typed into
 * the claude TUI is a SUBMIT, so a two-line digest arrives as several
 * half-prompts. And number-plus-title only: the lead reads the issue itself
 * with the command this line names, which keeps the brief authoritative in
 * one place instead of half-quoted into a keystroke burst.
 *
 * Board issue #158's spec gap: `why` (the operator's `--why` text) is
 * additive-only. Absent, this is byte-identical to the digest before this
 * gap was fixed — the whole reason it is a separate parameter rather than
 * folded into `task`. Present, it is flattened and capped exactly the way
 * `wake-events.ts`'s own comment excerpt is, and inserted BEFORE
 * `| read it:`, so the pointer to the full brief always comes last.
 */
export function assignDigest(task: { number: number; title: string }, why?: string | null): string {
  const title = oneLine(task.title);
  const whyPart = why ? ` | why: ${oneLine(why).slice(0, COMMENT_EXCERPT)}` : "";
  return `WAKE TASK ASSIGNED #${task.number} "${title}"${whyPart} | read it: fleet task show ${task.number}`;
}

/**
 * Wake the studio a task was just assigned to — or, since board #158, the
 * studio that already owns it, when the caller (a coordinator, `fleet task
 * assign`, `ff <role> <n>`) re-pointed the task there anyway. Called from
 * `assignTask`/`createTask`'s `onAssigned` hook (src/board/board.ts), which
 * fires on both a real move and that no-board-write nudge — see the hook's
 * own comment for why those two are NOT the same thing as "assignment
 * unchanged, skip everything."
 *
 * `why` (board issue #158): the operator's `--why` text, threaded through
 * ONLY on the no-op/same-studio path — a real move already writes it into
 * the lineage comment (board.ts's `renderLineageComment`), so passing it here
 * too would be redundant. See `assignDigest`'s own comment for how it is
 * flattened and capped before it reaches the digest.
 *
 * TOTAL on every path, deliberately: the assignment itself has already landed
 * on GitHub by the time this runs, and a failed wake must never turn a
 * successful assignment into an error response. Every failure comes back as a
 * `reason`, in the underlying waker's OWN words where there are any.
 *
 * Issue #278: `task.repo` is checked against the STUDIO'S own recorded
 * `repoSlug` before anything is sent. Measured failure: a task filed/assigned
 * into a studio for a different repo used to wake it anyway — the studio's
 * own DO then resolved the woken task NUMBER against ITS OWN repo (a task
 * number is only unique within one repo), got a 404 from `fleet task show
 * <n>`, and the lead correctly refused. The caller (CLI/Worker) still
 * reported "woke the studio", as if the dispatch had worked. One wasted round
 * trip for something refusable up front. `repoSlug: null` (a studio
 * provisioned before this field existed — no evidence either way) FAILS
 * OPEN, exactly today's behaviour: see this feature's own PR body for why
 * that residual is accepted rather than closed here.
 *
 * Issue #284 round 2: the compare itself is `github/wake-events.ts`'s
 * `sameRepoSlug` (issue #268's own canonical-nameWithOwner match, reused —
 * not a naive `.toLowerCase() !==`), so a studio recorded against a repo's
 * OLD name still matches a task filed against its current one after a
 * rename or ownership transfer.
 */
/** The reason text both `repoMismatchReason`'s "different" case and
 *  `checkAssignRepo`'s "different" case report — pulled into one place so
 *  the write-gate and the wake-gate never drift onto two different wordings
 *  for the identical verdict. */
function repoMismatchMessage(studioId: string, repoSlug: string, taskRepo: string): string {
  return `${studioId} is provisioned for ${repoSlug}, not ${taskRepo} — assigning it a task ` +
    `from a different repo would wake a lead that cannot see it. Assign this task to a studio for ` +
    `${taskRepo} instead.`;
}

async function repoMismatchReason(
  deps: Pick<AssignWakeDeps, "resolveCanonicalRepo">, studioId: string, repoSlug: string | null, taskRepo: string,
): Promise<string | null> {
  if (repoSlug === null) return null;
  const match = await sameRepoSlug(repoSlug, taskRepo, deps.resolveCanonicalRepo);
  if (match === "same") return null;
  const reason = repoMismatchMessage(studioId, repoSlug, taskRepo);
  // Issue #295 bug 2: "unknown" (a canonical lookup failed and left no
  // confirmed match) refuses the WAKE exactly like a genuine "different" —
  // the wake-gate fails closed always. Only the write-gate below
  // (`checkAssignRepo`) treats "unknown" differently.
  return match === "unknown" ? `${reason} (canonical-name lookup failed — refusing the wake to be safe)` : reason;
}

/**
 * Issue #284 round 2: the repo-mismatch half of `wakeOnAssign`'s gate below,
 * split out so `routes.ts` can run it BEFORE `createTask`/`assignTask` write
 * a single label — see this function's one caller (`routes.ts`'s
 * `assignRepoPreflight`) for the failure this closes: a mismatched assign
 * used to still write the `studio:` label (`wakeOnAssign` only runs from
 * board.ts's `onAssigned` hook, fired AFTER that write lands), so the route
 * answered 200 with the refusal buried in a `wake: {woke:false}` field.
 *
 * Deliberately narrower than `wakeOnAssign`: a `stopped` or unregistered
 * studio is not a repo mismatch, and must not block the write pre-emptively
 * — only the wake attempt (still made post-write, unchanged) refuses those.
 * A registry read failure fails OPEN here for the same reason: blocking a
 * WRITE on a transient D1 hiccup is a worse failure than letting it land and
 * having the post-write wake attempt report the same read failure as a
 * `wake: {woke:false}` reason, exactly as it already does today.
 *
 * Issue #295 bug 2: a `resolveCanonicalRepo` lookup failure (`sameRepoSlug`
 * returning `"unknown"`, github/wake-events.ts) gets the SAME fail-open
 * treatment as the registry read above, and for the same reason — blocking a
 * label write on a transient token/network hiccup is strictly worse than the
 * false-409 it would prevent. This is where the write-gate and the wake-gate
 * (`repoMismatchReason`, `wakeOnAssign`, `wakeOnComment` — all fail CLOSED on
 * `"unknown"`) deliberately part ways. Because "wrote anyway despite an
 * undetermined repo" is not nothing, the ok branch carries an optional
 * `warning` — a return value rather than a bare `console.warn` in here, so
 * this stays provable without mocking a global; `routes.ts`'s
 * `assignRepoPreflight` is the one place that turns it into a logged line.
 */
export async function checkAssignRepo(
  deps: Pick<AssignWakeDeps, "studioState" | "resolveCanonicalRepo">, studioId: string, repo: string,
): Promise<{ ok: true; warning?: string } | { ok: false; reason: string }> {
  let studio: { state: string; repoSlug: string | null } | null;
  try {
    studio = await deps.studioState(studioId);
  } catch {
    return { ok: true };
  }
  if (studio === null || studio.repoSlug === null) return { ok: true };

  const match = await sameRepoSlug(studio.repoSlug, repo, deps.resolveCanonicalRepo);
  if (match === "same") return { ok: true };
  if (match === "different") return { ok: false, reason: repoMismatchMessage(studioId, studio.repoSlug, repo) };
  return {
    ok: true,
    warning: `${studioId}: canonical-name lookup failed while checking ${studio.repoSlug} against ${repo} — ` +
      `writing anyway rather than blocking on it (the wake attempt still refuses).`,
  };
}

export async function wakeOnAssign(
  deps: AssignWakeDeps, studioId: string, task: { number: number; title: string; repo: string },
  why: string | null = null,
): Promise<AssignWakeReport> {
  let studio: { state: string; repoSlug: string | null } | null;
  try {
    studio = await deps.studioState(studioId);
  } catch (err) {
    return { woke: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (studio === null) {
    return {
      woke: false,
      reason: `${studioId} is not in the fleet registry — nothing to wake. ` +
        `Spawn it (ff <role> ${task.number}) and it boots on this task.`,
    };
  }
  if (studio.state === "stopped") {
    return {
      woke: false,
      reason: `${studioId} is stopped — no wake was sent, because starting its container costs money ` +
        `silently. Provision it and the task is delivered on bring-up.`,
    };
  }
  const mismatch = await repoMismatchReason(deps, studioId, studio.repoSlug, task.repo);
  if (mismatch !== null) return { woke: false, reason: mismatch };

  const digest = assignDigest(task, why);
  let outcome: WakeOutcome;
  try {
    outcome = await deps.wake(studioId, digest);
  } catch (err) {
    return { woke: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!outcome.ok) return { woke: false, reason: outcome.error ?? "wake failed for an unstated reason" };
  return { woke: true, digest };
}
