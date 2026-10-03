import type { Env } from "../env";
import { setFlag } from "../state";
import type { StudioStatus } from "./types";
import { redactSecrets } from "./redact";
import type { Observed } from "./observed";
// The window length itself lives in archive.ts, which owns it (burn.ts's
// rollWindow imports the same constant from there) — imported from the
// constant's own home rather than through burn.ts, so this file shares no
// import edge with burn.ts's cursor code.
import { BURN_WINDOW_MS } from "./archive";
import {
  launchAccountOrReroute, accountLabel, autoFailoverOn, otherRepoPrimaries, resolveClaudeAccounts,
  type AccountLimits,
} from "./accounts";
import { readFleetAccountLimits } from "./account-limits-store";
import { parseStudioId } from "./ids";

// src/agents/registry.ts (the pattern this follows) is a hardcoded static
// array — there is no persistence mechanism to literally copy, since Day 1's
// one agent never changes at runtime. Studio rows DO change at runtime
// (provision/restart write, routes read), so this reuses the existing
// generic key/value table (src/state.ts's `fleet_state`, already migrated —
// no new table needed) with the same `<namespace>:<id>` key idiom
// src/tasks/watchdog.ts's rearmKey/alertedKey already use, rather than
// standing up a dedicated `studios` table for what's still, per the design
// spec, a single pilot row. Keeps this file the same small, single-purpose
// shape as its 22-line model.
const STUDIO_KEY_PREFIX = "studio:";

/**
 * Issue #296: claim a studio id ATOMICALLY. `fleet_state.key` is the primary
 * key, so an INSERT that does nothing on conflict is a compare-and-set: of
 * two concurrent spawns reaching for the same id, exactly one changes a row.
 * The claim IS the registry row -- a `provisioning` placeholder the DO's own
 * recordStudio overwrites -- so there is no second table to leak ids into.
 *
 * Returns the release (compare-and-delete: it removes the placeholder only
 * while it is still untouched, never a row provision has since written), or
 * null when the id is already taken.
 */
export async function claimStudioRow(
  env: Env, placeholder: StudioStatus, now: number = Date.now(),
): Promise<(() => Promise<void>) | null> {
  const key = studioKey(placeholder.id);
  const value = JSON.stringify(placeholder);
  const res = await env.DB
    .prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
    .bind(key, value, now)
    .run();
  if (res.meta.changes !== 1) return null;
  return async () => {
    await env.DB.prepare(`DELETE FROM fleet_state WHERE key = ? AND value = ?`).bind(key, value).run();
  };
}

/**
 * Issue #59 review round 1 (M1): resume's claim. One conditional UPDATE flips
 * the row `stopped` -> `provisioning`; D1 serializes writes, so of two racing
 * resumes exactly one sees `changes === 1`. Resolves to the release (flip
 * back to `stopped`, only while the row still reads `provisioning` — never
 * over a row provision itself has since written), or null for the loser.
 */
export async function claimStoppedRow(
  env: Env, id: string, now: number = Date.now(),
): Promise<(() => Promise<void>) | null> {
  const key = studioKey(id);
  const res = await env.DB
    .prepare(
      `UPDATE fleet_state SET value = json_set(value, '$.state', 'provisioning'), ts = ?
       WHERE key = ? AND json_extract(value, '$.state') = 'stopped'`,
    )
    .bind(now, key)
    .run();
  if (res.meta.changes !== 1) return null;
  return async () => {
    await env.DB
      .prepare(
        `UPDATE fleet_state SET value = json_set(value, '$.state', 'stopped')
         WHERE key = ? AND json_extract(value, '$.state') = 'provisioning'`,
      )
      .bind(key)
      .run();
  };
}

function studioKey(id: string): string {
  return `${STUDIO_KEY_PREFIX}${id}`;
}

/**
 * Task 4 (P2 plane 4): reconstructs `burn` from ONLY its known numeric
 * fields (plus `window5hStart`, a self-generated ISO timestamp, never
 * anything from parsed session content) rather than trusting whatever shape
 * arrived on `status.burn` — the same "the canonical write boundary
 * re-derives the safe shape, not just scrubs what's already there" posture
 * `error`/`lastRefreshError` get below. burn.ts's own parser already never
 * copies message content into a `Burn` (only counters), so this is belt and
 * braces, not the only line of defence — see test/studio.burn.test.ts's
 * "numbers-only" assertions for the end-to-end proof. `Number(x) || 0`
 * coerces any non-numeric/NaN survivor down to a safe 0 rather than letting
 * it through as-is.
 */
