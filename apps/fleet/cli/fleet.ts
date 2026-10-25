#!/usr/bin/env bun
/**
 * Mac cockpit for the studio fleet: `fleet ls | attach <id> | paste <id>`,
 * plus the board verbs `fleet task new|ls|show` (P4 §5).
 * Single-file bun CLI, `bun link`ed (package.json's `bin` entry) so it runs
 * as a plain `fleet` command from any directory — see agentastic's
 * `dev newtab "fleet attach websites--pilot"` usage.
 *
 * Talks to the deployed Worker's /studio/* routes, all behind Cloudflare
 * Access: every request carries the CF-Access-Client-Id/Secret service-token
 * headers Access's edge mints a JWT from. This file never sees that JWT and
 * never needs to — src/studio/auth.ts's verifyAccess is the Worker-side
 * gate that does.
 *
 * Several pieces here are exported for cli/ff.ts — the `ff` command, which is
 * pure composition of this file (loadCredentials, detectRepo, cmdAttach) plus
 * the same routes the commands below already call. Importing this module runs
 * no CLI: `main()` is guarded by `import.meta.main` at the bottom.
 */
import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";
import { statSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseFrame, resizeFrameFor } from "../src/studio/frames";
import { reconnectDelayMs, nextAttempt, attachRefusal } from "./backoff";
import { postTaskNew, taskNewFailureLine } from "./task-new-retry";
import { grabClipboardPng } from "./paste-mac";
import { classifyInput, CTRL_V } from "./input";
import { parseCliArgs, renderHelp } from "../src/studio/cli-args";
import { parseStudioId } from "../src/studio/ids";
import { parseGitRemote, parseRepoSlug, refuseBadSegment, repoIdSegment, studioIdForTarget, studioIdIn } from "../src/studio/repo";
import { runOnboardPreflight } from "../src/studio/onboard";
import { cmdJunior, cmdJuniorStats } from "./junior";
import { cmdAccounts, cmdAccountsSync, cmdAccountsHold, cmdAccountsClear } from "./accounts";
import { cmdModelsLs, cmdModelsAssign, cmdModelsSet } from "./models";
import { cmdGateRun, cmdGateStart, cmdGateWatch, cmdGateProtect, cmdGateLog } from "./gate";
import { formatAccountResolution } from "./accounts-format";
import { sweepAllPages, type SweepPage } from "./junior-sweep";
import { reapTerminalAll, type TerminalPage } from "./reap-terminal";
import { runTaskStateTransition, type TaskStateFetchResult } from "../src/studio/task-state";
import type { ReapOutcome } from "../src/studio/task-reap";
import { formatRescueReport, type RescueWorktree } from "../src/studio/rescue";
import type { RescueGcOutcome } from "../src/studio/rescue-gc";
import type { RepoReach } from "../src/github/reach";
import { fleetTotals, formatFleetTotalsLine } from "./fleet-totals";
import { formatBurn, BURN_LEGEND } from "./burn-format";
import { formatColumns } from "./columns";
import { formatRestartCell, formatRestartChurn, RESTART_LEGEND } from "./restart-format";
import { formatWipCell, formatWipInspectLines, WIP_LEGEND } from "./wip-format";
import { requestInspect, renderInspect, formatSessionForceArmedLine, type InspectBody } from "./inspect-request";
import type { Observed } from "../src/studio/observed";
import { ATTACH_CONNECT_TIMEOUT_MS, ATTACH_STALE_MS, attachTitle, hhmmssZ, titleSequence } from "./attach-liveness";
import { repairFailureLine, discardNote, destroyPath } from "./repair-failure";
import { errText, ERROR_SNIPPET_MAX_CHARS } from "./diag";
import { parseStudioStatus, parseStudioStatusArray } from "./studio-row";
import { requestDestroy, readStatus, DESTROY_STATUS_TIMEOUT_MS } from "./destroy-outcome";
import { requestRecycle } from "./recycle-outcome";
import {
  formatIdleAlarm, emptyReapState, runReap, destroyRaceOutcome, REAP_LIVE_READ_MAX_MS, type ReapDeps, type ReapFlags, type ReapState,
} from "./reap";
import { mkdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  formatReady, formatCheckedAt, readyOverride, isLeadInferenceSilent, formatSession, formatState, formatSessionGuards,
  formatSurvivalBriefs, formatDeadAccounts,
  formatObservedLines, formatActivity, lsJsonRows,
} from "./readiness-format";
import { formatTaskTable, formatTaskShow, formatAssignWake } from "./task-format";
import { formatSprintSummaries, formatSprintStatusLines, formatSprintStatus } from "./sprint-format";
// Issue #934: the INFER column's pure half (the cell format + the blocked
// threshold), kept Bun/node-free so either test pool can import it — see
// that module's own header.
import { formatInfer, isLeadInferenceBlocked, INFER_WINDOW_MS, type LeadInferUsage } from "./infer-format";
// Issue #1074 ask 1: the lead model, in the ACCOUNT cell and the --json fields.
import { leadAccountLabel, leadModelOf, type LeadModel } from "./lead-model";
import type { AssignWakeReport } from "../src/board/assign-wake";
// Board issue #332: the open-prs route's answer shape — a type-only import,
// so none of src/board's runtime graph rides into this CLI binary.
import type { OpenPr } from "../src/board/open-prs";
import { formatMemoryTable, MEMORY_LEGEND, type MemoryFileRow } from "./memory-format";
import {
  openStudioRow, closeStudioRow, reconcileStudioWorkspaces, planStudioWorkspaces, defaultOrcaDeps,
  studioWorkspaceTitle, readStudioRows, findAttachHandle, ensureLocalStudioWorktree, resolveStudioWorktreePath,
  resolveLocalWake,
  type OrcaDeps, type TabsReport, type TabsPlanEntry,
} from "./orca-workspace";
import type { StudioStatus } from "../src/studio/types";
import type { BoardTask, BoardTaskState } from "../src/board/types";
import type { TaskComment } from "../src/board/board";
import type { SprintSummary } from "../src/board/sprint";
import type { TaskBriefArgs } from "../src/studio/cli-args";

// ---------------------------------------------------------------------------
// Credentials — ~/.fleet/credentials, chmod 600 expected.

export interface Credentials {
  workerUrl: string;
  accessClientId: string;
  accessClientSecret: string;
}

const CREDENTIALS_PATH = join(homedir(), ".fleet", "credentials");

export async function loadCredentials(): Promise<Credentials> {
  const file = Bun.file(CREDENTIALS_PATH);
  if (!(await file.exists())) {
    console.error(`fleet: no credentials file at ${CREDENTIALS_PATH}`);
    console.error('fleet: expected JSON {"workerUrl":"...","accessClientId":"...","accessClientSecret":"..."}');
    process.exit(1);
  }

  // "chmod 600 expected (warn if looser)" — looser means group/other has
  // ANY access; a *stricter* mode (e.g. 400) still lets us read our own
  // file, so it is not warned about. A warning that blocks a working setup
  // would be worse than the leak it is guarding against, hence: warn, never
  // block.
  const mode = statSync(CREDENTIALS_PATH).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.error(
      `fleet: warning: ${CREDENTIALS_PATH} is mode ${mode.toString(8)} (group/other accessible). ` +
        `Run: chmod 600 ${CREDENTIALS_PATH}`,
    );
  }

  const raw = (await file.json()) as Partial<Credentials>;
  if (!raw.workerUrl || !raw.accessClientId || !raw.accessClientSecret) {
    console.error(`fleet: ${CREDENTIALS_PATH} is missing workerUrl/accessClientId/accessClientSecret`);
    process.exit(1);
  }
  return raw as Credentials;
}

/**
 * Board issue #208 fix round, item 3 (BLOCKER): a NON-EXITING twin of
 * `loadCredentials` above, for a caller that must survive a missing/
 * malformed credentials file rather than crash the whole process.
 * `loadCredentials`'s own `process.exit(1)` is the right call for every
 * interactive CLI command (there is nothing useful left to do without
 * credentials) — it is wrong for `scripts/sensors/run.ts`'s
 * platform-replacements sensor, which runs inside GitHub Actions (no
 * `~/.fleet/credentials` there, by design) ALONGSIDE two other sensors in
 * the same `Promise.all` that need no credential at all; an `exit(1)` there
 * killed the whole run, including those two.
 *
 * Deliberately a near-duplicate of `loadCredentials` rather than a shared
 * refactor with an "exit or not" flag threaded through: `loadCredentials`
 * has roughly a dozen existing call sites across this file and cli/ff.ts,
 * every one of them relying on its current "exits, never returns a falsy
 * value" contract; changing its own signature or adding a parameter risks
 * a silent behavior change at one of those sites. A second, small, clearly-
 * labeled function is the lower-risk shape here. Returns `null` on every
 * condition `loadCredentials` treats as fatal (missing file, missing
 * field) — logging the IDENTICAL messages, just without the exit. The
 * mode-warning path is unaffected: a too-loose file still warns either way.
 */
export async function loadCredentialsIfPresent(): Promise<Credentials | null> {
  const file = Bun.file(CREDENTIALS_PATH);
  if (!(await file.exists())) {
    console.error(`fleet: no credentials file at ${CREDENTIALS_PATH}`);
    console.error('fleet: expected JSON {"workerUrl":"...","accessClientId":"...","accessClientSecret":"..."}');
    return null;
  }

  const mode = statSync(CREDENTIALS_PATH).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.error(
      `fleet: warning: ${CREDENTIALS_PATH} is mode ${mode.toString(8)} (group/other accessible). ` +
        `Run: chmod 600 ${CREDENTIALS_PATH}`,
    );
  }

  // Fix round 2, item C1 (MINOR): a file that EXISTS but holds malformed
  // JSON used to throw straight out of `file.json()`, uncaught -- the exact
  // "kills the whole Promise.all" failure this soft variant exists to avoid
  // (see this function's own doc comment above), just one step later than
  // the missing-file case already guards against. Same soft-fail-to-null
  // posture, same reporting style.
  let raw: Partial<Credentials>;
  try {
    raw = (await file.json()) as Partial<Credentials>;
  } catch (err) {
    console.error(`fleet: ${CREDENTIALS_PATH} is not valid JSON`, err);
    return null;
  }
  if (!raw.workerUrl || !raw.accessClientId || !raw.accessClientSecret) {
    console.error(`fleet: ${CREDENTIALS_PATH} is missing workerUrl/accessClientId/accessClientSecret`);
    return null;
  }
  return raw as Credentials;
}

/**
 * The SOFT variant of loadCredentials, above — same file-read/JSON-shape
 * checks, deliberately duplicated rather than shared, because they diverge
 * on failure: loadCredentials() itself calls process.exit(1), which is
 * exactly right for every OTHER command (nothing else can proceed without
 * credentials) and exactly wrong for `fleet onboard`'s check #3 (board task
 * #125), which needs a missing/malformed file to be a FAILED CHECK it
 * reports and continues past — the first three checks must still print, and
 * check #3's own detail is meant to carry this message, not crash the
 * process before it gets there.
 */
export async function tryLoadCredentials(): Promise<Credentials | { error: string }> {
  const file = Bun.file(CREDENTIALS_PATH);
  if (!(await file.exists())) {
    return {
      error: `no credentials file at ${CREDENTIALS_PATH} — expected JSON ` +
        '{"workerUrl":"...","accessClientId":"...","accessClientSecret":"..."}',
    };
  }

  // Same "warn, never block" posture as loadCredentials — see its own doc
  // comment for why a looser-than-600 mode is a warning, not a refusal.
  const mode = statSync(CREDENTIALS_PATH).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    console.error(
      `fleet: warning: ${CREDENTIALS_PATH} is mode ${mode.toString(8)} (group/other accessible). ` +
        `Run: chmod 600 ${CREDENTIALS_PATH}`,
    );
  }

  let raw: Partial<Credentials>;
  try {
    raw = (await file.json()) as Partial<Credentials>;
  } catch {
    return { error: `${CREDENTIALS_PATH} is not valid JSON` };
  }
  if (!raw.workerUrl || !raw.accessClientId || !raw.accessClientSecret) {
    return { error: `${CREDENTIALS_PATH} is missing workerUrl/accessClientId/accessClientSecret` };
  }
  return raw as Credentials;
}

export function accessHeaders(creds: Credentials): Record<string, string> {
  return {
    "CF-Access-Client-Id": creds.accessClientId,
    "CF-Access-Client-Secret": creds.accessClientSecret,
  };
}

export function studioUrl(creds: Credentials, id: string, path: string): string {
  return new URL(`/studio/${id}${path}`, creds.workerUrl).toString();
}

/**
 * The board's own routes. Under `/studio/` on purpose, not at a `/board/`
 * prefix: the Cloudflare Access app is scoped to the `/studio` path, so the
 * service-token headers below are only exchanged for a JWT there — see
 * src/board/routes.ts's header for the full reasoning.
 */
export function boardUrl(creds: Credentials, path: string): string {
  return new URL(`/studio/board${path}`, creds.workerUrl).toString();
}

/** P5 §9's memory pass. Under `/studio/` for the same Access reason the board
 *  is — see boardUrl just above. */
export function memoryUrl(creds: Credentials, path: string): string {
  return new URL(`/studio/memory${path}`, creds.workerUrl).toString();
}

/** Issue #218's usage stats route (src/junior/usage.ts's
 *  handleJuniorUsageStats). Under `/studio/` for the same Access reason the
 *  board and memory passes are — see boardUrl just above. */
export function juniorUrl(creds: Credentials, path: string): string {
  return new URL(`/studio/junior${path}`, creds.workerUrl).toString();
}

/** https://... -> wss://..., http://... -> ws://... (the latter is what a
 *  local `wrangler dev` loopback needs during manual verification). */
