// Pure formatting for fleet ls's READY/CHECKED columns ("a dead studio looks
// alive" fix) — split out of cli/fleet.ts into its own tiny pure module for
// the SAME reason cli/fleet-totals.ts already is (see that file's own
// header): cli/fleet.ts pulls in `node:os`/`node:fs` and `Bun.file`/
// `Bun.spawn` (via ./paste-mac), fine for cli/tsconfig.json's own `"types":
// ["bun"]`, but importing it from ANYWHERE under test/ would drag those
// Bun-touching declarations into the ROOT tsconfig.json's compilation graph
// too, and that project's `types` array has no "bun" entry. Keeping this
// pure (no node:*/Bun imports) means a test can import it directly.
import type { StudioStatus } from "../src/studio/types";
import { SHIP_TRANSCRIPT_SECONDS } from "../src/studio/ship-cadence";
import { SYNC_SESSION_SECONDS } from "../src/studio/session-sync";
import { formatRateLimited, type RateLimitObservation } from "../src/studio/rate-limit";
import { isUnreachable, type Observed } from "../src/studio/observed";
import { leadAccountMismatch } from "../src/studio/lead-route";
import type { Activity } from "../src/studio/activity";
import type { MemberAlert } from "../src/studio/member-alerts";
// Issue #934: the INFER decoration's value shape — a TYPE-ONLY import so this
// module stays pure (no node:*/Bun imports, the header above's own reason),
// and cli/infer-format.ts is itself pure, so nothing rides along either way.
import type { LeadInferUsage } from "./infer-format";
// Issue #1074 ask 1: the lead-model read behind the MODEL column and the
// --json leadType/leadModel fields (a pure module of its own, see its header).
import { leadModelOf } from "./lead-model";

/**
 * One word, machine-parseable first token — reuses the SAME vocabulary
 * `/studio/:id/provisioned` and `fleet help` already speak ("provisioned"/
 * "bare"/"inconclusive") rather than inventing new words, so an agent that
 * already knows one surface reads the other for free.
 *
 * `readiness` null/undefined (never checked yet, or a pre-existing row from
 * before this feature) and `inconclusive` both start with "?" — neither may
 * ever read as a stale yes or a stale no; see StudioReadiness's own doc
 * comment for why. "provisioned"/"bare" are the only two tokens that assert
 * anything about the studio itself.
 *
 * `reason` (bare/inconclusive) carries container stdout/stderr — already
 * scrubbed of secrets at the recordStudio write boundary, but never
 * guaranteed single-line — so it gets the SAME whitespace collapse the
 * ERROR column already applies to `s.error`, here rather than at the
 * call site, so every caller of this function gets a table-safe string for
 * free instead of having to remember the collapse itself.
 *
 * KNOWN LIMIT, measured, and load-bearing for anyone reading this column:
 * "provisioned" means ALIVE, not WORKING. The liveness half of the verdict is
 * `pane_current_command` in `tmux studio:claude`, and it reads "claude" in
 * THREE different states — the lead mid-turn, the lead stopped waiting on
 * background subagents, and the lead dead at a shell prompt. It answers
 * ALIVE-or-DEAD. It cannot answer WORKING-or-STOPPED, and a green row is
 * never evidence that a studio is spending money productively.
 *
 * Issue #99: on a running or degraded row with a recorded limit, READY says
 * that instead — "rate-limited until 13:30Z" (a readable reset still ahead),
 * "limit modal open — Esc to dismiss (ff <id>)" (a select modal: no clock
 * ends it, a human must press Esc), or "rate-limited (reset time not shown)".
 */
export function formatReady(
  readiness: StudioStatus["readiness"],
  row?: Pick<StudioStatus, "id" | "state" | "rateLimited">,
  now: Date = new Date(),
): string {
  // Issue #99: a limited lead reads healthy on every other signal (pane
  // claude, exec fine, BURN frozen = a quiet lead). While the limit holds on
  // a LIVE row (running or degraded) it overrides the verdict; a stopped or
  // provisioning row has no lead to be limited. Past a printed reset it
  // renders nothing.
  const live = row?.state === "running" || row?.state === "degraded";
  const limited = live ? formatRateLimited(row?.rateLimited, now, row?.id) : null;
  if (limited) return limited;
  if (readiness == null) return "?";
  // Issue #189: "provisioned (tailnet: quota reached)" -- alive, no tailnet.
  if (readiness.kind === "provisioned") return readiness.warning ? `provisioned (${readiness.warning})` : "provisioned";
  const reason = readiness.reason.replace(/\s+/g, " ");
  return readiness.kind === "bare" ? `bare: ${reason}` : `? ${reason}`;
}

/** Bare bucketed age, largest whole unit, NO "ago"/suffix — the shared core
 *  formatCheckedAt already computed inline; factored out (issue #85) so the
 *  READY overrides and the SESSION column, which each attach their OWN
 *  suffix convention (" ago" only for `replaced`; none for `unreachable`/
 *  `unverified`/`snap`), share one bucketing implementation.
 *
 * "Largest WHOLE unit" is literal: an hour/day bucket is only used when the
 * age divides that unit EXACTLY (no dropped remainder) — a 61-minute age
 * renders "61m", never "1h", because "1h" would silently discard the extra
 * minute. Below the exact-hour/day boundary, minutes (or seconds) are always
 * a safe fallback since they never lose information the way rounding a
 * fractional hour/day would. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400}d`;
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s < 86400) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * Issue #85 review round 4, NIT 13 — `formatCheckedAt`'s OWN bucketing,
 * simple floor-based, distinct from `formatAge`'s exact-multiple-only
 * promotion above. `formatCheckedAt` predates this feature (issue #37) and
 * always promoted past the 60-minute/24-hour boundary regardless of
 * remainder (`Math.floor(minutes / 60)`, `Math.floor(hours / 24)`) — a
 * 484-minute-old verdict reads "8h ago", the same as it always has. This PR
 * must not silently change that established CHECKED-column reading just
 * because it introduced a stricter bucketer for its OWN new READY-override/
 * SESSION-column suffixes, which genuinely do want "never silently drop a
 * remainder" (see formatAge's own doc comment) — those are a different
 * reading with a different audience (a precise "how much would recycling
 * lose" figure) than CHECKED's "roughly how stale is this" one. */
