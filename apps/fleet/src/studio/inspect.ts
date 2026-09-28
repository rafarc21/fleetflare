/**
 * Board issue #47 — a read-only inspection path that answers "is this
 * studio alive and doing something" WITHOUT the one thing that has always
 * answered that question until now: attaching a tmux client to look.
 *
 * THE DAMAGE (measured 2026-09-23, `acme-os--pilot`, operator watching
 * live): garbled text with stray leading fragments (`Ne`, `Tr`, `My`, `Ag`
 * — each the first 1-2 characters of the PREVIOUS line). A client attaching
 * or detaching forces tmux to re-evaluate the shared pane's window size and
 * repaint into EVERY client sharing that session, the operator's own
 * terminal included. `container/studio-bringup.sh`'s tmux render-options
 * region already closed the worst of this mechanism (`window-size largest`,
 * `aggressive-resize off` — see that region's own comments, and issue #43)
 * but the fix does not remove the trigger: an attach is still a real tmux
 * client joining the session. The only way to never trigger it is to never
 * attach one — which is what this file is for.
 *
 * THE MECHANISM: `sbExec` (sandbox-api.ts) runs a command in the
 * container's own exec session ("sandbox-default", a plain shell process
 * the container-server owns) — a completely different code path from
 * `sbAttachPty` (also sandbox-api.ts), which is what `fleet attach` uses to
 * open a WebSocket onto `container/studio-shell.sh`'s `tmux attach -d -t
 * studio`. sbExec never runs studio-shell.sh, never opens that WebSocket,
 * and therefore never runs `tmux attach` at all. The single command this
 * file hands to sbExec runs `tmux display-message` and `tmux capture-pane
 * -p` — both are one-shot control invocations of the tmux CLI against the
 * already-running server, the exact same category `provisionedCheckCmd`
 * (provision.ts) already uses for `pane_current_command` and `wakeCmd`'s
 * own `PANE_PROBE_CMD` (wake.ts) already use for the same reason. Verified
 * empirically (see test/bun/inspect-cmd.test.ts, run against a real tmux
 * server): `tmux list-clients` reports zero clients before AND after a
 * `capture-pane -p` call, and `window-size`/`aggressive-resize` read back
 * unchanged — capture-pane genuinely never creates an attached client.
 *
 * Issue #85 added two more read-only facts, both captured BEFORE the pane
 * tail's `TAIL_BEGIN` sentinel: the incarnation token file (`INCARNATION_PATH`,
 * observed.ts) — the same file the ship tick reads to decide `replaced` —
 * and the tail of `bringup.log` (`bringupLogTailCmd`, provision.ts). Neither
 * adds a second exec; both ride this same command.
 *
 * MODAL SAFETY: `capture-pane -p` prints the pane's CURRENT screen buffer.
 * It sends nothing to the pane's process — no keystrokes, no `send-keys`,
 * nothing that could land on an interactive modal (a rate-limit prompt
 * where Enter selects "Upgrade your plan"). Verified empirically: capturing
 * a pane parked on a `read -p` prompt, twice, never satisfies the read —
 * the process never receives input.
 *
 */

/*
 * STOPPED-CONTAINER SAFETY: `sbExec` STARTS a container that is not
 * running (the same fact `runGatedWake`'s own doc comment states, wake.ts,
 * and `sweepMaestro`'s `isStopped` gate, do.ts) — billing begins the moment
 * it does. `runInspect` below therefore answers the stopped/never-
 * provisioned question ENTIRELY from the DO's own recorded status, before
 * ever calling `exec`, mirroring `runGatedWake`'s own two-gate shape
 * (GatedWakeDeps.recordedState, wake.ts) exactly.
 */
import { recycleCostLine, LIVENESS_RULE } from "./recycle-cost";

import { DESTROY_IN_FLIGHT } from "./provision";
import { STUDIO_TMUX, withStudioTmux } from "./tmux";