export function wsUrl(creds: Credentials, id: string): string {
  const u = new URL(studioUrl(creds, id, "/ws/terminal"));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

// ---------------------------------------------------------------------------
// fleet ls

// formatBurn and BURN_LEGEND now live in ./burn-format (pure, test-importable
// — see that file's own header for why). Re-exported here so every existing
// importer of them from cli/fleet.ts keeps working unchanged.
export { formatBurn, BURN_LEGEND } from "./burn-format";

/**
 * Issue #205: `fleet ls` line 1 — how many studios exist, how many bill, per
 * repo. Rows sort by id, so `fleet ls | head -N` cuts the LAST repos first:
 * measured 2026-09-24, a maestro read "zero studios" off a head that had cut
 * all five demosite-life rows while three of them billed. With this line first,
 * any cut still shows the denominator to check the row count against.
 * Billing = not stopped, or stopped with a running container (formatState's
 * own #95 rule).
 */
export function formatStudioCount(studios: StudioStatus[]): string {
  const billing = studios.filter((s) => s.state !== "stopped" || s.containerRunningSince != null).length;
  const head = `STUDIOS: ${studios.length} total, ${billing} billing`;
  if (studios.length === 0) return head;
  const perRepo = new Map<string, number>();
  for (const s of studios) {
    const repo = parseStudioId(s.id)?.repo ?? s.id;
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
  }
  const repos = [...perRepo].sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${r} ${n}`);
  return `${head} — ${repos.join(", ")}`;
}

/** The lines `fleet ls` prints above its table: the denominator FIRST. */
export function formatLsHead(studios: StudioStatus[]): string[] {
  return [formatStudioCount(studios), BURN_LEGEND, RESTART_LEGEND, WIP_LEGEND];
}

/** Issue #205: a 3,382-char ERROR padded every line of the table to ~3,600
 *  chars. The full text stays in `fleet check <id>`. */
const ERROR_CELL_MAX = 160;

function capErrorCell(error: string | null): string {
  const flat = (error ?? "-").replace(/\s+/g, " ");
  return flat.length <= ERROR_CELL_MAX ? flat : `${flat.slice(0, ERROR_CELL_MAX - 1)}…`;
}

/** Issue #289/#285: the ACCOUNT cell -- see formatTable's comment on it.
 *  Issue #1074: a non-Claude lead runs no Claude account, so its cell names
 *  the lead model (`glm:glm-5.3`) instead of a Claude token name. */
export function formatAccount(s: StudioStatus, lead: LeadModel): string {
  if (lead.leadType !== "claude") return leadAccountLabel(lead);
  if (s.launchedAccount === null) return "-";
  const name = s.claudeAccount ?? "CLAUDE_CODE_OAUTH_TOKEN";
  const shown = s.claudeAccountLabel ? `${s.claudeAccountLabel} (${name})` : name;
  return s.claudeAccountNext ? `${shown} (next launch: ${s.claudeAccountNext})` : shown;
}

/** `fleet check <id>`: the whole error, on its own line, when the table's
 *  ERROR cell had to cut it. Null when the cell already holds all of it. */
export function fullErrorLine(s: StudioStatus): string | null {
  const flat = (s.error ?? "").replace(/\s+/g, " ");
  return flat.length > ERROR_CELL_MAX ? `ERROR (full): ${flat}` : null;
}

/**
 * Pure formatting — no I/O — so the headless verification script can call
 * it directly. `lastRefresh` was relabeled "LAST ACTIVITY" by T7 (its
 * registry writes that field from both container bring-up AND the GitHub
 * token-refresh loop, so a column literally titled "last refresh" would lie
 * about what actually last touched the row) — and issue #221 (PR3a)
 * relabels it AGAIN, to "REFRESHED": PR1 explicitly deferred this exact
 * rename here ("`LAST ACTIVITY` keeps its label … PR3 revisits it once real
 * activity exists"), because leaving it beside a genuine, new `ACTIVITY`
 * column (this same PR) is the exact confusion this whole field exists to
 * remove — `lastRefresh` never touched the lead, and now there is a column
 * beside it that actually does.
 *
 * Task 7 (P2): HOST + BURN columns added — the design's own ride-along
 * ruling for tailscaleHost is explicit ("Grid + `fleet ls` display it",
 * docs/superpowers/specs/2026-08-16-studio-memory-p2-design.md's Task 6
 * ride-along), and burn.ts's per-studio counters exist for the same
 * "operator looks at the fleet from the terminal" reason. Both are already
 * plain fields on StudioStatus (mirrored via do.ts's mirrorBurnToRegistry
 * for burn, and the refresh tick for tailscaleHost) — this is the first
 * caller that surfaces them in the CLI table; the grid page (grid.ts/
 * grid.template.html) already shows both. `s.tailscaleHost ?? "-"` matches
 * every other absent-value column's own "-" convention (a local
 * `wrangler dev` / integration run has no TS_AUTHKEY, so this reads "-"
 * there — see Env.TS_AUTHKEY's own doc comment).
 *
 * READY + CHECKED columns ("a dead studio looks alive" fix): STATE/ERROR
 * are the registry's own last-write-wins fields — exactly what a container
 * that went bare on its own leaves untouched, which is how a bare studio
 * was able to read `running, error: null`. READY is do.ts's periodic
 * checkAndRecordReadiness verdict instead (the SAME live check GET
 * /studio/:id/provisioned and recycle gate on), and CHECKED is HOW OLD that
 * verdict is — see cli/readiness-format.ts's own doc comments for the exact
 * tokens, and for why issue #37 replaced the raw ISO timestamp this column
 * used to print with an age.
 *
 * Issue #85: READY now also runs through `readyOverride` FIRST, which reads
 * the DO's own Observed evidence (replaced/unreachable/unverified) — that
 * evidence can contradict or outrun the last container-side check, and
 * first-match-wins beats a stale/hopeful "provisioned"; `formatReady` only
 * renders once none of those overrides apply. SESSION is the new column
 * beside it — whether the live lead actually continued its history
 * (resumed/fresh/LOST/"?") plus how old the last shipped session snapshot
 * is, always shown even when the verdict itself is unclear. See
 * cli/readiness-format.ts's own doc comments for both.
 *
 * `now` is a parameter with a default rather than a clock read inside, so the
 * whole table renders against ONE instant (every row's age is comparable)
 * and a caller that needs determinism can supply it.
 *
 * PRS column (board issue #332): how many unmerged, still-open PRs this
 * studio's assigned tasks name — the live answer behind "is this lane safe
 * to park/destroy", which the open-task gate can never give (awaiting_merge
 * is not a board state, #110). Placed between WIP and READY because
 * park-readiness is read beside the work-age columns. `openPrs` (studio id
 * -> count) comes from cmdLs's one batched GET /studio/board/open-prs per
 * distinct repo — opt-in via `--prs` (#332 review H1: bare ls never fans out
 * live reads); see the cell's own comment for the "-"/count/0 contract.
 * Every single-studio call site passes no map and renders "-" — "no data" is
 * the honest reading for a view that never asked the board.
 *
 * INFER column (issue #934): this studio's lead-inference calls in the last
 * 30 minutes, "<ok>/<calls> <pct>%" — the one number that answers "is this
 * row alive AND getting answers", which READY cannot (an alive lead blocked
 * on Workers AI 429/5xx reads `running` with every number frozen; that
 * silence looked like progress for 5h on 2026-10-15). `inferBy` (studio id
 * -> {calls, ok}) comes from cmdLs's one batched GET
 * /studio/junior/usage/lead — NOT behind a flag, unlike PRS: it is a single
 * D1 GROUP BY inside the Worker, never a per-studio fan-out, so the #332
 * review H1 "bare ls never fans out live reads" rule does not apply. Placed
 * between ACTIVITY and CHECKED because it is read beside the live-signal
 * columns. Every single-studio call site passes no map and renders "-" —
 * same honest-reading reason as PRS.
 */
export function formatTable(
  studios: StudioStatus[], now: Date = new Date(), orcaRows?: Map<string, string> | null,
  openPrs?: Map<string, number>, inferBy?: Map<string, LeadInferUsage>,
  assignments?: Record<string, string>,
): string {
  if (studios.length === 0) return "(no studios provisioned)";
  // REPO column (operator request 2026-08-20): a studio id is
  // `<repo>--<role>`, so the repo is already in `id` — but `fleet ls` is
  // fleet-wide, not cwd-scoped, and reading "which repo is this one on" out
  // of a delimiter mid-id is exactly the confusion this splits apart. Derived
  // here, never a new API field: parseStudioId is the id grammar's own source
  // of truth, and a malformed id keeps rendering rather than crashing the
  // table.
  const headers = [
    "ID", "REPO", "STATE", "RST", "WIP", "PRS", "READY", "SESSION", "ACTIVITY", "INFER", "CHECKED", "ROW", "ACCOUNT", "HOST", "BURN", "REFRESHED", "ERROR",
  ];
  const rows = studios.map((s) => {
    // Issue #934: the blocked verdict is computed before the cells below,
    // because the marker rides the READY cell while the numbers live in
    // INFER — one lookup, shared by both.
    const blocked = isLeadInferenceBlocked(inferBy?.get(s.id));
    // Issue #1142, item 2: a router-led lead reading "working" with 0 router
    // calls in the window. Mutually exclusive with `blocked` (needs >=10 calls).
    const silent = isLeadInferenceSilent(s, inferBy?.get(s.id), inferBy !== undefined, now);
    return [
      s.id,
      parseStudioId(s.id)?.repo ?? "-",
      // STATE column (issue #95): formatState calls out a `stopped` row whose
      // container the Worker's detector saw RUNNING — billing while the
      // registry says off — rather than the bare state word.
      formatState(s),
      // RST column (issue #56): containers replaced in the last 24h / lifetime
      // -- churn a coordinator can see without opening a container.
      formatRestartCell(s, now),
      // WIP column (board issue #208, part 2): age since the last periodic
      // WIP safety-net check (fleet/rescue/<studio>/wip/<bootStamp>, #208 fix
      // round item 1 -- scoped per container boot) -- bounds how much a
      // platform-side container replacement (no pre-replacement rescue hook)
      // could have cost, without opening a container.
      formatWipCell(s, now),
      // PRS cell (board issue #332): a map ENTRY (0 included) is a counted
      // answer from the board's open-prs route; ABSENCE is "no data" — the
      // route was unavailable for this studio's repo (an old Worker answering
      // 404) — rendered "-", never a silent 0: "could not look" must not read
      // as "looked and found none", the exact false-clean shape #332 exists
      // to prevent (a bounced security-adjacent PR parked 5x in a day while
      // nothing anywhere said so).
      String(openPrs?.get(s.id) ?? "-"),
      // Issue #85: `readyOverride` reads the DO's own Observed evidence
      // (replaced/unreachable/unverified) FIRST — that evidence contradicts or
      // supersedes the last container-side check `formatReady` renders, and
      // first-match-wins beats a stale/hopeful "provisioned". `formatReady` is
      // the fallback only once none of those overrides apply — and (issue #99)
      // itself checks the row's own rateLimited field before falling through
      // to the container-side readiness verdict.
      // Issue #934: a blocked lead APPENDS " inference-blocked" here — the
      // READY column is where an operator already looks for "this row is
      // lying about being fine" (issue #99's rate-limit override reads there),
      // and the marker never REPLACES the verdict underneath (it still
      // shows), firing only on the threshold: >=10 calls under 50% ok in the
      // last 30 min (isLeadInferenceBlocked, cli/infer-format.ts).
      (() => {
        const ready = readyOverride(s, now) ?? formatReady(s.readiness, s, now);
        if (blocked) return `${ready} inference-blocked`;
        return silent ? `${ready} inference-silent` : ready;
      })(),
      formatSession(s, now),
      // ACTIVITY column (issue #221, PR3a): working/idle/waiting-members/limit
      // from the pane itself, `?` with a reason when it cannot say — the
      // answer READY cannot give (READY only says alive-or-dead). Reads the
      // D1-mirrored `observed.activity`, so this budget is the mirror one
      // (`formatActivity`'s own default third argument).
      formatActivity(s, now),
      // INFER cell (issue #934): "<ok>/<calls> <pct>%" of this studio's
      // lead-inference calls in the last 30 min, "-" when it made none in the
      // window (Claude-led or idle) or the route never answered — the same
      // absent-means-no-data contract the PRS cell above carries. See
      // formatInfer's own doc comment (cli/infer-format.ts) for the shape.
      formatInfer(inferBy?.get(s.id)),
      formatCheckedAt(s.readiness, now),
      // ROW column (board #55): this machine's Orca row + attach terminal,
      // cli/orca-workspace.ts's classifyStudioRow. `fleet ls` always passes a
      // map (`?` + footer when Orca gave no verdict, #299); "-" only on the
      // single-studio views that never read Orca at all.
      orcaRows?.get(s.id) ?? "-",
      // ACCOUNT column (issue #53): WHICH claude account this studio is running
      // on, by the name of the Worker secret it comes from. The fleet now moves
      // a studio to the next account by itself when the first one hits its
      // limit, and "a silent failover that works is still a failover nobody can
      // audit when the second account drains too" — this column is where an
      // operator sees that it happened, without opening a container.
      //
      // The secret's NAME, never its value: a variable name is not a credential.
      // Absent is rendered as the first account rather than "-": a studio that
      // has never switched is on CLAUDE_CODE_OAUTH_TOKEN by construction (see
      // StudioStatus.claudeAccount), and "-" would read as "unknown".
      //
      // Issue #271: with the operator's label (CLAUDE_ACCOUNT_<n>_LABEL, stamped
      // by the Worker's listStudios) as `<label> (<secret name>)`.
      //
      // Issue #289/#285: the account the container was LAUNCHED on, the next
      // launch's in a note when they differ; "-" after a refused launch.
      formatAccount(s, leadModelOf(s, assignments)),
      // Fleet task #1248: a local studio has no tailnet host — its HOST cell
      // reads "local" (where it runs: the operator's Mac), never a "-" that
      // would read as "unknown".
      s.host === "local" ? "local" : s.tailscaleHost ?? "-",
      formatBurn(s.burn),
      s.lastRefresh ?? "-",
      capErrorCell(s.error),
    ];
  });
  return formatColumns(headers, rows);
}

// ---------------------------------------------------------------------------
// Board issue #332: the open-prs read behind the PRS column and the destroy
// warning. One route — GET /studio/board/open-prs?repo=<owner/name>
// (src/board/routes.ts, this issue's steps 1-2) — answers EVERY studio of one
// repo at once, so the GitHub reads happen inside the Worker, once per repo
// the caller names: exactly the batched shape issue #37's "never fan out a
// live check per studio on the listing path" ruling demands. Every helper
// here is best-effort the same way the route itself is: a 404 from a Worker
// deployed before this feature, a 5xx, or a transport blip contributes NO
// data and never fails the command that asked.

/** The route path for one repo — an ABSENT `repo` param is the fleet
 *  default, the same reading the route itself gives a null repoSlug. */
function openPrsPath(repoParam: string | null): string {
  return repoParam === null ? "/open-prs" : `/open-prs?repo=${encodeURIComponent(repoParam)}`;
}

/** One open-prs request's headers: the Access service-token pair plus the
 *  explicit JSON Accept every CLI read of a content-negotiating route
 *  already sends (cmdLs's own /studio/ read established this discipline). */
function openPrsHeaders(creds: Credentials): Record<string, string> {
  return { ...accessHeaders(creds), Accept: "application/json" };
}

/** #332 review H1: every open-prs client fetch carries its own deadline —
 *  `fleet ls` must never sit waiting on a slow scan; the AbortSignal turns
 *  a hung read into the same "no data" degrade the 404 path already takes. */
const OPEN_PRS_TIMEOUT_MS = 10_000;

/**
 * The per-studio PRS counts for a whole listing (#332): one fetch per
 * DISTINCT repo, merged into a single studio-id -> count map for formatTable
 * and `fleet ls --json` (readiness-format.ts's lsJsonRows), plus the
 * `unknown` list — every studio whose scan the route REPORTS as failed
 * (#332 review H2: absent from `counts`, so its cell renders '-'; cmdLs
 * prints one degrade warning naming them, and "scan failed" must never
 * read as a confident zero).
 *
 * WHICH value names a "distinct repo": the row's own `repoSlug` — the full
 * `owner/name` the Worker resolved and wrote (StudioStatus.repoSlug), not
 * the id's folded repo segment, because the segment is not something the
 * route can accept (resolveBoardRepo's grammar is owner/name) and because
 * the route filters its own studio set by that very field. A NULL repoSlug
 * (a studio provisioned before P4a) means the fleet default by construction
 * — those rows share ONE fetch with an absent `repo` param, the route's own
 * reading of that null, so a fleet mid-upgrade (some rows null, some not,
 * same repo) reads every studio from the right map.
 *
 * #332 review H1: every fetch carries an AbortSignal (OPEN_PRS_TIMEOUT_MS)
 * — `fleet ls` never sits waiting on a slow scan; a hung read degrades the
 * same way the 404 path already does.
 *
 * `fetchImpl` is a parameter for the same reason TabsDeps exists: the real
 * caller passes the global fetch; a test passes a fake and needs no network.
 * Never throws and never rejects — every failure reads as "that repo's
 * studios have no data this run".
 */
export async function openPrsByStudio(
  creds: Credentials, studios: StudioStatus[], fetchImpl: typeof fetch = fetch,
): Promise<{ counts: Map<string, number>; unknown: string[] }> {
  // Keyed by the value that decides the FETCH (repoSlug, with every null
  // row folded onto the default-repo group), so two rows of one repo always
  // share one request and a mixed null/non-null fleet never reads one
  // studio's PRs out of another repo's map.
  const groups = new Map<string, { param: string | null; ids: string[] }>();
  for (const s of studios) {
    const key = s.repoSlug ?? "(default)";
    const group = groups.get(key) ?? { param: s.repoSlug, ids: [] };
    group.ids.push(s.id);
    groups.set(key, group);
  }
  const counts = new Map<string, number>();
  const unknown: string[] = [];
  for (const group of groups.values()) {
    try {
      const res = await fetchImpl(boardUrl(creds, openPrsPath(group.param)), {
        headers: openPrsHeaders(creds),
        signal: AbortSignal.timeout(OPEN_PRS_TIMEOUT_MS),
      });
      // !ok — a 404 from a Worker that predates this route above all — is
      // NO data for this repo's studios, never a failed ls: their cells read
      // "-", and every other repo keeps its real answer.
      if (!res.ok) continue;
      const body = (await res.json()) as { prs?: Record<string, OpenPr[]>; unknown?: string[] };
      for (const id of group.ids) {
        // The route answers every studio of the repo: a covered id (an
        // array entry, empty included) is a counted answer; an id the body
        // names in `unknown` is a scan the route RAN and could not answer —
        // reported, never recorded as 0; anything else is a mismatched
        // answer (an old route shape with no `unknown` key, a foreign id),
        // recorded as absence, never a silent 0.
        const prs = body.prs?.[id];
        if (Array.isArray(prs)) counts.set(id, prs.length);
        else if (body.unknown?.includes(id)) unknown.push(id);
      }
    } catch {
      // A transport blip on one repo's read is the same as the route being
      // unavailable: absence for that group, real answers for the rest.
    }
  }
  return { counts, unknown };
}

/**
 * ONE studio's live unmerged PRs (#332) — the destroy path's half of the
 * route. `{ ok: false }` means "could not look" (a non-ok answer, a throw,
 * or a 200 whose map does not cover this studio) and is the ONLY failure
 * shape: this helper never throws and never invents an empty list, because
 * the strict refusal must treat "unknown" and "zero" as different facts.
 *
 * #332 review H2: `{ ok: false, unknown: true }` is the DIFFERENT failure —
 * the route ANSWERED, and named this studio in its `unknown` array: the scan
 * ran and could not answer. Strict refuses on that one (a scan-failed studio
 * is not an unavailable route); the plain { ok: false } (route-missing,
 * transport blip, uncovered map) still proceeds loudly.
 *
 * #332 review H1: the fetch carries the same OPEN_PRS_TIMEOUT_MS deadline —
 * a hung read is a "could not look", never a hung destroy.
 */
export async function fetchStudioOpenPrs(
  creds: Credentials, repoParam: string | null, studioId: string, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; prs: OpenPr[] } | { ok: false; unknown?: true }> {
  try {
    const res = await fetchImpl(boardUrl(creds, openPrsPath(repoParam)), {
      headers: openPrsHeaders(creds),
      signal: AbortSignal.timeout(OPEN_PRS_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { prs?: Record<string, OpenPr[]>; unknown?: string[] };
    // The route ran and could not answer for THIS studio — scan-failed,
    // a different fact from route-missing.
    if (Array.isArray(body.unknown) && body.unknown.includes(studioId)) return { ok: false, unknown: true };
    const prs = body.prs?.[studioId];
    return Array.isArray(prs) ? { ok: true, prs } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** #332: one PR's own line in a refusal or warning — `#<n> <title> <url>`,
 *  indented, the URL last so a phone tap works. */
function openPrLine(pr: OpenPr): string {
  return `  #${pr.prNumber} ${pr.title} ${pr.url}`;
}

/**
 * `--strict-unmerged`'s REFUSAL lines (#332): the count and the flag lead
 * (the operator must see WHY in the first line), then every PR, one per
 * line. Pure — cmdDestroy prints these and exits 1 before any destroy
 * request fires.
 */
export function strictRefusalLines(prs: OpenPr[]): string[] {
  return [
    `fleet destroy: refusing: ${prs.length} unmerged PR(s) still open (--strict-unmerged) — ` +
      "merge or close them first, or re-run without the flag",
    ...prs.map(openPrLine),
  ];
}

/**
 * The post-destroy NON-BLOCKING warning (#332), printed after a confirmed
 * stop — for a plain destroy exactly as much as for --park, because an
 * unmerged PR needs its lane's history alive either way. Never affects the
 * exit code. The header's "PR(s)" shape is fixed for every count: a machine
 * grepping it must not need to know the pluralization rules.
 */
export function parkWarningLines(id: string, prs: OpenPr[]): string[] {
  return [
    `park warning: ${id} still has ${prs.length} unmerged PR(s):`,
    ...prs.map(openPrLine),
  ];
}

/**
 * The strict pre-check's degradation line (plan ruling): a 404 or any other
 * unavailable answer is NOT evidence of zero PRs, and blocking a destroy on
 * a Worker upgrade race is worse than proceeding without the check — so
 * strict says so, loudly, and proceeds.
 */
export const STRICT_UNMERGED_UNKNOWN_PROCEEDING =
  "fleet destroy: unmerged-PR status unknown (open-prs route unavailable) — proceeding";

/** #332 review H2: a scan the route REPORTS as failed is not the same as an
 *  unavailable route — the check ran and could not answer, so strict has the
 *  one thing it needs to refuse: uncertainty about zero. */
export const STRICT_UNMERGED_UNKNOWN_SCAN =
  "fleet destroy: refusing: unmerged-PR status unknown (the scan failed for this studio) — cannot confirm zero PRs (--strict-unmerged); re-run, or drop the flag to proceed";

/** The post-destroy warning's own degradation line: same honesty, one line,
 *  nothing claimed the check could not back. */
export const PARK_WARNING_UNAVAILABLE =
  "park warning: could not check unmerged PRs (route unavailable)";

/** The park warning's unknown-scan line: the route ANSWERED, but this
 *  studio's own scan failed — "could not check", never a clean zero. */
export const PARK_WARNING_UNKNOWN_SCAN =
  "park warning: could not check unmerged PRs (the scan failed for this studio)";

// ---------------------------------------------------------------------------
// Issue #1074 ask 1: the lead-model assignments behind the ACCOUNT label and
// `fleet ls --json`'s leadType/leadModel — one GET to /studio/models (the same
// route `fleet models` reads), studio id -> Workers AI model id. Best-effort:
// null on any failure, so the listing degrades (a glm lead reads plain glm)
// and never fails.
async function fetchLeadAssignments(creds: Credentials): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(new URL("/studio/models", creds.workerUrl), {
      headers: { ...accessHeaders(creds), Accept: "application/json" },
      signal: AbortSignal.timeout(LEAD_INFER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { assignments?: Record<string, string> };
    return body.assignments ?? {};
  } catch {
    return null;
  }
}

// Issue #934: the lead-inference read behind the INFER column. ONE route —
// GET /studio/junior/usage/lead?since=<ms> (src/junior/usage.ts's
// handleLeadUsageStats, this issue's step 1) — answers EVERY studio at once:
// the GROUP BY runs inside the Worker as one batched D1 read, so the #332
// review H1 "bare ls never fans out live reads" concern does not apply and
// this fetch is NOT behind a flag, unlike --prs. Best-effort the same way
// openPrsByStudio above is: a 404 from a Worker deployed before this
// feature, a 5xx, or a transport blip contributes NO data and never fails
// the listing that asked.

/** The route path for the window — `since` is the epoch-ms cutoff, exactly
 *  what the route's own doc comment says the CLI layer always hands it:
 *  `now - 30min` (INFER_WINDOW_MS). */
function leadInferPath(sinceMs: number): string {
  return `/usage/lead?since=${encodeURIComponent(String(sinceMs))}`;
}

/** #934 review posture (same rule as OPEN_PRS_TIMEOUT_MS): the fetch carries
 *  its own deadline — `fleet ls` must never sit waiting on a slow read; the
 *  AbortSignal turns a hung read into the same "no data" degrade the 404
 *  path already takes. */
const LEAD_INFER_TIMEOUT_MS = 10_000;

/**
 * The per-studio lead-inference usage for a whole listing (#934): one GET
 * to /studio/junior/usage/lead with `since = nowMs - INFER_WINDOW_MS`, the
 * rows folded into a single studio-id -> {calls, ok} map for formatTable's
 * INFER cell and `fleet ls --json` (readiness-format.ts's lsJsonRows).
 *
 * A tagged result, never a throw and never a rejection — every failure
 * (a !ok answer above all a 404 from a Worker that predates the route, or
 * a transport blip) reads as `{ ok: false, message }`, and the caller
 * degrades: the table still prints, every INFER cell reads "-", and ONE
 * stderr line says the status is unavailable. `fetchImpl` is a parameter
 * for the same reason openPrsByStudio's is: the real caller passes the
 * global fetch; a test passes a fake and needs no network.
 */
export async function fetchLeadInferUsage(
  creds: Credentials, nowMs: number, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; by: Map<string, LeadInferUsage> } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl(juniorUrl(creds, leadInferPath(nowMs - INFER_WINDOW_MS)), {
      headers: { ...accessHeaders(creds), Accept: "application/json" },
      signal: AbortSignal.timeout(LEAD_INFER_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Never a failed ls — a 404 is an old Worker, the cells read "-".
      return { ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}` };
    }
    const body = (await res.json()) as { rows?: { studioId: string; calls: number; ok: number }[] };
    const by = new Map<string, LeadInferUsage>();
    // The route answers every studio with lead rows in the window; a studio
    // absent from the body made no lead calls there (Claude-led or idle),
    // which is absence, never a silent 0 — the cell's own "-" contract.
    for (const r of body.rows ?? []) by.set(r.studioId, { calls: r.calls, ok: r.ok });
    return { ok: true, by };
  } catch (err) {
    // A transport blip is the same as the route being unavailable: absence
    // for everyone, never a failed command.
    return { ok: false, message: errText(err) };
  }
}

/**
 * Issue #37: one studio, checked LIVE — POST /studio/:id/check (routes.ts).
 * The answer to "an operator cannot tell a healthy studio from a dead one
 * without opening a shell inside the container".
 *
 * The Worker records the verdict as well as returning it, so the next
 * `fleet ls` agrees rather than showing the pre-check row for up to another
 * 300s.
 *
 * READ THE CAVEAT PRINTED BELOW BEFORE TRUSTING A GREEN ROW. The check's
 * liveness marker is `pane_current_command` in `tmux studio:claude`, and it
 * reads "claude" in THREE different states — lead mid-turn, lead stopped
 * waiting on background subagents, and lead dead at a shell prompt. It
 * answers ALIVE-or-DEAD. It does NOT answer WORKING-or-STOPPED, and must
 * never be used to conclude a studio is spending money productively.
 */
async function cmdCheck(creds: Credentials, id: string): Promise<void> {
  const res = await fetch(studioUrl(creds, id, "/check"), {
    method: "POST",
    headers: accessHeaders(creds),
  });
  if (!res.ok) {
    console.error(repairFailureLine("check", res.status, await res.text()));
    process.exit(1);
  }
  const status = parseStudioStatus(await res.json());
  if (status === null) {
    console.error("fleet check: answered 200 but the body was not a studio row");
    process.exit(1);
  }
  console.log(formatTable([status]));
  const full = fullErrorLine(status);
  if (full) console.log(full);
  console.log(READY_CAVEAT);
}

/**
 * Board #140 (HOLD fix) — POST /studio/:id/clear-session-guard (routes.ts).
 * See that route's own doc comment, and do.ts's clearSessionGuard, for the
 * full design: this arms a ONE-SHOT override that makes the NEXT sync
 * upload the container's current session over R2's latest without the
 * usual richness comparison — the old latest is preserved first under
 * sessions/<id>/superseded/<iso>.tar.gz, and a blank/unreadable candidate
 * still refuses (the override stays armed for a later, real one).
 *
 * Issue #228 HOLD fix, item 3: "next sync" is not only the periodic 300s
 * tick — `fleet restart`/`fleet recycle`/`fleet destroy` each run their own
 * pre-teardown sync (restartWithSync/recycleWithSync/destroyWithSync,
 * do.ts/destroy.ts) before doing anything else, and whichever one runs
 * FIRST after this call consumes the override, force-uploading the
 * studio's LAST session (bypassing the mark/poorerThan comparison) before
 * the container goes away. The stderr line below now says so, rather than
 * naming only the tick and leaving an operator who runs `fleet destroy`
 * right after this surprised that the "next sync tick" already happened.
 * Destroying a studio whose container is not running never syncs at all
 * (see destroy.ts's own doc comment) — the override stays armed for
 * whichever studio/sync actually consumes it next.
 */
async function cmdClearSessionGuard(creds: Credentials, id: string): Promise<void> {
  const res = await fetch(studioUrl(creds, id, "/clear-session-guard"), {
    method: "POST",
    headers: accessHeaders(creds),
  });
  if (!res.ok) {
    console.error(repairFailureLine("clear-session-guard", res.status, await res.text()));
    process.exit(1);
  }
  const clearedRow = parseStudioStatus(await res.json());
  if (clearedRow === null) {
    console.error("fleet clear-session-guard: answered 200 but the body was not a studio row");
    process.exit(1);
  }
  console.log(formatTable([clearedRow]));
  console.error(
    `fleet: ${id}'s next sync will force-upload over R2's latest (old latest preserved under sessions/${id}/superseded/) — one-shot, consumed by whichever runs first: the periodic sync tick, or a restart/recycle/destroy's own pre-teardown sync. Destroying a stopped (not-running) container skips sync entirely and leaves the override armed.`,
  );
}

/**
 * Board issue #47 — GET /studio/:id/inspect (src/studio/routes.ts). Read a
 * studio without ever attaching a tmux client: `fleet attach` corrupts
 * whatever a human is currently reading on the same shared pane the instant
 * a client joins or leaves it (that issue's own measured incident); this
 * asks the container for `pane_current_command`, checkout presence, and the
 * pane's own tail via `tmux capture-pane -p` — a plain `sbExec`, never the
 * pty.
 *
 * Always a 200 from the route (same posture `fleet check`'s /check and
 * /wake already take) with the outcome riding the body's `ok` field, so a
 * refusal (stopped studio, never provisioned) prints as a message, not an
 * HTTP error — this exits non-zero either way, the CLI's own way of making
 * that visible in a script.
 *
 * Board #91: bounded and side-naming — see cli/inspect-request.ts.
 *
 * Issue #85, maestro correction #12: the DO's own stored `Observed` verdict
 * (`replaced`/`unreachable`/session) prints BEFORE the `ok` check exits —
 * today, a container-side failure returns only an error string, and an
 * operator gets no signal at all about what the DO itself already knows,
 * right when they need it most.
 */
async function cmdInspect(creds: Credentials, id: string): Promise<void> {
  const out = await requestInspect(studioUrl(creds, id, "/inspect"), accessHeaders(creds));
  if (!out.ok) {
    console.error(`fleet inspect: ${out.message}`);
    process.exit(1);
  }
  const body = out.body as (InspectBody & { observed?: Observed })
    | { ok: false; error: string; observed?: Observed; sessionForceArmedAt?: string | null };
  // Maestro correction #12 — printed on BOTH branches, before the ok-check
  // returns/exits, so a container-side failure still shows what the DO
  // itself already knows.
  //
  // Fix round (issue #85 review, BLOCKER 2): `body.observed` is optional —
  // absent on routes.ts's "Worker->DO call failed" catch branch (a rejection
  // that never reaches `runInspect`) and on any response from a Worker
  // deployed before this feature. `formatObservedLines` (readiness-format.ts)
  // renders the honest-floor line for that case instead of crashing on
  // `body.observed.replacedAt`.
  for (const line of formatObservedLines(body.observed)) console.log(line);
  // Board issue #208, part 2: same "before the ok-check" treatment as
  // formatObservedLines just above -- the WIP safety-net sync age is DO-
  // stored evidence too, so a container-side failure still shows it.
  for (const line of formatWipInspectLines(id, body.observed, new Date())) console.log(line);
  // Issue #228 HOLD fix, item 4: same "before the ok-check" treatment as
  // formatObservedLines just above — the Worker sends sessionForceArmedAt on
  // BOTH branches (routes.ts), so an ok:false inspect (a stopped studio, a
  // container exec failure) now shows an armed override too, instead of the
  // line only ever appearing on the ok:true path renderInspect used to own.
  for (const line of formatSessionForceArmedLine(body.sessionForceArmedAt)) console.log(line);
  if (!body.ok) {
    console.error(`fleet inspect: ${body.error}`);
    process.exit(1);
  }
  const rendered = renderInspect(body, Date.now());
  for (const line of rendered.lines) console.log(line);
  if (!rendered.ok) process.exit(1);
}

/**
 * What a `provisioned` verdict does and does not prove. Printed under every
 * live check (issue #37's follow-up ruling: "document it wherever you
 * surface/recommend this check"), because a reader who takes READY=provisioned
 * for "this studio is working" will be wrong a third of the time by
 * construction.
 *
 * Issue #85 extended this: READY can now ALSO read replaced/unreachable/
 * unverified — the ship tick's own Observed evidence contradicting or
 * outrunning the last container-side check — and each means something
 * different enough that naming them here, not just in `fleet ls --help`, is
 * the same "document it wherever you surface/recommend this check" ruling
 * this whole caveat already follows. The unreachable/unverified/replaced
 * cases are never a live re-check themselves — they are evidence the LAST
 * verdict is stale or contradicted. Maestro correction #11: every repair
 * verb (restart, recycle, heal) goes through the SAME DO a failing `fleet
 * inspect` would also be failing against — if inspect itself cannot get an
 * answer DO-side (not merely a container-side refusal), the right move is to
 * WAIT and re-check, not to race straight to recycle into a DO that cannot
 * currently answer at all.
 */
const READY_CAVEAT =
  "READY=provisioned means ALIVE, not WORKING: pane_current_command reads \"claude\" for a lead mid-turn, " +
  "a lead stopped waiting on subagents, AND a lead dead at a shell prompt. It cannot tell those three apart. " +
  "READY may also read replaced/unreachable/unverified (issue #85) — evidence the row's LAST VERDICT is stale " +
  "or contradicted, never a live re-check: replaced means the ship tick found no incarnation token (wait for " +
  "heal, or provision — the container itself may already be fine, just not yet re-confirmed); unreachable " +
  "means the DO itself is alive but the container exec plane is not (the message itself names what a recycle " +
  "would lose); unverified means readiness checks themselves have stopped landing (run fleet inspect first — " +
  "it names which side failed). If fleet inspect ITSELF fails DO-side (not a container-side refusal), every " +
  "repair verb — restart, recycle, heal — goes through that SAME DO, so the right move is to WAIT and re-check, " +
  "not to immediately recycle into a DO that cannot currently answer at all. " +
  "ACTIVITY (issue #221) answers working-or-stopped — WORKING/IDLE/WAITING MEMBERS/WAITING QUESTION/LIMIT, read from the pane " +
  "itself, or \"?\" with a reason when it cannot say; READY only ever answers alive-or-dead.";

/**
 * Issue #37: the fleet-wide opt-in live check behind `fleet ls --fresh`. One
 * POST /studio/:id/check per studio, fanned out from HERE rather than from a
 * server-side `?fresh` on the listing route, deliberately:
 *
 *   - the cost (one container exec per studio) stays visible at the call site,
 *     and the issue's own boundary is explicit — the DEFAULT listing must
 *     never fan out;
 *   - one unreachable container cannot wedge the whole listing. A studio whose
 *     check fails keeps its last recorded row, so `fleet ls --fresh` degrades
 *     to `fleet ls` per studio instead of failing outright, and the CHECKED
 *     column's age is what shows which ones did not refresh.
 */
async function refreshAll(creds: Credentials, studios: StudioStatus[]): Promise<StudioStatus[]> {
  return Promise.all(studios.map(async (s) => {
    try {
      const res = await fetch(studioUrl(creds, s.id, "/check"), { method: "POST", headers: accessHeaders(creds) });
      if (!res.ok) {
        console.error(repairFailureLine("check", res.status, await res.text(), `fleet ls --fresh: ${s.id}`));
        return s;
      }
      // Same posture as the catch below: a body this side cannot read
      // leaves the studio's last recorded row in place, never a gap.
      const refreshed = parseStudioStatus(await res.json());
      if (refreshed === null) {
        console.error(`fleet ls --fresh: ${s.id}: answered 200 but the body was not a studio row`);
        return s;
      }
      return refreshed;
    } catch (err) {
      console.error(`fleet ls --fresh: ${s.id}: ${errText(err)}`);
      return s;
    }
  }));
}

export async function cmdLs(
  creds: Credentials, fresh: boolean, orcaDeps: OrcaDeps = defaultOrcaDeps(), json = false, prs = false,
): Promise<void> {
  // Task 5 (P2 plane 3): explicit, now that GET /studio/ content-negotiates
  // on Accept (routes.ts) — without this, a future default change there
  // could silently start handing the CLI an HTML page instead of the JSON
  // array formatTable expects.
  const res = await fetch(new URL("/studio/", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`fleet ls: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
    process.exit(1);
  }
  const recorded = parseStudioStatusArray(await res.json());
  if (recorded === null) {
    console.error(`fleet ls: answered ${res.status} but the body was not studio rows`);
    process.exit(1);
  }
  // Issue #37: --fresh re-checks every studio LIVE before the table is
  // printed; bare `fleet ls` prints what the registry already has, and the
  // CHECKED column says how old each of those verdicts is.
  const studios = fresh ? await refreshAll(creds, recorded) : recorded;
  // Board issue #332, #332 review H1: the PRS column's data is --prs OPT-IN
  // — bare `fleet ls` never fans out live reads (a 30s monitor polling ls
  // was burning ~27k GitHub calls/hr through the Worker's per-studio
  // scans), staying the one registry read issue #37 rules it must be.
  // With --prs the batched fetch (one per distinct repo, inside the Worker)
  // is launched now so it overlaps the Orca read below instead of stacking
  // on it. Best-effort and never rejects: a Worker that predates the route
  // only costs this await.
  const openPrs = prs
    ? openPrsByStudio(creds, studios)
    : Promise.resolve({ counts: new Map<string, number>(), unknown: [] as string[] });
  // Issue #934: the INFER column's read, launched unconditionally (NOT
  // behind a flag, unlike --prs) — one batched D1 GROUP BY inside the
  // Worker, never a per-studio fan-out, so the #332 review H1 rule does not
  // apply. Fired here so it overlaps the openPrs await above instead of
  // stacking on it; best-effort, never rejects — a Worker that predates the
  // route only costs this await and the degrade line below. Runs in BOTH
  // --json and table mode: it is one cheap read either way.
  const inferFetch = fetchLeadInferUsage(creds, Date.now());
  // Issue #1074 ask 1: the lead-model assignments read, fired alongside
  // the INFER read for the same reason (one cheap GET, overlapping the awaits).
  const assignFetch = fetchLeadAssignments(creds);
  // #332 review H2: a scan the route reports as failed prints ONE degrade
  // warning naming the studios — never a confident zero. console.error, so
  // stdout stays machine-clean in --json mode.
  const { counts: openPrsCounts, unknown: openPrsUnknown } = await openPrs;
  if (openPrsUnknown.length > 0) {
    console.error(`fleet ls: unmerged-PR status unknown for ${openPrsUnknown.join(", ")} (scan failed)`);
  }
  const inferRes = await inferFetch;
  const inferBy = inferRes.ok ? inferRes.by : undefined;
  if (!inferRes.ok) {
    // One line, stderr, never a failed listing: the table still prints,
    // every INFER cell reads "-", and stdout stays machine-clean in --json
    // mode. console.error, same posture as the openPrs warning above.
    console.error(`fleet ls: lead inference status unavailable (${inferRes.message})`);
  }
  // Issue #70 ask 4: machine-readable lead state, nothing else on stdout.
  // #332: openPrs rides each row when the route answered for its repo.
  // #934: infer rides each row the same way (absence = no data, never 0/0).
  const assignments = (await assignFetch) ?? undefined;
  if (assignments === undefined) {
    // Stderr, one line, same degrade posture as the INFER line above: the
    // table and the JSON still print; a glm studio simply shows no model id.
    console.error("fleet ls: lead model status unavailable (/studio/models unreadable)");
  }
  if (json) {
    console.log(JSON.stringify(lsJsonRows(studios, new Date(), undefined, openPrsCounts, inferBy, assignments), null, 2));
    return;
  }
  for (const line of formatLsHead(studios)) console.log(line);
  const orca = await readStudioRows(studios, orcaDeps);
  console.log(formatTable(studios, new Date(), orca.rows, openPrsCounts, inferBy, assignments));
  // #299: stdout, not stderr — survives `fleet ls 2>&1 | grep`-style reads.
  if (orca.footer && studios.length > 0) console.log(orca.footer);
  // Issue #53: idle studios bill with zero events; say so above the caveat.
  const idle = formatIdleAlarm(studios, new Date());
  if (idle) console.log(idle);
  console.log(READY_CAVEAT);
  for (const line of formatSessionGuards(studios)) console.log(line);
  // Issue #56: a studio whose container keeps being replaced.
  for (const line of formatRestartChurn(studios, new Date())) console.log(line);
  // Issue #249 (PR4b) round 2, item 2: a survival re-brief still owed, or one
  // the studio has given up retrying. Same place, same shape as the session-guard
  // lines above — see formatSurvivalBriefs' own doc comment.
  for (const line of formatSurvivalBriefs(studios)) console.log(line);
  // Issue #141 review, item 4: every account the fleet knows is dead,
  // fleet-wide — including one with no studio currently parked on it, which
  // the table above can never show. Best-effort: a Worker that predates this
  // route 404s, and that must never break `fleet ls` itself.
  const accountsRes = await fetch(new URL("/studio/accounts", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (accountsRes.ok) {
    const accounts = (await accountsRes.json()) as { name: string; label: string | null; dead: boolean; seenAt: string | null }[];
    for (const line of formatDeadAccounts(accounts)) console.log(line);
  }
  // Fleet Spawn P3, Task 5: omitted for an empty fleet — a "0 turns, 0
  // output tokens" line under "(no studios provisioned)" would be noise,
  // not information.
  if (studios.length > 0) {
    console.log(formatFleetTotalsLine(fleetTotals(studios)));
  }
}

/**
 * `fleet tabs` — the reconcile verb. Every studio that is not stopped, in
 * scope, gets its own row in Orca's sidebar, each with a live `fleet attach`
 * terminal.
 *
 * This is what makes the operator's rule true for studios that are ALREADY up, rather
 * than only for ones spawned after it shipped. It is a separate verb on
 * purpose: `fleet ls` says it is read-only and agents rely on that, so the
 * reconcile does not ride along on a read.
 *
 * Issue #216, 2026-09-24: an operator ran bare `fleet tabs` meaning to fix its
 * OWN studio's row, and it reconciled the ENTIRE fleet — another maestro's
 * studios too, stacking duplicate attach clients on rows nobody asked to
 * touch, with no way to see in advance what the command would do. This verb
 * is now scoped to one repo's studios by default (see `resolveTabsScope`),
 * prints its plan before it acts (see `planStudioWorkspaces`,
 * cli/orca-workspace.ts), and confirms before a fleet-wide run.
 *
 * The whole reconcile pass is best-effort by construction
 * (ensureStudioWorkspace never throws), so a studio it could not open is a
 * printed line, not a dead command; a scope refusal or a failed studio-list
 * fetch is this command's only non-zero exit.
 */
export interface TabsFlags {
  /** Raw `--repo` value, unresolved — see `CliCommand`'s own `tabs` variant
   *  for why cli-args.ts hands this over without resolving it itself. Null
   *  when the flag was not given, which falls back to the cwd's own repo. */
  repo: string | null;
  all: boolean;
  yes: boolean;
}

/**
 * Every side effect `runTabs` needs, injected — this codebase's established
 * DI convention for exactly this class of untestable-outside-a-real-network
 * problem (see `runOnboardPreflight`'s own header for the identical posture).
 * `defaultTabsDeps` below is the ONE real wiring, used only by `cmdTabs`
 * itself; every test goes through a fake `OrcaDeps` (never real Orca — issue
 * #210 is mid-fix for a real-Orca duplicate-attach-client bug this feature
 * must not risk triggering) and a fake `detectRepo`/`confirm`/`listStudios`.
 */
export interface TabsDeps {
  detectRepo: () => Promise<DetectedRepo>;
  listStudios: () => Promise<StudioStatus[]>;
  /** Board #39: one board read per studio, so each row is titled by that
   *  studio's own current task. Never throws (real callers return [] on any
   *  failure, same as `listStudioTasks` itself), which yields the `(idle)`
   *  title rather than failing the reconcile. */
  listStudioTasks: (id: string) => Promise<BoardTask[]>;
  orcaDeps: OrcaDeps;
  /** One y/N prompt. Resolves `true` only on an explicit affirmative — a
   *  bare Enter, "n", or anything else is a refusal, never a fallback to
   *  proceeding. */
  confirm: (question: string) => Promise<boolean>;
  log: (line: string) => void;
}

export type TabsRunResult =
  | { ok: false; message: string }
  | { ok: true; cancelled: true; plan: TabsPlanEntry[]; studios: StudioStatus[] }
  | { ok: true; cancelled: false; plan: TabsPlanEntry[]; studios: StudioStatus[]; report: TabsReport };

/**
 * Resolves WHICH repo's studios this run may touch: `--all` (explicit,
 * fleet-wide — today's old behaviour, now opt-in), `--repo <owner/repo>`
 * (explicit override, skips `detectRepo` entirely), or the cwd's own repo
 * (default — the SAME `detectRepo()` `fleet spawn` already calls).
 *
 * A folder that names no repo is a REFUSAL here, never a silent fallback to
 * `--all`: `studioIdIn` (src/studio/repo.ts) already takes this exact
 * posture for the identical reason — guessing which repo an operator meant
 * is the silent-wrong-target failure issue #216 is about, and this verb
 * touching the whole fleet by accident is precisely how that issue happened.
 */
async function resolveTabsScope(
  flags: TabsFlags, detectRepo: () => Promise<DetectedRepo>,
): Promise<{ ok: true; segment: string | null; label: string } | { ok: false; message: string }> {
  if (flags.all) return { ok: true, segment: null, label: "--all (every repo in the fleet)" };

  // Board #21: the studio id's repo half is the FOLDED segment
  // (repo.ts's repoIdSegment) — the same fold every other repo/studio-id
  // comparison in this codebase goes through, never a raw slug/id compare.
  const badSegment = (slug: string): { ok: false; message: string } => ({
    ok: false,
    message: `fleet tabs: ${refuseBadSegment(slug, slug.split("/")[1] ?? "")}`,
  });

  if (flags.repo !== null) {
    const segment = repoIdSegment(flags.repo.split("/")[1] ?? "");
    if (segment === null) return badSegment(flags.repo);
    return { ok: true, segment, label: `${flags.repo} (--repo)` };
  }

  const detected = await detectRepo();
  if (detected.slug === null) {
    return {
      ok: false,
      message: `fleet tabs: ${detected.reason} — this folder names no repo, so tabs refuses rather ` +
        "than falling back to the whole fleet; run it from inside a repo, pass --repo <owner/repo>, or pass --all",
    };
  }
  const segment = repoIdSegment(detected.slug.split("/")[1] ?? "");
  if (segment === null) return badSegment(detected.slug);
  return { ok: true, segment, label: `${detected.slug} (from git remote origin)` };
}

/**
 * The testable core of `fleet tabs`. Resolves scope, filters the fleet-wide
 * studio list down to it, prints the plan (`planStudioWorkspaces`) BEFORE
 * anything is touched, gates a fleet-wide run behind a y/N confirmation
 * unless `--yes` was given, then runs the real reconcile and prints its
 * report. Every side effect comes from `deps`, so this is provable against
 * fake Orca deps end to end — see the boundary comment on `TabsDeps`.
 */
export async function runTabs(flags: TabsFlags, deps: TabsDeps): Promise<TabsRunResult> {
  const scope = await resolveTabsScope(flags, deps.detectRepo);
  if (!scope.ok) return { ok: false, message: scope.message };
  deps.log(`fleet tabs: scope ${scope.label}`);

  const allStudios = await deps.listStudios();
  const studios = scope.segment === null
    ? allStudios
    : allStudios.filter((s) => parseStudioId(s.id)?.repo === scope.segment);

  // The plan: one line per studio THIS RUN will touch, printed before any
  // Orca mutation and before the confirmation prompt below — an operator (or
  // the y/N answer) must be able to see what would happen before it does.
  const plan = await planStudioWorkspaces(studios, deps.orcaDeps);
  for (const p of plan) {
    if (p.kind === "skipped") deps.log(`skipped  ${p.id} (${p.why})`);
    else if (p.kind === "has one") deps.log(`has one  ${p.id}`);
    else deps.log(`open     ${p.id} (${p.detail})`);
  }
  if (plan.length === 0) deps.log("no studios in scope");

  // Confirmation gate: ONLY a fleet-wide run without --yes. A repo-scoped run
  // (cwd-default or explicit --repo) never needs one — it is already bounded
  // to "your own repo", which is the whole point of this fix. The "cwd names
  // no repo" case never reaches here at all: resolveTabsScope above already
  // refused it.
  if (flags.all && !flags.yes) {
    const proceed = await deps.confirm(`fleet tabs: reconcile ${plan.length} studio(s) fleet-wide? [y/N] `);
    if (!proceed) {
      deps.log("fleet tabs: cancelled — nothing touched");
      return { ok: true, cancelled: true, plan, studios };
    }
  }

  const tasksByStudio = new Map<string, BoardTask[]>();
  for (const s of studios) tasksByStudio.set(s.id, await deps.listStudioTasks(s.id));
  const report = await reconcileStudioWorkspaces(
    studios,
    (id) => studioWorkspaceTitle(id, tasksByStudio.get(id) ?? []),
    deps.orcaDeps,
  );
  for (const id of report.opened) deps.log(`opened   ${id}`);
  for (const id of report.existing) deps.log(`has one  ${id}`);
  for (const s of report.skipped) deps.log(`skipped  ${s.id} (${s.why})`);
  // Board #42, requirement 3: a recurrence must be loud, never a silent pick.
  for (const d of report.deduped) {
    deps.log(`deduped  ${d.id} (closed ${d.closed.length} duplicate attach terminal(s): ${d.closed.join(", ")})`);
  }
  return { ok: true, cancelled: false, plan, studios, report };
}

/** node:readline's one-line y/N prompt — the confirmation gate's real stdin
 *  read. No existing prompt helper anywhere in this file to reuse: `cmdAttach`'s
 *  process.stdin plumbing (below) is a raw-mode keystroke relay for a live
 *  tmux session, and `cmdMemoryCompact`'s stdin read is a whole JSON body —
 *  neither is a line-buffered yes/no question. Default is refusal: only an
 *  explicit "y"/"yes" (case-insensitive) proceeds. */
async function confirmYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function cmdTabs(creds: Credentials, flags: TabsFlags): Promise<void> {
  let result: TabsRunResult;
  try {
    result = await runTabs(flags, {
      detectRepo,
      listStudios: async () => {
        const res = await fetch(new URL("/studio/", creds.workerUrl), {
          headers: { ...accessHeaders(creds), Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
        const studios = parseStudioStatusArray(await res.json());
        if (studios === null) throw new Error("studio listing was not studio rows");
        return studios;
      },
      listStudioTasks: (id) => listStudioTasks(creds, id),
      orcaDeps: defaultOrcaDeps(),
      confirm: confirmYesNo,
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`fleet tabs: ${errText(err)}`);
    process.exit(1);
  }
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// fleet onboard — board task #125. A pure, read-only preflight for a repo the
// fleet has never talked to before, run from inside ANY git repo (not
// necessarily this one). The four checks and the brief are runOnboardPreflight
// (src/studio/onboard.ts, pure and unit-tested there); everything below is
// the real I/O it is injected with — the same "impure wiring lives in
// cli/fleet.ts, pure logic lives under src/studio" split detectRepo/
// parseGitRemote and cmdLs/formatTable already draw.

/** Real `checkReach`: GET /studio/reach — the ONE new route this feature
 *  adds (routes.ts), Access-authenticated the same as every other request
 *  here. Same "explicit Accept, not the default" discipline cmdLs's own
 *  fetch already applies. */
async function onboardCheckReach(creds: Credentials, repo: string): Promise<RepoReach> {
  const res = await fetch(new URL(`/studio/reach?repo=${encodeURIComponent(repo)}`, creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`reach check: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
  return (await res.json()) as RepoReach;
}

/** Real `listStudios`: the SAME GET /studio/ list route cmdLs already calls
 *  — one HTTP call serves both "does the Worker answer" (check #3) and
 *  "does a studio already exist for this repo" (check #4), per the design's
 *  own ruling; no second route for check #4. */
async function onboardListStudios(creds: Credentials): Promise<StudioStatus[]> {
  const res = await fetch(new URL("/studio/", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`fleet ls: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
  const studios = parseStudioStatusArray(await res.json());
  if (studios === null) throw new Error("studio listing was not studio rows");
  return studios;
}

/**
 * Prints each check in the task's own order (1 repo, 2 reach, 3
 * credentials+worker, 4 studio-exists), then the brief when checks 1-3 all
 * pass, then exits non-zero when `allPass` is false — check #4 is
 * informational per the spec and never gates the exit code.
 */
async function cmdOnboard(): Promise<void> {
  const result = await runOnboardPreflight<Credentials>({
    detectRepo,
    loadCredentials: tryLoadCredentials,
    checkReach: onboardCheckReach,
    listStudios: onboardListStudios,
  });

  console.log("fleet onboard:");
  for (const check of result.checks) {
    console.log(`  [${check.pass ? "PASS" : "FAIL"}] ${check.label} — ${check.detail}`);
  }

  if (result.brief) {
    console.log("");
    console.log(result.brief);
  }

  if (!result.allPass) process.exit(1);
}

// ---------------------------------------------------------------------------
// Dynamic repo selection (P4a) — which repo the studio this command creates
// will clone. Read from the CWD's own `git remote origin`, so `fleet spawn
// web-studio` run inside ~/code/fleetflare/sites/beta spawns a studio on beta. No
// flag: the folder the operator is standing in IS the argument.
//
// The impure half lives here (one `git` subprocess); the parsing is
// src/studio/repo.ts's parseGitRemote, which is where it can be unit-tested
// — the same split src/studio/cli-args.ts already draws for argv.

export interface DetectedRepo {
  /** `owner/repo`, or null when this folder cannot name one. */
  slug: string | null;
  /** Why not — git's own words, printed to the operator. Null on success. */
  reason: string | null;
}

/**
 * `git remote get-url origin` in the current directory.
 *
 * ONE subprocess covers every failure the brief calls out, because git
 * already distinguishes them in its own stderr: outside a repo it says
 * "fatal: not a git repository...", inside one with no origin it says
 * "error: No such remote 'origin'". Reporting git's line verbatim beats
 * re-deriving those cases with extra `rev-parse` calls and then
 * paraphrasing them. A remote that resolves but isn't github.com is the
 * third case, and parseGitRemote is what names it.
 *
 * Never throws and never guesses: an undetectable repo returns a null slug
 * plus a reason, the caller prints it, and the Worker falls back to the
 * fleet default. A guessed owner would be exactly the silent-wrong-target
 * failure this whole feature removes.
 */
export async function detectRepo(): Promise<DetectedRepo> {
  let stdout = "";
  let stderr = "";
  try {
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], { stdout: "pipe", stderr: "pipe" });
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) {
      return { slug: null, reason: stderr.trim().split("\n")[0] || "git could not read `origin`" };
    }
  } catch {
    // git missing from PATH entirely — same outcome, different cause.
    return { slug: null, reason: "could not run `git`" };
  }
  const url = stdout.trim();
  const slug = parseGitRemote(url);
  if (!slug) return { slug: null, reason: `origin (${url}) is not a github.com repo` };
  return { slug, reason: null };
}

/**
 * One line on stderr, always — stdout stays the machine-readable table.
 * Both branches print, deliberately: the operator has to be able to see
 * which repo a spawn targeted just as much as why one fell back, and a
 * command that only speaks up when it fails trains nobody to read it.
 */
function reportRepo(cmd: string, detected: DetectedRepo): void {
  if (detected.slug) console.error(`${cmd}: target repo ${detected.slug} (from git remote origin)`);
  else console.error(`${cmd}: ${detected.reason} — using the fleet's default repo`);
}

export type RepoForCreate =
  | { ok: true; slug: string }
  | { ok: false; message: string };

/** The studio-CREATING verbs' repo gate (issue #1229): a cwd that names no
 *  repo and no `--repo` refuses instead of falling back to the fleet default.
 *  `--repo` wins over detection (the same precedence `tabs`/`task new` use),
 *  and a malformed `--repo` is a refusal, never a guess. */
export function requireRepoForCreate(
  cmd: string, repoFlag: string | undefined, detected: DetectedRepo,
): RepoForCreate {
  if (repoFlag !== undefined) {
    const parsed = parseRepoSlug(repoFlag);
    if (!parsed) return { ok: false, message: `${cmd}: bad --repo ${JSON.stringify(repoFlag)} — expected "owner/name"` };
    return { ok: true, slug: `${parsed.owner}/${parsed.repo}` };
  }
  if (detected.slug === null) {
    return { ok: false, message: `${cmd}: no git remote here; pass --repo owner/name` };
  }
  return { ok: true, slug: detected.slug };
}

// ---------------------------------------------------------------------------
// fleet spawn / fleet provision — Fleet Spawn P3, Task 3 (R-P3-2/R-P3-3).
// Both are one authenticated POST + a one-row table print, the same shape
// cmdLs/cmdPaste already use; neither introduces a new response format.

/**
 * Operator-initiated spawn: POST /studio/spawn (routes.ts's operator
 * passthrough — the same org-chart edge check `container/studio-fleet`'s
 * in-container spawn goes through, just authenticated by Access instead of a
 * spawn token, and with the parent fixed to the literal "operator" role).
 */
async function cmdSpawn(
  creds: Credentials, role: string, newInstance: boolean, leadType?: "claude" | "glm" | "kimi" | "deepseek",
  repoFlag?: string,
): Promise<void> {
  // Dynamic repo selection (P4a): the detected repo rides along as `repo`.
  // Issue #1229: unlike before, a cwd that names none and no `--repo` is a
  // refusal, not a fallback — `requireRepoForCreate` exits before any fetch,
  // so the Worker's own default is never the source of a guessed target.
  const detected = await detectRepo();
  const r = requireRepoForCreate("fleet spawn", repoFlag, detected);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  // The repo is always sent now: detection or --repo, never omitted — the
  // omitted case (no repo anywhere) no longer reaches the body at all.
  console.error(repoFlag === undefined
    ? `fleet spawn: repo ${r.slug} (from git remote origin)`
    : `fleet spawn: target repo ${r.slug} (--repo)`);
  const res = await fetch(new URL("/studio/spawn", creds.workerUrl), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    // Issue #269: `--new` sends `instance: "next"` and lets the WORKER pick the
    // lowest free number, unlike `ff --new` which allocates client-side. The
    // difference is need, not taste: `ff` has to know the id before it spawns
    // (it assigns a task to that id by label first), and this command does not
    // — so it spends one round trip instead of two and reads the number it got
    // off the row it prints. Omitted without the flag, which leaves that
    // request byte-identical to the pre-#269 one.
    //
    // Issue #249: `--lead glm` sends `leadType: "glm"` the SAME way — omitted
    // without the flag, so a bare `fleet spawn <role>` stays byte-identical
    // to every request sent before this feature existed. #717: `--lead
    // kimi`/`--lead deepseek` ride the identical field, unresolved — the
    // Worker's own readLeadTypeRequest (src/studio/spawn.ts) is what maps
    // either to a glm-led studio with that pool model pinned.
    body: JSON.stringify({
      role, repo: r.slug,
      ...(newInstance ? { instance: "next" } : {}),
      ...(leadType === undefined ? {} : { leadType }),
    }),
  });
  if (!res.ok) {
    console.error(`fleet spawn: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
    process.exit(1);
  }
  const spawned = parseStudioStatus(await res.json());
  if (spawned === null) {
    console.error("fleet spawn: answered 200 but the body was not a studio row");
    process.exit(1);
  }
  console.error(`fleet spawn: repo ${r.slug} → ${spawned.id}`);
  console.log(formatTable([spawned]));
  // Issue #305: stderr, like reportRepo — stdout stays the table.
  const spawnAccount = formatAccountResolution("fleet spawn", spawned);
  if (spawnAccount !== null) console.error(spawnAccount);
  // the operator's rule, enforced here rather than remembered: a studio that is now
  // burning tokens in the cloud gets a row in Orca's sidebar. After the table,
  // deliberately — stdout is the machine-readable result and must not wait on
  // a GUI, and this can never fail the spawn that already succeeded.
  const spawnTasks = await listStudioTasks(creds, spawned.id);
  await openStudioRow(spawned.id, spawnTasks, defaultOrcaDeps());
}

// ---------------------------------------------------------------------------
// fleet spawn --local / ff --local — fleet task #1248. A local studio runs on
// the operator's Mac instead of a container: the registry row is written by
// POST /studio/local/spawn (host:"local", localPath), and the lead is
// materialized into an Orca worktree checked out from a LOCAL clone — never a
// container. Same role prompt, house rules and lead-gate the container would
// get; only WHERE differs.

/** One git subprocess, decoded: `code` 0 means success, `stdout`/`stderr` are
 *  the whole streams. The `run` port keeps resolveGitToplevel and
 *  resolveDefaultBranch unit-testable over canned subprocess outputs (T3). */
export interface GitRun {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** The real `run`: one `git <args>` via Bun.spawn, never throwing — a spawn
 *  that cannot even start reads as a non-zero exit (code 128), the same
 *  "could not run git" outcome the callers already handle. */
function defaultGitRun(): GitRun {
  return async (args) => {
    try {
      const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, stdout, stderr };
    } catch {
      return { code: 128, stdout: "", stderr: "could not run git" };
    }
  };
}

// ---------------------------------------------------------------------------
// Fleet task #1248 review BLOCKER B1: local destroy must not wipe the
// worktree's own work. A local studio's Orca worktree IS its checkout —
// uncommitted/unpushed commits live only there — yet cmdDestroy's teardown
// called `closeStudioRow` (-> `worktree rm --force`) for it the same as for a
// cloud studio, whose worktree is only a sidebar row. The three helpers below
// turn that into a decision: keep the worktree unless the operator has
// explicitly forced a discard and nothing is left to lose.

/** The pure teardown decision for a local studio's worktree.
 *
 *  park -> keep: a park is a pause, never a deletion, and `--park` used to
 *    still `worktree rm` a local checkout. Remove only on a real destroy.
 *  not (force && discardUnsynced) -> keep: without the operator explicitly
 *    naming the price (the same two flags the cloud path already honours),
 *    a destroy never deletes work it could still rescue.
 *  dirty or ahead -> keep: dirty files or unpushed commits are the work; a
 *    local destroy cannot recreate them from anywhere else. Only a clean,
 *    fully-pushed checkout — nothing to lose — is removed.
 *
 *  Pure (no I/O) so it is unit-testable; `dirty`/`ahead` come from the git
 *  reads `cmdDestroy` makes over `GitRun`. */
export function localTeardownDecision(
  flags: { force: boolean; discardUnsynced: boolean; park: boolean },
  dirty: boolean, ahead: boolean,
): { action: "keep" | "remove"; note: string } {
  if (flags.park) return { action: "keep", note: "parked — the worktree is kept (fleet destroy --park never removes a local checkout)" };
  if (!(flags.force && flags.discardUnsynced)) {
    return {
      action: "keep",
      note: "kept — a local studio's worktree IS its checkout; remove it only with --force --discard-unsynced",
    };
  }
  if (dirty) return { action: "keep", note: "kept — the worktree has uncommitted changes (--discard-unsynced was given, but dirty files are not unsynced commits)" };
  if (ahead) return { action: "keep", note: "kept — the worktree has unpushed commits; nothing is removed until they are pushed" };
  return { action: "remove", note: "clean and fully pushed — removing" };
}

/** `git -C <path> status --porcelain` non-empty -> dirty. Non-zero exit (git
 *  cannot read the tree) is treated as dirty — refusing to delete is the safe
 *  side, since the tree could not be proven clean. */
export async function gitIsDirty(run: GitRun, path: string): Promise<boolean> {
  const { code, stdout } = await run(["-C", path, "status", "--porcelain"]);
  if (code !== 0) return true;
  return stdout.trim() !== "";
}

/** `git -C <path> rev-list --count @{u}..` — how many commits are unpushed.
 *  `null` on a non-zero exit (no upstream configured, no remote, shallow
 *  clone): with no upstream to compare against, the count cannot be proven,
 *  so the caller must treat it as UNSYNCED and keep the tree — the dirty
 *  check is not the only thing standing between a local destroy and unpushed
 *  work. Fail closed, never "0 ahead". */
export async function gitAheadCount(run: GitRun, path: string): Promise<number | null> {
  const { code, stdout } = await run(["-C", path, "rev-list", "--count", "@{u}.."]);
  if (code !== 0) return null;
  const n = Number(stdout.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The destroy decision's injectable seam: WHICH path the dirty/ahead git
 *  reads target, and whether to remove. Every side effect is `deps`, so the
 *  decision is unit-testable over canned git outputs and a fake worktree-path
 *  resolver — no real Orca or git. */
export interface LocalWorktreeRemoval { remove: boolean; note: string | null }

/**
 * Fleet task #1248 review BLOCKER B1 (fix round): what `cmdDestroy`'s
 * teardown should do. Cloud (`status === null` or `status.host !== "local"`)
 * always removes — the cloud teardown runs unconditionally. Local resolves
 * the studio's ORCA worktree on-disk path via `deps.resolveWorktreePath(id)`
 * and reads `gitIsDirty`/`gitAheadCount` against THAT path, then feeds
 * `localTeardownDecision`. A null path keeps the worktree with a note, never
 * a silent remove.
 */
export async function localWorktreeRemoval(
  status: { host?: string; localPath?: string | null } | null,
  flags: { force: boolean; discardUnsynced: boolean; park: boolean },
  deps: { run: GitRun; resolveWorktreePath: (id: string) => Promise<string | null> },
  id: string,
): Promise<LocalWorktreeRemoval> {
  if (status === null || status.host !== "local") return { remove: true, note: null };
  const path = await deps.resolveWorktreePath(id);
  if (path === null) return { remove: false, note: "worktree path could not be resolved — kept" };
  const [dirty, ahead] = await Promise.all([gitIsDirty(deps.run, path), gitAheadCount(deps.run, path)]);
  // `null` = no upstream: the tree's commits are unsynced by definition, and
  // a local destroy must never remove work it cannot recreate. Folding it
  // into `unsynced` makes the decision keep the tree; the note below names
  // the no-upstream cause rather than the "unpushed commits" wording that
  // would wrongly imply there is an upstream to push to.
  const unsynced = ahead === null || ahead > 0;
  const decision = localTeardownDecision(flags, dirty, unsynced);
  if (decision.action === "remove") return { remove: true, note: decision.note };
  if (ahead === null && !dirty && flags.force && flags.discardUnsynced && !flags.park) {
    return { remove: false, note: "kept — the worktree has no upstream, so its commits are unsynced; --discard-unsynced never removes unpushed work" };
  }
  return { remove: false, note: decision.note };
}

/** `git rev-parse --show-toplevel` — the local clone's absolute path, used
 *  when `--local` was given without `--path`. Null (never a throw) when git
 *  cannot name one, and the caller refuses with a clear message. */
export async function resolveGitToplevel(run: GitRun = defaultGitRun()): Promise<string | null> {
  const { code, stdout, stderr } = await run(["rev-parse", "--show-toplevel"]);
  if (code !== 0) {
    console.error(`fleet: could not resolve the local clone: ${stderr.trim().split("\n")[0] || "git could not find a toplevel"}`);
    return null;
  }
  const toplevel = stdout.trim();
  return toplevel === "" ? null : toplevel;
}

/** The local clone's default branch — `git symbolic-ref refs/remotes/origin/HEAD`,
 *  falling back to `git remote show origin`'s HEAD line, then `git branch -r`.
 *  Returns the PLAIN branch name (never `origin/`), or null when none of the
 *  three can resolve it. The caller refuses with a clear message. When `cwd`
 *  is given, every git argv is prefixed with `-C <cwd>` — the default branch
 *  must come from the `--path` clone, not whatever repo this process happens
 *  to be standing in. */
export async function resolveDefaultBranch(run: GitRun = defaultGitRun(), cwd?: string): Promise<string | null> {
  const withCwd = (args: string[]): string[] => (cwd ? ["-C", cwd, ...args] : args);
  const tryRun = async (args: string[]): Promise<string | null> => {
    const { code, stdout } = await run(withCwd(args));
    if (code !== 0) return null;
    return stdout.trim();
  };
  const symbolic = await tryRun(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic) return symbolic.replace(/^refs\/remotes\/origin\//, "");
  // `git remote show origin` prints a "HEAD branch: main" line; the first
  // fallback for clones predating `refs/remotes/origin/HEAD` (git 1.8.4).
  const remoteShow = await tryRun(["remote", "show", "origin"]);
  const headLine = remoteShow?.split("\n").find((l) => l.trim().startsWith("HEAD branch:"));
  if (headLine) {
    const branch = headLine.trim().replace(/^HEAD branch:\s*/, "");
    if (branch !== "") return branch;
  }
  // `git branch -r` — the last fallback: the first origin/* entry. Ambiguous
  // for a repo with several branches, but it is the only remaining signal.
  const branchR = await tryRun(["branch", "-r"]);
  const firstRemote = branchR?.split("\n").map((l) => l.trim()).find((l) => l.startsWith("origin/") && !l.includes("HEAD"));
  if (firstRemote) return firstRemote.replace(/^origin\//, "");
  return null;
}

/**
 * Fleet task #1248 review BLOCKER B4: the clone's origin slug — `git -C <cwd>
 * remote get-url origin` through parseGitRemote (src/studio/repo.ts), the same
 * parser `detectRepo` already uses. Null when git cannot read the remote or it
 * is not a github.com repo. This is what lets spawnLocalStudio REFUSE a
 * `--path /other/clone` whose origin names a different repo than the target
 * slug: silently building a studio out of the wrong checkout is exactly the
 * silent-wrong-target failure this whole feature exists to remove.
 */
export async function resolveCloneOriginSlug(run: GitRun = defaultGitRun(), cwd?: string): Promise<string | null> {
  const args = cwd ? ["-C", cwd, "remote", "get-url", "origin"] : ["remote", "get-url", "origin"];
  const { code, stdout } = await run(args);
  if (code !== 0) return null;
  return parseGitRemote(stdout.trim());
}

/** The decoded local-spawn response: the row plus the bring-up env the route
 *  attaches (prompt/allowedTools/effort/members/skills/leadType). */
interface LocalSpawnResponse extends StudioStatus {
  prompt?: string;
  allowedTools?: string;
  effort?: string;
  members?: Record<string, string>;
  skills?: string;
  leadType?: "claude" | "glm";
  completionGate?: boolean;
}

/**
 * The shared local spawn+worktree flow, used by `fleet spawn --local`
 * (`cmdLocalSpawn`) and `ff --local`. Detects the repo (requireRepoForCreate
 * still applies — a cwd naming no repo with no `--repo` refuses), resolves
 * localPath (empty -> `git rev-parse --show-toplevel`) and the default branch,
 * POSTs /studio/local/spawn, then materializes the worktree via
 * ensureLocalStudioWorktree and prints the row. `opts.attach` decides the
 * final hand-off: `fleet spawn` never attaches (just opens the row),
 * `ff --local` attaches when this process has a real TTY.
 */
export async function spawnLocalStudio(
  creds: Credentials, role: string, newInstance: boolean,
  leadType: "claude" | "glm" | "kimi" | "deepseek" | undefined,
  repoFlag: string | undefined, localPath: string,
  opts: { cmd: string; attach: (id: string, materialized: boolean) => Promise<void>; task?: number | null },
): Promise<void> {
  const detected = await detectRepo();
  const r = requireRepoForCreate(opts.cmd, repoFlag, detected);
  if (!r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  console.error(repoFlag === undefined
    ? `${opts.cmd}: repo ${r.slug} (from git remote origin)`
    : `${opts.cmd}: target repo ${r.slug} (--repo)`);

  // --local without --path: the clone is the folder the operator is standing
  // in, so resolve it here rather than guessing.
  let resolvedPath = localPath;
  if (resolvedPath === "") {
    resolvedPath = (await resolveGitToplevel()) ?? "";
    if (resolvedPath === "") {
      console.error(`${opts.cmd}: --local needs a clone path — run inside the repo, or pass --path <abs>`);
      process.exit(1);
    }
  }
  // Fleet task #1248 review BLOCKER B4: every git read below must target the
  // RESOLVED clone (`-C <resolvedPath>`), never this process's own cwd — a
  // `--path /other/clone` used to read the base branch of whatever repo the
  // operator happened to be standing in (or fail outside one).
  const gitRun = defaultGitRun();
  const defaultBranch = await resolveDefaultBranch(gitRun, resolvedPath);
  if (defaultBranch === null) {
    console.error(`${opts.cmd}: could not resolve the default branch of ${r.slug} (git symbolic-ref refs/remotes/origin/HEAD) — ` +
      "fetch origin first, or re-run once the clone has a remote HEAD");
    process.exit(1);
  }
  // B4 (second half): the clone's origin must name the SAME repo this spawn
  // targets — a `--path /other/clone` whose origin is a different repo would
  // build a studio for `<target>` out of somebody else's checkout, silently.
  const cloneSlug = await resolveCloneOriginSlug(gitRun, resolvedPath);
  // Fail closed: a null slug (no GitHub origin, e.g. a gitlab remote) must
  // refuse, not skip — a local studio has to be built from the repo it
  // targets, and an unverifiable clone origin is a silent-wrong-target.
  if (cloneSlug === null || cloneSlug.toLowerCase() !== r.slug.toLowerCase()) {
    const originDesc = cloneSlug === null ? "no GitHub origin" : `origin ${cloneSlug}`;
    console.error(`${opts.cmd}: the clone at ${resolvedPath} has ${originDesc}, not ${r.slug} — ` +
      "a local studio must be built from the repo it targets; pass --path to the right clone");
    process.exit(1);
  }

  const res = await fetch(new URL("/studio/local/spawn", creds.workerUrl), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    // Same body shape cmdSpawn sends, plus the local identity the route's
    // readLocalRequest requires (`local: true`, `localPath`).
    body: JSON.stringify({
      role, repo: r.slug, local: true, localPath: resolvedPath,
      ...(newInstance ? { instance: "next" } : {}),
      ...(leadType === undefined ? {} : { leadType }),
      // The task NUMBER, never the brief text — the Worker reads the issue
      // itself and verifies it is assigned to the studio it is about to
      // build (the same rule the cloud spawn's `task` field follows).
      ...(opts.task == null ? {} : { task: opts.task }),
    }),
  });
  if (!res.ok) {
    console.error(`${opts.cmd}: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
    process.exit(1);
  }
  const body = (await res.json()) as LocalSpawnResponse;
  const spawned = parseStudioStatus(body);
  if (spawned === null) {
    console.error(`${opts.cmd}: answered 200 but the body was not a studio row`);
    process.exit(1);
  }
  const prompt = body.prompt ?? "";
  const allowedTools = body.allowedTools ?? "";
  if (prompt === "" || allowedTools === "") {
    console.error(`${opts.cmd}: the local-spawn route answered without prompt/allowedTools — cannot launch the lead`);
    process.exit(1);
  }
  console.error(`${opts.cmd}: repo ${r.slug} → ${spawned.id} (local)`);
  console.log(formatTable([spawned]));
  // The lead's Orca worktree + attach terminal, materialized from the local
  // clone. Best-effort-fail-safe (like openStudioRow), so a wedged Orca never
  // THROWS — but a local studio IS its Orca worktree (the Orca terminal is
  // the lead, there is no container fallback), so ANY non-"created" outcome —
  // skipped for no binary OR for a plain terminal with the binary on PATH
  // (TERM_PROGRAM not Orca), or failed — means the lead never materialized.
  // Reporting the row as "up" then is exactly the false up this feature
  // exists to prevent. The row is already registered; say so and exit
  // non-zero rather than proceeding to a success handoff over a lead that
  // never materialized.
  const orcaDeps = defaultOrcaDeps();
  const outcome = await ensureLocalStudioWorktree(spawned.id, orcaDeps, {
    localPath: resolvedPath,
    defaultBranch,
    prompt,
    allowedTools,
    ...(body.effort !== undefined ? { effort: body.effort } : {}),
    ...(body.members !== undefined ? { members: body.members } : {}),
    ...(typeof body.skills === "string" ? { skills: body.skills.split(",") } : {}),
    ...(body.completionGate !== undefined ? { completionGate: body.completionGate } : {}),
  });
  if (outcome.kind !== "created") {
    // `why` rides the two outcomes ensureLocalStudioWorktree can actually
    // produce here — skipped and failed; the "exists" kind in
    // WorkspaceOutcome belongs to ensureStudioWorkspace's reuse path and
    // never reaches a local spawn, so the bare-kind fallback below is
    // defensive-only and never runs.
    const why = outcome.kind === "skipped" || outcome.kind === "failed" ? outcome.why : outcome.kind;
    console.error(`${opts.cmd}: ${spawned.id} has no local lead — the Orca worktree did not materialize (${why})`);
    console.error(`  tear the registered row down with: fleet destroy ${spawned.id}`);
    process.exit(1);
  }
  // `ff --local` attaches (a local worktree boots claude directly, so there
  // is no provisioned-wait); `fleet spawn --local` just reports the row.
  // After the fatal check above, outcome.kind is always "created" — the lead
  // genuinely materialized — so the attach is handed a real worktree.
  await opts.attach(spawned.id, true);
}

async function cmdLocalSpawn(
  creds: Credentials, role: string, newInstance: boolean,
  leadType: "claude" | "glm" | "kimi" | "deepseek" | undefined,
  repoFlag: string | undefined, localPath: string,
): Promise<void> {
  await spawnLocalStudio(creds, role, newInstance, leadType, repoFlag, localPath, {
    cmd: "fleet spawn",
    attach: async () => {},
  });
}

/**
 * #1259 round 4 fix 4: `cmdProvision`'s local-resume branch POSTs once to
 * `/provision`, and that POST — routes.ts's own provision branch — already
 * flips the row's state to "running" (local-spawn.ts's `localRowStatus`)
 * before any of the checks that follow can run: their own data (localPath,
 * prompt/allowedTools, the clone's default branch, the materialized
 * worktree's outcome) only arrives IN that POST's response or afterward, so
 * none of them could ever run earlier. Every refusal past that point must
 * flip the row back to stopped itself — best-effort, through the SAME
 * `/destroy` route a local row's own teardown already uses (a synchronous
 * D1 flip for a `host:"local"` row, confirmed no container/task-gate
 * checks run for it — see routes.ts's destroy branch) — or the row is left
 * reading "running" with no lead behind it, and routes.ts's own `/provision`
 * then refuses the operator's very next retry with a 409 ("not stopped").
 *
 * `res.ok` is checked and reported distinctly (round 3 left this
 * unchecked): a flip-back that itself failed must say so, never be
 * silently assumed to have worked.
 */
async function flipLocalRowToStopped(creds: Credentials, id: string): Promise<void> {
  try {
    const res = await fetch(studioUrl(creds, id, destroyPath(false, false)), {
      method: "POST",
      headers: accessHeaders(creds),
    });
    if (!res.ok) {
      console.error(`fleet provision: ${id} could not be flipped back to stopped (${res.status}) — the row may still read "running" with no lead behind it`);
    }
  } catch (err) {
    console.error(`fleet provision: ${id} could not be flipped back to stopped — ${errText(err)}`);
  }
}

/**
 * Explicit provision — POST /studio/:id/provision (routes.ts's existing,
 * already-tested route; this command adds no new server-side behaviour, only
 * a direct way to call it without `fleet spawn`'s org-chart check, e.g. for
 * re-provisioning an existing studio or provisioning one the operator names
 * directly by id). The body carries at most the detected repo (P4a, see
 * below); routes.ts's own `req.json().catch(() => ({}))` reads `{}` and an
 * absent body identically, so neither shape means "blueprintRef override".
 */
async function cmdProvision(
  creds: Credentials, id: string, freshSession = false, cancelFreshSession = false, discardSession = false,
  forceMappedAccount = false, repoFlag?: string,
): Promise<void> {
  // Dynamic repo selection (P4a): unlike spawn, this command is ADDRESSED by
  // a studio id, and that id already names a repo segment. The detected repo
  // is sent only when the two agree — re-provisioning `websites--pilot`
  // while standing in the beta folder is an ordinary thing to do, and the
  // Worker (which refuses a repo that disagrees with the id) would reject
  // it. Sending nothing there is not a fallback to the default: the Worker
  // resolves a bodyless provision to whatever repo the studio is already
  // bound to.
  const detected = await detectRepo();
  // Issue #1229: provision is ADDRESSED by id — the id's own repo segment IS
  // the address — so a cwd that names no repo (and no --repo) stays a
  // legitimate bodyless provision: the Worker resolves it to the studio's
  // bound repo, never a guessed fallback. Only a malformed --repo is a
  // refusal here, unlike spawn where the id is DERIVED from the cwd and a
  // no-remote cwd means no target at all.
  const r = requireRepoForCreate("fleet provision", repoFlag, detected);
  if (repoFlag !== undefined && !r.ok) {
    console.error(r.message);
    process.exit(1);
  }
  // Board #21: the id's repo half is the FOLDED segment (repo.ts's
  // repoIdSegment), so a dotted repo only ever agrees with its own id through
  // that same fold — comparing the raw short name would make every
  // `fleet provision` inside a dotted repo send no repo at all.
  const idRepo = parseStudioId(id)?.repo ?? null;
  // Issue #1237 nit 1: an EXPLICIT --repo that disagrees with the id's segment
  // is a stated intent the Worker would 400 on — refuse it locally, naming
  // both, instead of silently dropping the flag into a bodyless provision. A
  // cwd-DETECTED repo that disagrees stays bodyless (the existing address-by-id
  // contract: the folder is not the operator's statement of the target).
  if (r.ok && repoFlag !== undefined && idRepo !== null) {
    const seg = repoIdSegment(r.slug.split("/")[1]);
    if (seg !== idRepo) {
      console.error(
        `fleet provision: --repo ${r.slug} does not match studio id repo segment "${idRepo}" — ` +
        "the id and the checkout would name different repos",
      );
      process.exit(1);
    }
  }
  const matchesId = r.ok
    ? (() => { const seg = repoIdSegment(r.slug.split("/")[1]); return seg !== null && seg === idRepo; })()
    : false;
  if (matchesId && r.ok) {
    console.error(repoFlag === undefined
      ? `fleet provision: repo ${r.slug} (from git remote origin)`
      : `fleet provision: target repo ${r.slug} (--repo)`);
  }
  // Issue #115: same query-string convention `?fresh-session=true` already
  // uses. cli-args.ts's own parsing already refuses both flags at once, so
  // at most one of freshSession/cancelFreshSession is ever true here.
  // Issue #231: `discardSession` rides alongside freshSession as a second
  // query param, never its own branch — it is meaningless without
  // freshSession also set, and cli-args.ts places no exclusivity on it.
  const provisionParams = new URLSearchParams();
  if (freshSession) provisionParams.set("fresh-session", "true");
  if (cancelFreshSession) provisionParams.set("no-fresh-session", "true");
  if (discardSession) provisionParams.set("discard-session", "true");
  // Issue #1074 ask 2: `--account mapped`, the same query-string convention
  // recycle's `?account=mapped` already uses (board task #131 ask 2).
  if (forceMappedAccount) provisionParams.set("account", "mapped");
  const provisionPath = provisionParams.size > 0 ? `/provision?${provisionParams.toString()}` : "/provision";
  const res = await fetch(studioUrl(creds, id, provisionPath), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify(matchesId && r.ok ? { repo: r.slug } : {}),
  });
  if (!res.ok) {
    console.error(repairFailureLine("provision", res.status, await res.text()));
    process.exit(1);
  }
  const body = (await res.json()) as LocalSpawnResponse;
  const studio = parseStudioStatus(body);
  if (studio === null) {
    // #1259 round 5 minor fix: `host` read directly off the still-unvalidated
    // body — the same trust level `body.localPath`/`body.prompt` already get
    // a few lines below once `studio` exists. A `host: "local"` answer tells
    // us flipping back IS safe (routes.ts's own synchronous D1 flip for a
    // local row runs no container/task-gate checks either way), even though
    // the row otherwise failed `parseStudioStatus`'s own id/state/error
    // checks. Any OTHER value (absent, a real cloud host, or `body` not even
    // an object) stays exactly as round 4 left it — NOT flipped back here,
    // because calling `/destroy` before `host` is known risks a real
    // cloud-container teardown if the row turns out non-local.
    if (typeof body === "object" && body !== null && (body as LocalSpawnResponse).host === "local") {
      await flipLocalRowToStopped(creds, id);
    }
    console.error("fleet provision: answered 200 but the body was not a studio row");
    process.exit(1);
  }
  console.log(formatTable([studio]));
  // Issue #305: stderr, like reportRepo — stdout stays the table.
  const provisionAccount = formatAccountResolution("fleet provision", studio);
  if (provisionAccount !== null) console.error(provisionAccount);
  // Fleet task #1259 item 7: a local row answers a local-spawn-shaped body —
  // the stopped local studio the operator is resuming. Re-materialize its Orca
  // worktree from the row's own localPath instead of opening a cloud sidebar row.
  if (studio.host === "local") {
    const localPath = body.localPath;
    if (typeof localPath !== "string" || localPath === "") {
      console.error("fleet provision: the local row answered without a localPath — cannot re-materialize the worktree");
      await flipLocalRowToStopped(creds, id);
      process.exit(1);
    }
    const prompt = body.prompt ?? "";
    const allowedTools = body.allowedTools ?? "";
    if (prompt === "" || allowedTools === "") {
      console.error("fleet provision: the local row answered without prompt/allowedTools — cannot launch the lead");
      await flipLocalRowToStopped(creds, id);
      process.exit(1);
    }
    const gitRun = defaultGitRun();
    const defaultBranch = await resolveDefaultBranch(gitRun, localPath);
    if (defaultBranch === null) {
      console.error("fleet provision: could not resolve the default branch of the local clone — cannot re-materialize the worktree");
      await flipLocalRowToStopped(creds, id);
      process.exit(1);
    }
    // Same origin rule as the spawn path: the clone the row names must be the
    // repo the studio is bound to, or a resume re-materializes the lead out of
    // somebody else's checkout (or a non-GitHub clone whose origin cannot be
    // verified at all).
    const cloneSlug = await resolveCloneOriginSlug(gitRun, localPath);
    const bound = (studio.repoSlug ?? "").toLowerCase();
    if (cloneSlug === null || cloneSlug.toLowerCase() !== bound) {
      const originDesc = cloneSlug === null ? "no GitHub origin" : `origin ${cloneSlug}`;
      // Fix 3 (#1259 round 3): `fleet provision` takes no `--path` flag at
      // all — that flag belongs to `fleet spawn --local --path <abs>`, the
      // ORIGINAL bring-up, not this resume. The real remedy here is fixing
      // the clone's own git remote, THEN re-running provision.
      //
      // #1259 round 4 fix 4: the hint used to end "...or destroy this row
      // and fleet spawn --local --path <the right clone>" — a dead end,
      // since `fleet destroy`'s default KEEPS the row (round 3's own
      // finding), so a respawn with the SAME id would 409 "studio exists"
      // (src/studio/spawn.ts). The flip-back below is exactly what makes
      // "fix the origin, then re-run fleet provision" the REAL remedy:
      // routes.ts's own `/provision` only resumes a `stopped` local row.
      console.error(`fleet provision: the clone at ${localPath} has ${originDesc}, not ${studio.repoSlug} — a local studio must be built from the repo it targets; fix the clone's origin (git -C ${localPath} remote set-url origin <url>), then re-run: fleet provision ${id}`);
      await flipLocalRowToStopped(creds, id);
      process.exit(1);
    }
    const outcome = await ensureLocalStudioWorktree(studio.id, defaultOrcaDeps(), {
      localPath,
      defaultBranch,
      prompt,
      allowedTools,
      ...(body.effort !== undefined ? { effort: body.effort } : {}),
      ...(body.members !== undefined ? { members: body.members } : {}),
      ...(typeof body.skills === "string" ? { skills: body.skills.split(",") } : {}),
      ...(body.completionGate !== undefined ? { completionGate: body.completionGate } : {}),
    });
    // Fix 2 (#1259 round 3): `ensureLocalStudioWorktree`'s resume-reuse branch
    // now also answers `{ kind: "exists" }` when a healthy attach terminal
    // already lived in the kept worktree (reconciled instead of duplicated) —
    // that is success too, the SAME as "created"; only "skipped"/"failed"
    // mean the lead never materialized.
    if (outcome.kind !== "created" && outcome.kind !== "exists") {
      const why = outcome.why;
      console.error(`fleet provision: ${studio.id} has no local lead — the Orca worktree did not materialize (${why})`);
      // #1259 round 5 minor fix: "skipped" means `ensureLocalStudioWorktree`
      // ran no orca call at all (not under Orca) — nothing about the row
      // itself is broken, and the flip-back right below already returns it
      // to "stopped" so a retry works. "Tear the registered row down" was
      // stale advice here (round 4's own fix already made the SAME call for
      // the origin-mismatch exit above): the real remedy is simply running
      // under Orca and re-provisioning, never destroying anything.
      if (outcome.kind === "skipped") {
        console.error(`  run under Orca, then re-run: fleet provision ${studio.id}`);
      } else {
        console.error(`  tear the registered row down with: fleet destroy ${studio.id}`);
      }
      await flipLocalRowToStopped(creds, id);
      process.exit(1);
    }
    // A local studio's Orca terminal IS its lead; there is no cloud sidebar row.
    return;
  }
  // Same rule as `fleet spawn`: this path also leaves a studio running, so it
  // also owes that studio a visible row in Orca's sidebar. Idempotent, so a
  // studio that already has one is not given a second.
  const rowTasks = await listStudioTasks(creds, studio.id);
  await openStudioRow(studio.id, rowTasks, defaultOrcaDeps());
}

/**
 * Recycle — POST /studio/:id/recycle (routes.ts). Root-cause fix for the
 * stranded-image bug: restart/provision alone can never get a new image onto
 * a studio once its container exists (Cloudflare keeps it on whatever image
 * it originally booted with — see src/studio/do.ts's recycle() doc comment),
 * so this destroys the container outright and re-provisions on the CURRENT
 * one. Same shape as cmdProvision just above, deliberately: no body — an
 * empty POST is all routes.ts's recycle branch accepts (it takes no
 * blueprintRef override, unlike provision).
 *
 * Board issue #133: the request is `requestRecycle`'s, not a bare fetch — it
 * carries a deadline and, when that deadline (or any other transport
 * failure) hits, it polls GET /studio/:id/status and reports the TRUE
 * outcome. Measured 2026-09-30: a recycle on a studio whose lead sat on a
 * limit modal never returned (killed after 15 min) even though the container
 * came back running — the same class of bug #203 already fixed for `fleet
 * destroy`. See cli/recycle-outcome.ts's own header.
 */
async function cmdRecycle(
  creds: Credentials, id: string, discardUnsynced: boolean, freshSession = false, forceMappedAccount = false,
): Promise<void> {
  // #96: without the flag, a container that cannot answer makes the Worker
  // refuse (409) and name the age of the snapshot a recycle would restore.
  // Issue #28: --fresh-session rides the same query string.
  // Board task #131 ask 2: --account mapped, same query-string convention.
  const q = [
    discardUnsynced ? "discard-unsynced=true" : "", freshSession ? "fresh-session=true" : "",
    forceMappedAccount ? "account=mapped" : "",
  ].filter(Boolean).join("&");
  const path = q ? `/recycle?${q}` : "/recycle";
  const report = await requestRecycle(
    { recycle: studioUrl(creds, id, path), status: studioUrl(creds, id, "/status") },
    accessHeaders(creds), id,
  );
  for (const line of report.lines) console.error(line);
  if (report.status) console.log(formatTable([report.status]));
  // ONLY on a confirmed outcome — a plain 200, or a poll that proved THIS
  // recycle's own bring-up landed. A report whose outcome this side could not
  // read must never claim the Orca sidebar/rescue-report work below, the
  // same rule cmdDestroy's own `report.teardown` gate follows for #203.
  if (report.kind === "ok" || report.kind === "timeout-provisioned") {
    // The decoder narrows the confirmed row before the Orca/rescue work
    // runs; a null decode leaves this side with no row to act on, so the
    // whole block is skipped — the report lines above and the exit code
    // below are untouched, the same posture an unconfirmed outcome takes.
    const studio = parseStudioStatus(report.status);
    if (studio !== null) {
      // Issue #39: the pre-destroy rescue, one line per worktree.
      for (const line of studio.rescueReport ?? []) console.log(`rescue: ${line}`);
      if (discardUnsynced) console.error(discardNote(id));
      // Same rule as `fleet spawn`: this path also leaves a studio running, so
      // it also owes that studio a visible row in Orca's sidebar. Idempotent,
      // so a studio that already has one is not given a second.
      const rowTasks = await listStudioTasks(creds, studio.id);
      await openStudioRow(studio.id, rowTasks, defaultOrcaDeps());
    }
  }
  if (report.exitCode !== 0) process.exit(report.exitCode);
}

/**
 * Destroy — POST /studio/:id/destroy (routes.ts). Board task #124: recycle
 * can never leave a studio stopped (it always reprovisions); this is the
 * verb that does. `force` maps straight onto `?force=true` — the ONLY thing
 * this route reads from the query string, and the only override this verb
 * takes at all (see routes.ts's own destroy branch for why that stays a
 * query param rather than a body, unlike provision's JSON body).
 *
 * A refusal (409, an open assigned board task) surfaces through the SAME
 * generic `!res.ok` branch every other verb here already uses — the
 * response body already carries the reason (routes.ts sends it as the whole
 * text body, not JSON, on that path), so there is nothing destroy-specific
 * to special-case here; the 409-vs-500 distinction only has to exist at the
 * route layer, which is what a caller actually needs to be told apart.
 *
 * Board issue #57: stopping the container is only HALF a teardown. The Orca
 * worktree and attach terminal `ensureStudioWorkspace` gave this studio (on
 * spawn/provision/recycle) survive the container stop and leave a sidebar
 * row visually identical to a live studio — `skills/fleet-cockpit/SKILL.md`
 * used to tell operators never to delete that worktree, with no exception
 * for one already destroyed, which is exactly how two coordinators produced
 * stale rows by following the docs correctly. So a destroy that stopped the
 * container now ALSO calls `closeStudioRow` — same injected `OrcaDeps`
 * `ensureStudioWorkspace` already uses, same best-effort posture: cleanup
 * runs only after the container is confirmed stopped, and any Orca-side
 * failure there degrades to one stderr line, never a non-zero exit for a
 * destroy that otherwise succeeded.
 */
async function cmdDestroy(
  creds: Credentials, id: string, force: boolean, discardUnsynced: boolean, park = false, strictUnmerged = false,
): Promise<void> {
  // Board issue #332: --strict-unmerged refuses CLIENT-side, BEFORE any
  // destroy request fires — a refusal that let the destroy through would
  // not be a refusal. The check asks the board's open-prs route for this
  // studio's unmerged PRs; a studio id that does not even parse is skipped
  // entirely (a malformed id never blocks a destroy — the route call below
  // refuses it its own way).
  if (strictUnmerged && parseStudioId(id) !== null) {
    // The route needs the studio's repo as `owner/name`, which the id's own
    // repo HALF cannot name (parseStudioId's segment is a folded id
    // segment, not a slug) — so the row is read bounded, the same status
    // read requestDestroy's own poll path already makes, and repoSlug is
    // the only client-side source of the full slug. A row that cannot be
    // read still asks the DEFAULT repo (a null repoParam below): a
    // default-repo studio keeps a real answer, any other reads as unknown.
    const row = await readStatus(
      studioUrl(creds, id, "/status"), accessHeaders(creds), fetch, DESTROY_STATUS_TIMEOUT_MS,
    );
    const answer = await fetchStudioOpenPrs(
      creds, row.ok ? row.status.repoSlug : null, id,
    );
    if (!answer.ok) {
      if (answer.unknown) {
        // #332 review H2: the scan ran and failed for THIS studio — refuse;
        // an unavailable route (the else) still proceeds loudly.
        console.error(STRICT_UNMERGED_UNKNOWN_SCAN);
        process.exit(1);
      }
      // Plan ruling: a 404/unavailable route is NOT evidence of zero PRs,
      // and blocking a destroy on a Worker upgrade race is worse than the
      // warning — strict degrades to proceeding, loudly.
      console.error(STRICT_UNMERGED_UNKNOWN_PROCEEDING);
    } else if (answer.prs.length > 0) {
      for (const line of strictRefusalLines(answer.prs)) console.error(line);
      process.exit(1);
    }
  }
  // Board task #203: the request is `requestDestroy`'s, not a bare fetch —
  // it carries a deadline and, when that deadline (or any other transport
  // failure) hits, it polls GET /studio/:id/status and reports the TRUE
  // outcome. Measured 2026-09-24: this side printed "The operation timed
  // out." for a destroy that had SUCCEEDED, and skipped the Orca teardown
  // below. See cli/destroy-outcome.ts's header.
  const report = await requestDestroy(
    { destroy: studioUrl(creds, id, destroyPath(force, discardUnsynced, park)), status: studioUrl(creds, id, "/status") },
    accessHeaders(creds), id,
  );
  for (const line of report.lines) console.error(line);
  if (report.status) console.log(formatTable([report.status]));
  // ONLY on a confirmed `stopped` row. A destroy whose outcome this side
  // could not read must never print a teardown line — an operator who reads
  // "Orca worktree and attach terminal removed" stops looking.
  if (report.teardown) {
    // Fleet task #1248 review BLOCKER B1: a LOCAL studio's Orca worktree IS
    // its checkout — `worktree rm --force` here would delete uncommitted/
    // unpushed work that lives nowhere else. The decision reads the git state
    // of the RESOLVED Orca worktree path (never the clone), so a clean clone
    // beside a dirty worktree is never removed. The CLOUD path (remove:true)
    // runs the SAME single closeStudioRow call it always did.
    const removal = await localWorktreeRemoval(report.status, { force, discardUnsynced, park },
      { run: defaultGitRun(), resolveWorktreePath: (sid) => resolveStudioWorktreePath(sid, defaultOrcaDeps()) }, id);
    if (removal.remove) {
      for (const line of await closeStudioRow(id, defaultOrcaDeps())) console.error(`fleet: ${line}`);
    } else if (removal.note !== null) {
      console.error(`fleet: ${id}: ${removal.note}`);
    }
    // Board issue #332: after a confirmed stop, the NON-BLOCKING warning —
    // the studio's unmerged PRs outlive its lane, and the registry row
    // still exists, so the route still answers for it. For a plain destroy
    // exactly as much as for --park: an unmerged, bounced PR needs this
    // lane's history alive either way. Never affects the exit code; a
    // malformed id skips the warning entirely (never blocked anything
    // either). The repo comes from the confirmed row this side already
    // holds — no extra round trip.
    if (parseStudioId(id) !== null) {
      const answer = await fetchStudioOpenPrs(creds, report.status?.repoSlug ?? null, id);
      if (!answer.ok) {
        // #332 review H2: the scan ran and failed for THIS studio — its own
        // line, never the route-unavailable one.
        console.error(answer.unknown ? PARK_WARNING_UNKNOWN_SCAN : PARK_WARNING_UNAVAILABLE);
      } else if (answer.prs.length > 0) {
        for (const line of parkWarningLines(id, answer.prs)) console.error(line);
      }
    }
  }
  if (report.exitCode !== 0) process.exit(report.exitCode);
}

// ---------------------------------------------------------------------------
// fleet task new | ls | show — P4 §5's board. GitHub Issues IS the board, so
// none of these commands owns any state of its own: each is one authenticated
// request to the Worker, which is the single writer, plus a print. The repo
// comes from the cwd's git remote — same rule as `fleet spawn`, since the
// board repo is the repo being worked, not always the fleet's own.

async function boardRequest(creds: Credentials, cmd: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(boardUrl(creds, path), {
    ...init,
    headers: { ...accessHeaders(creds), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    console.error(`${cmd}: ${res.status} ${(await res.text()).slice(0, 500)}`);
    process.exit(1);
  }
  return res.json();
}

/** `?repo=` for the read verbs. Absent when this folder names no GitHub repo
 *  — the Worker then falls back to the fleet's own, which is the single
 *  source of that fallback (this CLI never guesses one). */
function repoQuery(slug: string | null): string {
  return slug ? `?repo=${encodeURIComponent(slug)}` : "";
}

/** Board issue #41, and board issue #158: an assigning response carries a
 *  `wake` field on every successful assign or adopt — including a
 *  same-studio re-assign that lands no board write at all (#158's deliberate
 *  nudge to an idle lead). Printed rather than dropped: a studio that was
 *  given work and never heard about it is the whole of that issue. */
type AssignedTask = BoardTask & { wake?: AssignWakeReport; pathWarnings?: string[] };

async function reportAssignWake(task: AssignedTask): Promise<void> {
  const line = formatAssignWake(await resolveLocalWake(task.wake, task.assignee, task.number, defaultOrcaDeps()));
  if (line !== null) console.log(line);
}

/** Board issue #112 / #70 ask 8: one advisory line per path-claim overlap,
 *  printed the same way `reportRepo`'s own lines already are — stderr, since
 *  these are diagnostics for the human, not part of the table's stdout. */
function reportPathWarnings(task: AssignedTask): void {
  for (const w of task.pathWarnings ?? []) console.error(`fleet task new: ${w}`);
}

/** Board tasks assigned to one studio, for the Orca row title (board #39).
 *  Never throws and never blocks the command it decorates: a title is
 *  cosmetic, and a board that is slow or down must not fail a spawn, a
 *  provision or an attach. An empty list simply yields the `(idle)` title. */
export async function listStudioTasks(creds: Credentials, studioId: string): Promise<BoardTask[]> {
  try {
    const res = await fetch(boardUrl(creds, `/tasks?assignedTo=${encodeURIComponent(studioId)}`), {
      headers: accessHeaders(creds),
    });
    if (!res.ok) return [];
    return (await res.json()) as BoardTask[];
  } catch {
    return [];
  }
}

/** Issue #1245: the open sprint titles, for the sprint-required refusal.
 *  `null` means the `/sprints` read itself failed — the refusal still fires,
 *  but must not claim "no sprints are open" when it could not tell (a broken
 *  board must not silently pass a task that should have been refused, nor
 *  lie about why). */
async function openSprintTitles(creds: Credentials, repo: string | undefined): Promise<string[] | null> {
  const params = new URLSearchParams();
  if (repo !== undefined) params.set("repo", repo);
  try {
    const res = await fetch(boardUrl(creds, `/sprints?${params}`), { headers: accessHeaders(creds) });
    if (!res.ok) return null;
    const summaries = (await res.json()) as SprintSummary[];
    return summaries.map((s) => s.title);
  } catch {
    // A network error must print the refusal line, never a stack trace.
    return null;
  }
}

async function cmdTaskNew(
  creds: Credentials, brief: TaskBriefArgs, provision = false, freshSession = false,
): Promise<void> {
  const detected = await detectRepo();
  // Issue #278: an explicit `--repo` (brief.repo) overrides the CWD-detected
  // repo — same override-wins-over-detection precedence `fleet tabs`'s own
  // `--repo` already establishes (resolveTabsScope above). Detection stays
  // the default when `--repo` is absent, and "neither resolves" keeps
  // today's unchanged posture: no repo in the payload, the Worker falls back
  // to the fleet default (reportRepo's own "using the fleet's default repo"
  // branch) — task new has never refused for that case, and this fix does
  // not add a new refusal.
  if (brief.repo) {
    console.error(`fleet task new: target repo ${brief.repo} (--repo, overriding CWD detection)`);
  } else {
    reportRepo("fleet task new", detected);
  }
  const repo = brief.repo ?? detected.slug ?? undefined;
  // Issue #1245: a task files onto one sprint — or the backlog. Neither named
  // is refused before anything is filed, naming the open sprints so the
  // operator can pick one. The refusal is CLI-only: the Worker still accepts a
  // milestone-less brief (ff, the in-container verb, a phone-filed issue).
  if (brief.milestone === undefined && brief.backlog !== true) {
    const titles = await openSprintTitles(creds, repo);
    const hint = titles === null
      ? "could not read the open sprints (the board may be down)"
      : titles.length === 0
        ? "no sprints are open — `fleet sprint open \"<title>\" ...` first, or file with --backlog"
        : `open sprints: ${titles.map((t) => `"${t}"`).join(", ")}`;
    console.error(`fleet task new: --sprint is required (or --backlog) — ${hint}`);
    process.exit(1);
  }
  // Issue #139: one key per invocation; postTaskNew replays it on every retry,
  // and the Worker returns the issue an earlier attempt already filed.
  const key = crypto.randomUUID();
  const res = await postTaskNew((body) => fetch(boardUrl(creds, "/tasks"), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body,
  }), repo ? { ...brief, repo } : { ...brief }, key);
  if (!res.ok) {
    console.error(taskNewFailureLine(res.status, await res.text(), key));
    process.exit(1);
  }
  const task = (await res.json()) as AssignedTask;
  console.log(formatTaskTable([task]));
  await reportAssignWake(task);
  reportPathWarnings(task);
  if (brief.readRepos && task.assignee !== null) reportReadRepos("fleet task new", task.assignee, brief.readRepos);
  // Issue #113 ask 9: --provision boots or heals the assigned studio in the
  // same call, instead of leaving a filed task's "NO WAKE" (task-format.ts)
  // to a second, separate `fleet provision <id>` run. cli-args.ts's own
  // parse-time validation refuses --provision when the brief carries neither
  // --studio nor --continues, so `task.assignee === null` here should never
  // happen in practice — the check below is defensive against the Worker's
  // own assignment resolution (out of this CLI's control) disagreeing.
  if (provision) {
    if (task.assignee === null) {
      console.error("fleet task new --provision: task has no assignee — nothing to provision");
      process.exit(1);
    }
    await cmdProvision(creds, task.assignee, freshSession);
  }
}

async function cmdTaskLs(
  creds: Credentials, query: { milestone?: string; state?: string; assignedTo?: string; repo?: string },
): Promise<void> {
  const params = new URLSearchParams();
  // Issue #63: --repo wins. Else the cwd's remote; with none and --studio,
  // the Worker reads that studio's own repo (or refuses), never a guess.
  if (query.repo !== undefined) {
    console.error(`fleet task ls: target repo ${query.repo} (--repo, overriding CWD detection)`);
    params.set("repo", query.repo);
  } else {
    const detected = await detectRepo();
    if (detected.slug) console.error(`fleet task ls: target repo ${detected.slug} (from git remote origin)`);
    else if (query.assignedTo !== undefined) console.error(`fleet task ls: ${detected.reason} — using ${query.assignedTo}'s own repo`);
    else reportRepo("fleet task ls", detected);
    if (detected.slug) params.set("repo", detected.slug);
  }
  if (query.milestone !== undefined) params.set("milestone", query.milestone);
  if (query.state !== undefined) params.set("state", query.state);
  if (query.assignedTo !== undefined) params.set("assignedTo", query.assignedTo);
  const tasks = (await boardRequest(creds, "fleet task ls", `/tasks?${params.toString()}`)) as BoardTask[];
  console.log(formatTaskTable(tasks));
}

/**
 * `fleet task assign <n> <role>` — P5 §3's reassignment, Maestro's verb.
 *
 * Every write is the Worker's: it removes the old `studio:` label, adds the
 * new one, resets the state to `submitted`, and comments the lineage (from,
 * to, when, why). This side sends a number, a studio id and a reason. There is
 * deliberately no `gh issue edit` and no label call anywhere in this CLI —
 * Maestro decides, the Worker writes, and that is what keeps a merged PR from
 * leaving an issue claiming in-progress.
 *
 * Prior comments are untouched by construction: the board's port has no delete
 * verb at all. The dead studio's envelopes are the record of what it did, and
 * they outlive it.
 */
async function cmdTaskAssign(
  creds: Credentials, number: number, target: string, why: string | undefined,
  readRepos?: string[],
): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task assign", detected);
  // Issue #269: `studioIdForTarget` (src/studio/repo.ts) is the one place the
  // three target shapes — a bare role, `<role>--<k>`, and a full studio id —
  // become one id. A bare role still resolves exactly as it did through
  // `studioIdIn`, which is what this used to call directly.
  const studio = studioIdForTarget(detected.slug, target);
  if (!studio.ok) {
    console.error(`fleet task assign: ${studio.message}`);
    process.exit(1);
  }
  const task = (await boardRequest(creds, "fleet task assign", `/tasks/${number}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assignee: studio.id, ...(why === undefined ? {} : { why }),
      ...(readRepos === undefined ? {} : { readRepos }),
      ...(detected.slug ? { repo: detected.slug } : {}),
    }),
  })) as AssignedTask;
  console.log(formatTaskTable([task]));
  await reportAssignWake(task);
  if (readRepos && task.assignee !== null) reportReadRepos("fleet task assign", task.assignee, readRepos);
}

/** Issue #291: the grant lands on the studio's next credential refresh —
 *  provision/restart, or the 50-minute cycle — not instantly. */
function reportReadRepos(cmd: string, studio: string, repos: string[]): void {
  console.error(
    `${cmd}: read-only access for ${studio}: ${repos.join(", ")} — applies on its next credential refresh ` +
    `(\`fleet provision ${studio}\` applies it now)`,
  );
}

async function cmdTaskShow(creds: Credentials, number: number): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task show", detected);
  const view = (await boardRequest(
    creds, "fleet task show", `/tasks/${number}${repoQuery(detected.slug)}`,
  )) as { task: BoardTask; comments: TaskComment[] };
  console.log(formatTaskShow(view));
}

async function cmdSprintLs(creds: Credentials): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet sprint ls", detected);
  const summaries = (await boardRequest(creds, "fleet sprint ls", `/sprints${repoQuery(detected.slug)}`)) as SprintSummary[];
  console.log(formatSprintSummaries(summaries));
}

async function cmdSprintOpen(creds: Credentials, title: string, owner: string, goal: string): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet sprint open", detected);
  const res = (await boardRequest(creds, "fleet sprint open", "/sprints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, owner, goal, ...(detected.slug ? { repo: detected.slug } : {}) }),
  })) as { number: number; title: string };
  console.log(`opened sprint "${res.title}" (milestone #${res.number})`);
}

async function cmdSprintStatus(creds: Credentials, title: string | null): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet sprint status", detected);
  if (title === null) {
    const summaries = (await boardRequest(creds, "fleet sprint status", `/sprints${repoQuery(detected.slug)}`)) as SprintSummary[];
    console.log(formatSprintStatusLines(summaries));
    return;
  }
  const sprintParams = new URLSearchParams({ title });
  if (detected.slug) sprintParams.set("repo", detected.slug);
  const summaries = (await boardRequest(creds, "fleet sprint status", `/sprints?${sprintParams}`)) as SprintSummary[];
  const taskParams = new URLSearchParams({ milestone: title });
  if (detected.slug) taskParams.set("repo", detected.slug);
  const tasks = (await boardRequest(creds, "fleet sprint status", `/tasks?${taskParams}`)) as BoardTask[];
  console.log(formatSprintStatus(summaries[0], tasks));
}

async function cmdSprintClose(creds: Credentials, title: string): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet sprint close", detected);
  const res = (await boardRequest(creds, "fleet sprint close", "/sprints/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, ...(detected.slug ? { repo: detected.slug } : {}) }),
  })) as { movedToBacklog: number[]; closed: number[] };
  console.log(`sprint "${title}" closed — ${res.closed.length} completed closed, ${res.movedToBacklog.length} moved to backlog`);
}

