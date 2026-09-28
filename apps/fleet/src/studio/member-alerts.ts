// Issue #311 — PR3 addendum: memguard kills, member liveness, and the
// poll-loop guard. See docs/superpowers/specs/2026-09-24-row-tells-truth-
// design.md, "PR3 addendum (issue #311)", for the full design, including
// WHY this lives in its own file rather than folded into activity.ts
// (`Activity` is deliberately about the LEAD alone) and the two
// mutant-proof claims `test/studio.member-alerts.test.ts` pins.
//
// Observation-only (spec Principle 2, reaffirmed for #311): nothing in this
// file heals, restarts, wakes, or recycles anything. It only builds a list
// of facts a reader (`fleet ls`/`fleet inspect`, or the lead inspecting
// itself) can choose to act on.
import { agentPanelRows } from "./activity";
import { MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY } from "./failover";
import type { MemguardKillLogEntry } from "./memguard-log";

export { MEMBER_ALERTS_KEY, MEMBER_ROWS_KEY };

export type MemberAlertKind = "memguard-kill" | "member-gone" | "poll-loop";

export interface MemberAlert {
  kind: MemberAlertKind;
  /** PR #336 round 2, item 1 — the alert's own subject: the member row name
   *  for `member-gone`/`poll-loop`, or the killed process's own `comm` for
   *  `memguard-kill`. Exists ONLY so equality (do.ts's `sameAlertSet`) and
   *  first-seen lookup (`buildMemberAlerts`'s own `prevAlerts` scan, below)
   *  can key on `kind`+`name` directly, never by parsing it back out of the
   *  free-text `detail` — `detail` stays free-text precisely because nothing
   *  needs to parse it. Not rendered on its own (cli/readiness-format.ts's
   *  `formatMemberAlert` folds it into the verb text for `poll-loop`; the
   *  other two kinds still carry it in `detail` too, unchanged). */
  name: string;
  /** ISO — the underlying evidence's OWN timestamp: the kill log line's own
   *  time for `memguard-kill`/`member-gone` (there is a real, better anchor
   *  than "now" for those). For `poll-loop`, the FIRST tick this exact
   *  (kind, name) alert appeared — carried forward from `prevAlerts` on
   *  every later tick the same row keeps crossing the threshold, never
   *  re-stamped to "now" each time.
   *
   *  PR #336 round 2, item 1 (BLOCKER) — round 1 stamped `at: now` on EVERY
   *  tick a poll-loop row stayed flagged. Two compounding bugs followed: (a)
   *  `sameAlertSet`'s whole-JSON compare then read as "changed" every single
   *  30s tick for the entire duration of any long-running member, firing an
   *  out-of-cadence D1 write unboundedly instead of only on a genuine
   *  set-membership change; (b) `formatMemberAlert`'s own "<age> ago" render
   *  (`ageSeconds(alert.at, now)`) always measured against a timestamp that
   *  was itself always "now", so the row permanently read as "~0s ago" no
   *  matter how long the alert had actually been live. Never pre-renders an
   *  age itself either way — Principle 1: the reader computes it. */
  at: string;
  /** Static, age-free description — `cli/readiness-format.ts`'s formatter
   *  appends "<age> ago" itself. */
  detail: string;
  /** "measured" — read directly off memguard's own on-disk log
   *  (`memguard-kill`) or the row's own printed fields (`poll-loop`).
   *  "inferred" — a correlation across two independent, noisy signals
   *  (`member-gone`), never a certainty; see the design addendum's "Ask 2"
   *  and Open measurement M8. */
  confidence: "measured" | "inferred";
}