import { INCARNATION_PATH } from "./observed";
import { bringupLogTailCmd } from "./provision";

/** The one window this file ever reads. Same name, same "by NAME never by
 *  index" reasoning as `provisionedCheckCmd` (provision.ts) and
 *  `WAKE_TARGET` (wake.ts) — a live studio accumulates extra windows
 *  (bring-up's own `shell`, an operator's or a probe's extras), and this
 *  must keep reading the claude window regardless of which one is active. */
export const INSPECT_TARGET = "studio:claude";

/** How many pane lines `tmux capture-pane -p -S -<n>` returns when a caller
 *  does not ask for a specific count. Generous enough to show a lead's last
 *  few turns without dragging back the whole 50000-line scrollback
 *  (container/studio-bringup.sh's `history-limit`) on every inspect. */
export const INSPECT_DEFAULT_TAIL_LINES = 60;

/**
 * Board #91 — the most one inspect exec may take before `runInspect` stops
 * waiting and answers "the container did not answer". Before this, the exec
 * had no deadline at all: against a wedged container the DO call sat for
 * minutes (measured 2026-09-24 in this Worker's own analytics: DO
 * `internalError` after 737s, 182s and 50s, each paired 1:1 with a Worker
 * `scriptThrewException` of the same wall time) and the operator got a
 * Cloudflare 500 page, then a hang past their own 600s timeout.
 *
 * Same idea as `CONTAINER_PROBE_MS` (do.ts, board #68): a container that
 * cannot answer three one-shot tmux reads in this long is not going to, and
 * the operator reaching for inspect is usually already suspicious. Wider
 * than that probe's 8s because this is the real read, not `printf ok`.
 */
export const INSPECT_EXEC_MS = 15_000;

// Sentinel tokens, one per output line, machine-parseable by construction —
// same idiom provision.ts's PROVISIONED_OK/PROVISIONED_UNKNOWN and this
// file's own PANE_LINE_PREFIX use, chosen so parseInspectOutput never has to
// guess at container stdout shape.
export const CHECKOUT_PRESENT = "FLEET_INSPECT_CHECKOUT_PRESENT";
export const CHECKOUT_MISSING = "FLEET_INSPECT_CHECKOUT_MISSING";
const PANE_LINE_PREFIX = "FLEET_INSPECT_PANE:";
/** #151: the container's own clock, epoch seconds, stamped in the SAME exec
 *  as capture-pane — a tail without its age let a frozen screen read as live. */
const CAPTURED_AT_PREFIX = "FLEET_INSPECT_CAPTURED_AT:";
/** Marks the end of the two structured lines above and the start of the RAW
 *  capture-pane tail. Everything from here to the end of stdout is treated
 *  as pane content verbatim — never re-parsed — because that content can
 *  legitimately contain anything the pane ever displayed, sentinel-shaped
 *  text included. */
export const TAIL_BEGIN = "FLEET_INSPECT_TAIL_BEGIN";

// Issue #85 — two more sentinel-bounded sections, both read BEFORE
// TAIL_BEGIN's pane capture (same ordering reasoning: everything after
// TAIL_BEGIN is raw, unparsed pane content).
export const INCARNATION_SECTION = "FLEET_INSPECT_INCARNATION";
export const BRINGUP_LOG_SECTION = "FLEET_INSPECT_BRINGUP_LOG";
/** How many bringup.log lines `fleet inspect` shows — short: this is a
 *  quick "did the last bring-up land cleanly" glance, not the full log
 *  provision.ts's own retry/degrade path already surfaces on failure. */
export const INSPECT_BRINGUP_LOG_LINES = 15;