/**
 * `fleet task verify <n>` — board task #119. POSTs to the Worker's own
 * `verify` route (src/board/verify.ts's attemptVerification), which reads
 * the newest §6 result envelope, mechanically re-checks its `verification`
 * block, and posts ONE classifying comment. This side does no checking of
 * its own — it only sends the repo (same detect-and-report convention every
 * other task command uses) and prints back what the Worker found.
 *
 * `boardRequest` already exits 1 on any non-ok response (including the
 * route's 404 when the task carries no result envelope yet), so that case
 * needs no special handling here.
 *
 * Exits 1 when any result verdict is attempted-failed — the same posture
 * every other check verb already has; not-mechanically-checkable is not a
 * failure.
 */
async function cmdTaskVerify(creds: Credentials, number: number): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task verify", detected);
  const result = (await boardRequest(creds, "fleet task verify", `/tasks/${number}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(detected.slug ? { repo: detected.slug } : {}),
  })) as { comment: { url: string }; envelopeMsgId: string; results: { label: string; verdict: string; detail: string }[] };

  const icon = (verdict: string) =>
    verdict === "attempted-ok" ? "✅" : verdict === "attempted-failed" ? "❌" : "➖";
  console.log(`fleet task verify #${number} — checking result envelope ${result.envelopeMsgId}:`);
  for (const r of result.results) console.log(`  ${icon(r.verdict)} ${r.verdict} — ${r.label}: ${r.detail}`);
  console.log(`comment: ${result.comment.url}`);
  // Failure must be visible from $?: not-mechanically-checkable is not one.
  if (result.results.some((r) => r.verdict === "attempted-failed")) process.exit(1);
}

/**
 * `fleet task message <n> "<text>"` — board issue #1077, item 2. The local twin
 * of the in-container verb: POSTs {text} and, when this folder names a repo,
 * `repo` in the body (the operator's writes read the board repo from the body,
 * issue #1106) to the Worker's message route, which writes one board comment
 * and wakes the task's one studio lead (src/board/task-message.ts). Prints the
 * comment and the wake outcome, so a refused wake (a stopped lead) is printed
 * as NO WAKE, never silent. A Worker refusal (a closed or finished task, 409)
 * exits 1 through boardRequest.
 */
async function cmdTaskMessage(creds: Credentials, number: number, text: string): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task message", detected);
  const result = (await boardRequest(creds, "fleet task message", `/tasks/${number}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(detected.slug ? { repo: detected.slug } : {}) }),
  })) as { comment: { url: string }; assignee: string; wake: AssignWakeReport };
  console.log(`task #${number} message posted: ${result.comment.url}`);
  const wake = formatAssignWake(await resolveLocalWake(result.wake, result.assignee, number, defaultOrcaDeps()));
  if (wake !== null) console.log(wake);
}

/**
 * `fleet task state <n> <to>` — board task #131. Real I/O for
 * src/studio/task-state.ts's `runTaskStateTransition`: `getCurrentState`
 * GETs the same task-show URL `cmdTaskShow` already calls and pulls out
 * `.task.state`; `transition` POSTs to the EXISTING `/tasks/<n>/state`
 * route (board.ts's transitionTask, untouched by this feature). Neither
 * uses `boardRequest` directly — that helper calls `process.exit(1)` on any
 * non-ok response, which would make a stale-`from` 409 unreachable for
 * `runTaskStateTransition` to surface verbatim; these return the tagged
 * `TaskStateFetchResult` instead, and `cmdTaskState` below is the one place
 * that decides whether to print and exit.
 */
async function taskStateFetchCurrent(
  creds: Credentials, number: number, repoSlug: string | null,
): Promise<TaskStateFetchResult> {
  const res = await fetch(boardUrl(creds, `/tasks/${number}${repoQuery(repoSlug)}`), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) return { ok: false, status: res.status, message: (await res.text()).slice(0, 500) };
  const view = (await res.json()) as { task: BoardTask };
  if (view.task.state === null) {
    return {
      ok: false, status: 409,
      message: `task #${number} carries no single board state label (labels: ${view.task.labels.join(", ") || "none"}) ` +
        "— there is no \"from\" this CLI can read to transition it safely. " +
        "If it has NO state label at all (an interrupted transition), repair it: " +
        `fleet task state ${number} <to> --from-none`,
    };
  }
  return { ok: true, state: view.task.state };
}

async function taskStateFetchTransition(
  creds: Credentials, number: number, from: string, to: string, repoSlug: string | null, noPr = false,
): Promise<TaskStateFetchResult> {
  const res = await fetch(boardUrl(creds, `/tasks/${number}/state`), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, ...(repoSlug ? { repo: repoSlug } : {}), ...(noPr ? { noPr: true } : {}) }),
  });
  if (!res.ok) return { ok: false, status: res.status, message: (await res.text()).slice(0, 500) };
  const task = (await res.json()) as BoardTask;
  if (task.state === null) {
    return {
      ok: false, status: 500,
      message: `task #${number}: the Worker wrote the transition but returned no single state label back`,
    };
  }
  return { ok: true, state: task.state };
}