function formatAgeFloor(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * How OLD this verdict is, in the largest whole unit — "7s ago", "5m ago",
 * "3h ago", "2d ago".
 *
 * Issue #37 changed this from the raw ISO timestamp it used to print. The
 * requirement is explicit: `fleet ls` stays cheap (registry read only, no
 * live check unless --fresh is asked for), and in exchange "the default
 * listing must say plainly how old each verdict is". A raw UTC timestamp does
 * not say that — it asks the reader to subtract, in their head, and on
 * 2026-09-23 a verdict up to SYNC_SESSION_SECONDS (300s) old was read as
 * current by both an operator and a reviewing agent. An age cannot be
 * misread that way.
 *
 * `now` is a parameter, never `new Date()` read inside: this module is the
 * pure half of the CLI (see this file's header) and a hidden clock is not
 * testable.
 *
 * "never" rather than the "-" every other absent-value column uses: "-" in a
 * CHECKED column reads as "nothing to say", and what it actually means here
 * is that no live check has EVER been taken for this studio — which, paired
 * with formatReady's "?", is the one thing an operator must not gloss over.
 *
 * A `checkedAt` that does not parse is printed verbatim. Rendering "NaN ago",
 * or silently calling it fresh, would be a lie about a field whose whole job
 * is saying how much to trust the value beside it.
 */
export function formatCheckedAt(readiness: StudioStatus["readiness"], now: Date): string {
  if (readiness == null) return "never";
  if (Number.isNaN(Date.parse(readiness.checkedAt))) return readiness.checkedAt;
  // Clock skew (the Worker stamps checkedAt, the Mac renders it) must never
  // print a negative age — floored at 0, which reads as "just now" and is.
  return `${formatAgeFloor(ageSeconds(readiness.checkedAt, now))} ago`;
}

/** How stale a readiness verdict must be before the CLI itself calls it
 *  unverified — 2 sync cycles plus a minute of slack (issue #85). Derived
 *  from SYNC_SESSION_SECONDS, never a bare 660. */
const UNVERIFIED_AFTER_SECONDS = 2 * SYNC_SESSION_SECONDS + 60;

export function ageSeconds(iso: string, now: Date): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now.getTime() - at) / 1000));
}

/** Issue #1142, item 2 (the issue #911 ask), review F2: how long a lead must have
 *  been working before silence means anything. A turn that started seconds ago
 *  has not logged its first call yet (anthropic-route logs at completion). */
export const INFER_SILENT_MIN_WORKING_MS = 5 * 60 * 1000;

/**
 * Issue #1142, item 2: a router-led row (glm, which kimi/deepseek are stored as
 * too) whose lead reads "working" yet made ZERO router calls in the INFER window
 * — the lead claims progress the router never saw. Reads the same gate fleet ls
 * ACTIVITY reads (leadGate: a limit, a replaced row, or a stopped one is never
 * "working"), the same freshness rule the --json `lead` field applies (a stale
 * mirror is never "working"), and a working run long enough to have logged a
 * call. `usageKnown` is whether the usage map answered at all: an absent answer
 * is no data, never 0, so it can never flag. Claude-led and idle rows are never
 * silent.
 */
export function isLeadInferenceSilent(
  status: StudioStatus,
  u: LeadInferUsage | undefined,
  usageKnown: boolean,
  now: Date,
): boolean {
  if (!usageKnown || status.leadType !== "glm") return false;
  if (leadGate(status, now).kind !== "activity") return false;
  const activity = status.observed?.activity;
  if (activity?.state !== "working") return false;
  // A timestamp that does not parse is no evidence either way: NaN compares false
  // against every threshold, and ageSeconds reads an unparseable mirror as age 0
  // (fresh), so both stamps are rejected up front.
  const observedMs = Date.parse(activity.observedAt);
  const sinceMs = Date.parse(activity.since);
  if (!Number.isFinite(observedMs) || !Number.isFinite(sinceMs)) return false;
  if (ageSeconds(activity.observedAt, now) > ACTIVITY_MIRROR_STALE_SECONDS) return false;
  if (now.getTime() - sinceMs < INFER_SILENT_MIN_WORKING_MS) return false;
  return (u?.calls ?? 0) === 0;
}

/**
 * Issue #85 — READY overrides, `state: "running"` only, first match wins:
 * replaced -> unreachable -> mismatch (#911/#1142) -> unverified -> null (render
 * today's formatReady).
 * A stopped or provisioning studio (the operation lock — #86/#87) never
 * gets an override: a bring-up in flight has no token yet, and a stopped
 * studio renders exactly as today. Maestro correction #11: `unreachable`
 * carries its own cost (what a `recycle` right now would lose) rather than
 * a bare `→ recycle` — an operator should never have to go look that up
 * separately before deciding whether the loss is acceptable.
 */
