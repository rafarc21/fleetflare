// Wire-format contract copy (issue #275): the real builders are now private
// to src/studio/transcript.ts. This local copy is the bash -n safety net's
// owned spec of the wire format — test/studio.transcript.test.ts pins the
// REAL builder byte-for-byte via literal asserts on the command the tick
// sends (its command-shape describe), so a drift between these two copies
// fails there, not here. Issue #85's BLOCKER 1 lesson stands: the command
// string MUST be bash -n'd; keeping that net is worth one owned copy.
import { TRANSCRIPT_PULL_MAX, HOT_TAIL_BYTES } from "../../src/studio/archive";
import { INCARNATION_PATH, paneLeadProbeCmd } from "../../src/studio/observed";
import { STUDIO_TMUX, withStudioTmux } from "../../src/studio/tmux";

// Wire-format literals, same values the private builders embed — the
// container↔Worker delimited-stdout protocol, pinned here the same way
// test/studio.transcript.test.ts pins it.
const TRANSCRIPT_LOG_PATH = "/workspace/.transcript/claude.log";
const TRANSCRIPT_BOOT_ID_PATH = "/workspace/.transcript/boot-id";
const SECTION_BOOTID = "---FLEET-BOOTID---";
const SECTION_STAT = "---FLEET-STAT---";
export const SECTION_INCARNATION = "---FLEET-INCARNATION---";
export const SECTION_CHUNK = "---FLEET-CHUNK---";
const SECTION_TAIL = "---FLEET-TAIL---";
const SECTION_PANE = "---FLEET-PANE---";
const SECTION_ACTIVITY_HOOK = "---FLEET-ACTIVITY-HOOK---";
const ACTIVITY_HOOK_PATH = "/workspace/.fleet/activity.json";
const SECTION_MEMGUARD = "---FLEET-MEMGUARD---";
const MEMGUARD_LOG_PATH = "${MEMGUARD_LOG:-${FLEET_WORKSPACE:-/workspace}/.fleet/memguard.log}";
const MEMGUARD_LOG_TAIL_LINES = 20;
const ROTATED_MARKER = "ROTATED";
const SKIPPED_MARKER = "SKIPPED";

/** Verbatim copy of src/studio/transcript.ts's private `shellSingleQuote` —
 *  the one dependency `shipTickCmd`'s body has beyond constants. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Verbatim copy of src/studio/transcript.ts's private `shipTickCmd` — the
 *  bash -n safety net's owned spec of the ship-tick command's wire format
 *  (see this file's header for the drift contract). */