/**
 * Prints the before -> after line on success; on failure prints the
 * surfaced message (unchanged — see task-state.ts's own doc comment) and
 * exits 1, the same posture `boardRequest` already establishes for every
 * other board verb in this file.
 */
async function cmdTaskState(creds: Credentials, number: number, to: BoardTaskState, fromNone = false, noPr = false): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task state", detected);

  const result = await runTaskStateTransition(
    {
      getCurrentState: (c, n) => taskStateFetchCurrent(c, n, detected.slug),
      transition: (c, n, from, toState) => taskStateFetchTransition(c, n, from, toState, detected.slug, noPr),
    },
    creds, number, to, { fromNone },
  );

  if (!result.ok) {
    console.error(`fleet task state: ${result.message}`);
    process.exit(1);
  }
  console.log(`task #${number}: ${result.from} -> ${result.to}`);
}

/**
 * `fleet task reap [--dry-run|--apply]` — board issue #8. One POST to the
 * Worker's own `/tasks/reap` route (src/board/routes.ts's
 * handleTaskReapRoute), which runs src/studio/task-reap.ts's pure
 * `runTaskReap` against real GitHub. This side does no computation of its
 * own — same detect-and-report repo convention every other task command
 * uses, then prints the report the Worker sent back. `boardRequest` already
 * exits 1 on any non-ok response, so that case needs no special handling
 * here. #546: the --terminal branch exits 1 when any close errored (the
 * terminal path's own failure word — it never goes through runTaskReap);
 * the non-terminal branch keeps its all-outcomes-on-stdout exit-0 shape —
 * which rows there count as run failures is the Worker's policy call, not
 * this print loop's.
 */