// MEMBER_ALERTS_KEY/MEMBER_ROWS_KEY themselves are defined in failover.ts
// and re-exported above — see that file's own doc comment for why (this
// module's own value-import of `agentPanelRows` FROM activity.ts would
// otherwise cycle back through activity.ts's `clearActivityState`, which
// needs both keys too).
//
// MEMBER_ALERTS_KEY: D1-mirrored as `Observed.memberAlerts` — same "own
// key, never inside OBSERVED_KEY's own read-patch-write cycle" convention
// `ACTIVITY_KEY` (activity.ts) already established (Principle 4).
// Overwritten wholesale every ship tick — no accumulation, no cap/trim
// logic, matching Principle 1 (the reader computes staleness from each
// alert's own `at`, not from when it was appended to a list).
//
// MEMBER_ROWS_KEY: last tick's member-row NAMES only — nothing else
// survives across ticks; elapsed/tokens are read fresh off the row every
// 30s and need no historical baseline. Used solely to detect a row that
// VANISHED between two ticks (`goneMemberNames`, below).

export interface MemberAlertsStorage {
  get(key: typeof MEMBER_ALERTS_KEY): Promise<MemberAlert[] | undefined>;
  get(key: typeof MEMBER_ROWS_KEY): Promise<string[] | undefined>;
  put(key: typeof MEMBER_ALERTS_KEY, value: MemberAlert[]): Promise<void>;
  put(key: typeof MEMBER_ROWS_KEY, value: string[]): Promise<void>;
}

export interface MemberRow {
  name: string;
  elapsedS: number;
  /** Absolute token count — "225.5k tokens" becomes 225500, "506.3k
   *  tokens" becomes 506300, a plain "3 tokens" (no 'k') stays 3. */
  tokens: number;
}

// "1h 1m 15s", "36m 35s", "15s" — every unit optional, but at least one must
// be present (an all-empty match, e.g. from trailing whitespace alone, is
// rejected by the caller below, never silently read as 0s).
const DURATION = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/;

