// apps/fleet/cli/accounts.ts — `fleet accounts [sync] [--watch] [--json]`
// (issue #232, step 3).
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
  joinAccountsToCswap, decideAccountSync, type CswapAccount, type FleetAccountSlot, type SyncDecision,
} from "../src/studio/claude-swap";
import { formatAccountsTable, snapshotsEqual, type AccountSnapshotRow, type AccountCurrentState } from "./accounts-format";

export interface AccountsFlags {
  watch: boolean;
  json: boolean;
}

/** GET /studio/accounts's own row shape (routes.ts) — the D1-held truth. */
interface AccountsApiRow {
  name: string;
  label: string | null;
  dead: boolean;
  until: string | null;
  seenAt: string | null;
}

type CswapRead = { available: true; accounts: CswapAccount[] } | { available: false; reason: string };

/**
 * Runs `cswap list --json` as a real subprocess on THIS (operator's)
 * machine — same house style as cli/fleet.ts's `detectRepo` (a bare
 * Bun.spawn, stdout/stderr piped, exit code checked). Never throws and never
 * crashes the rest of the command: ENOENT (cswap not installed), a non-zero
 * exit, or unparseable JSON all fold into `{ available: false }`, which
 * `joinAccountsToCswap`'s own `cswapAvailable: false` path turns into every
 * slot reading "cswap-missing" — never a defaulted limit/clear guess.
 */