async function cmdTaskReap(creds: Credentials, apply: boolean, terminal = false): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task reap", detected);
  if (terminal) {
    // Issue #55: one page of closes per request; follow `remaining`.
    const t = await reapTerminalAll(async () => (await boardRequest(creds, "fleet task reap", "/tasks/reap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply, terminal: true, ...(detected.slug ? { repo: detected.slug } : {}) }),
    })) as TerminalPage);
    console.log(`fleet task reap --terminal ${t.apply ? "(--apply)" : "(dry-run)"} — ${t.repo}`);
    if (t.results.length === 0) console.log("  (no open issue in a terminal state)");
    for (const r of t.results) {
      console.log(`  #${r.number} (${r.state}): ${r.outcome} as ${r.reason}${r.error ? ` — ${r.error}` : ""}`);
    }
    if (t.remaining > 0) console.log(`  ${t.remaining} left: a page closed nothing; re-run after checking the errors above`);
    // #546 (S19-F2): a close that failed is a failure this run must not
    // report as success. Exit 1 when any row errored, mirroring rescue-all's
    // failures counter; would-close/closed/deliberate-skip rows stay 0. The
    // t.apply gate keeps dry runs 0 — a dry page only previews, and the
    // Worker's real dry path never mints "error" rows (the dry-run print
    // pin above feeds one in synthetically to cover the error line).
    if (t.apply && t.results.some((r) => r.outcome === "error")) process.exit(1);
    return;
  }
  const result = (await boardRequest(creds, "fleet task reap", "/tasks/reap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apply, ...(detected.slug ? { repo: detected.slug } : {}) }),
  })) as { repo: string; apply: boolean; defaultBranch: string; results: ReapOutcome[] };

  console.log(
    `fleet task reap ${result.apply ? "(--apply)" : "(dry-run)"} — ${result.repo} @ ${result.defaultBranch}`,
  );
  if (result.results.length === 0) {
    console.log("  (no open tasks)");
    return;
  }
  for (const r of result.results) {
    if (r.outcome === "failed") {
      console.log(`  #${r.taskNumber} (PR #${r.prNumber}): failed — ${r.reason}`);
    } else if (r.outcome === "skipped") {
      console.log(`  #${r.taskNumber}: skipped — ${r.reason}`);
    } else {
      console.log(`  #${r.taskNumber} (PR #${r.prNumber}): ${r.outcome} — ${r.sha.slice(0, 8)}`);
    }
  }
}

