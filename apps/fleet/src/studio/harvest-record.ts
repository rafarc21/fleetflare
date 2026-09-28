// Board #316: pure shell builder for the teardown learning harvest, split out
// of do.ts (which imports cloudflare:workers) so a bun test can EXECUTE it
// against a real git fixture — same split as rescue.ts's rescuePushCmd.
/**
 * Task 4 (P5a guardrails): teardown learning harvest. P4 section 8 designed
 * three memory layers (fleet/memory/<studio>/, fleet/memory/shared/,
 * skills/) and none were built; P5 section 9 assigns this one to the exact
 * seam rescue-push (above) already proved out — "the studio writes
 * learnings into its envelope BEFORE the container dies; the Worker commits
 * them. Same kill path as rescue-push, same reason." A Stop hook cannot see
 * a teardown either way.
 *
 * Reads the studio's own done record — the SAME record the completion gate
 * (gates/completion-gate.sh) already demands from every code-writing studio.
 *
 * Board issue #316: one record per task, `<task>.json`, never one shared file
 * every task overwrote. Issue #361: that file lives OUTSIDE the product
 * checkout, in DONE_RECORD_DIR below, never committed -- the gate refuses a
 * branch that commits one.
 *
 * Fix round 1: the gate's own HOWTO now shows `learnings` as one MORE field
 * on the same record — OPTIONAL, never a refusal condition (ruling: a
 * studio that genuinely learned nothing must still be able to finish;
 * `verification_intent` is the mandatory field, `learnings` is the
 * invitation). Most records still carry none — most tasks surface nothing
 * worth a permanent memory file — so "nothing to harvest" stays the
 * expected common case, same as rescue-push's own RESCUE_CLEAN.
 */
export const HARVEST_NO_RECORD = "HARVEST_NO_RECORD";
/** Issue #361: the record dir, OUTSIDE the product checkout -- the same
 *  `/workspace/.fleet/` dir working-set.md lives in, and the one
 *  gates/completion-gate.sh reads ($FLEET_WORKSPACE, /workspace in a studio).
 *  It used to be `/workspace/<repo>/.fleet/done/` (#316), so every task PR
 *  committed its record into the product repo. */
export const DONE_RECORD_DIR = "/workspace/.fleet/done";

// Board #316 (PR #325 review): read EXACTLY the delivered task's record,
// `<task>.json` — never "the newest file" or a sibling's. Unknown task →
// nothing. Never `exit` (shared sandbox-default session), never
// `status --porcelain` (the rescue-push builder's own dispatch marker).
// `_repo` is kept for the callers' shape: the record no longer lives in the
// repo's checkout (#361).
export function harvestRecordCmd(_repo: string, task: number | null): string {
  if (task === null) return `echo "${HARVEST_NO_RECORD}"`;
  const own = `${DONE_RECORD_DIR}/${task}.json`;
  return `if [ -f "${own}" ]; then cat "${own}"; else echo "${HARVEST_NO_RECORD}"; fi`;
}

/**
 * Issue #361: every record in the dir, for the teardown archive
 * (do.ts's archiveDoneRecords) -- one `<task>\t<base64 of the file>` line
 * each, only for `<number>.json` names. base64 so a record's own newlines and
 * tabs survive the line format; `tr -d` because GNU base64 wraps at 76 and
 * BSD's takes no `-w`. No dir or no records → no output. Never `exit`.
 */
export function doneRecordsListCmd(): string {
  return (
    `for f in ${DONE_RECORD_DIR}/*.json; do ` +
    `n=\${f##*/}; n=\${n%.json}; ` +
    `case "$n" in ''|*[!0-9]*) continue ;; esac; ` +
    `[ -f "$f" ] || continue; ` +
    `printf '%s\t%s\n' "$n" "$(base64 < "$f" | tr -d '\n')"; ` +
    `done`
  );
}
