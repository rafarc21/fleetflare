// apps/fleet/cli/accounts.ts — `fleet accounts [sync] [--watch] [--json]
// [--write-labels]` (issue #232, step 3).
//
// Step 1 (src/studio/claude-swap.ts) built the pure join/decision logic;
// step 2 (src/studio/routes.ts) built the dumb, validated persistence route
// (POST /studio/accounts/sync). This file is the last piece: the ONE place
// that actually runs `cswap list --json` as a subprocess on the operator's
// own machine, reads GET /studio/accounts, joins the two, and — only for
// `sync` — posts the resulting decisions back.
//
// `fleet accounts` (bare) is deliberately read-only: it shows what a sync
// WOULD do (cli/accounts-format.ts's WOULD column) without ever calling the
// write route. `fleet accounts sync` is the one that writes.
import { accessHeaders, type Credentials } from "./fleet";
import {
  joinAccountsToCswap, decideAccountSync, type FleetAccountSlot, type SlotJoin, type SyncDecision,
} from "../src/studio/claude-swap";
import {
  formatAccountsTable, snapshotsEqual, buildLabelSuggestions, parseCswapListOutput, formatCswapUnavailableNote,
  type AccountSnapshotRow, type AccountCurrentState, type CswapRead,
} from "./accounts-format";

export interface AccountsFlags {
  watch: boolean;
  json: boolean;
  /** MAJOR 4 (STATUS comment): prints a pasteable `CLAUDE_ACCOUNT_<n>_LABEL=
   *  <email>` line per `"inferred"` slot. Orthogonal to `watch`/`json`/sync —
   *  see `printSnapshot`'s own doc comment for how it combines with `json`. */
  writeLabels: boolean;
}

/** GET /studio/accounts's own row shape (routes.ts) — the D1-held truth,
 *  `until` included (account-limit:<slot>'s own reset time), which
 *  claude-swap.ts's reset-time join pass needs. */
interface AccountsApiRow {
  name: string;
  label: string | null;
  dead: boolean;
  until: string | null;
  seenAt: string | null;
}

/**
 * Runs `cswap list --json` as a real subprocess on THIS (operator's)
 * machine — same house style as cli/fleet.ts's `detectRepo` (a bare
 * Bun.spawn, stdout/stderr piped, exit code checked). Never throws and never
 * crashes the rest of the command: ENOENT (cswap not installed), a non-zero
 * exit, or unparseable/malformed JSON all fold into `{ available: false,
 * reason }`, which `joinAccountsToCswap`'s own `cswapAvailable: false` path
 * turns into every slot reading `matchSource: "cswap-missing"` — never a
 * defaulted limit/clear guess. `reason` rides along so the table-printing
 * side (`printSnapshot` below) can surface WHY, once per snapshot — see
 * accounts-format.ts's `formatCswapUnavailableNote`.
 *
 * Issue #240: the actual JSON-shape parsing (bare array / schemaVersion-1
 * envelope / anything else) lives in `parseCswapListOutput`
 * (accounts-format.ts) — pure, so it's unit-testable without a subprocess.
 * This function's own job is just running the subprocess and special-casing
 * ENOENT (binary genuinely missing from PATH) distinctly from any other
 * spawn failure.
 */
export async function readCswapList(): Promise<CswapRead> {
  let stdout: string;
  try {
    const proc = Bun.spawn(["cswap", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return { available: false, reason: `exited ${code}` };
    stdout = out;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false, reason: "binary not found on PATH" };
    }
    return { available: false, reason: `could not run cswap: ${errText(err)}` };
  }
  return parseCswapListOutput(stdout);
}

