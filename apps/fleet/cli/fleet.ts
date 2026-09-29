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
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { parseFrame, resizeFrameFor } from "../src/studio/frames";
import { reconnectDelayMs, nextAttempt, attachRefusal } from "./backoff";
import { postTaskNew, taskNewFailureLine } from "./task-new-retry";
import { grabClipboardPng } from "./paste-mac";
import { classifyInput, CTRL_V } from "./input";
import { parseCliArgs, renderHelp } from "../src/studio/cli-args";
import { parseStudioId } from "../src/studio/ids";
import { parseGitRemote, repoIdSegment, studioIdForTarget, studioIdIn } from "../src/studio/repo";
import { runOnboardPreflight } from "../src/studio/onboard";
import { cmdJunior } from "./junior";
import { sweepAllPages, type SweepPage } from "./junior-sweep";
import { runTaskStateTransition, type TaskStateFetchResult } from "../src/studio/task-state";
import type { ReapOutcome } from "../src/studio/task-reap";
import { formatRescueReport, type RescueWorktree } from "../src/studio/rescue";
import type { RescueGcOutcome } from "../src/studio/rescue-gc";
import type { RepoReach } from "../src/github/reach";
import { fleetTotals, formatFleetTotalsLine } from "./fleet-totals";
import { formatBurn, BURN_LEGEND } from "./burn-format";
import { requestInspect, renderInspect, formatSessionForceArmedLine, type InspectBody } from "./inspect-request";
import type { Observed } from "../src/studio/observed";
import { ATTACH_CONNECT_TIMEOUT_MS, ATTACH_STALE_MS, attachTitle, hhmmssZ, titleSequence } from "./attach-liveness";
import { repairFailureLine, discardNote, destroyPath } from "./repair-failure";
import { requestDestroy } from "./destroy-outcome";
import {
  formatIdleAlarm, emptyReapState, runReap, REAP_LIVE_READ_MAX_MS, type ReapDeps, type ReapFlags, type ReapState,
} from "./reap";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  formatReady, formatCheckedAt, readyOverride, formatSession, formatState, formatSessionGuards,
  formatSurvivalBriefs,
  formatObservedLines, formatActivity,
} from "./readiness-format";
import { formatTaskTable, formatTaskShow, formatAssignWake } from "./task-format";
import type { AssignWakeReport } from "../src/board/assign-wake";
import { formatMemoryTable, MEMORY_LEGEND, type MemoryFileRow } from "./memory-format";
import {
  ensureStudioWorkspace, reconcileStudioWorkspaces, planStudioWorkspaces, defaultOrcaDeps, studioWorkspaceTitle,
  removeStudioWorkspace, describeWorkspaceRemoval, readStudioRows, findAttachHandle,
  type OrcaDeps, type TabsReport, type TabsPlanEntry,
} from "./orca-workspace";
import type { StudioStatus } from "../src/studio/types";
import type { BoardTask, TaskState } from "../src/board/types";
import type { TaskComment } from "../src/board/board";
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
  return [formatStudioCount(studios), BURN_LEGEND];
}

/** Issue #205: a 3,382-char ERROR padded every line of the table to ~3,600
 *  chars. The full text stays in `fleet check <id>`. */
const ERROR_CELL_MAX = 160;

function capErrorCell(error: string | null): string {
  const flat = (error ?? "-").replace(/\s+/g, " ");
  return flat.length <= ERROR_CELL_MAX ? flat : `${flat.slice(0, ERROR_CELL_MAX - 1)}…`;
}