function cleanBurn(burn: StudioStatus["burn"]): StudioStatus["burn"] {
  if (!burn) return null;
  return {
    turns: Number(burn.turns) || 0,
    inputTokens: Number(burn.inputTokens) || 0,
    outputTokens: Number(burn.outputTokens) || 0,
    costUsd: Number(burn.costUsd) || 0,
    window5hStart: typeof burn.window5hStart === "string" ? burn.window5hStart : new Date(0).toISOString(),
    window5hOutput: Number(burn.window5hOutput) || 0,
  };
}

/**
 * Issue #181 — the READ-side half of the 5h bucket's life cycle.
 *
 * burn.ts's rollWindow resets `window5hOutput` only INSIDE a sync tick
 * (session-sync.ts's syncSession). A stopped studio never ticks again, so
 * its bucket freezes at whatever it held when the container went down and
 * every reader keeps quoting that dead number. Measured 2026-09-24 19:56Z:
 * 4.38M of the fleet's 5.42M reported 5h output was phantom — ~81% — and
 * operators size the shared Claude account's limit from exactly that figure.
 *
 * Same tumbling-bucket rule rollWindow already applies, same inclusive `>=`
 * boundary, evaluated against the reader's clock instead of the ticker's: a
 * bucket whose nominal 5h have fully elapsed has NO current output, so it
 * reads 0. Applied at READ (listStudios below, and routes.ts's `burnView`
 * for the DO-status routes — see listStudios' own comment on why there are
 * two) rather than here-at-write (`cleanBurn`) precisely because the write
 * path is the one that never runs for a stopped studio — expiry has to be
 * evaluated when someone LOOKS.
 *
 * Cumulative counters (`turns`/`inputTokens`/`outputTokens`/`costUsd`) are
 * lifetime totals that never reset, for a roll or for an expiry — they pass
 * through untouched. `window5hStart` is left as stored too: this returns a
 * corrected VIEW, it does not fabricate a new window, and nothing here (or
 * in listStudios) writes back.
 *
 * Deliberate interaction with cleanBurn's own malformed-input fallback: a
 * non-string `window5hStart` is stored as `new Date(0).toISOString()`, and
 * epoch is always more than 5h ago, so a malformed bucket reads 0 under this
 * rule. That is the wanted answer, not an accident — a bucket whose start
 * time cannot be trusted cannot be shown to be current, and the safe display
 * for an unprovable burn figure is zero, never a number an operator might
 * size an account limit against. A `window5hStart` that parses to NaN (a
 * hand-edited D1 row that never went through cleanBurn) gets the same
 * treatment, via the explicit non-finite check.
 */
export function expireBurnWindow(burn: StudioStatus["burn"], now: Date): StudioStatus["burn"] {
  if (!burn) return null;
  const startMs = new Date(burn.window5hStart).getTime();
  const expired = !Number.isFinite(startMs) || now.getTime() - startMs >= BURN_WINDOW_MS;
  return expired ? { ...burn, window5hOutput: 0 } : burn;
}

/**
 * Fleet ls readiness: `readiness.reason` (bare/inconclusive only) carries
 * container stdout/stderr verbatim — do.ts's runProvisionedCheck echoes the
 * container's own text — exactly the same secret-shaped risk `error`/
 * `lastRefreshError` carry below, scrubbed at this same write boundary for
 * the same reason. `provisioned` has no `reason` field to scrub. `undefined`
 * (every StudioStatus literal that predates this field) normalizes to
 * `null` here — see StudioStatus.readiness's own doc comment for why the
 * two must always be read as identical.
 */
function cleanReadiness(readiness: StudioStatus["readiness"]): StudioStatus["readiness"] {
  if (readiness == null) return null;
  if (readiness.kind === "provisioned") return readiness;
  return { ...readiness, reason: redactSecrets(readiness.reason) };
}