/**
 * The one command `runInspect` hands to `sbExec`. Five read-only tmux/shell
 * facts, in order:
 *
 *   1. Does the checkout exist on disk (`/workspace/<repo>/.git`)?
 *   2. `pane_current_command` for `studio:claude`, addressed BY NAME via
 *      `display-message -p -t` — proves whether claude is running vs bash
 *      or something else, without requiring the window to be active and
 *      without ever selecting/switching it (the same "invisible by
 *      construction" requirement provisionedCheckCmd's own doc comment
 *      states, inherited here verbatim). `#{session_name}:#{window_name}`
 *      rides alongside the answer for the same measured tmux 3.2a reason
 *      PANE_PROBE_CMD (wake.ts) carries it: a MISSING `studio:claude`
 *      silently answers about whatever pane is current and exits 0, so the
 *      window name is what tells a real answer from that fallback.
 *   3. Issue #85: the incarnation token file (`INCARNATION_PATH`,
 *      observed.ts) — read into a shell variable FIRST, never echoed via a
 *      bare `cat FILE || echo ''` glued straight into this command's own
 *      stdout (that would swallow the file's own trailing newline
 *      ambiguously — see observed.ts's own newline-safety note). A missing
 *      file reads as an empty `$FLEET_INC`, same "absent reads as MISSING"
 *      posture the checkout/pane facts above already take.
 *   4. Issue #85: the last `INSPECT_BRINGUP_LOG_LINES` lines of
 *      `bringup.log` (`bringupLogTailCmd`, provision.ts, unmodified) — a
 *      quick glance at whether the last bring-up landed cleanly.
 *   5. The last `tailLines` lines of that pane's buffer, via
 *      `tmux capture-pane -p -t studio:claude -S -<n>` — the read-only
 *      primitive this whole feature exists to use instead of attaching.
 *
 * Never calls the shell `exit` builtin (provision.ts's PROVISIONED_OK doc
 * comment: `exit` inside an sbExec command kills the shared "sandbox-default"
 * exec session's shell rather than the command, and took down a healthy
 * studio's check once already). Never contains `attach`, `send-keys`,
 * `new-session`, `new-window`, `select-window`, `select-pane`, or
 * `switch-client` — pinned by test/studio.inspect.test.ts so no future edit
 * can reintroduce a client or a keystroke.
 */
export function inspectCmd(repo: string, tailLines: number = INSPECT_DEFAULT_TAIL_LINES): string {
  const n = Number.isFinite(tailLines) && tailLines > 0 ? Math.floor(tailLines) : INSPECT_DEFAULT_TAIL_LINES;
  return withStudioTmux(
    `if [ -d /workspace/${repo}/.git ]; then echo ${CHECKOUT_PRESENT}; else echo ${CHECKOUT_MISSING}; fi; ` +
    `p="$(${STUDIO_TMUX} display-message -p -t ${INSPECT_TARGET} '#{session_name}:#{window_name} #{pane_current_command}' 2>/dev/null || true)"; ` +
    `case "$p" in ` +
    `"${INSPECT_TARGET} "*) echo "${PANE_LINE_PREFIX}\${p#${INSPECT_TARGET} }" ;; ` +
    `*) echo "${PANE_LINE_PREFIX}none" ;; ` +
    `esac; ` +
    // Maestro correction #2 — captured into a shell variable BEFORE
    // anything is echoed, never a bare `cat FILE || echo ''` glued straight
    // into this command's own stdout.
    `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; ` +
    `echo ${INCARNATION_SECTION}; echo "$FLEET_INC"; ` +
    `echo ${BRINGUP_LOG_SECTION}; ${bringupLogTailCmd(INSPECT_BRINGUP_LOG_LINES)}; ` +
    // #151: the container's own clock, same exec, right before the tail.
    `echo "${CAPTURED_AT_PREFIX}$(date -u +%s)"; ` +
    `echo ${TAIL_BEGIN}; ` +
    `${STUDIO_TMUX} capture-pane -p -t ${INSPECT_TARGET} -S -${n} 2>/dev/null || true`
  );
}