/** Message text, not console output: `--watch`'s loop needs to catch and
 *  retry on exactly the same failures a one-shot command exits on (see
 *  cli/ff.ts's `errText`, same shape), so both the bad-status and the raw
 *  network-exception case THROW here rather than printing/exiting directly.
 *  The two one-shot callers (`cmdAccounts`, `cmdAccountsSync`) catch this at
 *  their own top level and print+exit exactly as before; `watchAccounts`'s
 *  loop catches it per-iteration and retries instead. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchAccountsApi(creds: Credentials): Promise<AccountsApiRow[]> {
  let res: Response;
  try {
    res = await fetch(new URL("/studio/accounts", creds.workerUrl), {
      headers: { ...accessHeaders(creds), Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(`fleet accounts: could not reach ${creds.workerUrl}: ${errText(err)}`);
  }
  if (!res.ok) {
    throw new Error(`fleet accounts: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as AccountsApiRow[];
}

/** `buildAccountsSnapshot`'s own result: the per-slot rows, and the ONE
 *  instant (ISO) the local cswap read happened — the exact same instant
 *  `decideAccountSync` below was handed as `now`. These two must never drift
 *  apart (a dispatch requirement): a sync POST's `usageFetchedAt` is the
 *  yardstick routes.ts compares a D1 row's own `seenAt` against (MAJOR 6),
 *  and a `seenAt`/`usageFetchedAt` pair stamped from two separate `new
 *  Date()` calls could disagree by milliseconds in exactly the edge case
 *  that comparison exists to catch. */
export interface AccountsSnapshot {
  rows: AccountSnapshotRow[];
  usageFetchedAt: string;
  /** Issue #240: null when cswap WAS available this snapshot; otherwise the
   *  `readCswapList`/`parseCswapListOutput` reason naming why every slot
   *  reads `matchSource: "cswap-missing"` — `printSnapshot` below surfaces
   *  this once, not per slot. */
  cswapUnavailableReason: string | null;
}

/**
 * The shared snapshot: one GET /studio/accounts + one local `cswap list
 * --json` read, joined and decided per slot (default threshold). Used by
 * the bare table command, `sync`, and `--watch`'s own loop body — exactly
 * the "shared snapshot function" this dispatch's brief asks for, so all
 * three read the SAME join/decision logic rather than three copies of it.
 *
 * `fetchedAt` is captured ONCE, before either network call resolves, and
 * reused both as `decideAccountSync`'s own `now` AND (ISO-stringified) as
 * `usageFetchedAt` — see `AccountsSnapshot`'s own doc comment for why.
 *
 * MAJOR 3 belt-and-suspenders: `joinAccountsToCswap`/`decideAccountSync`
 * (claude-swap.ts) are already defensive by construction — a malformed
 * cswap entry degrades to "no-data" for that one slot, never throws. This
 * loop wraps its OWN mapping/rendering work in the same per-slot try/catch
 * anyway, so a bug in THIS file's code can never kill the whole command for
 * every other slot either — one bad row degrades to its own error state,
 * same posture routes.ts's `renderStudioGrid` already takes for a bad DO
 * round trip.
 *
 * Maestro review round 2, finding 3: `joinAccountsToCswap` itself is now
 * ALSO provably non-throwing by construction (every `cswapAccounts` entry
 * is shape-validated up front, before any label/reset-time logic runs — see
 * its own doc comment) — this is not a defensive rewrite of that fix, just
 * one extra belt-and-suspenders `try`/`catch` around the one call that sits
 * outside the per-slot loop below (it needs cross-slot visibility for the
 * collision check, so it runs once over the whole batch): a future
 * regression there degrades to every slot reading "unmapped" rather than
 * killing the whole command, never load-bearing today.
 */