/**
 * Issue #85: `observed.session.reason` can carry a pane-probe/exec error —
 * container-echoed text, the same secret-shaped risk `readiness.reason`
 * already carries, scrubbed at this same write boundary for the same
 * reason. Unlike `cleanReadiness`, an absent/null `observed` stays
 * `undefined` here rather than being normalized to an explicit `null` —
 * `observed` is a genuinely optional signal (no reader treats "never
 * observed" and "observed, nothing wrong" as needing to look identical the
 * way `readiness`'s callers do), so there is no equivalent normalization
 * requirement to satisfy.
 */
function cleanObserved(observed: StudioStatus["observed"]): Observed | undefined {
  if (observed == null) return undefined;
  if (!observed.session) return observed;
  return {
    ...observed,
    session: {
      ...observed.session,
      reason: observed.session.reason === null ? null : redactSecrets(observed.session.reason),
    },
  };
}

// Review round 2, Spec 5: scrubbed here too, not only at provision.ts's own
// catch-time scrub — this is the one write path every caller of
// recordStudio goes through (today: runProvision/runRestart, both already
// clean by the time they call it), so it is the natural place to guarantee
// listStudios' Task 9 consumer (`fleet ls`) never sees a raw token
// regardless of what a FUTURE call site forgets to scrub first. Redundant
// against an already-clean status (redactSecrets is idempotent — a second
// pass over clean text is a no-op), not wasteful.
export async function recordStudio(env: Env, status: StudioStatus): Promise<void> {
  // Task 7 review round 1, C2: lastRefreshError (do.ts's own refresh-streak
  // marker) carries the exact same secret-shaped risk `error` does — scrub
  // both at this one write boundary, same reasoning as the comment above.
  // Task 4: `burn` always runs through cleanBurn — see its own doc comment.
  //
  // Fleet Spawn P3, Task 2: `spawnedBy` and `spawnTokenHash` pass straight
  // through the spread below, deliberately. Neither is re-derived or scrubbed
  // the way `error`/`burn` are, because neither can ever carry
  // container-echoed text: `spawnedBy` is a studio id the Worker resolved
  // server-side, and `spawnTokenHash` is a sha256 digest this Worker computed
  // (org.ts's hashSpawnToken) — the TOKEN it digests is exactly what must
  // never land here, and cannot, since no code path assigns one to this
  // field. redactSecrets' `fsp_` pattern is the backstop if one ever did.
  // Issue #53: `claudeAccount` passes straight through the spread below,
  // deliberately, on the same argument `spawnedBy`/`spawnTokenHash` already
  // make — it can never carry container-echoed text. It is the NAME of a
  // Worker secret, chosen server-side from accounts.ts's fixed list
  // (`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_2`, …); the TOKEN it
  // names is exactly what must never land here, and cannot, since no code
  // path assigns one to this field. redactSecrets' `sk-ant-` pattern is the
  // backstop if one ever did.
  const clean: StudioStatus = {
    ...status,
    error: status.error === null ? null : redactSecrets(status.error),
    lastRefreshError: status.lastRefreshError === null ? null : redactSecrets(status.lastRefreshError),
    burn: cleanBurn(status.burn),
    readiness: cleanReadiness(status.readiness),
    observed: cleanObserved(status.observed),
  };
  await setFlag(env.DB, studioKey(clean.id), JSON.stringify(clean), Date.now());
}

/**
 * Issue #181: `now` is a parameter (defaulted) rather than a bare
 * `new Date()` inside, so a test can pin the clock without faking timers
 * around a D1 round trip — the same injected-clock shape burn.ts's
 * rollWindow and cli/fleet.ts's formatTable already use. Every caller in the
 * Worker takes the default.
 *
 * This is the read boundary for the REGISTRY copy of burn — the D1
 * `fleet_state` row reaches a reader no other way, so every registry-fed
 * surface is corrected in one place: GET /studio/'s JSON (routes.ts), the
 * grid page (routes.ts's renderStudioGrid, hence grid.ts's
 * computeFleetTotals), and, through that JSON, every `fleet ls` surface
 * (cli/burn-format.ts's formatBurn and BURN_LEGEND, cli/fleet-totals.ts's
 * FLEET TOTALS).
 *
 * It is NOT the only read boundary, and an earlier version of this comment
 * wrongly said it was. Burn lives in TWO stores: this row, and the DO's own
 * STATUS_KEY, which do.ts's mirrorBurnToRegistry writes and destroy.ts
 * spreads into the stopped row. Every route that answers a DO
 * `StudioStatus` — /status, /check, /provision, /restart, /recycle,
 * /destroy — bypasses this function entirely, so routes.ts's `burnView`
 * applies expireBurnWindow at that second boundary. `fleet ls --fresh` is
 * why it matters: refreshAll (cli/fleet.ts) POSTs /check per studio and
 * REPLACES each listing row with the answer, so the table this function
 * corrected is overwritten by DO rows. Measured before that wrap: /check
 * answered 3,805,818 where listStudios answered 0. Any NEW route that hands
 * out a `StudioStatus` from DO storage has to wrap it too.
 *
 * Purely a corrected VIEW: no branch below writes, and the stored row keeps
 * its stale bucket verbatim (pinned by test/studio.burn-window-expiry.ts's
 * "nothing write storage from a read"). The next real sync tick still rolls
 * the window the same way it always did.
 */