export interface InspectSnapshot {
  /** `/workspace/<repo>/.git` exists in the container. */
  checkoutExists: boolean;
  /** `pane_current_command` for `studio:claude` — "claude" proves the lead
   *  process is running, "bash" (or anything else) proves it is not. `null`
   *  when `studio:claude` does not exist at all (display-message's own
   *  silent fallback to the current pane — see inspectCmd's doc comment). */
  paneCommand: string | null;
  /** Issue #85: does `/workspace/.fleet/incarnation` exist and hold text? */
  incarnationPresent: boolean;
  /** Issue #85: the last INSPECT_BRINGUP_LOG_LINES lines of bringup.log,
   *  verbatim — empty string when the file has nothing (pre-feature
   *  container, or bring-up died before writing it). */
  bringupLogTail: string;
  /** The last N lines of the claude window's pane buffer, verbatim from
   *  `tmux capture-pane -p`. May be empty (a pane with nothing in it yet)
   *  but is never truncated by this parser — inspectCmd's own `-S` flag is
   *  what bounds it. */
  tail: string;
  /** #151: when the tail was captured, epoch seconds from the container's
   *  `date -u +%s` in the same exec. `null` when absent or unparseable —
   *  never a guess. */
  capturedAt: number | null;
}

/** Splits `inspectCmd`'s stdout into the facts it carries. Never throws —
 *  malformed/short output (a container that answered nothing, or answered
 *  before the tail sentinel) degrades to the least-informative honest
 *  reading (`checkoutExists: false`, `paneCommand: null`,
 *  `incarnationPresent: false`, empty `bringupLogTail`/`tail`) rather than
 *  crashing the caller. */
export function parseInspectOutput(stdout: string): InspectSnapshot {
  const tailAt = stdout.indexOf(TAIL_BEGIN);
  const head = tailAt === -1 ? stdout : stdout.slice(0, tailAt);
  const tail = tailAt === -1 ? "" : stdout.slice(tailAt + TAIL_BEGIN.length).replace(/^\r?\n/, "");
  const checkoutExists = head.includes(CHECKOUT_PRESENT);
  const paneLine = head.split("\n").find((line) => line.startsWith(PANE_LINE_PREFIX));
  const paneValue = paneLine ? paneLine.slice(PANE_LINE_PREFIX.length).trim() : "none";

  const incAt = head.indexOf(INCARNATION_SECTION);
  const logAt = head.indexOf(BRINGUP_LOG_SECTION);
  const capAt = head.indexOf(CAPTURED_AT_PREFIX);
  const incarnationRaw = incAt === -1
    ? ""
    : head.slice(incAt + INCARNATION_SECTION.length, logAt === -1 ? head.length : logAt).replace(/^\r?\n/, "").trim();
  // #151's CAPTURED_AT line now sits after the bringup-log section (both
  // read before TAIL_BEGIN) — bound bringupLogTail at it when present so the
  // stamp line is never swallowed into the log tail.
  const bringupEnd = capAt !== -1 && (logAt === -1 || capAt > logAt) ? capAt : head.length;
  const bringupLogTail = logAt === -1
    ? ""
    : head.slice(logAt + BRINGUP_LOG_SECTION.length, bringupEnd).replace(/^\r?\n/, "").replace(/\n$/, "");

  const stampLine = head.split("\n").find((line) => line.startsWith(CAPTURED_AT_PREFIX));
  const stamp = stampLine ? stampLine.slice(CAPTURED_AT_PREFIX.length).trim() : "";
  const capturedAt = /^\d+$/.test(stamp) ? Number(stamp) : null;

  return {
    checkoutExists,
    paneCommand: paneValue === "none" || paneValue === "" ? null : paneValue,
    incarnationPresent: incarnationRaw.length > 0,
    bringupLogTail,
    tail,
    capturedAt,
  };
}

/** The container-exec port — same shape as `WakeExec` (wake.ts) and
 *  `ProvisionDeps.sbExec` (provision.ts), the established seam every studio
 *  subsystem that touches a container takes. */