export async function buildAccountsSnapshot(creds: Credentials, fetchedAt: Date = new Date()): Promise<AccountsSnapshot> {
  const [apiRows, cswap] = await Promise.all([fetchAccountsApi(creds), readCswapList()]);
  const slots: FleetAccountSlot[] = apiRows.map((r) => ({ name: r.name, label: r.label, until: r.until }));
  let joins: SlotJoin[];
  try {
    joins = joinAccountsToCswap(slots, cswap.available ? cswap.accounts : [], cswap.available);
  } catch (err) {
    console.error(`fleet accounts: join failed, every slot reads unmapped (${errText(err)})`);
    joins = slots.map((slot) => ({
      name: slot.name, label: slot.label, until: slot.until, cswap: null, matchSource: "unmapped" as const,
    }));
  }
  const rows = apiRows.map((r, i): AccountSnapshotRow => {
    try {
      const join = joins[i]!;
      const decision = decideAccountSync(join, fetchedAt);
      const usage = join.cswap?.usage ?? null;
      return {
        name: r.name,
        label: r.label,
        matchSource: join.matchSource,
        matchedEmail: join.cswap?.email ?? null,
        fiveHourPct: usage ? usage.fiveHour.pct : null,
        sevenDayPct: usage ? usage.sevenDay.pct : null,
        decision,
        current: { dead: r.dead, until: r.until, seenAt: r.seenAt },
      };
    } catch (err) {
      return {
        name: r.name,
        label: r.label,
        matchSource: "unmapped",
        matchedEmail: null,
        fiveHourPct: null,
        sevenDayPct: null,
        decision: { name: r.name, action: "no-data", reason: `fleet accounts: ${errText(err)}` },
        current: { dead: r.dead, until: r.until, seenAt: r.seenAt },
      };
    }
  });
  return {
    rows,
    usageFetchedAt: fetchedAt.toISOString(),
    cswapUnavailableReason: cswap.available ? null : cswap.reason,
  };
}

/**
 * Prints one snapshot. `--write-labels` combines with EITHER output shape
 * (never a separate stdout line mixed into `--json`'s own output, which
 * would corrupt it as JSON): plain text gets the suggestions as extra lines
 * after the table; `--json` folds them into the SAME JSON object, under
 * `labelSuggestions`, alongside the rows under `accounts` — so `--json`'s
 * output is a bare array exactly as before whenever `--write-labels` is NOT
 * given (every existing `--json` consumer sees no shape change at all), and
 * becomes `{ accounts, labelSuggestions }` only when it is.
 *
 * Issue #240: `cswapUnavailableReason` (null when cswap read fine) is
 * surfaced via `console.error` — stderr, never folded into stdout — so the
 * `--json` bare-array contract above is never put at risk by this (an
 * operator piping `--json` into `jq` must keep getting a bare array even on
 * a cswap-unavailable run); a human watching either mode's stdout still sees
 * it on the same terminal, immediately after the table/JSON is printed.
 *
 * Issue #253: `now` must be the SAME instant `rows`' own `decision`s were
 * computed against (the snapshot's `fetchedAt`/`usageFetchedAt`), never a
 * fresh `new Date()` taken here — `formatAccountsTable`'s self-free check
 * (cli/accounts-format.ts's `describeCurrentState`) has to judge every row
 * in one render against the same clock reading, not one that ticked forward
 * mid-print.
 */