/**
 * `fleet task junior-sweep [--dry-run|--apply]` — issue #35. One POST to the
 * Worker's `/tasks/junior-sweep` route; same cwd repo convention as reap.
 */
async function cmdTaskJuniorSweep(creds: Credentials, apply: boolean): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task junior-sweep", detected);
  // Issue #41: the Worker sweeps one page per request; follow `next`.
  const result = await sweepAllPages(async (after) => (await boardRequest(creds, "fleet task junior-sweep", "/tasks/junior-sweep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apply, ...(detected.slug ? { repo: detected.slug } : {}), ...(after === null ? {} : { after }) }),
  })) as SweepPage);
  console.log(`fleet task junior-sweep ${result.apply ? "(--apply)" : "(dry-run)"} — ${result.repo}`);
  if (result.results.length === 0) {
    console.log("  (no junior records)");
    return;
  }
  for (const r of result.results) console.log(`  #${r.number}: ${r.outcome} — ${r.reason}`);
}

/**
 * `fleet rescue-gc [--older-than N] [--dry-run|--apply]` — issue #217. One
 * POST to the Worker's `/tasks/rescue-gc` route (src/board/routes.ts), which
 * runs src/studio/rescue-gc.ts's rule against real GitHub; this side only
 * picks the repo (same cwd convention as `fleet task reap`) and prints.
 */
async function cmdRescueGc(creds: Credentials, apply: boolean, olderThanDays: number): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet rescue-gc", detected);
  const result = (await boardRequest(creds, "fleet rescue-gc", "/tasks/rescue-gc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apply, olderThanDays, ...(detected.slug ? { repo: detected.slug } : {}) }),
  })) as { repo: string; apply: boolean; defaultBranch: string; olderThanDays: number; results: RescueGcOutcome[] };

  console.log(
    `fleet rescue-gc ${result.apply ? "(--apply)" : "(dry-run)"} — ${result.repo} @ ${result.defaultBranch}, older than ${result.olderThanDays} days`,
  );
  if (result.results.length === 0) {
    console.log("  (no fleet/rescue/* branches)");
    return;
  }
  for (const r of result.results) console.log(`  ${r.branch}: ${r.outcome} — ${r.reason}`);
}

/**
 * Issue #251: `fleet rescue-all [--repo R] [--dry-run]` — the pre-image-
 * deploy gate. An image rollout replaces EVERY studio's container with no
 * rescue mechanism running at all; this fans rescue-push out across the
 * fleet, right before that happens, so nothing is lost the way #251's own
 * incident was.
 *
 * NEVER execs against a stopped OR provisioning studio: an exec STARTS a
 * stopped one (#113 F1's own reason — `destroyStudio`'s `containerRunning`
 * gate takes the identical posture), and a provisioning one has no work of
 * its own yet. The filter here is `deps.listStudios()`'s own `state` field,
 * read straight from the registry — the SAME source `fleet ls` prints
 * without ever touching a container — never a live per-studio check.
 *
 * PR #263 round 2, C6: `state === "degraded"` IS exec'd, same as `"running"`
 * — a degraded studio (a failed refresh, a failed restart, a failover) still
 * runs a container that can hold real, uncommitted work; only the ROLLOUT
 * that eventually replaces it skips rescue entirely (docs/operations.md's
 * own "does not run the rescue push" warning), and this command exists
 * precisely to cover that gap. Every studio this filter excludes is printed
 * as `skipped
 * <id> (<state>)` — visible, never silent — in both the real run and
 * `--dry-run`.
 *
 * A registry state of "running"/"degraded" can still be stale by the time
 * the exec actually reaches the DO: `rescueStudio`'s own `{ ok: false, error:
 * "not running" }` (routes.ts -> do.ts's `rescueNow`, gated on
 * `ctx.container.running` — unchanged by this fix) means the container
 * itself answered "not running" without ever execing rescue-push. That is
 * reported as `skipped <id>: container not running`, exactly like a
 * state-filtered skip — never counted as a failed rescue attempt, and never
 * affects the exit code.
 */
/** Issue #266: `kind` says whether `files` is a real file count (a dirty
 *  tree) or a real commit count (a clean tree with unpushed commits) — see
 *  do.ts's RescuePushKind for the full reasoning. Every push this route ever
 *  reports comes from an actual RESCUE_PUSHED line, which always carries one. */
export interface RescueAllPush { branch: string; files: number; kind: "files" | "commits"; }
/** Issue #359: `timedOut` is set ONLY by this module's own client-side
 *  timeout race (below) — never by the server, which has no concept of it
 *  (do.ts's `rescueNow` always resolves `ok: true`/`ok: false` on its own).
 *  It distinguishes "no response ever reached the CLI" from a genuine
 *  `RESCUE_FAILED <wt> <step>` the server DID answer with — the former can
 *  never honestly name which rescue.ts step failed (no response arrived to
 *  read a step from); the latter already does, in `error`, unchanged. */
export type RescueAllOutcome =
  | { ok: true; pushes: RescueAllPush[]; worktrees?: RescueWorktree[] }
  | { ok: false; error: string; timedOut?: boolean; worktrees?: RescueWorktree[] };
export interface RescueAllDeps {
  listStudios: () => Promise<StudioStatus[]>;
  /** One rescue-push exec against a single RUNNING studio — never called
   *  for a studio this module's own filter did not already select. */
  rescueStudio: (id: string) => Promise<RescueAllOutcome>;
  log: (line: string) => void;
  /** Issue #20: stderr — carries the UNSAFE verdict. */
  error: (line: string) => void;
}
export interface RescueAllFlags {
  repo: string | null;
  dryRun: boolean;
  /** Issue #359: per-studio client-side budget — defaults to
   *  RESCUE_ALL_STUDIO_TIMEOUT_MS below. A test seam only; production never
   *  overrides it. */
  timeoutMs?: number;
  /** Fresh review of PR #359 round 2, Finding 3: how many targets' rescue
   *  execs may be in flight at once — defaults to
   *  RESCUE_ALL_CONCURRENCY_LIMIT below. A test seam only; production never
   *  overrides it. */
  concurrency?: number;
}

/**
 * Issue #359, measured live 2026-09-26: `rescue-all` had no client-side
 * timeout at all — a hung exec on one studio blocked that studio's own
 * `rescueStudio` call forever, invisible to the CLI (bounded only by
 * whatever the server's own exec deadline eventually enforced, which the
 * CLI never observes directly). Must be AT LEAST the server's own rescue
 * exec deadline (`EXEC_CLASSES.rescue.timeoutMs` in sandbox-api.ts — 300s)
 * plus that adapter's own `DEADLINE_SLACK_MS` margin (`KILL_GRACE_SECONDS *
 * 1000 + 2000` = 7s there) — a shorter client-side budget would report a
 * false TIMEOUT for a rescue that would have genuinely succeeded a few
 * seconds later. Not imported directly from sandbox-api.ts: that module
 * pulls in `@cloudflare/sandbox`'s own workerd-only `proxyTerminal` at load
 * time (see that file's own header comment on why), which this CLI binary
 * does not run under. 360s (6 minutes) gives ~53s of margin over the
 * server's own worst case (307s) for real HTTP/DO-wake overhead on top —
 * re-verify against sandbox-api.ts's own EXEC_CLASSES.rescue if that value
 * ever changes.
 */
export const RESCUE_ALL_STUDIO_TIMEOUT_MS = 360_000;

/** Issue #359: the one outcome shape every "no response arrived" path
 *  produces — the generic client-side race below AND cmdRescueAll's own
 *  real `AbortSignal.timeout` catch (defense in depth: the race guarantees
 *  the LOOP never hangs even if a fetch's own abort somehow didn't fire;
 *  the abort additionally frees the real underlying socket instead of
 *  leaving it dangling in the background). Deliberately never names a
 *  rescue.ts step — see RescueAllOutcome's own doc comment above for why. */
function rescueTimedOutOutcome(timeoutMs: number): RescueAllOutcome {
  return {
    ok: false,
    error: `timed out waiting for a response after ${Math.round(timeoutMs / 1000)}s ` +
      `(no response reached the CLI — the server may still be running rescue)`,
    timedOut: true,
  };
}

/** Races one studio's real `rescueStudio` call against `timeoutMs`. Never
 *  cancels the underlying call itself (a fake test double has nothing to
 *  cancel, and a real one is separately bounded by cmdRescueAll's own
 *  `AbortSignal.timeout` on the fetch) — only stops the CALLER from waiting
 *  on it past its own budget, exactly like sandbox-api.ts's `sbExec` already
 *  does for the Worker's own exec calls, one layer further out. */