/** Issue #289/#285: the ACCOUNT cell -- see formatTable's comment on it. */
export function formatAccount(s: StudioStatus): string {
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
 */
export function formatTable(studios: StudioStatus[], now: Date = new Date(), orcaRows?: Map<string, string> | null): string {
  if (studios.length === 0) return "(no studios provisioned)";
  // REPO column (operator request 2026-08-20): a studio id is
  // `<repo>--<role>`, so the repo is already in `id` — but `fleet ls` is
  // fleet-wide, not cwd-scoped, and reading "which repo is this one on" out
  // of a delimiter mid-id is exactly the confusion this splits apart. Derived
  // here, never a new API field: parseStudioId is the id grammar's own source
  // of truth, and a malformed id keeps rendering rather than crashing the
  // table.
  const headers = [
    "ID", "REPO", "STATE", "READY", "SESSION", "ACTIVITY", "CHECKED", "ROW", "ACCOUNT", "HOST", "BURN", "REFRESHED", "ERROR",
  ];
  const rows = studios.map((s) => [
    s.id,
    parseStudioId(s.id)?.repo ?? "-",
    // STATE column (issue #95): formatState calls out a `stopped` row whose
    // container the Worker's detector saw RUNNING — billing while the
    // registry says off — rather than the bare state word.
    formatState(s),
    // Issue #85: `readyOverride` reads the DO's own Observed evidence
    // (replaced/unreachable/unverified) FIRST — that evidence contradicts or
    // supersedes the last container-side check `formatReady` renders, and
    // first-match-wins beats a stale/hopeful "provisioned". `formatReady` is
    // the fallback only once none of those overrides apply — and (issue #99)
    // itself checks the row's own rateLimited field before falling through
    // to the container-side readiness verdict.
    readyOverride(s, now) ?? formatReady(s.readiness, s, now),
    formatSession(s, now),
    // ACTIVITY column (issue #221, PR3a): working/idle/waiting-members/limit
    // from the pane itself, `?` with a reason when it cannot say — the
    // answer READY cannot give (READY only says alive-or-dead). Reads the
    // D1-mirrored `observed.activity`, so this budget is the mirror one
    // (`formatActivity`'s own default third argument).
    formatActivity(s, now),
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
    formatAccount(s),
    s.tailscaleHost ?? "-",
    formatBurn(s.burn),
    s.lastRefresh ?? "-",
    capErrorCell(s.error),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  // Issue #205: the LAST column is never padded -- trailing blanks on every
  // line are pure bytes, and they turned one long ERROR into 87 KB of output.
  const last = headers.length - 1;
  const line = (cols: string[]) => cols.map((c, i) => (i === last ? c : c.padEnd(widths[i]))).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
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
  const status = (await res.json()) as StudioStatus;
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
  console.log(formatTable([(await res.json()) as StudioStatus]));
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
      return (await res.json()) as StudioStatus;
    } catch (err) {
      console.error(`fleet ls --fresh: ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
      return s;
    }
  }));
}

export async function cmdLs(creds: Credentials, fresh: boolean, orcaDeps: OrcaDeps = defaultOrcaDeps()): Promise<void> {
  // Task 5 (P2 plane 3): explicit, now that GET /studio/ content-negotiates
  // on Accept (routes.ts) — without this, a future default change there
  // could silently start handing the CLI an HTML page instead of the JSON
  // array formatTable expects.
  const res = await fetch(new URL("/studio/", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`fleet ls: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const recorded = (await res.json()) as StudioStatus[];
  // Issue #37: --fresh re-checks every studio LIVE before the table is
  // printed; bare `fleet ls` prints what the registry already has, and the
  // CHECKED column says how old each of those verdicts is.
  const studios = fresh ? await refreshAll(creds, recorded) : recorded;
  for (const line of formatLsHead(studios)) console.log(line);
  const orca = await readStudioRows(studios, orcaDeps);
  console.log(formatTable(studios, new Date(), orca.rows));
  // #299: stdout, not stderr — survives `fleet ls 2>&1 | grep`-style reads.
  if (orca.footer && studios.length > 0) console.log(orca.footer);
  // Issue #53: idle studios bill with zero events; say so above the caveat.
  const idle = formatIdleAlarm(studios, new Date());
  if (idle) console.log(idle);
  console.log(READY_CAVEAT);
  for (const line of formatSessionGuards(studios)) console.log(line);
  // Issue #249 (PR4b) round 2, item 2: a survival re-brief still owed, or one
  // the studio has given up retrying. Same place, same shape as the session-guard
  // lines above — see formatSurvivalBriefs' own doc comment.
  for (const line of formatSurvivalBriefs(studios)) console.log(line);
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
    message: `fleet tabs: repo "${slug}" cannot name a studio: not a valid id segment ` +
      "(lowercase alphanumerics joined by single hyphens; dots and underscores fold to hyphens)",
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
    else deps.log(`${p.kind === "open" ? "open     " : "has one  "}${p.id}`);
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
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
        return (await res.json()) as StudioStatus[];
      },
      listStudioTasks: (id) => listStudioTasks(creds, id),
      orcaDeps: defaultOrcaDeps(),
      confirm: confirmYesNo,
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`fleet tabs: ${err instanceof Error ? err.message : String(err)}`);
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
  if (!res.ok) throw new Error(`reach check: ${res.status} ${(await res.text()).slice(0, 300)}`);
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
  if (!res.ok) throw new Error(`fleet ls: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as StudioStatus[];
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
async function cmdSpawn(creds: Credentials, role: string, newInstance: boolean): Promise<void> {
  // Dynamic repo selection (P4a): the detected repo rides along as `repo`.
  // Omitted entirely when this folder names none — the Worker's own default
  // is then the single source of that fallback, rather than this CLI
  // guessing one and the Worker guessing a second.
  const detected = await detectRepo();
  reportRepo("fleet spawn", detected);
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
    body: JSON.stringify({
      role, ...(detected.slug ? { repo: detected.slug } : {}),
      ...(newInstance ? { instance: "next" } : {}),
    }),
  });
  if (!res.ok) {
    console.error(`fleet spawn: ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const spawned = (await res.json()) as StudioStatus;
  console.log(formatTable([spawned]));
  // the operator's rule, enforced here rather than remembered: a studio that is now
  // burning tokens in the cloud gets a row in Orca's sidebar. After the table,
  // deliberately — stdout is the machine-readable result and must not wait on
  // a GUI, and this can never fail the spawn that already succeeded.
  const spawnTasks = await listStudioTasks(creds, spawned.id);
  await ensureStudioWorkspace(spawned.id, studioWorkspaceTitle(spawned.id, spawnTasks), defaultOrcaDeps());
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
async function cmdProvision(creds: Credentials, id: string, freshSession = false): Promise<void> {
  // Dynamic repo selection (P4a): unlike spawn, this command is ADDRESSED by
  // a studio id, and that id already names a repo segment. The detected repo
  // is sent only when the two agree — re-provisioning `websites--pilot`
  // while standing in the beta folder is an ordinary thing to do, and the
  // Worker (which refuses a repo that disagrees with the id) would reject
  // it. Sending nothing there is not a fallback to the default: the Worker
  // resolves a bodyless provision to whatever repo the studio is already
  // bound to.
  const detected = await detectRepo();
  // Board #21: the id's repo half is the FOLDED segment (repo.ts's
  // repoIdSegment), so a dotted repo only ever agrees with its own id through
  // that same fold — comparing the raw short name would make every
  // `fleet provision` inside a dotted repo send no repo at all.
  const detectedSegment = detected.slug === null ? null : repoIdSegment(detected.slug.split("/")[1]);
  const matchesId = detectedSegment !== null && detectedSegment === parseStudioId(id)?.repo;
  if (matchesId) reportRepo("fleet provision", detected);
  const res = await fetch(studioUrl(creds, id, freshSession ? "/provision?fresh-session=true" : "/provision"), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify(matchesId ? { repo: detected.slug } : {}),
  });
  if (!res.ok) {
    console.error(repairFailureLine("provision", res.status, await res.text()));
    process.exit(1);
  }
  const studio = (await res.json()) as StudioStatus;
  console.log(formatTable([studio]));
  // Same rule as `fleet spawn`: this path also leaves a studio running, so it
  // also owes that studio a visible row in Orca's sidebar. Idempotent, so a
  // studio that already has one is not given a second.
  const rowTasks = await listStudioTasks(creds, studio.id);
  await ensureStudioWorkspace(studio.id, studioWorkspaceTitle(studio.id, rowTasks), defaultOrcaDeps());
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
 */
async function cmdRecycle(creds: Credentials, id: string, discardUnsynced: boolean, freshSession = false): Promise<void> {
  // #96: without the flag, a container that cannot answer makes the Worker
  // refuse (409) and name the age of the snapshot a recycle would restore.
  // Issue #28: --fresh-session rides the same query string.
  const q = [discardUnsynced ? "discard-unsynced=true" : "", freshSession ? "fresh-session=true" : ""].filter(Boolean).join("&");
  const path = q ? `/recycle?${q}` : "/recycle";
  const res = await fetch(studioUrl(creds, id, path), {
    method: "POST",
    headers: accessHeaders(creds),
  });
  if (!res.ok) {
    console.error(repairFailureLine("recycle", res.status, await res.text()));
    process.exit(1);
  }
  const studio = (await res.json()) as StudioStatus;
  console.log(formatTable([studio]));
  // Issue #39: the pre-destroy rescue, one line per worktree.
  for (const line of studio.rescueReport ?? []) console.log(`rescue: ${line}`);
  if (discardUnsynced) console.error(discardNote(id));
  // Same rule as `fleet spawn`: this path also leaves a studio running, so it
  // also owes that studio a visible row in Orca's sidebar. Idempotent, so a
  // studio that already has one is not given a second.
  const rowTasks = await listStudioTasks(creds, studio.id);
  await ensureStudioWorkspace(studio.id, studioWorkspaceTitle(studio.id, rowTasks), defaultOrcaDeps());
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
 * container now ALSO calls `removeStudioWorkspace` — same injected `OrcaDeps`
 * `ensureStudioWorkspace` already uses, same best-effort posture: cleanup
 * runs only after the container is confirmed stopped, and any Orca-side
 * failure there degrades to one stderr line, never a non-zero exit for a
 * destroy that otherwise succeeded.
 */
async function cmdDestroy(creds: Credentials, id: string, force: boolean, discardUnsynced: boolean): Promise<void> {
  // Board task #203: the request is `requestDestroy`'s, not a bare fetch —
  // it carries a deadline and, when that deadline (or any other transport
  // failure) hits, it polls GET /studio/:id/status and reports the TRUE
  // outcome. Measured 2026-09-24: this side printed "The operation timed
  // out." for a destroy that had SUCCEEDED, and skipped the Orca teardown
  // below. See cli/destroy-outcome.ts's header.
  const report = await requestDestroy(
    { destroy: studioUrl(creds, id, destroyPath(force, discardUnsynced)), status: studioUrl(creds, id, "/status") },
    accessHeaders(creds), id,
  );
  for (const line of report.lines) console.error(line);
  if (report.status) console.log(formatTable([report.status]));
  // ONLY on a confirmed `stopped` row. A destroy whose outcome this side
  // could not read must never print a teardown line — an operator who reads
  // "Orca worktree and attach terminal removed" stops looking.
  if (report.teardown) {
    const removal = await removeStudioWorkspace(id, defaultOrcaDeps());
    for (const line of describeWorkspaceRemoval(id, removal)) console.error(`fleet: ${line}`);
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
type AssignedTask = BoardTask & { wake?: AssignWakeReport };

function reportAssignWake(task: AssignedTask): void {
  const line = formatAssignWake(task.wake);
  if (line !== null) console.log(line);
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

async function cmdTaskNew(creds: Credentials, brief: TaskBriefArgs): Promise<void> {
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
  reportAssignWake(task);
}

async function cmdTaskLs(
  creds: Credentials, query: { milestone?: string; state?: string; assignedTo?: string },
): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task ls", detected);
  const params = new URLSearchParams();
  if (detected.slug) params.set("repo", detected.slug);
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
      ...(detected.slug ? { repo: detected.slug } : {}),
    }),
  })) as AssignedTask;
  console.log(formatTaskTable([task]));
  reportAssignWake(task);
}

async function cmdTaskShow(creds: Credentials, number: number): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task show", detected);
  const view = (await boardRequest(
    creds, "fleet task show", `/tasks/${number}${repoQuery(detected.slug)}`,
  )) as { task: BoardTask; comments: TaskComment[] };
  console.log(formatTaskShow(view));
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
        "— there is no \"from\" this CLI can read to transition it safely",
    };
  }
  return { ok: true, state: view.task.state };
}