export function readyOverride(status: StudioStatus, now: Date): string | null {
  if (status.state !== "running") return null;
  const observed = status.observed;
  if (observed?.replacedAt != null) {
    return `replaced ${formatAge(ageSeconds(observed.replacedAt, now))} ago — not brought up`;
  }
  // Board issue #183 — replaces the old fixed `execFailures >= 3` gate
  // (issue #85 PR1, review round 3 MUST-FIX 7) with the maestro's own
  // time-based rule: >=2 consecutive failed ship ticks AND >=90s elapsed
  // since the last known-good tick (`observed.lastShipOkAt`) — see
  // `isUnreachable`'s own doc comment (observed.ts) for the full reasoning.
  // A null `lastShipOkAt` does NOT break this render: `isUnreachable` falls
  // back to `unreachableSince` (`lastShipOkAt ?? unreachableSince`) whenever
  // `lastShipOkAt` itself is null — a studio wedged from its very first tick,
  // which never records a `lastShipOkAt` at all, still renders "unreachable"
  // correctly off that fallback anchor. `unreachableSince != null` is still
  // checked here too — it is what
  // supplies the "since <age>" figure below; `isUnreachable` alone says
  // whether the RENDER should fire at all.
  if (observed?.unreachableSince != null && isUnreachable(observed, now)) {
    const lastSnapshotAt = observed.lastSnapshotAt;
    const cost = lastSnapshotAt == null
      ? "loses everything unshipped (no snapshot on file)"
      : `loses work since snap ${formatAge(ageSeconds(lastSnapshotAt, now))}`;
    return `unreachable ${formatAge(ageSeconds(observed.unreachableSince, now))} — wedged; recycle ${cost}`;
  }
  // Issue #911: a router-led lead recorded on a Claude account burns Claude
  // quota and stalls on its limit. Surfaced here so fleet ls shows it, not
  // just the row. Issue #1142, item 3: below "unreachable", so a wedged row's
  // recycle cost is never hidden behind this line. Wording is router-neutral:
  // kimi/deepseek rows are stored glm too, so "glm" named the wrong lead.
  if (leadAccountMismatch(status)) {
    return `lead on wrong account (${status.launchedAccount}) — router lead on Claude; recycle to put it back on the router`;
  }
  const checkedAt = status.readiness?.checkedAt;
  if (checkedAt != null) {
    const age = ageSeconds(checkedAt, now);
    if (age > UNVERIFIED_AFTER_SECONDS) {
      return `unverified ${formatAge(age)} — checks not completing → fleet inspect`;
    }
  }
  return null;
}

/**
 * Issue #85 — the SESSION column. Grammar:
 * `<verdict>[ · had <n> turns][ · from snap <age> old] · snap <age>[ STALE]`
 * Maestro correction #8: `<verdict>` is `"?"` whenever there is nothing
 * useful to say (no `session` recorded at all, OR `session.verdict ===
 * "unknown"`) — but the trailing `snap <age>` suffix is ALWAYS computed and
 * ALWAYS appended regardless, because `lastSnapshotAt` is a completely
 * separate signal from the session verdict and throwing it away just
 * because the verdict itself is unclear serves nobody. The literal word
 * "unknown" is never rendered — `"?"` carries the same meaning without
 * reading like an error state distinct from every other reason this column
 * might not have a confident verdict.
 */
export function formatSession(status: StudioStatus, now: Date): string {
  const session = status.observed?.session ?? null;
  const parts: string[] = [];
  if (session === null || session.verdict === "unknown") {
    parts.push("?");
  } else {
    const verdict = session.verdict === "lost" ? "LOST" : session.verdict;
    parts.push(verdict);
    if (session.verdict === "lost") parts.push(`had ${session.turnsBefore} turns`);
    if (session.snapshotAgeS !== null && session.snapshotAgeS > UNVERIFIED_AFTER_SECONDS) {
      // Review round 3 (issue #85 PR1), MUST-FIX 8(d): a `≤` prefix when the
      // figure is only an upper bound (resolveSnapshotAge's own fallback —
      // observed.ts) — the real work-at-risk age can only be LESS than or
      // equal to this number, never more, so the reader must never read it
      // as exact.
      const bound = session.snapshotAgeIsUpperBound ? "≤" : "";
      // Board #250 (#85/#118 follow-up) — a keeper-sourced restore names the
      // keeper (`session.snapshotSource`, e.g. "daily 2026-09-20") so an
      // operator can tell it apart from a `latest` restore; absent for a
      // `latest` restore, which renders exactly as before.
      const from = session.snapshotSource ? `${session.snapshotSource} ` : "";
      parts.push(`from ${from}snap ${bound}${formatAge(session.snapshotAgeS)} old`);
    }
  }
  const lastSnapshotAt = status.observed?.lastSnapshotAt ?? null;
  if (lastSnapshotAt === null) {
    parts.push("snap ?");
  } else {
    const age = ageSeconds(lastSnapshotAt, now);
    const stale = age > UNVERIFIED_AFTER_SECONDS && status.state === "running";
    parts.push(`snap ${formatAge(age)}${stale ? " STALE" : ""}`);
  }
  return parts.join(" · ");
}

/**
 * Issue #221 (PR3a) — the two staleness budgets Principle 1 demands: the
 * reader computes the age, and a verdict past its budget renders `?` with
 * that age, never the stored word.
 *
 *   - `ACTIVITY_DO_STALE_SECONDS`: 3 × the ship tick's own 30s cadence
 *     (`SHIP_TRANSCRIPT_SECONDS`, the shared leaf src/studio/ship-cadence.ts)
 *     — the SAME three-consecutive-ticks shape PR1 uses for `unreachable`.
 *     The Worker-side twin, activity.ts's `HOOK_STALE_BUDGET_MS`, derives
 *     from the same leaf, so the sync between the two budgets is mechanical:
 *     bump the tick and both follow. For a caller reading the DO's own
 *     `activity` key directly (`fleet inspect`, `GET /studio/:id/status`).
 *   - `ACTIVITY_MIRROR_STALE_SECONDS`: `2 × SYNC_SESSION_SECONDS + 60`, the
 *     exact budget PR1 already uses for `unverified` — the D1 mirror only
 *     advances `observedAt` on the existing 300s burn-mirror cadence
 *     (do.ts's `mirrorBurnToRegistry`), so a steady state's own `observedAt`
 *     is only ever that fresh. For `fleet ls`, which reads the D1 mirror.
 *
 * `formatActivity`'s own `staleAfterSeconds` parameter defaults to the
 * mirror budget — `fleet ls`'s `formatTable` (cli/fleet.ts) calls it with no
 * third argument; a caller reading the DO directly passes
 * `ACTIVITY_DO_STALE_SECONDS` explicitly.
 */