export function shipTickCmdWire(
  manifestOffset: number, storedBootId: string | undefined, adoptionToken?: string,
): string {
  const storedBootIdLiteral = shellSingleQuote(storedBootId ?? "");
  const incarnationRead = adoptionToken === undefined
    ? `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; `
    : (
      `FLEET_INC="$(cat ${INCARNATION_PATH} 2>/dev/null)"; ` +
      `if [ -z "$FLEET_INC" ]; then ` +
      // `$(dirname ${INCARNATION_PATH})`, not a hardcoded `/workspace/.fleet`
      // — the same fix as observed.ts's writeIncarnationCmd/
      // bringupObservationCmd, one source of truth for the directory,
      // derived from the same constant the write/rename targets already use.
      `mkdir -p "$(dirname ${INCARNATION_PATH})" && printf '%s\\n' ${shellSingleQuote(adoptionToken)} > ${INCARNATION_PATH}.tmp ` +
      `&& mv ${INCARNATION_PATH}.tmp ${INCARNATION_PATH} && FLEET_INC=${shellSingleQuote(adoptionToken)}; ` +
      `fi; `
    );
  // Maestro correction #7: fold the pane probe into the SAME exec, but only
  // when this tick MIGHT adopt — a steady-state tick (adoptionToken
  // undefined) never pays for a probe it has no use for.
  //
  // Fix round (BLOCKER 1, #85 review): `paneLeadProbeCmd()`'s own return
  // value ends mid-statement (`...; fi; echo`, its own trailing cwd `echo`
  // with no separator after it) — string-concatenating it directly onto the
  // NEXT fragment below (`if [ "$FLEET_SIZE" -ge 0 ]; then ...`) glued them
  // into one bareword, `echoif`, a bash syntax error (exit 2) on EVERY
  // adoption-path tick. The trailing `; ` here is the fix: it terminates the
  // probe's own last statement before the next fragment's `if` ever begins.
  const probeFragment = adoptionToken === undefined ? "" : `${paneLeadProbeCmd()}; `;
  // Issue #221 (PR3a, Task 3) — B1: ONE `capture-pane -p` frame, no `sleep`,
  // riding this SAME exec. Addressed BY NAME (`withStudioTmux`, same as
  // failover.ts's own paneCaptureCmd) — never selects, switches or attaches.
  // Placed AFTER the (optional) adoption probe fragment and BEFORE the
  // file-exists guard, so its base64 content ends exactly at the next known
  // marker (SECTION_CHUNK when the file exists, or simply the end of stdout
  // when it does not) with nothing else able to land in between.
  const paneFragment = withStudioTmux(
    `echo '${SECTION_PANE}'; ${STUDIO_TMUX} capture-pane -p -t studio:claude 2>/dev/null | base64; `,
  );
  // Issue #221 (PR3b) — the hook-heartbeat read: `2>/dev/null` so a missing
  // file (pre-hook-install studio, or a hook that has never fired yet) never
  // fails the whole chained script, same guard shape `paneFragment` already
  // uses for a gone tmux server. Unconditional, and placed AFTER the
  // if/fi block below (never inside it) — the heartbeat file's existence has
  // nothing to do with whether the transcript log exists yet.
  const activityHookFragment = `echo '${SECTION_ACTIVITY_HOOK}'; cat ${ACTIVITY_HOOK_PATH} 2>/dev/null | base64; `;
  // Issue #311 — memguard's own kill log, tailed and base64'd like every
  // other section, right after the pane. `2>/dev/null` guards BOTH "file
  // does not exist yet" (a studio that has never had a low-memory episode)
  // and any other unreadable-file case — `tail` itself still exits 0 on a
  // missing file with this redirect, so this can never fail the tick the
  // way an unguarded read could. Placed AFTER paneFragment and BEFORE the
  // file-exists guard, same "ends exactly at the next known marker" rule
  // SECTION_PANE's own placement already follows (see `parsePaneSection`'s
  // own doc comment) — `parsePaneSection` now ends its own slice at
  // SECTION_MEMGUARD when present, never swallowing this section's bytes.
  const memguardFragment =
    `echo '${SECTION_MEMGUARD}'; tail -n ${MEMGUARD_LOG_TAIL_LINES} ${MEMGUARD_LOG_PATH} 2>/dev/null | base64; `;
  return (
    `FLEET_FRESH_BOOT_ID=$(cat ${TRANSCRIPT_BOOT_ID_PATH} 2>/dev/null || echo ''); ` +
    `echo '${SECTION_BOOTID}'; echo "$FLEET_FRESH_BOOT_ID"; ` +
    `FLEET_SIZE=$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1); ` +
    `echo '${SECTION_STAT}'; echo "$FLEET_SIZE"; ` +
    incarnationRead +
    `echo '${SECTION_INCARNATION}'; echo "$FLEET_INC"; ` +
    probeFragment +
    paneFragment +
    memguardFragment +
    `if [ "$FLEET_SIZE" -ge 0 ]; then ` +
    `FLEET_STORED_BOOT_ID=${storedBootIdLiteral}; ` +
    `if [ -n "$FLEET_FRESH_BOOT_ID" ] && [ -n "$FLEET_STORED_BOOT_ID" ] && [ "$FLEET_FRESH_BOOT_ID" != "$FLEET_STORED_BOOT_ID" ]; then FLEET_EFF=0; else FLEET_EFF=${manifestOffset}; fi; ` +
    `if [ "$FLEET_EFF" -gt "$FLEET_SIZE" ]; then FLEET_EFF=0; fi; ` +
    `echo '${SECTION_CHUNK}'; ` +
    `tail -c +$((FLEET_EFF+1)) ${TRANSCRIPT_LOG_PATH} | head -c ${TRANSCRIPT_PULL_MAX} | base64; ` +
    `echo '${SECTION_TAIL}'; ` +
    `tail -c ${HOT_TAIL_BYTES} ${TRANSCRIPT_LOG_PATH} | base64; ` +
    `fi; ` +
    activityHookFragment
  );
}

/** Verbatim copy of src/studio/transcript.ts's private `rotateCmd` — the
 *  rotation exec's wire shape (same drift contract as shipTickCmdWire's). */
export function rotateCmdWire(shippedSize: number): string {
  return (
    `if [ "$(stat -c %s ${TRANSCRIPT_LOG_PATH} 2>/dev/null || echo -1)" -le ${shippedSize} ]; then ` +
    `truncate -s 0 ${TRANSCRIPT_LOG_PATH} && echo ${ROTATED_MARKER}; else echo ${SKIPPED_MARKER}; fi`
  );
}