async function taskStateFetchTransition(
  creds: Credentials, number: number, from: string, to: string, repoSlug: string | null,
): Promise<TaskStateFetchResult> {
  const res = await fetch(boardUrl(creds, `/tasks/${number}/state`), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, ...(repoSlug ? { repo: repoSlug } : {}) }),
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
async function cmdTaskState(creds: Credentials, number: number, to: TaskState): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task state", detected);

  const result = await runTaskStateTransition(
    {
      getCurrentState: (c, n) => taskStateFetchCurrent(c, n, detected.slug),
      transition: (c, n, from, toState) => taskStateFetchTransition(c, n, from, toState, detected.slug),
    },
    creds, number, to,
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
 * here.
 */
async function cmdTaskReap(creds: Credentials, apply: boolean): Promise<void> {
  const detected = await detectRepo();
  reportRepo("fleet task reap", detected);
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
    if (r.outcome === "skipped") {
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
 * that eventually replaces it skips rescue entirely (README.md's own "does
 * not run the rescue push" warning), and this command exists precisely to
 * cover that gap. Every studio this filter excludes is printed as `skipped
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
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
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
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 300)}` };
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
export const REAP_STATE_PATH = join(homedir(), ".fleet", "reap-state.json");

/** Review F1: every plain read reap makes is bounded. A hung read must never
 *  sit between the last live read and a destroy, nor stall a poll. */
export const REAP_READ_TIMEOUT_MS = 20_000;
/** A lock file older than this is a crashed run's, and is taken over. */
export const REAP_LOCK_STALE_MS = 15 * 60_000;

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { headers: { ...headers, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

function isCountMap(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && Object.values(v).every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0);
}

/** Review F5: the state file's exact shape, or null. Absent maps are fine
 *  (older file); present-but-wrong is not. */
export function parseReapState(raw: string): ReapState | null {
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
  return {
    now: () => new Date(),
    listStudios: async () => {
      const body = await fetchJson(new URL("/studio/", creds.workerUrl).toString(), headers, readMs);
      if (!Array.isArray(body)) throw new Error("studio listing was not a JSON array");
      return body as StudioStatus[];
    },
    listBoard: async () => {
      const body = await fetchJson(boardUrl(creds, `/tasks?${repoQ}`), headers, readMs);
      if (!Array.isArray(body)) throw new Error("board listing was not a JSON array");
      return body as BoardTask[];
    },
    studioTasks: async (id) => {
      const body = await fetchJson(boardUrl(creds, `/tasks?${repoQ}&assignedTo=${encodeURIComponent(id)}`), headers, readMs);
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
        if (!res.ok) return { ok: false, error: `${res.status} ${(await res.text()).slice(0, 300)}` };
        const outcome = (await res.json()) as RescueAllOutcome;
        return outcome.ok === true ? { ok: true } : { ok: false, error: outcome.error ?? "rescue answered not ok" };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    destroy: async (id) => {
      const report = await requestDestroy(
        { destroy: studioUrl(creds, id, destroyPath(false, false)), status: studioUrl(creds, id, "/status") }, headers, id,
      );
      for (const line of report.lines) log(`  ${id}  ${line}`);
      if (report.teardown) {
        const removal = await removeStudioWorkspace(id, orcaDeps);
        for (const line of describeWorkspaceRemoval(id, removal)) log(`  ${id}  ${line}`);
      }
      if (report.status?.state === "stopped") return { outcome: "destroyed" };
      return { outcome: report.kind === "http-error" ? "refused" : "unknown", message: report.lines.join(" ") || report.kind };
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

/** Review F5: one reap per state file at a time. The lock is an exclusively
 *  created file; a second run refuses rather than racing the state or the
 *  destroys. A lock older than REAP_LOCK_STALE_MS (a crashed run) is taken over. */
export async function withReapLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  const take = () => writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
  try {
    await take();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = Date.now() - (await stat(lock)).mtimeMs;
    if (age < REAP_LOCK_STALE_MS) {
      throw new Error(`another fleet reap holds ${lock} (${Math.round(age / 1000)}s old); refusing to run alongside it`);
    }
    await unlink(lock);
    await take();
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function cmdReap(creds: Credentials, flags: Omit<ReapFlags, "repo"> & { repo: string | null }): Promise<void> {
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
  const { exitCode } = await withReapLock(REAP_STATE_PATH, () =>
    runReap({ ...flags, repo }, reapDeps(creds, repo, REAP_STATE_PATH, (l) => console.log(l))));
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
  if (!res.ok) throw new Error(`paste upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
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
  const body = (await res.json()) as {
    repo: string; ref: string; index: { title: string }[]; unindexed: string[]; files: MemoryFileRow[];
    truncated: boolean;
  };
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
  const body = JSON.parse(text) as {
    url: string; pr: number; branch: string;
    summary: { merged: number; demoted: number; promoted: number; archived: number; indexLines: number };
    truncated: boolean;
  };
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
  console.log(await uploadPaste(creds, id, bytes));
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
      console.error(`\r\n[fleet] ${err instanceof Error ? err.message : String(err)}\r\n`);
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
            console.error(`fleet: input handling failed: ${err instanceof Error ? err.message : String(err)}`);
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

  // Junior: purely local (a symlink + one config file), so like onboard it
  // must work on a machine with no ~/.fleet/credentials at all.
  if (parsed.cmd === "junior") {
    process.exitCode = cmdJunior(parsed);
    return;
  }

  const creds = await loadCredentials();
  switch (parsed.cmd) {
    case "ls":
      return cmdLs(creds, parsed.fresh);
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
      return cmdSpawn(creds, parsed.role, parsed.newInstance);
    case "provision":
      return cmdProvision(creds, parsed.id, parsed.freshSession);
    case "recycle":
      return cmdRecycle(creds, parsed.id, parsed.discardUnsynced, parsed.freshSession);
    case "destroy":
      return cmdDestroy(creds, parsed.id, parsed.force, parsed.discardUnsynced);
    case "task-new":
      return cmdTaskNew(creds, parsed.brief);
    case "task-ls":
      return cmdTaskLs(creds, parsed.query);
    case "task-show":
      return cmdTaskShow(creds, parsed.number);
    case "task-verify":
      return cmdTaskVerify(creds, parsed.number);
    case "task-assign":
      return cmdTaskAssign(creds, parsed.number, parsed.target, parsed.why);
    case "task-state":
      return cmdTaskState(creds, parsed.number, parsed.to);
    case "task-reap":
      return cmdTaskReap(creds, parsed.apply);
    case "task-junior-sweep":
      return cmdTaskJuniorSweep(creds, parsed.apply);
    case "rescue-gc":
      return cmdRescueGc(creds, parsed.apply, parsed.olderThanDays);
    case "rescue-all":
      return cmdRescueAll(creds, { repo: parsed.repo, dryRun: parsed.dryRun });
    case "reap":
      return cmdReap(creds, { apply: parsed.apply, idleMs: parsed.idleMs, repo: parsed.repo });
    case "memory-ls":
      return cmdMemoryLs(creds);
    case "memory-compact":
      return cmdMemoryCompact(creds);
  }
}

// Guarded so this file can be imported (its pure exports above — formatTable,
// wsUrl, studioUrl, accessHeaders) without also running the CLI — e.g. the
// Task 9 headless verification script does exactly this.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`fleet: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