/**
 * Issue #271: the account a row is on, as `fleet ls` shows it — stamped at
 * read time from this Worker's vars, never stored, so a map or label edit
 * shows on the next `fleet ls`. A studio with no recorded account is on its
 * repo's mapped primary (CLAUDE_ACCOUNT_BY_REPO); the label is
 * CLAUDE_ACCOUNT_<n>_LABEL. Names and labels only, never a token. No map and
 * no label: the row comes back unchanged.
 *
 * Issue #213: `claudeAccountNext` used to be stamped by the plain,
 * limit-UNAWARE `launchAccount` — a fleet-wide rate-limited mapped/recorded
 * account showed as "next" even though the real launch gate
 * (`launchAccountOrRefuse`, do.ts) would reroute around it via
 * `launchAccountOrReroute`'s three-tier cascade. Calling the SAME
 * reroute-aware function here means this column never disagrees in the
 * common case (tiers 1 and 2 -- this studio's own chain, or an unclaimed
 * spare); tier-3 borrow selection can still diverge from the real gate's
 * lowest-burn pick when 2+ reserved accounts are simultaneously free -- see
 * the readBurn note below. `limits`/`reserved`/`now` are the
 * caller's (listStudios below): `limits` is one shared D1 read for the whole
 * `fleet ls` call, not one per row; `reserved` depends on the row's own repo
 * so it is still computed per row. `readBurn` is deliberately left at its
 * default (`async () => ({})`) — tier-3 borrow-account selection falls back
 * to list order instead of lowest-5h-burn for this display-only column, to
 * avoid importing `readFleetAccountBurn` (do.ts), which would drag in
 * `@cloudflare/sandbox` and break this file's sandbox-free import boundary
 * (the same boundary issue #217 fixed for routes.ts).
 */
export async function withAccountDisplay(
  env: Env, row: StudioStatus, limits: AccountLimits, reserved: Set<string>, now: Date,
): Promise<StudioStatus> {
  // #273 r2: with auto-failover off, a claudeAccount an EARLIER failover
  // recorded is not what launches (launchAccount ignores it).
  const recorded = autoFailoverOn(env) ? row.claudeAccount ?? null : null;
  const next = await launchAccountOrReroute(
    env, parseStudioId(row.id)?.repo ?? null, recorded, limits, reserved, now, row.borrowedAccount,
  );

  // #289: the account the container was LAUNCHED on, with the next launch's
  // account as a note when a map (or failover) change has not reached it.
  if (typeof row.launchedAccount === "string") {
    const launched = row.launchedAccount;
    const label = accountLabel(env, launched);
    return {
      ...row,
      claudeAccount: launched,
      ...(label !== null ? { claudeAccountLabel: label } : {}),
      ...(next.ok && next.name !== launched ? { claudeAccountNext: next.name } : {}),
    };
  }
  // #285: the last launch was refused -- no name (fleet ls prints "-"; the
  // ERROR column says which slot is missing). A row stored before #289 that
  // cannot launch now reads the same: its recorded name is stale either way.
  if (row.launchedAccount === null || !next.ok) {
    return { ...row, claudeAccount: null, launchedAccount: null };
  }

  // #292 r2: no launch record (a row written before #289, or a start whose
  // account could not be read back): the running account is NOT known. Never
  // claim one -- `?`, and the next launch's account as the note. (Rendering
  // the mapped account here was the #289 lie for every studio still running
  // after a Worker-only deploy.)
  return { ...row, claudeAccount: "?", claudeAccountNext: next.name };
}