export const ACTIVITY_DO_STALE_SECONDS = 3 * SHIP_TRANSCRIPT_SECONDS;
export const ACTIVITY_MIRROR_STALE_SECONDS = 2 * SYNC_SESSION_SECONDS + 60;

/** `until`, a UTC instant, as claude itself prints a reset ("1:30pm (UTC)") —
 *  12-hour clock, always labelled `(UTC)` regardless of the zone the pane
 *  originally showed: `RateLimitObservation.until` only ever stores the
 *  converted UTC instant, never the original printed zone, so UTC is the
 *  only zone this can honestly claim. */
function formatResetUtcClock(until: Date): string {
  const h = until.getUTCHours();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minute = String(until.getUTCMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "am" : "pm";
  return `${hour12}:${minute}${ampm} (UTC)`;
}

/**
 * The ACTIVITY column (issue #221, PR3a): whether the lead is WORKING, IDLE,
 * WAITING MEMBERS, LIMIT, or `?` with a reason — see the design's own state
 * table. `—` while `state` is not `running`/`degraded` (a stopped studio has
 * no lead to be active — the same carve-out applies while the operation
 * lock is held, which do.ts's own write side already enforces by storing
 * nothing then).
 *
 * LIMIT is checked FIRST and outranks every stored `activity` verdict —
 * `row.rateLimited` is the SAME #99/#144 detector READY already reads
 * (`formatReady`), never re-parsed here: one source of truth, two
 * renderings. Past its own printed reset, a limit says nothing and this
 * falls through to the stored activity, exactly as `formatReady` already
 * does for its own override.
 */
/**
 * Issue #221 fix round 2, Fix 5 — the shared "given a stored `Activity` (or
 * none), what word does the column say" logic, factored out of
 * `formatActivity` so `fleet inspect`'s own ACTIVITY line
 * (`formatObservedLines`, below) can reuse it against the DO's OWN
 * `ACTIVITY_DO_STALE_SECONDS` budget (90s) instead of `fleet ls`'s looser
 * D1-mirror budget (660s) — the two-budget split the design always called
 * for (this file's own `ACTIVITY_DO_STALE_SECONDS` doc comment), but which
 * `ACTIVITY_DO_STALE_SECONDS` never actually had a production caller wired
 * to until this fix (only a direct-call test exercised it before).
 */
function formatActivityVerdict(activity: Activity | null, now: Date, staleAfterSeconds: number): string {
  if (!activity) return "?";
  const age = ageSeconds(activity.observedAt, now);
  if (age > staleAfterSeconds) return `? stale ${formatAge(age)}`;
  if (activity.state === "unknown") return `? ${activity.reason ?? "unrecognised frame"}`;
  if (activity.state === "limit") return activity.reason ? `? ${activity.reason}` : "?";
  const prefix = activity.anchored ? "" : "≥";
  const sinceAge = ageSeconds(activity.since, now);
  const word = activity.state === "waiting-members" ? "WAITING MEMBERS"
    : activity.state === "waiting-question" ? "WAITING QUESTION"
      : activity.state.toUpperCase();
  // Issue #221 (PR3b) — "the rendered string names a hook source when it was
  // one" (spec, verbatim: "WORKING 40s (hook)"). Can only ever be true for
  // working/idle/waiting-question — limit/waiting-members/unknown never
  // carry source: "hook" by construction (nextActivity, activity.ts), so no
  // further state-gating is needed here.
  const sourceSuffix = activity.source === "hook" ? " (hook)" : "";
  return `${word} ${prefix}${formatAge(sinceAge)}${sourceSuffix}`;
}

/**
 * Issue #311 — one `MemberAlert` -> a static, age-computed-at-render-time
 * note. Never pre-renders an age into stored text (member-alerts.ts's
 * `MemberAlert.at`'s own doc comment, Principle 1) — this is the ONE place
 * that turns `at` into "<age> ago". The issue's own example wording
 * ("member killed by memguard <t>") is the `memguard-kill` case; the other
 * two kinds follow the same "<verb> <age> ago (<detail>)" shape for a
 * consistent row. `confidence: "inferred"` (only ever `member-gone` today —
 * see the design addendum's "Ask 2") gets a trailing `[inferred]` tag so a
 * reader never mistakes a correlation for a certainty.
 *
 * PR #336 round 2, item 2 — `poll-loop`'s verb names the member
 * (`alert.name`, PR #336's own new field) and says "long-running", never
 * "poll-loop": the detector cannot tell a genuine wedged poll loop from a
 * legitimate long-running job crossing the same unmeasured threshold (see
 * member-alerts.ts's `POLL_LOOP_ELAPSED_MINUTES`/`POLL_LOOP_TOKENS` own doc
 * comment and the design addendum's Open measurement M10) — claiming
 * "poll-loop" would assert more certainty than the evidence supports.
 */
function formatMemberAlert(alert: MemberAlert, now: Date): string {
  const age = formatAge(ageSeconds(alert.at, now));
  const verb = alert.kind === "memguard-kill" ? "member killed by memguard"
    : alert.kind === "member-gone" ? "possible member death"
      : `long-running member ${alert.name}`;
  const tag = alert.confidence === "inferred" ? " [inferred]" : "";
  return `${verb} ${age} ago (${alert.detail})${tag}`;
}

/** Issue #311 — every CURRENT alert, formatted, for `fleet inspect`'s own
 *  `member alert:` lines (`formatObservedLines`, below) — the full-detail
 *  read, one line per alert, unlike `formatActivity`'s own single-note
 *  ACTIVITY-column suffix. Empty when `alerts` is null or empty — a studio
 *  with nothing to report, or one that predates this feature, adds no
 *  lines at all (see `formatObservedLines`'s own regression-guarded "4-line
 *  shape unchanged" tests). */
function formatMemberAlertLines(alerts: MemberAlert[] | null, now: Date): string[] {
  if (!alerts || alerts.length === 0) return [];
  return alerts.map((a) => formatMemberAlert(a, now));
}

/** Issue #403 — the ONE lead-state precedence chain, factored out of
 *  `formatActivity` and `lsJsonRows` below, which were the same chain
 *  written twice and drifted together once already (#192 had to be gated in
 *  both). First match wins, identical order in both renderers before this
 *  fold: a live row (`running`/`degraded`) is required for any lead state
 *  at all; `rl.dead` (org disabled, #141) and `rl.select` (a modal, #53)
 *  outrank the clock; then the limit while its reset is null or still in
 *  the future; then a not-yet-confirmed replacement (#192) which must not
 *  report a leftover verdict; then the stored activity verdict.
 *
 *  `rl` rides the result so each renderer keeps ONLY its own rendering:
 *  `formatActivity` needs `until` for its clock string, `lsJsonRows` needs
 *  `seenAt`/`until` for `leadSince`/`limitResetsAt`. */
type LeadGate =
  | { kind: "stopped"; rl: null }
  | { kind: "dead" | "modal"; rl: RateLimitObservation }
  | { kind: "limit"; rl: RateLimitObservation }
  | { kind: "replaced"; rl: null }
  | { kind: "activity"; rl: null };

function leadGate(status: StudioStatus, now: Date): LeadGate {
  if (status.state !== "running" && status.state !== "degraded") return { kind: "stopped", rl: null };
  const rl = status.rateLimited;
  if (rl?.dead) return { kind: "dead", rl };
  if (rl?.select) return { kind: "modal", rl };
  const until = rl?.until ?? null;
  if (rl && (until === null || (!Number.isNaN(Date.parse(until)) && Date.parse(until) > now.getTime()))) {
    return { kind: "limit", rl };
  }
  // Issue #192 — a rollout can replace a running studio's container without
  // a clean onStop first, so the DO's `activity` key can still hold a word
  // left over from BEFORE the replacement; both renderers say "no lead"
  // rather than contradict readyOverride's "replaced … not brought up".
  if (status.observed?.replacedAt != null) return { kind: "replaced", rl: null };
  return { kind: "activity", rl: null };
}

export function formatActivity(status: StudioStatus, now: Date, staleAfterSeconds: number = ACTIVITY_MIRROR_STALE_SECONDS): string {
  // Issue #403 — the precedence chain lives in leadGate above; this keeps
  // only the ACTIVITY column's own rendering of each kind.
  const gate = leadGate(status, now);
  let base: string;
  switch (gate.kind) {
    // Review round 1 (S1): the pre-fold code returned "—" for a non-live
    // row BEFORE the member-alert suffix below ran, so a stopped row never
    // carried an alert note; the early return here keeps that exact shape.
    case "stopped":
      return "—";
    case "replaced":
      base = "—";
      break;
    case "dead":
      base = "DEAD · org disabled subscription access";
      break;
    case "modal":
      base = `LIMIT · modal — Esc (ff ${status.id})`;
      break;
    case "limit":
      base = gate.rl.until !== null && !Number.isNaN(Date.parse(gate.rl.until)) && Date.parse(gate.rl.until) > now.getTime()
        ? `LIMIT · resets ${formatResetUtcClock(new Date(Date.parse(gate.rl.until)))}`
        : "LIMIT";
      break;
    // No `default:` — an explicit case lets tsc enforce that every future
    // LeadGate kind gains a rendering here (the repo's no-default switch
    // convention, e.g. src/studio/survival-delivery.ts).
    case "activity":
      base = formatActivityVerdict(status.observed?.activity ?? null, now, staleAfterSeconds);
  }
  // Issue #311 — the freshest current alert (buildMemberAlerts's own push
  // order: memguard-kill, then member-gone, then poll-loop — already a
  // reasonable severity ordering) rides as a " · "-joined suffix on EVERY
  // branch above, LIMIT included: the alert axis (a member/background
  // process) is independent of the lead's own state a limit describes.
  const alerts = status.observed?.memberAlerts ?? null;
  if (alerts && alerts.length > 0) {
    return `${base} · ${formatMemberAlert(alerts[0], now)}`;
  }
  return base;
}

/** Issue #70 ask 4: one studio's lead, machine-readable (`fleet ls --json`). */
interface LsJsonRow {
  id: string;
  state: StudioStatus["state"];
  repo: string | null;
  /** stopped = not live; dead = org disabled subscription access (issue
   *  #141, permanent); modal = limit menu up; limit = usage limit; unknown =
   *  no verdict or a stale one; else the ACTIVITY verdict. */
  lead: "stopped" | "dead" | "modal" | "limit" | "unknown" | "working" | "idle" | "waiting-members" | "waiting-question";
  /** When the lead entered that state, ISO, or null when not known. */
  leadSince: string | null;
  limitResetsAt: string | null;
  /** The ACTIVITY column's own text, unchanged. */
  activity: string;
  /** The lead's last visible, non-chrome message line — redacted, bounded;
   *  issue #108 (#70 ask 4 remainder). */
  lastLine: string | null;
  /** Board issue #332: how many unmerged, still-open PRs this studio's
   *  assigned tasks name, per the board's open-prs route. Present ONLY when
   *  the route answered for the studio's repo (`fleet ls --prs` passes the
   *  map openPrsByStudio built — opt-in, #332 review H1; bare ls passes
   *  none); absent means "no data" (no --prs, or an old Worker whose route
   *  404s), never a silent 0 — the same "-"-vs-count split the PRS table
   *  column renders. */
  openPrs?: number;
  /** Issue #934: lead calls + ok count in the last 30 min, present ONLY
   *  when the lead-usage route answered for this studio (absence = no data,
   *  same contract as openPrs above — no lead calls in the window, or a
   *  Worker whose route 404s — never a silent 0/0). */
  infer?: { calls: number; ok: number };
  /** Issue #1074 ask 1: the lead's type — claude, glm, or a pool key (kimi,
   *  deepseek) — and the short id of the model it runs on (null when the
   *  CLI cannot know it: a claude lead, or a glm lead with no assignment). */
  leadType: string;
  leadModel: string | null;
}

/** The same data the ACTIVITY column renders, as a lead state per studio.
 *  #934: `inferBy` rides along exactly like `openPrs` — one map for the
 *  whole listing, per-row keys only for the studios it covers. */
export function lsJsonRows(
  studios: StudioStatus[], now: Date, staleAfterSeconds: number = ACTIVITY_MIRROR_STALE_SECONDS,
  openPrs?: Map<string, number>, inferBy?: Map<string, LeadInferUsage>,
  assignments?: Record<string, string>,
): LsJsonRow[] {
  return studios.map((s) => {
    // #403's precedence chain lives in leadGate above; the nested-function
    // wrap is #332's: the PRS decoration below wraps every kind's return in
    // ONE place instead of editing each case.
    // The lead fields are folded on after the kind switch (below), so the
    // per-kind builder types the row without them.
    const leadRow = (): Omit<LsJsonRow, "leadType" | "leadModel"> => {
      const base = {
        id: s.id, state: s.state, repo: s.repoSlug ?? null, activity: formatActivity(s, now, staleAfterSeconds),
        lastLine: s.observed?.lastMessageLine ?? null,
      };
      // Issue #403 — the precedence chain lives in leadGate above; this keeps
      // only the JSON row's own field mapping per kind.
      const gate = leadGate(s, now);
      switch (gate.kind) {
        case "stopped":
          return { ...base, lead: "stopped", leadSince: null, limitResetsAt: null };
        case "dead":
          return { ...base, lead: "dead", leadSince: gate.rl.seenAt, limitResetsAt: null };
        case "modal":
          return { ...base, lead: "modal", leadSince: gate.rl.seenAt, limitResetsAt: gate.rl.until ?? null };
        case "limit": {
          // `until === null` (no readable reset printed) and a reset still in
          // the future are BOTH "limit" here; the `limitResetsAt` field carries
          // the clock either way, null when there was none.
          const until = gate.rl.until ?? null;
          return { ...base, lead: "limit", leadSince: gate.rl.seenAt, limitResetsAt: until };
        }
        case "replaced":
          return { ...base, lead: "unknown", leadSince: null, limitResetsAt: null };
        // No `default:` — explicit case for tsc exhaustiveness over LeadGate.
        case "activity": {
          const a = s.observed?.activity ?? null;
          if (!a || ageSeconds(a.observedAt, now) > staleAfterSeconds || a.state === "unknown") {
            return { ...base, lead: "unknown", leadSince: null, limitResetsAt: null };
          }
          if (a.state === "limit") return { ...base, lead: "limit", leadSince: a.since, limitResetsAt: null };
          return { ...base, lead: a.state, leadSince: a.since, limitResetsAt: null };
        }
      }
    };
    const row = leadRow();
    // Board issue #332: an entry (0 included) is a counted answer; ABSENCE
    // is "no data", so the key is omitted entirely rather than written as 0 —
    // a reader scraping this JSON must never mistake "could not look" for
    // "looked and found none". Issue #934: `infer` folds onto that SAME
    // trailing return — one shape, both decorations, absence never a 0/0.
    const count = openPrs?.get(s.id);
    const infer = inferBy?.get(s.id);
    const decorated = count === undefined && infer === undefined
      ? row
      : { ...row, ...(count === undefined ? {} : { openPrs: count }), ...(infer === undefined ? {} : { infer }) };
    // Issue #1074 ask 1: lead type and model ride every row — never absent,
    // so a reader never has to guess a missing key means "claude".
    const lead = leadModelOf(s, assignments);
    return { ...decorated, leadType: lead.leadType, leadModel: lead.leadModel };
  });
}

/**
 * STATE column. Issue #95: a studio recorded `stopped` whose container the
 * Worker's detector saw RUNNING is billing while the registry says off, so
 * the column says so instead of the bare word. Rendered only while `stopped`
 * — a running container is expected in every other state. The time is the
 * detector's first sighting, in UTC (`HH:MMZ`); an unparseable value prints
 * verbatim, never as a time it is not.
 */
export function formatState(s: StudioStatus): string {
  if (s.state !== "stopped" || s.containerRunningSince == null) return s.state;
  const at = Date.parse(s.containerRunningSince);
  const since = Number.isNaN(at) ? s.containerRunningSince : `${new Date(at).toISOString().slice(11, 16)}Z`;
  return `stopped (container RUNNING since ${since} — billing)`;
}

/**
 * Issue #94: one line per studio whose session sync guard last refused a
 * candidate — `latest` was kept, the candidate went to a `displaced/` key.
 * Empty when no studio carries a refusal.
 *
 * Issue #228 item 5: also one line per studio whose force-next-sync override
 * is currently ARMED (StudioStatus.sessionForceArmedAt) — a `fleet
 * clear-session-guard` an operator ran that no tick has consumed yet, and
 * which was previously invisible here entirely.
 *
 * HOLD fix round NIT: the paragraph this replaces claimed a studio can
 * carry both lines at once because an armed override "still shows the OLD
 * refusal until the next tick clears it" — wrong. `clearSessionGuard`
 * (do.ts) nulls a non-oversize `SESSION_GUARD_KEY` on the SAME write that
 * arms the override (see that function's own doc comment), so arming
 * clears the old refusal immediately, not on the next tick. Both lines
 * actually co-exist in exactly two cases: (1) an OVERSIZE refusal, which
 * `clearSessionGuard` deliberately leaves alone (issue #176: a tar too big
 * to sync at all is not a stale guard the override can resolve); or (2) a
 * candidate synced AFTER arming that was itself blank, unreadable, or
 * un-forceable (no `r2Get` wired) — `syncSessionTick` displaces that
 * candidate too (writing a fresh `SESSION_GUARD_KEY`) while leaving the
 * override armed for a later, real candidate (see that function's own
 * "blank or unreadable candidate still refuses" doc comment above).
 *
 * Issue #258 round-3 (maestro brief item 3): also one line per studio whose
 * burn cursor/burn PERSIST last failed (`StudioStatus.burnPersistError`,
 * mirrored from session-sync.ts's own `BURN_PERSIST_ERROR_KEY` by do.ts's
 * `mirrorBurnToRegistry`) — a DISTINCT failure mode from `sessionGuard`
 * above (that field's own doc comment explains why the two ride separate
 * storage keys: a burn-persist failure and a displaced-snapshot refusal can
 * both occur on the very same tick, and used to clobber each other under one
 * shared field). Silent once a later tick's persist succeeds again
 * (`burnPersistError` back to `null`).
 *
 * Issue #115: also one line per studio whose `--fresh-session` intent is
 * currently PENDING (`StudioStatus.freshSessionPending`, mirrored from
 * provision.ts's own `FRESH_SESSION_PENDING_KEY` by do.ts's
 * `mirrorBurnToRegistry`, same bridge `sessionForceArmedAt` crosses) — a
 * prior `--fresh-session` attempt that never reached a CONFIRMED success, and
 * which keeps forcing every later provision fresh until one finally succeeds
 * or `fleet provision <id> --no-fresh-session` cancels it. Previously
 * invisible here entirely, same gap `sessionForceArmedAt` closed for the
 * force-next-sync override.
 */
export function formatSessionGuards(studios: StudioStatus[]): string[] {
  const lines: string[] = [];
  for (const s of studios) {
    const g = s.sessionGuard;
    if (g) {
      // Issue #176: an oversize refusal wrote nothing aside — it is a studio
      // that has STOPPED syncing, and says since when.
      if (g.tarBytes !== undefined && g.capBytes !== undefined) {
        const mib = (n: number) => `${Number((n / 1_048_576).toFixed(1))} MiB`;
        lines.push(`SESSION GUARD ${s.id}: NOT SYNCED since ${g.at}; tar ${mib(g.tarBytes)} > cap ${mib(g.capBytes)}; latest stale; burn not updating`);
      } else {
        lines.push(`SESSION GUARD ${s.id}: kept latest at ${g.at}, candidate -> ${g.key} (${g.reason})`);
      }
    }
    if (s.sessionForceArmedAt) {
      // HOLD fix round NIT: was "SESSION GUARD x: session guard: force-
      // next-sync armed since <t>" — a stutter, the same "session guard"
      // said twice. The leading "SESSION GUARD <id>:" prefix already names
      // what kind of line this is.
      lines.push(`SESSION GUARD ${s.id}: force-next-sync armed since ${s.sessionForceArmedAt}`);
    }
    if (s.burnPersistError) {
      lines.push(`BURN PERSIST ${s.id}: FAILED since ${s.burnPersistError.at} (${s.burnPersistError.reason})`);
    }
    // Issue #115: a stuck fresh-session intent, previously invisible here.
    if (s.freshSessionPending) {
      lines.push(`FRESH SESSION ${s.id}: fresh-session pending`);
    }
    // PR #46 review (#37): an aside session that is not reaching R2.
    for (const f of s.asideShip?.failed ?? []) {
      lines.push(`ASIDE ${s.id}: NOT SHIPPED ${f.dir} as of ${s.asideShip!.at} (${f.reason})`);
    }
  }
  return lines;
}

/**
 * Issue #249 (PR4b) round 2, item 2 — one line per studio that owes a survival
 * re-brief nobody has managed to type yet. Empty when every studio is square.
 *
 * SAME SHAPE AND SAME PLACE as `formatSessionGuards` above (a per-studio extra
 * line under the `fleet ls` table, keyed off a record the DO mirrors onto
 * `StudioStatus`), deliberately rather than a new column: this is a rare,
 * explanatory state, and a column would cost every row width for something
 * almost every row has nothing to say about. The record arrives through
 * `StudioStatus.observed` (do.ts's `withObserved`), which the sync tick already
 * mirrors to D1 on every tick — no new write path.
 *
 * TWO STATES, because they ask different things of an operator:
 *  - PENDING: the studio is still retrying on its own, and the line exists so
 *    the retry is not invisible while it happens.
 *  - UNDELIVERED: the bound in `SURVIVAL_RETRY_MAX_ATTEMPTS`/
 *    `SURVIVAL_RETRY_WINDOW_MS` (survival-delivery.ts) was exceeded and the
 *    studio has STOPPED trying. #107's whole complaint is a lead that was never
 *    told what survived and nothing anywhere saying so; this is the line that
 *    says so, and it is the reason the pending record is kept rather than
 *    deleted on give-up.
 *
 * Total against an older Worker: `observed` is absent from a pre-#85 response
 * and `survivalBriefPending` from a pre-#249 one, and both read as "nothing to
 * say" rather than throwing — the same defence `formatObservedLines` below was
 * written for.
 */
export function formatSurvivalBriefs(studios: StudioStatus[]): string[] {
  const lines: string[] = [];
  for (const s of studios) {
    const p = s.observed?.survivalBriefPending;
    if (!p) continue;
    const why = p.reason === "" ? "no reason recorded" : p.reason;
    lines.push(p.gaveUpAt
      ? `SURVIVAL ${s.id}: re-brief undelivered since ${p.since}, gave up ${p.gaveUpAt} after ${p.attempts} attempts — ${why}`
      : `SURVIVAL ${s.id}: re-brief pending since ${p.since}, ${p.attempts} attempts so far — ${why}`);
  }
  return lines;
}

/**
 * Issue #141 review, item 4 — every account the fleet knows is dead, printed
 * UNCONDITIONALLY (not filtered by which studio is currently on it — a dead
 * account with no studio parked on it right now is exactly the case a
 * per-studio view can never surface, and is real: several accounts can go
 * dead in one org-wide disable while every studio has already moved off of
 * them). SAME SHAPE AND SAME PLACE as `formatSessionGuards`/
 * `formatSurvivalBriefs` above: a plain-text trailer under the `fleet ls`
 * table, fed by `GET /studio/accounts` (src/studio/routes.ts) rather than by
 * `StudioStatus` — this is fleet-wide account state, not a per-studio field.
 */
export function formatDeadAccounts(
  accounts: { name: string; label: string | null; dead: boolean; seenAt: string | null }[],
): string[] {
  const dead = accounts.filter((a) => a.dead);
  if (dead.length === 0) return [];
  return dead.map((a) => {
    const label = a.label ? `${a.label} (${a.name})` : a.name;
    return `dead account: ${label}${a.seenAt ? ` — seen ${a.seenAt}` : ""} — see docs/operations.md#clearing-a-dead-claude-account to clear it`;
  });
}

/**
 * Issue #85 review, BLOCKER 2 — `fleet inspect`'s three "observed" lines
 * (`replaced:`/`unreachable:`/`session:`), extracted into a pure formatter so
 * `cmdInspect` (cli/fleet.ts) never reads `body.observed.*` directly and
 * crashes when `observed` itself is missing. Two distinct response shapes
 * carry no `observed` field at all: routes.ts's "Worker->DO call failed"
 * catch branch (a rejection reaching `stub.inspect` itself, before
 * `runInspect` — and therefore before `getObserved` — ever runs), and a
 * Worker deployed BEFORE this feature landed, talking to a NEWER CLI.
 *
 * Review round 6, MUST-FIX 3: both shapes reach `cmdInspect` (cli/fleet.ts)
 * as the exact same wire shape — `body.observed === undefined`, nothing else
 * distinguishes them at that call site (routes.ts's catch branch returns
 * `{ ok: false, error }` with no `observed` field at all, same as a pre-#85
 * Worker's response body simply never having one) — so this prints the
 * combined, honest wording rather than picking one guess over the other.
 *
 * Issue #221 fix round 2, Fix 5 — the `activity:` line, added here rather
 * than nowhere: `fleet inspect` used to print no ACTIVITY field at all,
 * despite reading the DO's own `activity` key directly at zero container
 * cost, exactly like every other line in this function already does. Uses
 * `ACTIVITY_DO_STALE_SECONDS` (90s, three ship ticks) — the DO-direct budget
 * the design always specified for a caller reading `activity` straight off
 * the DO (as opposed to `fleet ls`'s D1-mirror read, which uses the looser
 * 660s `ACTIVITY_MIRROR_STALE_SECONDS`) — never `row.rateLimited`: inspect
 * has no live row to hand it, and Principle 5 ("unknown is neither good nor
 * bad") makes falling through to the stored word here entirely correct.
 */
export function formatObservedLines(observed: Observed | undefined, now: Date = new Date()): string[] {
  if (observed === undefined) return ["observed:     ? (DO call failed, or Worker predates #85)"];
  return [
    `replaced:     ${observed.replacedAt ? `yes, since ${observed.replacedAt}` : "no"}`,
    `unreachable:  ${formatUnreachableLine(observed, now)}`,
    `session:      ${formatSessionLine(observed.session)}`,
    // Issue #192 — same gate as formatActivity above: a replaced-but-not-
    // yet-confirmed studio must not pair "replaced: yes" with a leftover
    // pre-replacement activity word.
    `activity:     ${observed.replacedAt != null ? "—" : formatActivityVerdict(observed.activity, now, ACTIVITY_DO_STALE_SECONDS)}`,
    // Issue #311 — one "member alert:" line per CURRENT alert, using the
    // DO-direct budget's own `now` (inspect reads the DO directly, no
    // staleness gate of its own here — same posture `activity:` above
    // already takes: the freshest DO-stored value, age computed at render
    // time). Adds NOTHING when `memberAlerts` is null/empty — see this
    // function's own tests for the "4-line shape unchanged" regression
    // guard.
    ...formatMemberAlertLines(observed.memberAlerts, now).map((l) => `member alert: ${l}`),
  ];
}

/**
 * Board issue #183 — `unreachableSince` is stamped at the FIRST failure of a
 * streak (do.ts, issue #85 review round 3 MUST-FIX 7), not once the studio
 * is actually considered unreachable — so rendering "yes" off
 * `unreachableSince != null` alone would flip this line on a single blip, a
 * tick before `readyOverride` (this same file) would ever show it on
 * `fleet ls`. This gates on the EXACT same time-based rule `isUnreachable`
 * uses (>=2 consecutive failures AND >=90s since `lastShipOkAt`) so the two
 * surfaces never disagree — replaces the old fixed `execFailures >= 3` gate.
 * Below that threshold, a building streak is still worth surfacing — "no (N
 * failed ticks since <t>)" — rather than silently discarding it back to a
 * bare "no" as if nothing were happening.
 */
function formatUnreachableLine(observed: Observed, now: Date): string {
  if (observed.unreachableSince == null) return "no";
  if (isUnreachable(observed, now)) return `yes, since ${observed.unreachableSince}`;
  return `no (${observed.execFailures} failed ticks since ${observed.unreachableSince})`;
}

/**
 * Issue #85 review round 4, NIT 15 — the verdict alone ("lost (via
 * restart)") makes an operator go dig for WHY separately; `reason` (set on
 * every LOST/unknown verdict, null on resumed/fresh — ObservedSession's own
 * doc comment) is appended right here, em-dash separated, matching the same
 * "— <cost/reason>" convention `readyOverride`'s own `unreachable`/
 * `unverified` lines already use.
 */
function formatSessionLine(session: Observed["session"]): string {
  if (!session) return "? (no verdict recorded yet)";
  // Issue #231 — bring-up log provenance: which trigger (explicit flag vs. a
  // stored pending key) caused `freshSession: true` for THIS bring-up.
  // Absent on every ordinary (non-fresh) bring-up — renders exactly as
  // before in that case.
  const fresh = session.freshSessionSource ? `, fresh: ${session.freshSessionSource}` : "";
  const base = `${session.verdict} (via ${session.via}${fresh})`;
  return session.reason ? `${base} — ${session.reason}` : base;
}