function parseDurationS(text: string): number | null {
  const m = DURATION.exec(text.trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

// A background-agent row, e.g. (real fixture, test/fixtures/rate-limit-
// panes.ts:621): "  ◯ frontend-developer  Track A e2e harness tasks 1…
// 1h 1m 15s · ↑ 225.5k tokens". Group 1: the member's name (the first
// whitespace-run after the glyph — claude never puts a space in this
// field). Group 2 (lazy): the free-text task snippet, which may itself
// contain spaces, digits, and an ellipsis — deliberately NOT parsed for
// content, only skipped over. Group 3: the duration, anchored to the same
// digit/h/m/s shape DURATION above expects, always immediately before
// " · ↑ ". Group 4/5: the token count, with an optional trailing "k". A row
// with no duration/token suffix at all (e.g. "  ● main") simply does not
// match and is skipped by the caller — see parseMemberRows.
const MEMBER_ROW =
  /^\s*(?:❯\s*)?[●◯⏺]\s+(\S+)\s+(.*?)\s*((?:\d+h\s*)?(?:\d+m\s*)?\d+s)\s*·\s*↑\s*(\d+(?:\.\d+)?)(k)?\s*tokens\s*$/;

/**
 * Parses individual agent-panel rows out of ONE pane capture — the SAME
 * `SECTION_PANE` frame `activity.ts`'s `agentPanelRows` already slices for
 * the panel-diff leg, reused here rather than re-implementing the footer/
 * panel boundary (no re-parse, matching this file's own "reuse, don't
 * fork" rule). Rows that do not carry a recognisable duration+token suffix
 * (a lead-only marker row like "  ● main", or anything unrecognised) are
 * silently skipped — this is a best-effort read of free-form terminal text,
 * never a source of truth that must account for every row, and skipping is
 * strictly safer than guessing at a shape that does not match.
 */
export function parseMemberRows(paneCapture: string): MemberRow[] {
  const joined = agentPanelRows(paneCapture);
  if (joined === null || joined === "") return [];
  const out: MemberRow[] = [];
  for (const line of joined.split("\n")) {
    const m = MEMBER_ROW.exec(line);
    if (!m) continue;
    const elapsedS = parseDurationS(m[3]);
    if (elapsedS === null) continue;
    const raw = Number(m[4]);
    if (!Number.isFinite(raw)) continue;
    const tokens = m[5] === "k" ? Math.round(raw * 1000) : Math.round(raw);
    out.push({ name: m[1], elapsedS, tokens });
  }
  return out;
}

/**
 * #311 design addendum, "Ask 3" — placeholder thresholds, EXPLICITLY NOT
 * measured against a real distribution of healthy-vs-wedged member timings.
 * Chosen only to sit below both figures issue #311 itself measured
 * (1h10m/506.3k tokens; 34m), so both real wedge incidents that motivated
 * this issue would have flagged. Needs real-world tuning once this ships
 * and produces real samples — see the design addendum's Open measurement
 * M10. Either threshold alone flags (OR, not AND): a wedge can show a
 * frozen token count with climbing elapsed time just as easily as a large
 * but still-growing one, and there is no measured way yet to prefer one
 * signal over the other.
 */
export const POLL_LOOP_ELAPSED_MINUTES = 30;
export const POLL_LOOP_TOKENS = 300_000;

/** Every CURRENT row whose own printed elapsed time or token count crosses
 *  the poll-loop threshold — see POLL_LOOP_ELAPSED_MINUTES's own doc
 *  comment for the OR/threshold rationale. */
export function pollLoopFlags(rows: MemberRow[]): MemberRow[] {
  return rows.filter((r) => r.elapsedS >= POLL_LOOP_ELAPSED_MINUTES * 60 || r.tokens >= POLL_LOOP_TOKENS);
}

/** Names present in `prevNames` (last tick's row-name snapshot) but absent
 *  from `currentRows` (this tick's parsed rows) — a row that VANISHED
 *  between two ticks. On its own this is NOT evidence of death (see
 *  buildMemberAlerts's own doc comment) — it is the raw diff `buildMemberAlerts`
 *  gates behind a corroborating memguard kill before ever surfacing it. */
export function goneMemberNames(prevNames: string[], currentRows: MemberRow[]): string[] {
  const current = new Set(currentRows.map((r) => r.name));
  return prevNames.filter((n) => !current.has(n));
}

/** How long a memguard kill stays worth surfacing at all. #311 design
 *  addendum's own Open measurement M9: unmeasured against any real
 *  polling/operator-check cadence, chosen only as "long enough for an
 *  operator checking every few minutes to still see it." */
export const MEMGUARD_ALERT_RETENTION_S = 10 * 60;

/** How close a vanished row and a memguard kill must land to correlate them
 *  into a `member-gone` alert — three ship ticks (30s cadence), the same
 *  cadence-multiple shape `ACTIVITY_DO_STALE_SECONDS` (cli/readiness-
 *  format.ts) already uses for its own DO-direct staleness budget. */
export const MEMBER_GONE_CORRELATION_S = 90;

function ageS(iso: string, now: Date): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / 1000) : Number.POSITIVE_INFINITY;
}