export async function readCswapList(): Promise<CswapRead> {
  let stdout: string;
  try {
    const proc = Bun.spawn(["cswap", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return { available: false, reason: `cswap exited ${code}` };
    stdout = out;
  } catch (err) {
    return { available: false, reason: `could not run cswap: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return { available: false, reason: "cswap list --json did not print an array" };
    return { available: true, accounts: parsed as CswapAccount[] };
  } catch {
    return { available: false, reason: "cswap list --json printed unparseable JSON" };
  }
}

async function fetchAccountsApi(creds: Credentials): Promise<AccountsApiRow[]> {
  const res = await fetch(new URL("/studio/accounts", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`fleet accounts: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  return (await res.json()) as AccountsApiRow[];
}

/**
 * The shared snapshot: one GET /studio/accounts + one local `cswap list
 * --json` read, joined and decided per slot (default threshold). Used by
 * the bare table command, `sync`, and `--watch`'s own loop body — exactly
 * the "shared snapshot function" this dispatch's brief asks for, so all
 * three read the SAME join/decision logic rather than three copies of it.
 */
export async function buildAccountsSnapshot(creds: Credentials, now: Date = new Date()): Promise<AccountSnapshotRow[]> {
  const [apiRows, cswap] = await Promise.all([fetchAccountsApi(creds), readCswapList()]);
  const slots: FleetAccountSlot[] = apiRows.map((r) => ({ name: r.name, label: r.label }));
  const joins = joinAccountsToCswap(slots, cswap.available ? cswap.accounts : [], cswap.available);
  return apiRows.map((r, i) => {
    const join = joins[i]!;
    const decision = decideAccountSync(join, now);
    const usage = join.cswap;
    return {
      name: r.name,
      label: r.label,
      fiveHourPct: usage ? usage.usage.fiveHour.pct : null,
      sevenDayPct: usage ? usage.usage.sevenDay.pct : null,
      decision,
      current: { dead: r.dead, until: r.until, seenAt: r.seenAt },
    };
  });
}

function printSnapshot(snapshot: AccountSnapshotRow[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(formatAccountsTable(snapshot));
}

/**
 * Applies `applied` decisions to the snapshot's own `current` field,
 * WITHOUT a second GET round-trip — the route already told us exactly which
 * names it wrote (`applied`), and `decideAccountSync`'s own output already
 * carries everything a fresh `current` needs. Cheaper and just as accurate
 * as re-fetching: the only way a second GET could disagree is a write from
 * somewhere else landing in the same instant, which a re-fetch cannot rule
 * out either. `rejected` names are left with their PRE-sync `current`
 * untouched (the route refused to write them, so nothing changed).
 */
function applyLocally(snapshot: AccountSnapshotRow[], applied: string[]): AccountSnapshotRow[] {
  const appliedSet = new Set(applied);
  return snapshot.map((row) => {
    if (!appliedSet.has(row.name)) return row;
    const current: AccountCurrentState = row.decision.action === "limit"
      ? { dead: false, until: row.decision.until, seenAt: row.decision.seenAt }
      : row.decision.action === "clear"
        ? { dead: false, until: null, seenAt: null }
        : row.current; // "unmanaged" never writes — unreachable here since it's filtered out before POSTing, kept for completeness.
    return { ...row, current };
  });
}

interface SyncResult {
  snapshot: AccountSnapshotRow[];
  applied: string[];
  rejected: { name: string; reason: string }[];
}

/**
 * The real write: builds the snapshot, POSTs every non-"unmanaged" decision
 * (routes.ts's own posture — "unmanaged" writes nothing, so sending it would
 * be a no-op the route would just echo back) to /studio/accounts/sync, and
 * returns the POST-sync snapshot built locally (see `applyLocally` above).
 */
async function doSync(creds: Credentials, now: Date = new Date()): Promise<SyncResult> {
  const snapshot = await buildAccountsSnapshot(creds, now);
  const decisions: SyncDecision[] = snapshot
    .map((r) => r.decision)
    .filter((d) => d.action !== "unmanaged");
  const res = await fetch(new URL("/studio/accounts/sync", creds.workerUrl), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify({ decisions }),
  });
  if (!res.ok) {
    console.error(`fleet accounts sync: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const { applied, rejected } = (await res.json()) as { applied: string[]; rejected: { name: string; reason: string }[] };
  return { snapshot: applyLocally(snapshot, applied), applied, rejected };
}

function reportSyncOutcome(applied: string[], rejected: { name: string; reason: string }[]): void {
  console.error(`fleet accounts sync: applied ${applied.length} (${applied.join(", ") || "none"})`);
  for (const r of rejected) console.error(`fleet accounts sync: rejected ${r.name} (${r.reason})`);
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
 */
async function watchAccounts(creds: Credentials, flags: AccountsFlags, sync: boolean): Promise<void> {
  process.on("SIGINT", () => process.exit(0));
  let prev: AccountSnapshotRow[] | null = null;
  for (;;) {
    let snapshot: AccountSnapshotRow[];
    if (sync) {
      const result = await doSync(creds);
      reportSyncOutcome(result.applied, result.rejected);
      snapshot = result.snapshot;
    } else {
      snapshot = await buildAccountsSnapshot(creds);
    }
    if (prev === null || !snapshotsEqual(prev, snapshot)) printSnapshot(snapshot, flags.json);
    else console.error(`fleet accounts: no change (${new Date().toISOString()})`);
    prev = snapshot;
    await Bun.sleep(WATCH_INTERVAL_MS);
  }
}

/** `fleet accounts` — read-only: builds the snapshot, prints it, never
 *  calls the write route. */
export async function cmdAccounts(creds: Credentials, flags: AccountsFlags): Promise<void> {
  if (flags.watch) return watchAccounts(creds, flags, false);
  printSnapshot(await buildAccountsSnapshot(creds), flags.json);
}

/** `fleet accounts sync` — builds the snapshot, POSTs the non-"unmanaged"
 *  decisions, reports what was applied/rejected, then prints the post-sync
 *  table (built locally — see `applyLocally`'s own doc comment for why no
 *  second GET round-trip). */
export async function cmdAccountsSync(creds: Credentials, flags: AccountsFlags): Promise<void> {
  if (flags.watch) return watchAccounts(creds, flags, true);
  const { snapshot, applied, rejected } = await doSync(creds);
  reportSyncOutcome(applied, rejected);
  printSnapshot(snapshot, flags.json);
}