/**
 * Issue #136: registry.ts's own malformed-row posture (skip-and-log,
 * "one bad row must not become a hard failure") is right for listStudios
 * and for getStudioRow's general "give me the row or null" contract — but
 * profile.ts's getStudioStub needs to tell "this id was never provisioned"
 * (safe to compute a fresh, role-derived doClass) apart from "this id HAS
 * a row, but we can't read it" (NOT safe — a malformed row might belong to
 * a studio already running under STUDIO; computing fresh from role could
 * send it to STUDIO_BIG instead, the same orphan-risk class #107 closed).
 * `getStudioRow` stays null-for-both for its existing callers; this is the
 * one place that needs the third state.
 */
export type StudioRowLookup =
  | { kind: "found"; row: StudioStatus }
  | { kind: "absent" }
  | { kind: "malformed" };

export async function getStudioRowLookup(env: Env, id: string): Promise<StudioRowLookup> {
  const row = await env.DB
    .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
    .bind(studioKey(id))
    .first<{ value: string }>();
  if (!row) return { kind: "absent" };
  try {
    return { kind: "found", row: JSON.parse(row.value) as StudioStatus };
  } catch (err) {
    console.error(`getStudioRowLookup: malformed fleet_state row for ${id}`, err);
    return { kind: "malformed" };
  }
}

/**
 * Issue #107 fix-first: one studio's row, or null if it has never been
 * written. Used by profile.ts's getStudioStub to find a RECORDED DO class
 * without a full-table scan — listStudios (below) reads every row; this
 * reads one, by primary key, the same D1 `.first()` idiom src/state.ts's
 * getFlag already uses. A malformed row is treated the same as absent
 * (null) — same "one bad row must not become a hard failure" posture
 * listStudios already takes for the whole-table case, just at N=1. Issue
 * #136: this stays null-for-both deliberately (existing callers depend on
 * it) — getStudioRowLookup above is the one that tells the two apart, for
 * the one caller (getStudioStub) that needs to.
 */
export async function getStudioRow(env: Env, id: string): Promise<StudioStatus | null> {
  const result = await getStudioRowLookup(env, id);
  return result.kind === "found" ? result.row : null;
}

export async function listStudios(env: Env, now: Date = new Date()): Promise<StudioStatus[]> {
  const res = await env.DB
    .prepare(`SELECT value FROM fleet_state WHERE key LIKE ? ORDER BY key ASC`)
    .bind(`${STUDIO_KEY_PREFIX}%`)
    .all<{ value: string }>();
  // Issue #213: one shared D1 read for the WHOLE listing, not one per row --
  // `launchAccountOrReroute`'s own early return (`if (!launch.ok ||
  // !autoFailoverOn(env)) return launch;`) means `limits` is never even
  // looked at when failover is off, so the read is skipped entirely then
  // (fail-OPEN to "nothing is limited", `{}`, the same no-signal convention
  // do.ts's own launchAccountOrRefuse uses at its own `limits` read -- see
  // that function's `let limits = {}; try { ... } catch { ... }` for the
  // exact pattern mirrored here, including warn-and-continue on a transient
  // D1 failure rather than failing the whole listing over it).
  let limits: AccountLimits = {};
  if (autoFailoverOn(env)) {
    try {
      limits = await readFleetAccountLimits(env.DB, resolveClaudeAccounts(env));
    } catch (err) {
      console.warn("listStudios: readFleetAccountLimits failed, showing next-launch as if nothing were fleet-wide limited (fail open)", err);
    }
  }
  const rows: StudioStatus[] = [];
  for (const r of res.results ?? []) {
    // Review round 2, Spec 5: one malformed row (hand-edited D1 data, a
    // future schema change, any other write path that isn't recordStudio)
    // must not fail the whole listing for every other studio.
    try {
      const row = JSON.parse(r.value) as StudioStatus;
      const reserved = otherRepoPrimaries(env, parseStudioId(row.id)?.repo ?? null);
      rows.push(await withAccountDisplay(env, { ...row, burn: expireBurnWindow(row.burn, now) }, limits, reserved, now));
    } catch (err) {
      console.error("listStudios: skipping a malformed fleet_state row", err);
    }
  }
  return rows;
}
