/**
 * Maestro waker — the one place that turns "something happened" into a turn
 * for a Claude session that would otherwise never get one.
 *
 * A studio's claude runs in tmux window `studio:claude` (created by
 * container/studio-bringup.sh). The ONLY way into it from the Worker is the
 * same thing a human does when attached: type into that window. `sbExec`
 * gives the Worker a shell in the container, so `tmux send-keys` is the
 * whole mechanism. No new channel, no new port.
 */

import { detectLimitOnScreen, limitBlockKey, RATE_LIMIT_HEADLINES } from "./failover";
import { DESTROY_IN_FLIGHT } from "./provision";
import { parseResetUtc, formatRateLimited, type LimitSighting } from "./rate-limit";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";

/**
 * Addressed by NAME, never by index. Live studios accumulate windows (bring-up's
 * own `shell`, an operator's extras) and `fleet attach` leaves whichever one it
 * left active — provisionedCheckCmd (provision.ts) keys on the same name for the
 * same reason. `window 0` is only true on a container nobody has touched.
 */
export const WAKE_TARGET = "studio:claude";

/** Beat between typing the prompt and submitting it. The TUI reads the two
 *  send-keys calls as one paste followed by a submit; with no gap the Enter
 *  can land inside the paste burst and submit a partial line. The operator's
 *  own probe (~/.fleet/probe/send.ts) waits 1.2s between the two for exactly
 *  this reason. */
const SUBMIT_GAP_SECONDS = 1;

/** POSIX single-quoting: the only quoting that is total. Everything inside a
 *  single-quoted string is literal, so the sole case to handle is the quote
 *  itself — closed, escaped, reopened. A GitHub issue title carrying `$`, a
 *  backtick or a `;` reaches the container as text, never as shell. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Flattened to ONE line, always. In the claude TUI a literal newline is a
 * SUBMIT, not a line break: a two-line prompt sent with `send-keys -l` would
 * submit its first line as a whole turn and leave the rest as the start of
 * the next one. Callers therefore cannot express a multi-line wake, and this
 * makes that structural rather than a rule someone has to remember.
 */