/**
 * Composes this tick's evidence into the `MemberAlert[]` written to
 * `MEMBER_ALERTS_KEY` — recomputed and OVERWRITTEN wholesale every tick,
 * never appended to (Principle 1: staleness is computed from each alert's
 * own `at`, not from list position).
 *
 * `killEntries` — this tick's SECTION_MEMGUARD tail, already parsed
 * (`parseMemguardKillLines`). `prevNames` — last tick's `MEMBER_ROWS_KEY`
 * snapshot. `currentRows` — this tick's `parseMemberRows` result. `now` —
 * this tick's own clock, injected (never `new Date()` read here — this
 * function stays pure and directly testable, the same discipline every
 * other pure decision table in this feature follows).
 *
 * MUTANT PROOF (a), `test/studio.member-alerts.test.ts`: a fresh kill in
 * `killEntries` ALWAYS produces a `memguard-kill` alert — a kill that
 * happened must never silently produce zero alerts.
 *
 * MUTANT PROOF (b), same file: a name in `goneMemberNames(prevNames,
 * currentRows)` produces a `member-gone` alert ONLY when the freshest kill
 * is also inside `MEMBER_GONE_CORRELATION_S` of `now` — a row vanishing
 * with NO nearby kill produces NOTHING, never a guess. This is the exact
 * "must never claim a member died when it merely finished cleanly"
 * guarantee the task specified, to the extent current evidence supports it
 * (see the design addendum's "Confidence, stated plainly" and Open
 * measurement M8 — there is no measured way yet to tell a clean finish
 * from a silent death without a corroborating kill).
 *
 * MUTANT PROOF (c), PR #336 round 2, item 1: `prevAlerts` carries a
 * `poll-loop` alert's `at` forward across ticks for the SAME (kind, name) —
 * comparing the whole `MemberAlert[]` (round-1 `sameAlertSet`) instead of
 * `kind`+`name` identity turns this red (see do.ts's `sameAlertSet` and
 * `test/studio.do.test.ts`'s own pin for the D1-write side of this same
 * proof).
 */
export function buildMemberAlerts(
  killEntries: MemguardKillLogEntry[],
  prevNames: string[],
  currentRows: MemberRow[],
  prevAlerts: MemberAlert[],
  now: Date,
): MemberAlert[] {
  const alerts: MemberAlert[] = [];

  const freshKills = killEntries
    .filter((k) => ageS(k.at, now) <= MEMGUARD_ALERT_RETENTION_S)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latestKill = freshKills[0] ?? null;
  if (latestKill) {
    alerts.push({
      kind: "memguard-kill",
      name: latestKill.comm,
      at: latestKill.at,
      detail: `comm=${latestKill.comm} rss_mib=${latestKill.rssMib} pid=${latestKill.pid}`,
      confidence: "measured",
    });
  }

  const gone = goneMemberNames(prevNames, currentRows);
  if (gone.length > 0 && latestKill && ageS(latestKill.at, now) <= MEMBER_GONE_CORRELATION_S) {
    for (const name of gone) {
      alerts.push({
        kind: "member-gone",
        name,
        at: latestKill.at,
        detail: `${name} — row vanished within ${MEMBER_GONE_CORRELATION_S}s of a memguard kill `
          + `(comm=${latestKill.comm}); not a proven match, see docs/superpowers/specs/`
          + `2026-09-24-row-tells-truth-design.md's open measurement M8`,
        confidence: "inferred",
      });
    }
  }

  // PR #336 round 2, item 1 (BLOCKER fix) — a poll-loop alert already live
  // for this exact row NAME keeps its FIRST-SEEN `at` rather than being
  // re-stamped to `now` every tick; only a row crossing the threshold for
  // the first time gets `now`. See MemberAlert.at's own doc comment for the
  // two bugs this fixes (an unbounded D1 write every tick, and an age that
  // could never read as more than ~0s).
  for (const row of pollLoopFlags(currentRows)) {
    const priorAt = prevAlerts.find((a) => a.kind === "poll-loop" && a.name === row.name)?.at;
    alerts.push({
      kind: "poll-loop",
      name: row.name,
      at: priorAt ?? now.toISOString(),
      // PR #336 round 2, item 2 — the detector cannot tell a genuine poll
      // loop from a legit long-running job (see cli/readiness-format.ts's
      // formatMemberAlert, which renders the VERB as "long-running member
      // <name>", not "poll-loop"); detail stays the row's own self-reported
      // figures, never a label claiming more certainty than the evidence
      // supports.
      detail: `${Math.floor(row.elapsedS / 60)}m per its own clock, ${row.tokens.toLocaleString("en-US")} tokens`
        + ` — thresholds unmeasured, see the design addendum's Open measurement M10`,
      confidence: "measured",
    });
  }

  return alerts;
}