function printSnapshot(
  rows: AccountSnapshotRow[],
  flags: Pick<AccountsFlags, "json" | "writeLabels">,
  cswapUnavailableReason: string | null,
  now: Date,
): void {
  const note = formatCswapUnavailableNote(cswapUnavailableReason);
  if (note !== null) console.error(note);
  if (flags.writeLabels) {
    const labelSuggestions = buildLabelSuggestions(rows);
    if (flags.json) {
      console.log(JSON.stringify({ accounts: rows, labelSuggestions }, null, 2));
      return;
    }
    console.log(formatAccountsTable(rows, now));
    if (labelSuggestions.length > 0) {
      console.log("");
      for (const line of labelSuggestions) console.log(line);
    } else {
      console.log("\n(no inferred matches — nothing to suggest)");
    }
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(formatAccountsTable(rows, now));
}

/**
 * Applies `applied` decisions to the snapshot's own `current` field,
 * WITHOUT a second GET round-trip — the route already told us exactly which
 * names it wrote (`applied`), and `decideAccountSync`'s own output already
 * carries everything a fresh `current` needs. Cheaper and just as accurate
 * as re-fetching: the only way a second GET could disagree is a write from
 * somewhere else landing in the same instant, which a re-fetch cannot rule
 * out either. `rejected`/`skipped` names are left with their PRE-sync
 * `current` untouched (the route did not write them, so nothing changed).
 *
 * A "limit" write preserves the row's own PRE-sync `dead` flag locally too —
 * routes.ts's MAJOR 5 fix means the Worker never un-deads a row on a usage
 * sighting alone, and this local projection must not show something the
 * Worker itself did not do.
 */
function applyLocally(rows: AccountSnapshotRow[], applied: string[]): AccountSnapshotRow[] {
  const appliedSet = new Set(applied);
  return rows.map((row) => {
    if (!appliedSet.has(row.name)) return row;
    const current: AccountCurrentState = row.decision.action === "limit"
      ? { dead: row.current.dead, until: row.decision.until, seenAt: row.decision.seenAt }
      : row.decision.action === "clear"
        ? { dead: false, until: null, seenAt: null }
        : row.current; // "unmanaged"/"no-data" never write — unreachable here since both are filtered out before POSTing, kept for completeness.
    return { ...row, current };
  });
}

interface SyncResult {
  rows: AccountSnapshotRow[];
  applied: string[];
  rejected: { name: string; reason: string }[];
  skipped: { name: string; reason: string }[];
  cswapUnavailableReason: string | null;
  /** Issue #253: the snapshot's own `fetchedAt`, ISO — `printSnapshot`'s
   *  callers reuse this as the `now` the post-sync table renders against,
   *  rather than a fresh `new Date()` taken after the POST round-trip. */
  usageFetchedAt: string;
}

/**
 * The real write: builds the snapshot, POSTs every "limit"/"clear" decision
 * (routes.ts's own posture — "unmanaged"/"no-data" write nothing, so sending
 * either would be a no-op the route would just echo back) to
 * /studio/accounts/sync alongside the snapshot's own `usageFetchedAt`
 * (MAJOR 6 — the yardstick the route compares a "clear"'s target row against
 * before applying it), and returns the POST-sync snapshot built locally (see
 * `applyLocally` above).
 */
async function doSync(creds: Credentials, fetchedAt: Date = new Date()): Promise<SyncResult> {
  const { rows, usageFetchedAt, cswapUnavailableReason } = await buildAccountsSnapshot(creds, fetchedAt);
  const decisions: SyncDecision[] = rows
    .map((r) => r.decision)
    .filter((d) => d.action === "limit" || d.action === "clear");
  let res: Response;
  try {
    res = await fetch(new URL("/studio/accounts/sync", creds.workerUrl), {
      method: "POST",
      headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
      body: JSON.stringify({ usageFetchedAt, decisions }),
    });
  } catch (err) {
    throw new Error(`fleet accounts sync: could not reach ${creds.workerUrl}: ${errText(err)}`);
  }
  if (!res.ok) {
    throw new Error(`fleet accounts sync: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const { applied, rejected, skipped } = (await res.json()) as {
    applied: string[];
    rejected: { name: string; reason: string }[];
    skipped: { name: string; reason: string }[];
  };
  return { rows: applyLocally(rows, applied), applied, rejected, skipped: skipped ?? [], cswapUnavailableReason, usageFetchedAt };
}

/** `applied`/`rejected` as before, plus a `skipped` line per entry — distinct
 *  from both: `skipped` is routes.ts's own "correct no-op, not an error"
 *  outcome (MAJOR 6 — a fresher sighting already recorded after this
 *  snapshot was taken, so the clear this batch asked for was never applied
 *  on purpose). */
function reportSyncOutcome(
  applied: string[], rejected: { name: string; reason: string }[], skipped: { name: string; reason: string }[],
): void {
  console.error(`fleet accounts sync: applied ${applied.length} (${applied.join(", ") || "none"})`);
  for (const r of rejected) console.error(`fleet accounts sync: rejected ${r.name} (${r.reason})`);
  for (const s of skipped) console.error(`fleet accounts sync: skipped ${s.name} (${s.reason})`);
}

/** Minimum (and, since there is no --interval flag, ALSO the only) delay
 *  between --watch snapshots. Clamped here rather than left to whatever a
 *  future flag might pass, so a 5s hammering loop stays impossible even if
 *  one is added later without updating this constant. */
export const WATCH_INTERVAL_MS = 60_000;

/**
 * `--watch`'s loop: same bounded poll-loop shape as cli/ff.ts's
 * waitProvisioned (a `for (;;)`, one stderr status line per iteration,
 * Bun.sleep between reads) rather than a new convention. Diff-only: a
 * snapshot identical to the previous one (cli/accounts-format.ts's
 * snapshotsEqual) only gets a one-line "no change" heartbeat, never a
 * reprinted table. Ctrl-C (SIGINT) exits the process directly — no
 * in-flight request this loop needs to clean up first.
 *
 * Fault tolerance: this is the one caller of `buildAccountsSnapshot`/
 * `doSync` that must NOT exit on a failed iteration — issue #232 item 4's
 * whole point is running unattended for extended periods, so one transient
 * 5xx or dropped connection must not kill the session. Matches
 * `waitProvisioned`'s own shape (`fetchVerdict`/`fetchStatus` there fold
 * every network error or non-2xx into a non-throwing "inconclusive" the loop
 * just retries): here the per-iteration work is wrapped in try/catch, and a
 * caught failure prints one stderr status line and falls through to the same
 * `Bun.sleep(WATCH_INTERVAL_MS)` every other iteration ends with, rather than
 * exiting. The bare one-shot commands (`cmdAccounts`/`cmdAccountsSync`,
 * below) deliberately do NOT get this treatment — a one-shot command failing
 * loudly is correct, only the long-running loop needs to tolerate a blip.
 */
async function watchAccounts(creds: Credentials, flags: AccountsFlags, sync: boolean): Promise<void> {
  process.on("SIGINT", () => process.exit(0));
  let prev: AccountSnapshotRow[] | null = null;
  for (;;) {
    try {
      let rows: AccountSnapshotRow[];
      let cswapUnavailableReason: string | null;
      let now: Date;
      if (sync) {
        const result = await doSync(creds);
        reportSyncOutcome(result.applied, result.rejected, result.skipped);
        rows = result.rows;
        cswapUnavailableReason = result.cswapUnavailableReason;
        now = new Date(result.usageFetchedAt);
      } else {
        const snapshot = await buildAccountsSnapshot(creds);
        rows = snapshot.rows;
        cswapUnavailableReason = snapshot.cswapUnavailableReason;
        now = new Date(snapshot.usageFetchedAt);
      }
      if (prev === null || !snapshotsEqual(prev, rows)) printSnapshot(rows, flags, cswapUnavailableReason, now);
      else console.error(`fleet accounts: no change (${new Date().toISOString()})`);
      prev = rows;
    } catch (err) {
      console.error(`fleet accounts: iteration failed, retrying in ${WATCH_INTERVAL_MS / 1000}s (${errText(err)})`);
    }
    await Bun.sleep(WATCH_INTERVAL_MS);
  }
}

/** `fleet accounts` — read-only: builds the snapshot, prints it, never
 *  calls the write route. One-shot: a failed fetch/non-2xx exits loudly
 *  (same as this route's previous behavior), unlike `--watch`'s loop. */
export async function cmdAccounts(creds: Credentials, flags: AccountsFlags): Promise<void> {
  if (flags.watch) return watchAccounts(creds, flags, false);
  try {
    const { rows, usageFetchedAt, cswapUnavailableReason } = await buildAccountsSnapshot(creds);
    printSnapshot(rows, flags, cswapUnavailableReason, new Date(usageFetchedAt));
  } catch (err) {
    console.error(errText(err));
    process.exit(1);
  }
}

/** `fleet accounts sync` — builds the snapshot, POSTs the limit/clear
 *  decisions, reports what was applied/rejected/skipped, then prints the
 *  post-sync table (built locally — see `applyLocally`'s own doc comment for
 *  why no second GET round-trip). One-shot: a failed fetch/non-2xx exits
 *  loudly (same as this route's previous behavior), unlike `--watch`'s loop. */
export async function cmdAccountsSync(creds: Credentials, flags: AccountsFlags): Promise<void> {
  if (flags.watch) return watchAccounts(creds, flags, true);
  try {
    const { rows, applied, rejected, skipped, cswapUnavailableReason, usageFetchedAt } = await doSync(creds);
    reportSyncOutcome(applied, rejected, skipped);
    printSnapshot(rows, flags, cswapUnavailableReason, new Date(usageFetchedAt));
  } catch (err) {
    console.error(errText(err));
    process.exit(1);
  }
}