export function flattenPrompt(prompt: string): string {
  return prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * Issue #136: the wake gate's LOOSE screen check. Failover's detector
 * (failover.ts) is strict on purpose — a false positive there kills a working
 * lead. Here the bias leans the other way: a false negative can press Enter
 * on "❯ 1. Upgrade your plan". But a false positive is not free either — an
 * idle screen never changes, so every later wake is refused too, until a
 * human attaches (#141 review).
 *
 * So the check is anchored on MODAL ROWS, never phrases: within the bottom
 * LOOSE_TAIL_LINES non-blank rows, a row that IS
 *   - the select footer "Enter to confirm · Esc to cancel",
 *   - the permission-prompt footer "Esc to cancel · Tab to amend · ctrl+e to
 *     explain" (#144 — claude draws a DIFFERENT footer for an ordinary
 *     permission prompt, "Do you want to proceed? / ❯ 1. Yes / 2. No", than
 *     for the limit/select modal above; failover.ts's strict detector
 *     already knows both shapes as alternatives in MODAL_FOOTER_LINE, this
 *     loose gate did not),
 *   - "(Run )/rate-limit-options" at the start of the row, or
 *   - a #53 headline as the whole row,
 * optionally inside a box border (a cursor only after a border). claude's
 * composer row starts with `❯` at column 0, so it never matches whole-row:
 * ghost suggestions ("❯ What do you want to do next?") and the wake's own
 * typed text cannot trip it. Rows are NOT found by stripping "the ❯ line":
 * a modal whose cursor sits at column 0 would lose its footer that way.
 *
 * POSIX ERE, C-locale safe, one list for both sides: the container's
 * `grep -E` reads it as is; the Worker swaps `[[:space:]]` for `\s`
 * (looseLimitOnScreen). `(│)?`, never `│?` — in the C locale `?` would bind
 * to the last BYTE of `│`. No `\s`, `\b` or `{n,}`. `ctrl\\+e`, never
 * `ctrl\+e`: these patterns are JS STRING literals (fed to both `grep -E`
 * and `new RegExp`), not regex literals — `\+` in a JS string is an
 * unrecognized escape and silently collapses to a bare `+` (one-or-more),
 * losing the literal match entirely; the doubled backslash is what actually
 * reaches the string's contents as `\+`.
 *
 * Inline limit headlines ("You've hit your session limit · resets …") are
 * NOT here: typing under one lands in claude's input box, which is harmless,
 * and a block left on screen after its reset would otherwise block every
 * wake. The strict detector plus #106's staleness rule decides those.
 */
const ROW_LEAD = "^[[:space:]]*(│[[:space:]]*(❯[[:space:]]*)?)?";
const ROW_TAIL = "[[:space:]]*(│)?[[:space:]]*$";
export const LOOSE_LIMIT_PATTERNS: readonly string[] = [
  `${ROW_LEAD}Enter to confirm · Esc to cancel${ROW_TAIL}`,
  `${ROW_LEAD}Esc to cancel · Tab to amend · ctrl\\+e to explain${ROW_TAIL}`,
  `${ROW_LEAD}(Run )?/rate-limit-options`,
  `${ROW_LEAD}(${RATE_LIMIT_HEADLINES.join("|")})${ROW_TAIL}`,
];
export const LOOSE_TAIL_LINES = 12;

const LOOSE_JS = LOOSE_LIMIT_PATTERNS.map((p) => new RegExp(p.replaceAll("[[:space:]]", "\\s")));

/** The first bottom row matching LOOSE_LIMIT_PATTERNS, or null. */
export function looseLimitOnScreen(screen: string): string | null {
  const tail = screen.split("\n").filter((l) => l.trim() !== "").slice(-LOOSE_TAIL_LINES);
  return tail.find((l) => LOOSE_JS.some((re) => re.test(l)))?.trim() ?? null;
}

/** Prefix of the one verdict line the in-container guard prints. */
export const WAKE_VERDICT = "__FLEET_WAKE__";

/**
 * Issue #249 round-2 review, item 3 — HOW THE INPUT BOX IS FOUND.
 *
 * claude's input box draws its cursor as `❯` at the start of the row, at
 * column 0 or just inside a box border. Measured, from this repo's own real
 * captures (test/fixtures/rate-limit-panes.ts): an empty box is the row `❯`,
 * and a box holding a draft is `❯ check on task 2 progress`.
 *
 * Same POSIX-ERE, C-locale-safe discipline LOOSE_LIMIT_PATTERNS above is
 * written under — `(│[[:space:]]*)?` with the `?` bound to a GROUP, never to
 * the last byte of a multibyte `│`.
 */
const COMPOSER_ROW = "^[[:space:]]*(│[[:space:]]*)?❯";

/**
 * Issue #249 round-2 review, item 3 — how much of the typed prompt the submit
 * check looks for.
 *
 * Short on purpose. It has to be long enough that nothing else claude draws
 * could coincide with it (16 characters of a real wake is `WAKE TASK #249 …` or
 * `What survived, f…`) and short enough that the input box cannot WRAP inside
 * it, which would break a fixed-string match. A box narrower than ~18 columns
 * is not a box a lead is working in.
 */
export const SUBMIT_FRAGMENT_CHARS = 16;

/** The leading slice of a flattened prompt the submit check greps for. */
export function submitFragment(prompt: string): string {
  return flattenPrompt(prompt).slice(0, SUBMIT_FRAGMENT_CHARS);
}

/**
 * Issue #249 round-2 review, item 3 — pane text that can share the input box
 * with nothing in it, and must therefore never be read as an unsent draft.
 *
 * Both are claude's own hints rather than content: `Press up to edit queued
 * messages` appears once a message has been ACCEPTED into the queue (i.e. on
 * exactly the submit this check is confirming), and `Image in clipboard` is a
 * clipboard notice that survives a submit. Reading either as "the draft is still
 * sitting there" would turn a landed wake into a reported failure — and, with
 * issue #249's own bounded retry behind it, into a duplicate brief typed at a
 * lead that already has one.
 *
 * Named here, and pinned by test (test/studio.wake.test.ts,
 * test/bun/wake-submit-check.test.ts), rather than stripped out of the row: the
 * check below asks whether THIS WAKE'S OWN TEXT is still in the box, so no hint
 * can be mistaken for it by construction. A strip list would have been the
 * weaker answer — it would have handled exactly these two strings and still
 * misread claude's GHOST SUGGESTIONS (`❯ What do you want to do next?`,
 * `❯ 1. Upgrade deps`), which this repo's own wake lane
 * (test/bun/wake-guard.test.ts, PR #144's N8 pins) proves appear in an empty
 * composer and must not block a wake.
 */
export const SUBMIT_HINT_TEXT: readonly string[] = [
  "Press up to edit queued messages",
  "Image in clipboard",
];

/**
 * Issue #249 round-2 review, item 3 — THE SUBMIT CONFIRMATION, as one shell
 * function for `wakeCmd` below to call.
 *
 * THE BUG IT FIXES, exactly: `wakeCmd` pressed Enter and printed `sent` on the
 * strength of `send-keys` having exited 0. That exit code means tmux delivered a
 * keystroke to a pane; it says nothing whatsoever about the TUI having accepted
 * it as a SUBMIT. A prompt left sitting in the composer was therefore reported
 * as delivered, and every caller wrote its at-most-once dedup marker on that
 * report — for issue #249's survival re-brief that is #107's original silent
 * loss reproduced by the code meant to fix it, and for board #229's task pointer
 * it is a task that stays `submitted` while the row claims delivery.
 *
 * THE QUESTION IT ASKS is "is the text THIS WAKE TYPED still in the input box",
 * not "is the input box empty". The difference is the whole design:
 *  - claude draws GHOST SUGGESTIONS in an EMPTY composer (`❯ What do you want to
 *    do next?`), measured and pinned in test/bun/wake-guard.test.ts. An
 *    emptiness test reads those as an unsent draft and reports every wake on an
 *    idle lead as a failure.
 *  - claude's own hints (SUBMIT_HINT_TEXT above) sit in the box too, and one of
 *    them appears on exactly the submit being confirmed.
 *  - a SUBMITTED prompt is echoed into the transcript ABOVE the box, so a
 *    whole-pane search for the text would read every landed wake as a draft.
 * Matching this wake's own leading fragment against the LAST composer row and
 * the rows below it (where the box's continuation lines go when a long prompt
 * wraps) answers all three at once.
 *
 * Prints nothing; ANSWERS IN ITS EXIT CODE, the same three-way convention
 * `__ffw_scan` uses and for the same reason (a `case $?` at the call site keeps
 * the whole thing one shell, with no Worker round trip in the middle):
 *   0 — the typed text is GONE from the box. The prompt was accepted.
 *   1 — it is still there. A genuine unsent draft.
 *   2 — UNREADABLE: no capture, no composer row, or a failed pipeline.
 *
 * FAIL CLOSED on 2, the opposite bias to `__ffw_scan`'s, deliberately. An
 * unreadable SCAN must refuse to type (a modal might be open); an unreadable
 * SUBMIT CHECK must refuse to claim success, because the two errors do not cost
 * the same. Wrongly reporting failure costs at most one duplicate message,
 * bounded by the caller's own retry bound (SURVIVAL_RETRY_MAX_ATTEMPTS,
 * survival-delivery.ts). Wrongly reporting success costs the message entirely,
 * with a dedup marker written to make sure nothing ever retries it — which is
 * the error this review item exists to stop.
 *
 * RESIDUAL, stated rather than hidden: a prompt long enough that claude scrolls
 * its own input box would push the leading fragment out of view, and this check
 * would read the remaining draft as submitted. Wakes are single-line pointers
 * and briefs of a few short lines, so the box grows rather than scrolls; and the
 * bias of that residual is the pre-#249 behaviour, never worse than it.
 */
function submitCheck(fragment: string): string {
  const f = shellQuote(fragment);
  return (
    `__ffw_submitted() { __ffw_sc=$(${STUDIO_TMUX} capture-pane -p -t ${WAKE_TARGET}) || return 2; ` +
    // The LAST composer row: after a submit, the live box is the bottom one and
    // the transcript's echo of the prompt is above it.
    `__ffw_box=$(printf '%s\\n' "$__ffw_sc" | grep -n -E -e ${shellQuote(COMPOSER_ROW)} | tail -n 1); ` +
    `[ -n "$__ffw_box" ] || return 2; ` +
    // `grep -n` prefixes `<line>:`, so the box's own row number is everything
    // before the first colon — POSIX parameter expansion, no `cut` subshell.
    '__ffw_from=$(printf \'%s\\n\' "$__ffw_sc" | tail -n +"${__ffw_box%%:*}") || return 2; ' +
    `printf '%s\\n' "$__ffw_from" | grep -F -q -e ${f}; ` +
    `case $? in 0) return 1;; 1) return 0;; *) return 2;; esac; }`
  );
}

/**
 * The wake, as ONE shell command for `sbExec`, with the screen check INSIDE
 * it (issue #136). Before, the Worker read the screen in one exec and typed
 * in another: a modal drawn in between — a second wake's Enter raising it on
 * an exhausted account — got the Enter. Now, in one shell, with no Worker
 * round trip in between:
 *
 *   1. scan the pane (LOOSE_LIMIT_PATTERNS); a hit types nothing;
 *   1b. issue #249 round-2 review — WHEN `clearDraftFirst`, C-u: a stuck
 *      unconfirmed draft left by this same caller's own prior attempt (see
 *      that param's own doc comment) sits at the cursor, and typing the new
 *      prompt on top of it would run the two together into one unreadable,
 *      doubled message. Gated behind step 1's clean scan exactly like the
 *      typed text below it — this repo's one rule for this pane is "nothing
 *      but the initial scan decides what may reach it while a modal might be
 *      open", and C-u is no exception;
 *   2. type the text (`-l`: literally — a word like `Enter` stays a word);
 *   3. wait SUBMIT_GAP_SECONDS (the TUI reads text + Enter as paste + submit);
 *   4. scan AGAIN; a modal that appeared gets no Enter — and nothing else
 *      either: no Esc, no C-u, no digit is ever sent to a modal;
 *   5. Enter;
 *   6. issue #249 round-2 item 3 — wait SUBMIT_GAP_SECONDS and CONFIRM the
 *      input box emptied (`__ffw_submitted`, above). `send-keys` exiting 0
 *      proves a keystroke was delivered, not that the TUI took it as a submit;
 *   7. a genuine draft still sitting there: scan for a modal once more, then
 *      ONE bare Enter, then confirm again;
 *   8. still drafted (or unreadable, or a modal appeared): the verdict is
 *      `unconfirmed`, NOT `sent`, so no caller writes an at-most-once dedup
 *      marker against a message the lead never received.
 *
 * Two residual windows, stated rather than hidden:
 *   A. step 1 → 2: a modal drawn after the first scan, before the text
 *      lands, receives the typed text — digits included. No Enter follows
 *      (step 4 catches it), but a digit alone can pick an option in a select
 *      modal. One `grep` + one `send-keys` long; single-flight (below) removes
 *      the known trigger, a second wake's Enter raising the modal.
 *   B. step 4 → 5: one `grep` long; a modal drawn there gets the Enter.
 * It prints ONE verdict
 * line (WAKE_VERDICT …) that runWake reads. A pane it cannot read fails the
 * command (`false`, never `exit`: this runs in the container's long-lived
 * session shell, and `exit` would kill it), so a gone window still fails
 * loudly with tmux's own stderr.
 */
export function wakeCmd(prompt: string, clearDraftFirst = false): string {
  const q = shellQuote(flattenPrompt(prompt));
  const clear = clearDraftFirst ? `${STUDIO_TMUX} send-keys -t ${WAKE_TARGET} C-u && ` : "";
  const es = LOOSE_LIMIT_PATTERNS.map((p) => `-e ${shellQuote(p)}`).join(" ");
  // Fail CLOSED (#141 review): a capture, sed, tail or grep error is
  // UNREADABLE (2), never clean. grep: 0 = a modal row, 1 = none, else error.
  const scan =
    `__ffw_scan() { __ffw_c=$(${STUDIO_TMUX} capture-pane -p -t ${WAKE_TARGET}) || return 2; ` +
    `__ffw_t=$(printf '%s\\n' "$__ffw_c" | sed '/^[[:space:]]*$/d') || return 2; ` +
    `__ffw_t=$(printf '%s\\n' "$__ffw_t" | tail -n ${LOOSE_TAIL_LINES}) || return 2; ` +
    `__ffw_row=$(printf '%s\\n' "$__ffw_t" | grep -E -m 1 ${es}); ` +
    `case $? in 0) return 1;; 1) return 0;; *) return 2;; esac; }`;
  const verdict = (phase: string, r: string) =>
    `if [ "$__ffw_r" = 1 ]; then echo "${WAKE_VERDICT} refused-${phase} modal: $__ffw_row"; ` +
    `elif [ "$__ffw_r" != 0 ]; then echo '${WAKE_VERDICT} refused-${phase} unreadable'; false; ` +
    `else ${r}; fi`;
  const enter = `${STUDIO_TMUX} send-keys -t ${WAKE_TARGET} Enter`;
  const unconfirmed = (why: string) => `echo '${WAKE_VERDICT} unconfirmed ${why}'`;
  const sent = `echo '${WAKE_VERDICT} sent'`;
  // Issue #249 round-2 item 3, steps 6-8 (see this function's own doc comment):
  // confirm the box emptied, and on a genuine draft rescan for a modal and send
  // ONE bare Enter. The rescan is not optional — a modal drawn in the second
  // between the Enter and this check would otherwise receive the second Enter,
  // which is the one keystroke #136 exists to prevent. A modal there means the
  // wake is UNCONFIRMED, never a forced Enter.
  const submit =
    `${enter} && sleep ${SUBMIT_GAP_SECONDS} && { __ffw_submitted; __ffw_s=$?; ` +
    `if [ "$__ffw_s" = 0 ]; then ${sent}; ` +
    `elif [ "$__ffw_s" = 1 ]; then { __ffw_scan; __ffw_r=$?; ` +
    `if [ "$__ffw_r" = 0 ]; then ${enter} && sleep ${SUBMIT_GAP_SECONDS} && { __ffw_submitted; __ffw_s=$?; ` +
    `if [ "$__ffw_s" = 0 ]; then ${sent}; else ${unconfirmed("still-drafted")}; fi; }; ` +
    `else ${unconfirmed("modal-before-resubmit")}; fi; }; ` +
    `else ${unconfirmed("unreadable")}; fi; }`;
  return withStudioTmux([
    scan,
    submitCheck(submitFragment(prompt)),
    `__ffw_scan; __ffw_r=$?`,
    verdict("before",
      `${clear}${STUDIO_TMUX} send-keys -t ${WAKE_TARGET} -l -- ${q} && sleep ${SUBMIT_GAP_SECONDS} && { __ffw_scan; __ffw_r=$?; ` +
      verdict("after", submit) + `; }`),
  ].join("\n"));
}

/**
 * Issue #249 round-2 item 3 — the submit check ALONE, as a runnable command,
 * exported for ONE reason: `test/bun/wake-submit-check.test.ts` runs this exact
 * shell against a REAL tmux server holding a real pane.
 *
 * Nothing in the Worker calls it. `wakeCmd` above builds its own copy from the
 * same `submitCheck` function over the same `submitFragment(prompt)`, so what
 * that test proves is what the wake runs. Same seam PANE_PROBE_CMD/
 * PANE_SCREEN_CMD below already are: a shell string a test can execute, rather
 * than shell logic only ever asserted as source text.
 *
 * Takes the PROMPT, not a fragment, so a test cannot accidentally pin a
 * different slice of it than the wake does.
 *
 * Prints `SUBMIT <code>` — 0 the typed text is gone, 1 still drafted,
 * 2 unreadable.
 */
export function submitCheckCmd(prompt: string): string {
  return withStudioTmux([submitCheck(submitFragment(prompt)), `__ffw_submitted; echo "SUBMIT $?"`].join("\n"));
}

/** The container-exec port, the same `sbExec`-shaped seam every other studio
 *  subsystem takes (ProvisionDeps.sbExec, SessionSyncDeps.exec). */
export type WakeExec = (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WakeOutcome {
  ok: boolean;
  /** tmux's own words on failure, or the thrown message. Never a rewrite. */
  error?: string;
  /** Set on DELIBERATE refusals: gate 1 (stopped, never provisioned,
   *  destroy in flight, #100 F5), gate 3 (a limit or select modal on screen,
   *  #99), the in-container guard (#136) and single-flight (#136). The gate
   *  WORKING, not a failure: callers log it at info, never as an error. */
  skipped?: true;
}

/**
 * Issue #100 F5: the one logging rule the webhook and spawn wakes share. A
 * deliberate skip is info (once per GitHub event per stopped maestro, as an
 * error, it buried every real failure); a failed wake is an error; a landed
 * wake says nothing.
 */
export function logWakeOutcome(label: string, outcome: WakeOutcome): void {
  if (outcome.ok) return;
  if (outcome.skipped) console.log(`${label} skipped: ${outcome.error ?? "no reason given"}`);
  else console.error(`${label} failed: ${outcome.error ?? "unknown"}`);
}

/**
 * Issue #249 round-2 item 3 — the three ways a submit can come back
 * unconfirmed, in the words a Worker tail needs. Each one names the state the
 * pane was left in, because that is what an operator has to act on: the text
 * IS in the container's input box either way, and the difference is whether a
 * bare Enter would finish the job or whether a modal has to be dismissed first.
 */
function unconfirmedSubmitError(why: string): string {
  const common = `no dedup marker written, so the caller retries`;
  switch (why) {
    case "still-drafted":
      return `submit unconfirmed: the prompt is still sitting in ${WAKE_TARGET}'s input box after Enter ` +
        `and one bare Enter more; ${common}. The text is in the box — attach and press Enter to send it.`;
    case "modal-before-resubmit":
      return `submit unconfirmed: the prompt did not submit and a limit or select modal appeared before the ` +
        `retry Enter, so no second keystroke was sent; ${common}.`;
    case "unreadable":
      return `submit unconfirmed: ${WAKE_TARGET}'s input box could not be read after Enter, so the prompt ` +
        `is not proven submitted; ${common}.`;
    default:
      return `submit unconfirmed (${why || "no reason given"}); ${common}.`;
  }
}

/**
 * Type one prompt into the studio's claude window and submit it.
 *
 * TOTAL — never throws, on any path. Both callers need that: the webhook
 * branch must return 200 past the signature gate (a throw becomes a 500 that
 * GitHub retries), and the sweep's `finally` must reach its reschedule.
 * Failure is a returned value, so both can log it and carry on.
 */
export async function runWake(exec: WakeExec, prompt: string, clearDraftFirst = false): Promise<WakeOutcome> {
  const flat = flattenPrompt(prompt);
  if (!flat) return { ok: false, error: "refused: empty wake prompt" };
  try {
    const res = await exec(wakeCmd(flat, clearDraftFirst));
    // Issue #136: the guard inside the command refused. Deliberate, so a
    // skip — and it says exactly which keystrokes did NOT happen.
    const guard = res.stdout.match(new RegExp(`${WAKE_VERDICT} refused-(before|after) modal`));
    if (guard) {
      return {
        ok: false, skipped: true,
        error: guard[1] === "before"
          ? `limit or select text appeared in ${WAKE_TARGET} before typing; nothing typed`
          : `a limit or select modal appeared in ${WAKE_TARGET} while typing; no Enter sent (text left in the input, nothing sent to the modal)`,
      };
    }
    if (res.code !== 0) {
      return { ok: false, error: `wake failed (${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}` };
    }
    // Issue #249 round-2 item 3: the submit confirmation said the prompt is
    // still sitting in the input box (or could not be confirmed at all).
    //
    // NOT a `skipped`. A skip is the gate WORKING and says which keystrokes did
    // NOT happen; this is the opposite — the keystrokes DID happen and the
    // message still is not in front of the lead, with a draft left in the pane
    // for a human to find. That is worth an error line, and it is what keeps
    // every caller's at-most-once dedup marker unwritten.
    const draft = res.stdout.match(new RegExp(`${WAKE_VERDICT} unconfirmed (\\S+)`));
    if (draft) return { ok: false, error: unconfirmedSubmitError(draft[1] ?? "") };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- board issue #41, half one: the gated wake --------------------------
//
// `runWake` above is unconditional by design — it does not itself decide
// whether a wake is owed, so it never throws and never refuses. Board issue
// #82: for a while `StudioDO.wakeStudio` (do.ts) called it directly, on the
// theory that its callers (the webhook's wakeMaestro, notifyMaestro, and the
// `POST /studio/:id/wake` route) had each already decided a wake was owed —
// they had not, so a webhook delivery alone could resurrect a stopped
// studio's container and bill for it. `wakeStudio` now runs the SAME gates
// below (via `runGatedWake`) that a board-assignment wake always has,
// reusing this exact function rather than a second copy of its logic.
// Issue #99 review: `sweepMaestro` (do.ts) was the last caller of the raw
// `runWake`. Its own `isStopped` check covered gate 1 only, so a sweep typed
// into a bash pane or a usage-limit modal. It now goes through `sweepWake`,
// i.e. every gate below. Nothing in the Worker calls `runWake` except
// `runGatedWake` itself.

/**
 * The pane probe. The SAME signal `provisionedCheckCmd` (provision.ts) reads,
 * addressed at the SAME window BY NAME, deliberately reusing it rather than
 * inventing a second liveness test that could disagree with the first:
 * `pane_current_command` reads `claude` exactly when the claude TUI owns the
 * pane and `bash` exactly when nothing is running in it.
 *
 * INVISIBLE, for provisionedCheckCmd's own stated reason: `display-message -p
 * -t studio:claude` does not require the window to be active and switches
 * nothing, so probing before a wake leaves no trace an operator attaching
 * later could misread as a dead studio. Verified against a real tmux in
 * test/bun/pane-probe.test.ts, which leaves a DIFFERENT window active and
 * asserts the probe did not move it.
 *
 * `#{session_name}:#{window_name}` is printed ALONGSIDE the command, and it is
 * load-bearing rather than decoration. MEASURED against tmux 3.2a: when
 * `studio:claude` does NOT exist, `display-message -p -t studio:claude`
 * silently answers about the CURRENT pane and exits 0 — no error, no stderr,
 * nothing to distinguish it from a healthy probe. A container whose claude
 * window is gone would therefore read as whatever its active window happened
 * to be running, and the whole gate would be answering about the wrong pane.
 * Asking tmux which window it actually resolved, in the SAME command, is what
 * makes that fallback visible; `runGatedWake` below refuses any answer that
 * is not about `studio:claude`. Same one signal, same one command, no second
 * probe.
 */
export const PANE_PROBE_CMD = withStudioTmux(
  `${STUDIO_TMUX} display-message -p -t ${WAKE_TARGET} '#{session_name}:#{window_name} #{pane_current_command}'`,
);

/** What `pane_current_command` reads when the claude TUI owns the pane. */
const PANE_CLAUDE = "claude";

/**
 * Issue #99: the one screen read the gate adds before typing. The visible
 * pane, addressed BY NAME, printed to stdout — invisible for the reason
 * PANE_PROBE_CMD gives: it selects, switches and attaches nothing.
 */
export const PANE_SCREEN_CMD = withStudioTmux(`${STUDIO_TMUX} capture-pane -p -t ${WAKE_TARGET}`);

export interface GatedWakeDeps {
  /**
   * This studio's OWN recorded state — read from the DO's own storage, never
   * from the D1 registry mirror, the same ruling `sweepMaestro`'s `isStopped`
   * already states. `null` means no status was ever recorded, i.e. this
   * Durable Object was minted by the `idFromName` call that is asking.
   */
  recordedState: () => Promise<string | null>;
  exec: WakeExec;
  /** The clock a printed reset is compared against. Defaults to now. */
  now?: () => Date;
  /** This studio's id, named in a refusal so the operator can act on it. */
  studioId?: string;
  /** Issue #106: the limit block the last account switch fired on
   *  (StudioStatus.failoverBlock), or null. Absent: no switch is known. */
  switchedBlock?: () => Promise<string | null>;
  /** Issue #127: the first sighting of the inline block failover last saw
   *  (LIMIT_SIGHTING_KEY), or null. A block already seen is judged by the
   *  until computed then, never re-parsed against this wake's clock. */
  limitSighting?: () => Promise<LimitSighting | null | undefined>;
}

/**
 * One wake, behind the three gates every wake owes (plus the guard inside
 * wakeCmd itself).
 *
 * GATE 1 — STOPPED, or never provisioned. Asked FIRST and answered entirely
 * from storage, because `sbExec` STARTS a container that is not running:
 * every later step, the probe included, would resurrect a studio the operator
 * deliberately shut down (or create one that never existed) and bill for it
 * silently. Refuse, and SAY the studio is stopped, so the operator knows to
 * provision it.
 *
 * GATE 2 — no claude TUI in the pane. `pane_current_command` is the only
 * tmux signal this fleet reads about that window, and its documented limit
 * (provisionedCheckCmd's own KNOWN LIMIT block) is that it answers
 * ALIVE-or-DEAD and cannot distinguish a lead mid-turn from an idle one. What
 * it CAN answer is the question that decides whether typing is safe at all:
 * with `claude` in the pane the keystrokes land in the TUI's composer, which
 * is the TUI's own business to sequence; with `bash` in the pane the exact
 * same keystrokes are a SHELL COMMAND LINE followed by Enter. Refusing
 * everything that is not `claude` is therefore the strongest gate this signal
 * supports, and the task simply stays `submitted` for the next wake or the
 * operator.
 *
 * TOTAL, exactly as `runWake` is and for the same reasons — the caller is the
 * board's assign path, which must never fail an assignment because a
 * container did not answer.
 *
 * `clearDraftFirst` (default false) — see `wakeCmd`'s own doc comment, step
 * 1b: a C-u sent before typing, gated behind the same clean scan the typed
 * text is. Only a caller retrying its OWN prior unconfirmed wake for the SAME
 * message may have left the draft this clears; every other caller leaves it
 * false and types as before.
 */
export async function runGatedWake(deps: GatedWakeDeps, prompt: string, clearDraftFirst = false): Promise<WakeOutcome> {
  const refused = await stoppedRefusal(deps);
  if (refused) return refused;

  let probe: { code: number; stdout: string; stderr: string };
  try {
    probe = await deps.exec(PANE_PROBE_CMD);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (probe.code !== 0) {
    return {
      ok: false,
      error: `refused: could not read tmux ${WAKE_TARGET} (${probe.code}): ` +
        `${(probe.stderr || probe.stdout).trim().slice(0, 300)}`,
    };
  }
  // "<session>:<window> <command>" — see PANE_PROBE_CMD. Split on the FIRST
  // space only: a window name cannot contain one, a command name can.
  const answer = probe.stdout.trim();
  const gap = answer.indexOf(" ");
  if (gap <= 0) {
    return {
      ok: false,
      error: `refused: tmux ${WAKE_TARGET} answered ${JSON.stringify(answer)}, which names no window — ` +
        "the wake will not be typed into a pane this Worker cannot identify",
    };
  }
  const window = answer.slice(0, gap);
  const pane = answer.slice(gap + 1).trim();
  if (window !== WAKE_TARGET) {
    return {
      ok: false,
      error: `refused: tmux answered about ${window}, not ${WAKE_TARGET} — that window is gone ` +
        "(tmux falls back to the current pane and still exits 0), so there is no claude session to wake",
    };
  }
  if (pane !== PANE_CLAUDE) {
    return {
      ok: false,
      error: `refused: no claude session in tmux ${WAKE_TARGET} (pane runs: ${pane || "none"}) — ` +
        "the wake would be typed at a shell prompt",
    };
  }

  // GATE 3 (issue #99) — claude's usage-limit / session-limit / spend modal.
  // Every select variant measured on 2026-09-24 lists a spend option ("2.
  // Upgrade your plan", "2. Add funds", "3. Upgrade"), and a wake is text +
  // Enter: a digit in it ("#2", "20s") can pick one. Detection is failover's
  // own anchored shapes (never a substring anywhere), over one screen.
  let screen: { code: number; stdout: string; stderr: string };
  try {
    screen = await deps.exec(PANE_SCREEN_CMD);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (screen.code !== 0) {
    return {
      ok: false,
      error: `refused: could not read the screen of tmux ${WAKE_TARGET} (${screen.code}): ` +
        `${(screen.stderr || screen.stdout).trim().slice(0, 300)}`,
    };
  }
  const now = (deps.now ?? (() => new Date()))();
  const sighting = deps.limitSighting ? await deps.limitSighting().catch(() => null) ?? null : null;
  const limit = detectLimitOnScreen(screen.stdout, now, sighting);
  if (limit.kind === "modal") {
    // A select modal (V1, V3, #53) is refused ALWAYS: its spend options stay
    // on screen whatever the clock says, and no unattended path may press a
    // key into it — not the wake, not an Esc.
    if (!limit.inline) {
      // Issue #109: the ONE sanctioned exception to "not the wake, not an
      // Esc" is failover.ts's own dismissModalCmd — a single Esc, gated by
      // its own immediate re-check of the SAME modal shape, never this gate
      // or the generic wake path.
      return {
        ok: false, skipped: true,
        error: `usage-limit modal open in ${WAKE_TARGET}; no keystroke sent (spend options on screen). ` +
          `Dismiss by hand: ff ${deps.studioId ?? "<id>"}, press Esc, detach, re-assign.`,
      };
    }
    // Issue #106 fix pass B: the block the last account switch fired on,
    // redrawn by `--continue`, is history — the NEW account is not limited
    // by it, so the wake goes through.
    const switched = deps.switchedBlock ? await deps.switchedBlock().catch(() => null) : null;
    if (switched === limitBlockKey(limit)) return afterLimitGate(deps, prompt, screen.stdout, clearDraftFirst);
    // An inline block the detector still counts is live by #106's staleness
    // rule (a stale one is not detected at all, and the wake goes through).
    const until = sighting?.block === limitBlockKey(limit)
      ? sighting.until
      : limit.resets ? parseResetUtc(limit.resets, now) : null;
    const holds = formatRateLimited({ until, seenAt: now.toISOString() }, now) ?? "rate-limited (reset time not shown)";
    return {
      ok: false, skipped: true,
      error: `${holds} — session-limit block on screen in ${WAKE_TARGET}; no keystroke sent`,
    };
  }

  return afterLimitGate(deps, prompt, screen.stdout, clearDraftFirst);
}

/**
 * Everything between the limit gate and the keystrokes. BOTH ways out of the
 * limit gate come through here — the normal path and #106 fix B's
 * switched-block early return — so neither can skip a step the other owes.
 *
 * `screen` is the SAME capture the limit gate judged (PANE_SCREEN_CMD), passed
 * in rather than re-read: a second capture would be a second check-then-act
 * window, and the in-container guard already re-scans at the last instant.
 */
async function afterLimitGate(
  deps: GatedWakeDeps, prompt: string, screen: string, clearDraftFirst = false,
): Promise<WakeOutcome> {
  // Issue #136: the LOOSE check (see LOOSE_LIMIT_PATTERNS) — a modal shape the
  // strict detector has never seen (a status row under the footer, a boxed
  // V1) still refuses. The same patterns run again inside wakeCmd.
  //
  // PR #144: INSIDE this function, not before the call. The switched-block
  // early return jumps straight here, and outside it that path reached the
  // container guard alone: nothing was typed, but the refusal came back as a
  // skip with no row named — safe for spend and SILENT. The whole point of
  // threading the screen text through is that both paths get the loud one.
  //
  // NOT a skip (#141 review): the strict detector said "working", so this is
  // either a modal nobody has catalogued or a false positive — and an idle
  // screen does not change, so every later wake would be refused silently.
  // An error, naming the row, is what gets a human to look.
  const loose = looseLimitOnScreen(screen);
  if (loose) {
    return {
      ok: false,
      error: `modal row near the bottom of ${WAKE_TARGET} the limit detector does not know: ${JSON.stringify(loose)}; ` +
        `no keystroke sent. If a modal is open: ff ${deps.studioId ?? "<id>"}, press Esc, detach, re-assign.`,
    };
  }

  // Issue #100 F3: asked AGAIN, immediately before typing. The probe above
  // is an outbound exec, and a Durable Object's input gate is open across
  // it: a destroy can land between the first read and here. Its marker
  // (provision.ts's DESTROYING_KEY) makes that destroy read as `stopped`.
  const late = await stoppedRefusal(deps);
  if (late) return late;

  return runWake(deps.exec, prompt, clearDraftFirst);
}

/** Gate 1 — stopped or never provisioned, answered from storage alone.
 *  `null` means the gate passes. Total: a storage throw is a refusal. */
async function stoppedRefusal(deps: GatedWakeDeps): Promise<WakeOutcome | null> {
  let state: string | null;
  try {
    state = await deps.recordedState();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (state === null) {
    return {
      ok: false, skipped: true,
      error: "refused: this studio was never provisioned — it has no recorded status, " +
        "and a wake must not create a container",
    };
  }
  if (state === "stopped") {
    return {
      ok: false, skipped: true,
      error: "refused: this studio is stopped — starting its container costs money silently. " +
        "Provision it to resume.",
    };
  }
  if (state === DESTROY_IN_FLIGHT) {
    return {
      ok: false, skipped: true,
      error: "refused: a destroy is in flight on this studio — a wake now would start the container it is stopping",
    };
  }
  return null;
}

/**
 * Issue #136: one wake in flight per studio. Two concurrent wakes on one
 * exec session interleave (probe, probe, capture, capture, send, send): wake
 * A's Enter can raise a modal and wake B's Enter then answer it. The lock is
 * the DO instance's own (in memory: a DO is single-threaded, and an evicted
 * isolate has no wake in flight). A second wake is refused as a skip, never
 * queued — the sweep and the board re-wake on their own.
 */
export async function singleFlightWake(
  lock: { busy: boolean }, wake: () => Promise<WakeOutcome>,
): Promise<WakeOutcome> {
  if (lock.busy) {
    return {
      ok: false, skipped: true,
      error: "refused: another wake is in flight on this studio — one at a time, so two Enters never race into one pane",
    };
  }
  lock.busy = true;
  try {
    return await wake();
  } finally {
    lock.busy = false;
  }
}