export type InspectExec = (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface InspectDeps {
  /** This studio's OWN recorded state — read from the DO's own storage,
   *  never the D1 registry mirror. Same ruling `GatedWakeDeps.recordedState`
   *  (wake.ts) and `sweepMaestro`'s `isStopped` (do.ts) already state, for
   *  the same reason: a stale mirror could read "running" over a container
   *  the operator just stopped. */
  recordedState: () => Promise<string | null>;
  exec: InspectExec;
  /** #96: upload time of the snapshot a recycle would restore (null = none).
   *  Read only when the container is wedged. Absent = age unknown. */
  lastSyncedAt?: () => Promise<Date | null>;
  now?: () => Date;
}

export type InspectOutcome =
  | { ok: true; snapshot: InspectSnapshot }
  | { ok: false; error: string };

/**
 * The whole feature, gated. Answers requirement 2 (never start a STOPPED
 * container) the same way `runGatedWake`'s GATE 1 does: the stopped/never-
 * provisioned question is answered ENTIRELY from storage, before `exec` is
 * ever called — `sbExec` starts a container that is not running, so the
 * refusal has to happen before any exec or it has already cost what it was
 * refusing to spend.
 *
 * TOTAL — never throws. Mirrors `runWake`/`runGatedWake`'s own posture: a
 * coordinator polling for liveness must get an answer back, including "I
 * could not tell", never an exception to catch.
 */
export async function runInspect(
  deps: InspectDeps, repo: string, tailLines: number = INSPECT_DEFAULT_TAIL_LINES,
): Promise<InspectOutcome> {
  let state: string | null;
  try {
    state = await deps.recordedState();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (state === null) {
    return {
      ok: false,
      error: "refused: this studio was never provisioned — it has no recorded status, " +
        "and inspect must not create a container",
    };
  }
  if (state === "stopped") {
    return {
      ok: false,
      error: "refused: this studio is stopped — reading it would start its container " +
        "and cost money silently. Provision it first.",
    };
  }
  if (state === DESTROY_IN_FLIGHT) {
    return { ok: false, error: "refused: a destroy is in flight on this studio — reading it now would start its container" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wedged = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { wedged = true; reject(new Error(
        `container did not answer within ${INSPECT_EXEC_MS / 1000}s — the studio is recorded ` +
          `as ${state}, but its container is unreachable or wedged. The Worker and Durable ` +
          "Object are fine; only the container side failed.",
      )); }, INSPECT_EXEC_MS);
    });
    const res = await Promise.race([deps.exec(inspectCmd(repo, tailLines)), deadline]);
    // inspectCmd's own trailing `|| true` means a non-zero code here is not
    // "the check failed", it is "the container answered nothing at all" —
    // parseInspectOutput already degrades an empty/short stdout to the
    // least-informative honest reading, so there is nothing extra to branch
    // on. Kept as a named case anyway (rather than silently parsing
    // whatever stdout happens to be) so a genuinely broken exec transport —
    // empty stdout AND a non-zero code — reads as a refusal, not a false
    // "claude is not running".
    if (res.code !== 0 && !res.stdout.trim()) {
      return {
        ok: false,
        error: `inspect exec failed (${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`,
      };
    }
    return { ok: true, snapshot: parseInspectOutput(res.stdout) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!wedged) return { ok: false, error: message };
    // #96: "only the container side failed" stays verbatim — it is accurate,
    // and the BETA coordinator relies on it — but read alone it sounded like
    // permission to recycle. The price rides right behind it.
    const lastSyncedAt = deps.lastSyncedAt
      ? await deps.lastSyncedAt().catch(() => undefined)
      : undefined;
    const now = deps.now ? deps.now() : new Date();
    return { ok: false, error: `${message} ${recycleCostLine(lastSyncedAt, now)} ${LIVENESS_RULE}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