async function rescueWithTimeout(
  rescueStudio: RescueAllDeps["rescueStudio"], id: string, timeoutMs: number,
): Promise<RescueAllOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RescueAllOutcome>((resolve) => {
    timer = setTimeout(() => resolve(rescueTimedOutOutcome(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([rescueStudio(id), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fresh review of PR #359 round 2, Finding 3: `runRescueAll` used to dispatch
 * EVERY target's exec/fetch at once (a bare `targets.map(...)`, no cap) — a
 * fleet with many studios could open dozens of simultaneous rescue execs at
 * once, each a real, resource-intensive server-side walk (worktrees,
 * branches, stashes). Capped at RESCUE_ALL_CONCURRENCY_LIMIT concurrent
 * targets, per the review's own suggested range (4–6). A small, manual
 * worker-pool (no library) — matches this codebase's own minimal-dependency
 * posture everywhere else (rescueWithTimeout above, withKillDeadline, etc.):
 * `limit` workers each pull the next unclaimed index off a shared cursor
 * until none remain, so at most `limit` calls to `worker` are ever in
 * flight at once, and a target's own failure inside `worker` (defensively
 * caught here too, beside the caller's own try/catch) never stops that
 * worker from moving on to its next target — the same "one rejection never
 * blocks another" guarantee `Promise.allSettled` already gave the old
 * unbounded dispatch.
 */
export const RESCUE_ALL_CONCURRENCY_LIMIT = 5;

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runOne(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch {
        // Defense in depth: `worker` below already catches everything it can
        // throw (rescueWithTimeout's own try/catch), but a failure here must
        // never stop this runner from picking up the NEXT target either way.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

/** Same fold every other repo/studio-id comparison in this codebase goes
 *  through (repo.ts's repoIdSegment) — never a raw slug/id compare. `null`
 *  means "no scope", not "match nothing": every running studio qualifies. */
function matchesRepoScope(id: string, repo: string | null): boolean {
  if (repo === null) return true;
  const segment = repoIdSegment(repo.split("/")[1] ?? repo);
  return segment !== null && parseStudioId(id)?.repo === segment;
}

/** The testable core: `--repo`/running-only selection, `--dry-run`'s report-
 *  only branch, and the exit code a pre-deploy script can gate on — every
 *  side effect (the list read, each rescue exec, each printed line) comes
 *  from `deps`, so this is provable against fakes without a live fleet. */
export async function runRescueAll(flags: RescueAllFlags, deps: RescueAllDeps): Promise<{ exitCode: number }> {
  const all = await deps.listStudios();
  const inScope = all.filter((s) => matchesRepoScope(s.id, flags.repo));
  // C6: running + degraded both run a container that can hold work;
  // stopped/provisioning never do — an exec against either would either
  // start a stopped container (#113 F1) or find nothing.
  const targets = inScope.filter((s) => s.state === "running" || s.state === "degraded");
  const outOfScope = inScope.filter((s) => s.state !== "running" && s.state !== "degraded");

  if (flags.dryRun) {
    for (const s of outOfScope) deps.log(`skipped  ${s.id} (${s.state})`);
    if (targets.length === 0) deps.log("fleet rescue-all (dry-run): no running studios in scope");
    for (const s of targets) deps.log(`would rescue  ${s.id}`);
    return { exitCode: 0 };
  }

  const timeoutMs = flags.timeoutMs ?? RESCUE_ALL_STUDIO_TIMEOUT_MS;
  const concurrency = flags.concurrency ?? RESCUE_ALL_CONCURRENCY_LIMIT;
  let failures = 0;
  // Issue #20: the verdict's own counts. `timedOut` is a subset of
  // `failures`; `notRunning` studios were never attempted.
  let timedOut = 0;
  let notRunning = 0;
  for (const s of outOfScope) deps.log(`skipped  ${s.id} (${s.state})`);
  if (targets.length === 0) deps.log("fleet rescue-all: no running studios in scope");
  // Issue #359, measured live 2026-09-26: this used to be a sequential
  // `for (const s of targets) { await deps.rescueStudio(s.id); ... }` — one
  // slow studio delayed every studio after it in the list, so a whole run's
  // wall time was the SUM of every studio's own duration, not the max of
  // them (an 8-studio run measured >15 minutes with no progress at all).
  // Dispatched CONCURRENTLY instead — up to `concurrency` at once
  // (`runLimited` above; fresh review of PR #359 round 2, Finding 3: an
  // earlier version of this fix dispatched EVERY target at once, unbounded)
  // — one studio's own rejection must never cancel every other studio's
  // still-running rescue or abort the batch's own settling, same guarantee
  // `Promise.allSettled` gave the unbounded version, preserved by
  // `runLimited`'s own try/catch around each `worker` call.
  // Each closure logs its own "rescuing" line the MOMENT it is dispatched
  // (synchronously, before its first `await`) — real per-studio progress for
  // an operator watching the RAW output live, unlike before (nothing printed
  // until the whole run finished) — and its own outcome line names how long
  // it took. Fresh review of PR #359 round 2: piping that output through
  // `| tail` specifically defeats this fix — `tail` buffers and prints
  // nothing until the piped command reaches EOF (the whole run finishing),
  // exactly like the "no progress" symptom this fix exists to close; this
  // progress-line fix only helps a plain, unpiped `fleet rescue-all`.
  // `failures` is a shared counter mutated from several of these closures;
  // safe without a lock because JS is single-threaded — only one of them
  // ever runs between any two `await`s.
  await runLimited(targets, concurrency, async (s) => {
    const startedAt = Date.now();
    deps.log(`rescuing  ${s.id}...`);
    let outcome: RescueAllOutcome;
    try {
      outcome = await rescueWithTimeout(deps.rescueStudio, s.id, timeoutMs);
    } catch (err) {
      outcome = { ok: false, error: errText(err) };
    }
    const elapsed = `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`;
    if (!outcome.ok) {
      // The registry's state can be stale by the time the exec reaches the
      // DO — its own `ctx.container.running` gate answered first. That is a
      // skip, not a failure: nothing was attempted, nothing was lost.
      if (outcome.error === "not running") {
        notRunning++;
        deps.log(`skipped  ${s.id}: container not running ${elapsed}`);
      } else if (outcome.timedOut) {
        // Issue #359: a distinct TIMEOUT verdict, never folded into FAILED —
        // the operator needs to know "this one was slow/stuck" (server may
        // still be working) apart from "this one had a real git error"
        // (RESCUE_FAILED, already named in `error` on the FAILED branch
        // below). Still counts toward the same non-zero-exit contract.
        failures++;
        timedOut++;
        deps.log(`TIMEOUT  ${s.id}: ${outcome.error} ${elapsed}`);
      } else {
        failures++;
        deps.log(`FAILED   ${s.id}: ${outcome.error} ${elapsed}`);
      }
    } else if (outcome.pushes.length === 0) {
      deps.log(`clean    ${s.id}: nothing to rescue ${elapsed}`);
    } else {
      // Issue #266: the label matches what was actually counted — "3 files"
      // for a dirty-tree rescue, "3 commits" for a clean-but-unpushed one.
      for (const p of outcome.pushes) deps.log(`rescued  ${s.id}: ${p.branch} (${p.files} ${p.kind}) ${elapsed}`);
    }
    // Issue #39: then one line per worktree, success or confirmed failure.
    for (const line of formatRescueReport(outcome.worktrees ?? [])) deps.log(`  ${s.id}  ${line}`);
  });
  // Issue #20: exit 1 alone was easy to miss (and `&&` was the whole gate).
  // One verdict line, in words, last.
  // Denominator = studios attempted (a "container not running" skip is not
  // one); a push failure and a timeout are named apart.
  if (failures > 0) {
    const attempted = targets.length - notRunning;
    const count = `${failures}/${attempted} attempted studios not rescued`;
    const kinds = `${failures - timedOut} push FAILED, ${timedOut} TIMED OUT`;
    let what = `${count} (${kinds})`;
    if (failures === attempted) {
      const every = timedOut === 0 ? "every push failed" : timedOut === failures ? "every rescue timed out" : "no studio rescued";
      what = `${every} (${count}: ${kinds})`;
    }
    deps.error(`fleet rescue-all: ${what} -- pre-deploy gate UNSAFE; do NOT deploy`);
    return { exitCode: 1 };
  }
  deps.log("fleet rescue-all: no failures -- pre-deploy gate SAFE");
  return { exitCode: 0 };
}

/**
 * Fresh review of PR #359 round 2, Finding 1 (most severe): Bun's OWN `fetch`
 * carries a HARDCODED, non-configurable ~300s connection ceiling that
 * `AbortSignal.timeout` alone does NOT extend or override — confirmed LIVE
 * against a real local HTTP server (its own idle timeout disabled) that
 * delayed its response past 300s: a fetch with `signal:
 * AbortSignal.timeout(310_000)` and no `timeout` field still died at
 * ~300005ms with `TimeoutError`, discarding a real response that would have
 * landed at 305000ms. The IDENTICAL call with `timeout: false` added waited
 * the full ~305000ms and returned the real response. This means
 * RESCUE_ALL_STUDIO_TIMEOUT_MS (360s, deliberately longer than the server's
 * own ~307s worst case) was NEVER actually honored by the real fetch below —
 * Bun's own ~300s ceiling fired first, every time, discarding the server's
 * real `RESCUE_FAILED <wt> <step>` answer (which would have landed within
 * its own ~307s budget, comfortably inside our intended 360s) and reporting
 * an opaque client-side TIMEOUT instead.
 *
 * `timeout: false` disables Bun's own ceiling; the caller's own `signal`
 * then becomes the SOLE timeout authority — this is genuinely undocumented
 * in Bun's own shipped TypeScript types (`BunFetchRequestInit`, bun-types)
 * even though the reviewer's/this fix's own live measurement confirms it is
 * real, respected runtime behavior. `rescueFetchInit` is a plain function
 * (not an inline object literal at the `fetch()` call site) specifically so
 * this extra, undeclared property passes TypeScript's structural typing
 * without a cast — `bun run check`'s own excess-property check only fires
 * against a FRESH object literal at the expected-type call site, never
 * against a function's return value.
 *
 * A literal 300+ second live test is impractical to run in this suite (see
 * test/bun/rescue-all-fetch-timeout.test.ts's own header for exactly what
 * WAS and was not directly re-provable at CI speed).
 */
export function rescueFetchInit(headers: Record<string, string>, timeoutMs: number) {
  return { method: "POST", headers, timeout: false, signal: AbortSignal.timeout(timeoutMs) };
}

/** Real wiring: `deps.listStudios` is the SAME GET /studio/ route `fleet
 *  ls`/onboard already call; `deps.rescueStudio` is one POST /studio/:id/rescue
 *  (routes.ts, do.ts's `rescueNow`) per selected studio.
 *
 * Issue #359: the fetch itself carries `AbortSignal.timeout` (the same
 * convention destroy-outcome.ts's `requestDestroy` and inspect-request.ts
 * already use for exactly this reason) so a genuinely stalled connection is
 * actually aborted — freeing the real underlying socket — rather than left
 * dangling in the background forever. `runRescueAll`'s own generic race
 * (above) is a SEPARATE, redundant guarantee that the per-studio loop itself
 * never hangs even if this abort somehow didn't fire; both use the same
 * `timeoutMs` budget, so in the ordinary case they fire together.
 *
 * Fresh review round 2, Finding 1: `rescueFetchInit` (above) additionally
 * disables Bun's own hardcoded fetch ceiling — see that function's own doc
 * comment for the full live-measured story.
 *
 * Fresh review round 2, Blocker 2 (this fix): `rescueFetchInit`'s OWN unit
 * tests (test/bun/rescue-all-fetch-timeout.test.ts) proved nothing about
 * whether THIS call site actually uses it — an inline object literal built
 * here instead (dropping `timeout: false` silently, e.g. by a future edit
 * that didn't know why it mattered) would leave every existing test green,
 * since none of them exercised this real fetch call at all. Exported (was
 * previously module-private) so a test can call it directly with a
 * monkeypatched `globalThis.fetch` and inspect the actual init object this
 * line constructs — the same "spy on the real dependency, call the real
 * production function" seam this codebase already uses for `fileTask`
 * (cli/ff.ts, test/bun/ff-file-task-retry.test.ts). */
export async function cmdRescueAll(creds: Credentials, flags: RescueAllFlags): Promise<void> {
  const timeoutMs = flags.timeoutMs ?? RESCUE_ALL_STUDIO_TIMEOUT_MS;
  const { exitCode } = await runRescueAll(flags, {
    listStudios: () => onboardListStudios(creds),
    rescueStudio: async (id: string) => {
      let res: Response;
      try {
        res = await fetch(studioUrl(creds, id, "/rescue"), rescueFetchInit(accessHeaders(creds), timeoutMs));
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") return rescueTimedOutOutcome(timeoutMs);
        return { ok: false, error: errText(err) };
      }
      if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}` };
      return (await res.json()) as RescueAllOutcome;
    },
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
  if (exitCode !== 0) process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// fleet reap — issue #53. Policy lives in cli/reap.ts; this is the wiring.

/** Where reap keeps its backoff, stall-alarm and board-floor memory. */
const REAP_STATE_PATH = join(homedir(), ".fleet", "reap-state.json");

/** Review F1: every plain read reap makes is bounded. A hung read must never
 *  sit between the last live read and a destroy, nor stall a poll. Issue
 *  #1117: 20 s timed out on a big repo's board listing (~25 s), so no nudge
 *  fired. `--read-timeout` overrides it. */
const REAP_READ_TIMEOUT_MS = 60_000;
/** `--nudge` (issue #1098): one assign call, whose wake the Worker runs. */
const REAP_NUDGE_TIMEOUT_MS = 60_000;
/** A lock file older than this is a crashed run's, and is taken over. */
export const REAP_LOCK_STALE_MS = 15 * 60_000;

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { headers: { ...headers, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
  return res.json();
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

function isStringListMap(v: unknown): v is Record<string, string[]> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && Object.values(v).every((x) => Array.isArray(x) && x.every((y) => typeof y === "string"));
}

function isCountMap(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && Object.values(v).every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0);
}

/** Review F5: the state file's exact shape, or null. Absent maps are fine
 *  (older file); present-but-wrong is not. */
function parseReapState(raw: string): ReapState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const out = emptyReapState();
  if (p.backoffUntil !== undefined) { if (!isStringMap(p.backoffUntil)) return null; out.backoffUntil = p.backoffUntil; }
  if (p.stallAlarmAt !== undefined) { if (!isStringMap(p.stallAlarmAt)) return null; out.stallAlarmAt = p.stallAlarmAt; }
  if (p.boardRows !== undefined) { if (!isCountMap(p.boardRows)) return null; out.boardRows = p.boardRows; }
  if (p.refusals !== undefined) { if (!isCountMap(p.refusals)) return null; out.refusals = p.refusals; }
  if (p.nudgedAt !== undefined) { if (!isStringMap(p.nudgedAt)) return null; out.nudgedAt = p.nudgedAt; }
  if (p.taskNudges !== undefined) { if (!isStringListMap(p.taskNudges)) return null; out.taskNudges = p.taskNudges; }
  return out;
}

/**
 * The real `ReapDeps`: the SAME routes `fleet ls`, `fleet task ls --studio`,
 * `fleet rescue-all`, `fleet inspect` and `fleet destroy` already call. The
 * destroy is `destroyPath(false, false)` by construction — reap never
 * passes --force or --discard-unsynced. Exported for the wiring test.
 */
export function reapDeps(
  creds: Credentials, repo: string, statePath: string, log: (line: string) => void,
  orcaDeps: OrcaDeps = defaultOrcaDeps(),
  opts: { readTimeoutMs?: number } = {},
): ReapDeps {
  const headers = accessHeaders(creds);
  const repoQ = `repo=${encodeURIComponent(repo)}`;
  const readMs = opts.readTimeoutMs ?? REAP_READ_TIMEOUT_MS;
  // Issue #1117: every board read logs its elapsed ms, ok or failed, so a slow
  // listing is visible before it times out.
  const boardRead = async (path: string) => {
    const started = Date.now();
    try {
      const body = await fetchJson(boardUrl(creds, path), headers, readMs);
      log(`fleet reap: board read ${Date.now() - started} ms`);
      return body;
    } catch (err) {
      log(`fleet reap: board read ${Date.now() - started} ms (failed)`);
      throw err;
    }
  };
  return {
    now: () => new Date(),
    listStudios: async () => {
      const body = await fetchJson(new URL("/studio/", creds.workerUrl).toString(), headers, readMs);
      const studios = parseStudioStatusArray(body);
      if (studios === null) throw new Error("studio listing was not studio rows");
      return studios;
    },
    listBoard: async () => {
      const body = await boardRead(`/tasks?${repoQ}&open=1`);
      if (!Array.isArray(body)) throw new Error("board listing was not a JSON array");
      return body as BoardTask[];
    },
    boardTotal: async () => {
      const body = await boardRead(`/tasks/count?${repoQ}`);
      if (typeof body !== "object" || body === null || Array.isArray(body) || typeof (body as { count?: unknown }).count !== "number") {
        throw new Error("board count was not { count: number }");
      }
      return (body as { count: number }).count;
    },
    studioTasks: async (id) => {
      const body = await boardRead(`/tasks?${repoQ}&open=1&assignedTo=${encodeURIComponent(id)}`);
      if (!Array.isArray(body)) throw new Error("task listing was not a JSON array");
      return body as BoardTask[];
    },
    inspect: async (id) => {
      // Bounded at the core's own live-read budget: a later answer is refused anyway.
      const out = await requestInspect(studioUrl(creds, id, "/inspect"), headers, { timeoutMs: REAP_LIVE_READ_MAX_MS });
      if (!out.ok) return { ok: false, message: out.message };
      const body = out.body as Partial<InspectBody> & { ok?: boolean; error?: string; observed?: Observed };
      if (body.ok !== true || typeof body.tail !== "string") return { ok: false, message: body.error ?? "inspect answered not ok" };
      return {
        ok: true, tail: body.tail,
        capturedAt: typeof body.capturedAt === "number" ? body.capturedAt : null,
        activity: body.observed?.activity ?? null,
      };
    },
    rescue: async (id) => {
      try {
        const res = await fetch(studioUrl(creds, id, "/rescue"), rescueFetchInit(headers, RESCUE_ALL_STUDIO_TIMEOUT_MS));
        if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}` };
        const outcome = (await res.json()) as RescueAllOutcome;
        return outcome.ok === true ? { ok: true } : { ok: false, error: outcome.error ?? "rescue answered not ok" };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    },
    destroy: async (id) => {
      const report = await requestDestroy(
        { destroy: studioUrl(creds, id, destroyPath(false, false)), status: studioUrl(creds, id, "/status") }, headers, id,
      );
      // Issue #86: not "destroyed" -> read the row once. Stopped, or another
      // destroy in flight, means this one raced an operator's: success.
      let race: "already-stopped" | "in-progress" | null = null;
      if (report.status?.state !== "stopped") {
        const row = await readStatus(studioUrl(creds, id, "/status"), headers, fetch, DESTROY_STATUS_TIMEOUT_MS);
        race = row.ok ? destroyRaceOutcome(row.status as StudioStatus & { destroyInFlight?: boolean }) : null;
      }
      if (race === null) for (const line of report.lines) log(`  ${id}  ${line}`);
      if (report.teardown || race === "already-stopped") {
        for (const line of await closeStudioRow(id, orcaDeps)) log(`  ${id}  ${line}`);
      }
      if (report.status?.state === "stopped") return { outcome: "destroyed" };
      if (race !== null) return { outcome: race };
      return { outcome: report.kind === "http-error" ? "refused" : "unknown", message: report.lines.join(" ") || report.kind };
    },
    // Issue #1098, review #1103: the lead's own wake (the same route the
    // maestro and the sweep use), with zero board writes. A `task assign` on a
    // working task would reset it to submitted and write a comment.
    nudge: async (id, taskNumber) => {
      const res = await fetch(studioUrl(creds, id, "/wake"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `continue task #${taskNumber}; check your todo list` }),
        signal: AbortSignal.timeout(REAP_NUDGE_TIMEOUT_MS),
      });
      if (!res.ok) return { woke: false, reason: `${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}` };
      const out = (await res.json()) as { ok?: boolean; error?: string };
      return out.ok === true ? { woke: true } : { woke: false, reason: out.error ?? "wake refused" };
    },
    loadState: async () => {
      let raw: string;
      try {
        raw = await readFile(statePath, "utf8");
      } catch {
        return emptyReapState();
      }
      const state = parseReapState(raw);
      if (state) return state;
      // Kept aside, never silently overwritten: the operator can read it.
      const aside = `${statePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(statePath, aside);
      throw new Error(`state file was corrupt or the wrong shape; kept aside at ${aside}`);
    },
    saveState: async (state) => {
      await mkdir(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2));
      await rename(tmp, statePath);
    },
    log,
  };
}

const execFileP = promisify(execFile);

/** Issue #1115: a process's start time (`ps -o lstart=`), or null when it
 *  cannot be read (no such pid, no ps). Pairs with the pid in the lock so a
 *  reused pid reads as a different process. */
async function processStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Issue #1115: is the lock's holder gone? `dead` only when the pid is gone
 *  (ESRCH) or its start time no longer matches the one the lock recorded.
 *  Anything it cannot prove (no recorded start time, ps unreadable) is
 *  `unsure`, and the caller keeps the age rule: unsure refuses while fresh. */
async function lockHolderState(pid: number, recordedStart: string | null): Promise<"dead" | "live" | "unsure"> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return "dead";
  }
  if (recordedStart === null) return "unsure";
  const now = await processStartTime(pid);
  if (now === null) return "unsure";
  return now === recordedStart ? "live" : "dead";
}

/** Review F5: one reap per state file at a time. The lock is an exclusively
 *  created file; a second run refuses rather than racing the state or the
 *  destroys. A lock older than REAP_LOCK_STALE_MS (a crashed run) is taken over.
 *  Issue #1115: the lock names its holder (`pid time start-time`). A dead
 *  holder is reclaimed at once, with one log line; a live one refuses as before.
 *  A SIGINT/SIGTERM during the run removes the lock before the process exits.
 *  `fn` gets `refresh`, which re-stamps the lock's mtime: runReap calls it once
 *  per candidate (ReapDeps.heartbeat), so a live run with several candidates
 *  never looks stale — only a run that stopped refreshing does. */
export async function withReapLock<T>(
  statePath: string,
  fn: (refresh: () => Promise<void>) => Promise<T>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<T> {
  const lock = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  const ownStart = await processStartTime(process.pid);
  const body = `${process.pid} ${new Date().toISOString()}${ownStart ? ` ${ownStart}` : ""}\n`;
  const take = () => writeFile(lock, body, { flag: "wx" });
  try {
    await take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const [, pidText, recordedStart] = /^(\d+) \S+(?: (.+))?$/.exec((await readFile(lock, "utf8")).trim()) ?? [];
    const holderPid = pidText ? Number(pidText) : NaN;
    const holder = Number.isInteger(holderPid) && holderPid > 0
      ? await lockHolderState(holderPid, recordedStart ?? null)
      : "unsure";
    if (holder === "dead") {
      log(`reclaimed reap lock from dead pid ${holderPid}`);
    } else {
      const age = Date.now() - (await stat(lock)).mtimeMs;
      if (age < REAP_LOCK_STALE_MS) {
        throw new Error(`another fleet reap holds ${lock} (${Math.round(age / 1000)}s old); refusing to run alongside it`);
      }
    }
    await unlink(lock);
    await take();
  }
  const refresh = async () => {
    const now = new Date();
    await utimes(lock, now, now);
  };
  // A signal's default action would skip `finally`, so the lock is removed
  // here, synchronously, and the process exits with the shell's 128+N code.
  const onSignal = (signal: NodeJS.Signals) => {
    try { unlinkSync(lock); } catch { /* already gone */ }
    process.exit(128 + osConstants.signals[signal]);
  };
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  try {
    return await fn(refresh);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    await unlink(lock).catch(() => {});
  }
}

async function cmdReap(
  creds: Credentials, flags: Omit<ReapFlags, "repo"> & { repo: string | null; readTimeoutMs: number },
): Promise<void> {
  let repo = flags.repo;
  if (repo === null) {
    const detected = await detectRepo();
    reportRepo("fleet reap", detected);
    repo = detected.slug;
  }
  if (!repo) {
    console.error("fleet reap: no repo — stand in a repo checkout or pass --repo owner/name. Never fleet-wide.");
    process.exit(1);
  }
  const { readTimeoutMs, ...reapFlags } = flags;
  const { exitCode } = await withReapLock(REAP_STATE_PATH, (refresh) =>
    runReap({ ...reapFlags, repo }, {
      ...reapDeps(creds, repo, REAP_STATE_PATH, (l) => console.log(l), undefined, { readTimeoutMs }),
      heartbeat: refresh,
    }));
  if (exitCode !== 0) process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// paste upload — shared by `fleet paste` and attach's ctrl-v intercept.
// pngpaste only ever produces PNG, so Content-Type is fixed.

async function uploadPaste(creds: Credentials, id: string, bytes: Uint8Array): Promise<string> {
  const res = await fetch(studioUrl(creds, id, "/paste"), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "image/png" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`paste upload failed: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
  const body = (await res.json()) as { path: string };
  return body.path;
}

/**
 * `fleet memory ls` — P5 §9's survey. Read-only, and the read an agent does
 * BEFORE proposing anything: it shows the measured citation count, age and
 * verdict per memory file, which is exactly what the Worker will check a
 * proposal against.
 */
async function cmdMemoryLs(creds: Credentials): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet memory ls", detected);
  const res = await fetch(memoryUrl(creds, repoQuery(detected.slug)), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`fleet memory ls: ${res.status} ${(await res.text()).slice(0, 500)}`);
    process.exit(1);
  }
  // Issue #548 (sweep 19 F5): a wrong-shaped or non-JSON 200 must die with
  // this command's own named line like every sibling read verb (cmdLs:
  // parseStudioStatusArray, fleet.ts:892-896), not as a TypeError thrown
  // into main()'s generic catch.
  let body: {
    repo: string; ref: string; index: { title: string }[]; unindexed: string[]; files: MemoryFileRow[];
    truncated: boolean;
  };
  try {
    const raw: unknown = await res.json();
    if (typeof raw !== "object" || raw === null) throw new Error();
    const r = raw as Record<string, unknown>;
    if (typeof r.repo !== "string" || typeof r.ref !== "string") throw new Error();
    if (!Array.isArray(r.index) || !Array.isArray(r.unindexed) || !Array.isArray(r.files)) throw new Error();
    // Review round 1: files rows are checked to the depth the table
    // renderer dereferences — target — the other row fields only print.
    if (!r.files.every((f) => typeof f === "object" && f !== null && typeof (f as Record<string, unknown>).target === "string")) throw new Error();
    if (typeof r.truncated !== "boolean") throw new Error();
    body = r as typeof body;
  } catch {
    console.error("fleet memory ls: answered 200 but the body was not the survey shape");
    process.exit(1);
  }
  console.log(`memory: ${body.repo}@${body.ref} — ${body.index.length} index line(s), ${body.files.length} file(s), ${body.unindexed.length} unindexed`);
  console.log(MEMORY_LEGEND);
  console.log(formatMemoryTable(body.files));
  // Issue #187: the survey walks the board repo's issues over GraphQL,
  // bounded by TASK_TEXTS_MAX_PAGES (board/api.ts) — a repo that outgrows
  // that bound gets a citation count measured over an INCOMPLETE set of
  // issues. Silence here would make that survey look like a normal one.
  if (body.truncated) {
    console.log("WARNING: citation survey truncated -- some issues were not scanned, see Worker logs");
  }
}

/**
 * `fleet memory compact` — the pass, run at sprint close.
 *
 * The proposal is JSON on STDIN, because it is a structured document an agent
 * writes, not four flags. Empty stdin is legal and means "rebuild the index
 * only" — the bootstrap run, which involves no judgment at all.
 *
 * This never writes anything itself. It hands the proposal to the Worker,
 * which measures it against the thresholds, refuses it outright if it would
 * destroy a specific, and — only then — opens a PR. Rejecting that PR costs
 * nothing: no memory file is ever deleted by it.
 */
async function cmdMemoryCompact(creds: Credentials): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet memory compact", detected);
  const stdin = process.stdin.isTTY ? "" : await new Response(Bun.stdin.stream()).text();
  const trimmed = stdin.trim();
  if (trimmed !== "") {
    try {
      JSON.parse(trimmed);
    } catch {
      console.error("fleet memory compact: stdin is not valid JSON (send {} or nothing for a bootstrap run)");
      process.exit(1);
    }
  }
  const res = await fetch(memoryUrl(creds, `/compact${repoQuery(detected.slug)}`), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: trimmed === "" ? "{}" : trimmed,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`fleet memory compact: ${res.status} ${text.slice(0, 800)}`);
    process.exit(1);
  }
  // Issue #548 (sweep 19 F4): the compact is the one memory verb with a
  // durable artifact — a 200 non-JSON body here means the Worker already
  // opened the PR and the CLI merely failed to read the answer, so the
  // refusal names the command and says the pass may have landed.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    console.error(
      "fleet memory compact: 200 but the body was not JSON — the pass may have landed; check the board repo's open PRs",
    );
    process.exit(1);
  }
  // Review round 1: a JSON 200 with the wrong shape is the exact case where
  // the POST did land — it must reach the same may-have-landed outcome, not
  // crash on body.summary into main()'s generic catch.
  let body: {
    url: string; pr: number; branch: string;
    summary: { merged: number; demoted: number; promoted: number; archived: number; indexLines: number };
    truncated: boolean;
  };
  try {
    const o = raw as Record<string, unknown>;
    if (typeof o.url !== "string" || typeof o.pr !== "number" || typeof o.branch !== "string") throw new Error();
    if (typeof o.truncated !== "boolean" || typeof o.summary !== "object" || o.summary === null) throw new Error();
    const s = o.summary as Record<string, unknown>;
    if (!["merged", "demoted", "promoted", "archived", "indexLines"].every((k) => typeof s[k] === "number")) throw new Error();
    body = o as typeof body;
  } catch {
    console.error(
      "fleet memory compact: 200 but the body was not the compact shape — the pass may have landed; check the board repo's open PRs",
    );
    process.exit(1);
  }
  const s = body.summary;
  console.log(`PR #${body.pr}  ${body.url}`);
  console.log(`branch ${body.branch}`);
  console.log(
    `merged ${s.merged}, demoted ${s.demoted}, promoted ${s.promoted}; ` +
    `${s.archived} file(s) MOVED to fleet/memory/archive/ (none deleted); index now ${s.indexLines} line(s)`,
  );
  // Same truncation flag `fleet memory ls` warns on — the proposal this PR
  // was measured against may have been judged over an incomplete citation
  // count (issue #187).
  if (body.truncated) {
    console.log("WARNING: citation survey truncated -- some issues were not scanned, see Worker logs");
  }
}

async function cmdPaste(creds: Credentials, id: string): Promise<void> {
  const bytes = await grabClipboardPng();
  if (!bytes) {
    console.error("fleet paste: no image on the clipboard (pngpaste missing, or the clipboard has no image)");
    process.exit(1);
  }
  try {
    console.log(await uploadPaste(creds, id, bytes));
  } catch (err) {
    console.error(`fleet paste: ${errText(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// attach — raw-mode WS terminal client. Manual-tested; logic kept thin.

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H\x1b[2J";

// hatcher's field-tested RESTORE_TERMINAL_SEQUENCE, reproduced verbatim
// (Task 9 brief is the authority for this exact byte sequence and order):
// all six mouse-tracking variants off, bracketed paste off, focus-reporting
// off, cursor keys + keypad back to normal, cursor visible, attributes
// reset, alternate screen exit — last, so everything above it is undone
// against the alt-screen buffer rather than the user's real one.
const RESTORE_TERMINAL_SEQUENCE =
  "\x1b[?1000l" + "\x1b[?1002l" + "\x1b[?1003l" + "\x1b[?1005l" + "\x1b[?1006l" + "\x1b[?1015l" +
  "\x1b[?2004l" +
  "\x1b[?1004l" +
  "\x1b[?1l" + "\x1b>" +
  "\x1b[?25h" +
  "\x1b[0m" +
  "\x1b[?1049l";

// ctrl-] (local hard escape) and ctrl-v (paste intercept) are the two
// controller-ruled special bytes; see ./input's classifyInput for the exact
// interception rule (standalone single-byte reads only). ctrl-c (0x03) is
// NOT special-cased anywhere in this file — classifyInput never matches it,
// so the generic "forward the chunk" path sends it straight through, which
// is what makes it reach claude's own cancel handling remotely.

function restoreTerminal(): void {
  process.stdout.write(RESTORE_TERMINAL_SEQUENCE);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

/**
 * Board #220: `fleet attach <id> --print-handle` — a purely local, read-only
 * Orca query. Prints the studio's healthy attach terminal handle (the
 * identifier `orca terminal send`/similar takes), or `"none"`, and returns.
 * A distinct, early function — not a flag threaded through `cmdAttach`'s
 * interactive machinery: it makes NO Worker call at all (no `creds` needed),
 * never sets raw terminal mode, never touches `process.stdin`, and never
 * opens a WebSocket. `deps` defaults to the real Orca wiring; a test injects
 * a fake one — same shape as every other `OrcaDeps` consumer in this file.
 */
export async function cmdPrintAttachHandle(id: string, deps: OrcaDeps = defaultOrcaDeps()): Promise<void> {
  const handle = await findAttachHandle(id, deps);
  console.log(handle ?? "none");
}

export async function cmdAttach(creds: Credentials, id: string): Promise<void> {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  // Safety net for every exit path (ctrl-], a crash, an external kill that
  // still lets Node run its exit handlers): the user's shell must never be
  // left in raw mode + the alternate screen. `process.on("exit", ...)`
  // permits only synchronous work, which restoreTerminal is.
  process.on("exit", restoreTerminal);

  let currentWs: WebSocket | null = null;
  let attempt = 0;

  /** THE SIZE-DECLARATION RULE (issue #43): only a client with a REAL
   *  TERMINAL declares a size. The old `process.stdout.columns ?? 80` guessed
   *  one whenever stdout was a pipe, and since the pty is SHARED that guess
   *  became everybody's size — measured 2026-09-23, four acme-os studios
   *  pinned at 80 columns by one tty-less client while the operator's own
   *  terminal sat at 180. resizeFrameFor returns null for exactly that case,
   *  and null means SEND NOTHING, never a default. */
  function sendResize(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const frame = resizeFrameFor(process.stdout);
    if (frame !== null) ws.send(frame);
  }
  process.on("SIGWINCH", () => {
    if (currentWs) sendResize(currentWs);
  });

  async function handlePaste(ws: WebSocket): Promise<void> {
    const bytes = await grabClipboardPng();
    if (!bytes) {
      ws.send(new Uint8Array([CTRL_V])); // pngpaste missing or no image: forward the raw byte
      return;
    }
    try {
      const path = await uploadPaste(creds, id, bytes);
      // WS *binary* data, not a JSON control frame — the remote pty reads
      // this exactly like typed characters (Task 9 brief, explicit).
      ws.send(new TextEncoder().encode(`${path} `));
    } catch (err) {
      // Review round 1, Important 1 (controller ruling): nothing about
      // ctrl-v may ever be silent. A real image was found but the upload
      // itself failed (network error, non-200) — forward the original
      // keystroke so the session doesn't just eat it, AND make the failure
      // visible: plain stderr text lands wherever the cursor happens to sit
      // under the alt screen and can be overwritten invisibly, so \r\n
      // forces it onto its own line first (raw mode has no line
      // discipline to do that for us).
      // uploadPaste's own thrown message already reads "paste upload
      // failed: ..." — not re-stated here, or the line would stutter.
      console.error(`\r\n[fleet] ${errText(err)}\r\n`);
      ws.send(new Uint8Array([CTRL_V]));
    }
  }

  /** One stdin chunk. ctrl-] and ctrl-v are intercepted only when they
   *  arrive as the WHOLE chunk (classifyInput's standalone-read rule) —
   *  anything else, including a multi-byte chunk that happens to contain
   *  0x1d/0x16 (a real terminal paste, a fast/buffered burst of typing),
   *  forwards untouched, byte for byte. */
  async function handleChunk(ws: WebSocket, chunk: Buffer): Promise<"exit" | "continue"> {
    const intercept = classifyInput(chunk);
    if (intercept === "escape") return "exit";
    if (intercept === "paste") {
      await handlePaste(ws);
      return "continue";
    }
    ws.send(chunk);
    return "continue";
  }

  /** One connection attempt: connect, enter the alt screen + send the
   *  initial size on open, pump stdin<->WS until it closes (for any reason
   *  — a network drop and the server's 1011 "pty ended" are both
   *  reconnectable, so both resolve "closed" identically) or ctrl-] fires
   *  (resolves "exit"). */
  function connectOnce(): Promise<{ outcome: "exit" | "closed"; lifetimeMs: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl(creds, id), { headers: accessHeaders(creds) });
      ws.binaryType = "arraybuffer";
      currentWs = ws;
      let settled = false;
      // null until "open" fires; a connection that never opens at all (DNS
      // failure, connection refused) reports a 0ms lifetime, same as before
      // this fix — reconnect floor-loop below reads it, not just "open".
      let openedAt: number | null = null;
      let chain: Promise<void> = Promise.resolve();
      // Issue #123: an upgrade the server never answers (a pty open wedged
      // in the DO) would otherwise pin this attempt forever.
      // #151: a socket can ALSO stay ESTABLISHED with nothing on it for
      // hours (the edge kept the client leg of a dropped DO socket) — the
      // age of the last frame is the only liveness signal the operator can
      // trust once open. One timer for the never-opened case (guarded by
      // openedAt so it never fires once "open" has cleared it), one interval
      // for the went-silent-after-opening case.
      let lastFrameAt = Date.now();
      const connectTimer = setTimeout(() => {
        if (openedAt === null) {
          console.error(`\r\nfleet: no answer to the upgrade in ${Math.round(ATTACH_CONNECT_TIMEOUT_MS / 1000)}s — retrying\r\n`);
          try { ws.close(); } catch { /* never opened */ }
          finish("closed");
        }
      }, ATTACH_CONNECT_TIMEOUT_MS);
      const watchdog = setInterval(() => {
        const now = Date.now();
        if (openedAt === null || now - lastFrameAt <= ATTACH_STALE_MS) return;
        process.stdout.write(titleSequence(attachTitle(id, { since: lastFrameAt, now })));
        console.error(
          `\r\nfleet: no output for ${Math.round((now - lastFrameAt) / 1000)}s — view stale since ` +
            `${hhmmssZ(lastFrameAt)}; reconnecting\r\n`,
        );
        try { ws.close(4000, "stale view"); } catch { /* already gone */ }
        finish("closed");
      }, Math.max(250, Math.min(5_000, ATTACH_STALE_MS / 3)));

      const onData = (chunk: Buffer) => {
        chain = chain.then(async () => {
          if (settled) return;
          try {
            if ((await handleChunk(ws, chunk)) === "exit") finish("exit");
          } catch (err) {
            console.error(`fleet: input handling failed: ${errText(err)}`);
          }
        });
      };

      const finish = (outcome: "exit" | "closed") => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearInterval(watchdog);
        process.stdin.off("data", onData);
        if (currentWs === ws) currentWs = null;
        if (outcome === "exit") {
          try { ws.close(1000, "client exit"); } catch { /* already gone */ }
        }
        const lifetimeMs = openedAt === null ? 0 : Date.now() - openedAt;
        resolve({ outcome, lifetimeMs });
      };

      ws.addEventListener("open", () => {
        clearTimeout(connectTimer);
        openedAt = Date.now();
        lastFrameAt = openedAt;
        // The alt-screen entry clears it, wiping any stale frame a previous
        // connection left on screen.
        process.stdout.write(ENTER_ALT_SCREEN);
        // #151: "live" belongs to a frame that actually arrived, not to the
        // open event — a joiner that opens and then goes silent forever
        // (this issue's own bug) must never read as live.
        process.stdout.write(titleSequence(attachTitle(id, "waiting")));
        sendResize(ws);
        process.stdin.on("data", onData);
      });
      let gotFirstFrame = false;
      ws.addEventListener("message", (ev) => {
        lastFrameAt = Date.now();
        if (!gotFirstFrame) {
          gotFirstFrame = true;
          process.stdout.write(titleSequence(attachTitle(id, "live")));
        }
        const frame = parseFrame(ev.data as string | ArrayBuffer);
        if (frame.type === "data") process.stdout.write(frame.bytes);
      });
      ws.addEventListener("close", (ev) => {
        console.error(`fleet: disconnected (${ev.code} ${ev.reason || "no reason given"})`);
        finish("closed");
      });
      // "close" still fires after "error" for a socket that never opened at
      // all (e.g. DNS failure, connection refused) — the `settled` guard in
      // finish() makes this a no-op when that happens, so there is exactly
      // one resolution path either way.
      ws.addEventListener("error", () => finish("closed"));
    });
  }

  /** Backoff wait between reconnects. A standalone ctrl-] keypress during
   *  the wait exits immediately instead of waiting out the timer — same
   *  classifyInput rule as the connected path, so a multi-byte chunk
   *  (e.g. a paste landing while disconnected) can never trigger it. There
   *  is no live WS to intercept a standalone ctrl-v for here, so a "paste"
   *  classification (and every other byte) is simply dropped, same as
   *  before this fix. */
  function waitOrExit(ms: number): Promise<"exit" | "timeout"> {
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        process.stdin.off("data", onData);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, ms);
      const onData = (chunk: Buffer) => {
        if (classifyInput(chunk) === "escape") {
          cleanup();
          resolve("exit");
        }
      };
      process.stdin.on("data", onData);
    });
  }

  console.error(`fleet: connecting to ${id}...`);
  for (;;) {
    // Sequential by design: one connection attempt at a time, one backoff
    // wait at a time — never overlapping.
    const { outcome, lifetimeMs } = await connectOnce();
    if (outcome === "exit") break;

    // Issue #123: a stopped or destroying studio refuses; reconnecting to it
    // is what booted a bare container after a destroy.
    const refusal = await attachRefusal(() =>
      fetch(studioUrl(creds, id, "/ws/terminal"), { headers: accessHeaders(creds), signal: AbortSignal.timeout(5000) }));
    if (refusal !== null) {
      restoreTerminal(); // first, or leaving the alt screen erases the line
      console.error(`fleet: ${refusal}`);
      process.exit(1);
    }

    // Reconnect floor-loop (P1 T10 ledger): a connection that closed within
    // 5s of opening does NOT reset the counter — nextAttempt carries the
    // prior `attempt` forward unchanged in that case, so a studio stuck
    // open-then-1011ing backs off exponentially instead of getting hammered
    // at the base delay forever.
    attempt = nextAttempt(attempt, lifetimeMs) + 1;
    const delay = reconnectDelayMs(attempt);
    console.error(`fleet: reconnecting in ${Math.round(delay)}ms (attempt ${attempt})...`);
    if ((await waitOrExit(delay)) === "exit") break;
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// entry point

/**
 * Fleet Spawn P3, Task 3: argv parsing itself moved to
 * src/studio/cli-args.ts's parseCliArgs — pure, so it's unit-tested directly
 * (see that file's own header for why cli/fleet.ts itself never is). This
 * function is the thin dispatch that was left behind: parse, then act.
 *
 * Argument shape is checked (inside parseCliArgs) before touching
 * credentials/disk, so a missing <id>/<role> is always reported as a usage
 * error — never masked by an unrelated broken-credentials-file error. Same
 * ordering the original inline dispatch used.
 */
async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.cmd === "usage") {
    console.error(parsed.message);
    process.exit(1);
  }

  // Before credentials, deliberately: `fleet help` is how an agent finds out
  // that ~/.fleet/credentials is even a thing, so it must answer on a machine
  // that has none.
  if (parsed.cmd === "help") {
    console.log(renderHelp());
    return;
  }

  // Board task #125: same reasoning as `help` just above — `fleet onboard`
  // must work on a machine with no ~/.fleet/credentials at all (a missing or
  // malformed file is exactly what its own check #3 reports), so it cannot
  // sit behind the hard loadCredentials() call below.
  if (parsed.cmd === "onboard") {
    return cmdOnboard();
  }

  // Board #220: same reasoning as `help`/`onboard` above — a purely local
  // Orca query must work on a machine with no ~/.fleet/credentials at all,
  // and must never reach anywhere near cmdAttach's interactive WS machinery.
  if (parsed.cmd === "attach" && parsed.printHandle) {
    return cmdPrintAttachHandle(parsed.id);
  }

  // Junior enable/disable/status: purely local (a symlink + one config
  // file), so like onboard they must work on a machine with no
  // ~/.fleet/credentials at all. `stats` (issue #218) is NOT purely local —
  // it calls the Worker's /studio/junior/usage route, so it needs the Access
  // JWT `loadCredentials()` below produces, same as every other board verb.
  if (parsed.cmd === "junior") {
    if (parsed.action !== "stats") {
      // Rebuilt as a literal (not `parsed` itself) because TS does not
      // narrow the type of a whole object from a nested property's
      // inequality check — only `parsed.action` as its own expression.
      process.exitCode = cmdJunior({ action: parsed.action, account: parsed.account });
      return;
    }
    // action === "stats": falls through to loadCredentials() below, unlike
    // enable/disable/status just above.
  }

  const creds = await loadCredentials();
  switch (parsed.cmd) {
    case "ls":
      return cmdLs(creds, parsed.fresh, defaultOrcaDeps(), parsed.json, parsed.prs);
    case "check":
      return cmdCheck(creds, parsed.id);
    case "clear-session-guard":
      return cmdClearSessionGuard(creds, parsed.id);
    case "inspect":
      return cmdInspect(creds, parsed.id);
    case "tabs":
      return cmdTabs(creds, { repo: parsed.repo, all: parsed.all, yes: parsed.yes });
    case "attach":
      return cmdAttach(creds, parsed.id);
    case "paste":
      return cmdPaste(creds, parsed.id);
    case "spawn":
      return parsed.local
        ? cmdLocalSpawn(creds, parsed.role, parsed.newInstance, parsed.leadType, parsed.repo, parsed.local.localPath)
        : cmdSpawn(creds, parsed.role, parsed.newInstance, parsed.leadType, parsed.repo);
    case "provision":
      return cmdProvision(creds, parsed.id, parsed.freshSession, parsed.cancelFreshSession, parsed.discardSession, parsed.forceMappedAccount === true, parsed.repo);
    case "recycle":
      return cmdRecycle(creds, parsed.id, parsed.discardUnsynced, parsed.freshSession, parsed.forceMappedAccount === true);
    case "destroy":
      return cmdDestroy(creds, parsed.id, parsed.force, parsed.discardUnsynced, parsed.park === true, parsed.strictUnmerged === true);
    case "task-new":
      return cmdTaskNew(creds, parsed.brief, parsed.provision === true, parsed.freshSession === true);
    case "task-ls":
      return cmdTaskLs(creds, parsed.query);
    case "task-show":
      return cmdTaskShow(creds, parsed.number);
    case "task-verify":
      return cmdTaskVerify(creds, parsed.number);
    case "task-message":
      return cmdTaskMessage(creds, parsed.number, parsed.text);
    case "task-assign":
      return cmdTaskAssign(creds, parsed.number, parsed.target, parsed.why, parsed.readRepos);
    case "task-state":
      return cmdTaskState(creds, parsed.number, parsed.to, parsed.fromNone === true, parsed.noPr === true);
    case "task-reap":
      return cmdTaskReap(creds, parsed.apply, parsed.terminal === true);
    case "task-junior-sweep":
      return cmdTaskJuniorSweep(creds, parsed.apply);
    case "sprint-ls":
      return cmdSprintLs(creds);
    case "sprint-open":
      return cmdSprintOpen(creds, parsed.title, parsed.owner, parsed.goal);
    case "sprint-status":
      return cmdSprintStatus(creds, parsed.title);
    case "sprint-close":
      return cmdSprintClose(creds, parsed.title);
    case "rescue-gc":
      return cmdRescueGc(creds, parsed.apply, parsed.olderThanDays);
    case "rescue-all":
      return cmdRescueAll(creds, { repo: parsed.repo, dryRun: parsed.dryRun });
    case "reap":
      return cmdReap(creds, {
        apply: parsed.apply, idleMs: parsed.idleMs, repo: parsed.repo,
        nudge: parsed.nudge, nudgeAfterMs: parsed.nudgeAfterMs, readTimeoutMs: parsed.readTimeoutMs,
      });
    case "memory-ls":
      return cmdMemoryLs(creds);
    case "memory-compact":
      return cmdMemoryCompact(creds);
    case "junior":
      // Only "stats" reaches here — enable/disable/status already returned
      // above, before loadCredentials(), per #218's early-dispatch guard.
      // Return code wired like cmdJunior's branch above, not `return`ed:
      // main() is Promise<void>, and the default exit dep already called
      // process.exit(1) on any usage error before a number gets here.
      process.exitCode = await cmdJuniorStats(creds, parsed.since);
      return;
    case "accounts":
      return parsed.sync
        ? cmdAccountsSync(creds, { watch: parsed.watch, json: parsed.json, writeLabels: parsed.writeLabels })
        : cmdAccounts(creds, { watch: parsed.watch, json: parsed.json, writeLabels: parsed.writeLabels });
    case "accounts-hold":
      return cmdAccountsHold(creds, parsed.name, parsed.until, parsed.reason);
    case "accounts-clear":
      return cmdAccountsClear(creds, parsed.name);
    case "models-ls":
      return cmdModelsLs(creds);
    case "models-assign":
      return cmdModelsAssign(creds, parsed.studio, parsed.model);
    case "models-set":
      return cmdModelsSet(creds, parsed.state, parsed.model);
    case "gate-run":
      return cmdGateRun(creds, parsed.pr, { failedOnly: parsed.failedOnly });
    case "gate-start":
      return cmdGateStart(creds, parsed.pr);
    case "gate-watch":
      return cmdGateWatch(creds, parsed.pr, parsed.runId);
    case "gate-protect":
      return cmdGateProtect(creds, parsed.repo);
    case "gate-log":
      return cmdGateLog(creds, parsed.pr, parsed.leg, { runId: parsed.runId, full: parsed.full, all: parsed.all });
  }
}

// Guarded so this file can be imported (its pure exports above — formatTable,
// wsUrl, studioUrl, accessHeaders) without also running the CLI — e.g. the
// Task 9 headless verification script does exactly this.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`fleet: ${errText(err)}`);
    process.exit(1);
  });
}
