/**
 * Every studio the fleet leaves running gets its own entry in Orca's sidebar.
 *
 * the operator 2026-09-11: "I won't accept invisible things spending money in the
 * cloud without me seeing it." A studio is a cloud container burning tokens;
 * if the only way to know it exists is to type `fleet ls`, it is invisible.
 * So the rule lives in CODE, on every path that leaves a studio running
 * (`fleet spawn`, `ff`, `fleet provision`, `fleet recycle`), not in a habit an
 * operator or an agent can forget.
 *
 * The visible thing is an Orca WORKTREE, not a terminal tab in whichever
 * worktree happened to run the spawn. A tab is buried one level down inside
 * somebody else's workspace; a worktree is a row in the sidebar, next to every
 * other piece of work, which is the surface the operator actually reads. It costs a
 * checkout of the repo per studio — deliberately accepted ("I don't care if it
 * uses extra disk space just for that").
 *
 * FIVE PROPERTIES, each one a way this could otherwise go wrong:
 *
 *  1. It never fails its caller. A spawn that worked must not exit non-zero,
 *     print a stack, or hang because Orca is absent, slow or wedged. Every
 *     path through here funnels into one try/catch that logs ONE line to
 *     stderr and returns an outcome. It has no other failure mode.
 *  2. It is a no-op outside Orca. See `orcaPresent` for the exact predicate.
 *     In CI, inside a studio container, or in a plain terminal this makes no
 *     orca call at all — not a failed one, none.
 *  3. It is idempotent, at BOTH levels: the worktree is matched by a name
 *     derived deterministically from the studio id, and the attach terminal
 *     inside it is matched by whether a terminal that is BOTH `connected`
 *     AND running the attach process is already there — not by title; see
 *     `ensure`'s own comment for why the exact title string is structurally
 *     unusable, and `isAttachTerminal` for why `connected` alone (board #6's
 *     fix) was still one bug short. Two sidebar rows for one studio is a
 *     bug; so is a row whose terminal died and never came back, which is why
 *     the terminal is checked separately rather than assumed from the
 *     worktree. Board #42: idempotent per PROCESS too, not just per call —
 *     the whole check-then-act window is serialized per studio id (see
 *     `OrcaDeps.lock`), because two `fleet` invocations (e.g. `fleet spawn`
 *     and `fleet tabs`) are two separate OS processes with no shared memory,
 *     and nothing before this fix stopped both from reading "no attach
 *     terminal yet" before either had created one.
 *  4. It never steals focus. No `--focus`, no `--activate`, ever — see
 *     `ensureStudioWorkspace` for why that is unconditional rather than
 *     once-per-invocation.
 *  5. It is bounded. Every orca call carries a timeout; a wedged CLI costs a
 *     bounded delay and one stderr line, never a hang.
 *
 * Orca itself is reached only through the injected `run` — that is what lets
 * test/bun/orca-workspace.test.ts prove all five without a real Orca.
 */
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { parseStudioId } from "../src/studio/ids";
import { repoIdSegment } from "../src/studio/repo";
import type { StudioStatus } from "../src/studio/types";
import type { BoardTask } from "../src/board/types";
import { salvageContext, type SalvageOutcome, type SalvageDestination } from "./context-salvage";
import { attachTitleState, ATTACH_STALE_MS } from "./attach-liveness";

// ---------------------------------------------------------------------------
// Budgets. `worktree create` does a real git checkout, so it gets the generous
// one; everything else is a local query against the running app and should
// answer in milliseconds. Worst case for one studio is CREATE + three LISTs,
// and it is paid by commands that already block for minutes on a container
// bring-up.

const LIST_TIMEOUT_MS = 10_000;
// #124: `fleet ls` decorates a read with its ROW column — a slow Orca costs
// "-", never seconds of the operator's listing.
const ROW_TIMEOUT_MS = 3_000;
// Orca pages `list` by default; ask for everything, and treat `truncated`
// as "could not tell" (see `fullList`).
const LIST_ALL = ["--limit", "10000"];
const CREATE_TIMEOUT_MS = 45_000;

// Board #42's lock budgets. A legitimate holder may be mid `worktree create`
// (up to CREATE_TIMEOUT_MS), so the wait is generous rather than tight — a
// caller that waits an extra few seconds behind a real provision is a much
// smaller cost than the duplicate terminal this lock exists to prevent.
// STALE_MS is what stops a holder that crashed (or was `kill -9`'d) mid
// critical-section from wedging every later call forever: past that age the
// lock file is assumed abandoned and stolen, never honoured indefinitely.
const LOCK_POLL_MS = 200;
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 120_000;

export interface LockBudget {
  waitMs: number;
  staleMs: number;
}

const STUDIO_LOCK_BUDGET: LockBudget = { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS };
// #193: the registry lock guards a ~1 ms read-merge-rename, not a worktree
// create. A held lock costs `set` 2 s (then the write is skipped — best-effort,
// see fileWorkspaceRegistry); a crashed holder's file is stolen after 10 s.
const REGISTRY_LOCK_BUDGET: LockBudget = { waitMs: 2_000, staleMs: 10_000 };

// ---------------------------------------------------------------------------
// The injected seam.

export interface OrcaResult {
  /** Exit code 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Killed by us for exceeding its budget — reported separately from a
   *  non-zero exit so the stderr line can say which one happened. */
  timedOut: boolean;
}

export type OrcaRun = (args: string[], timeoutMs: number) => Promise<OrcaResult>;

/**
 * Board #39's decoupled lookup key: the Orca worktree id this code last
 * found or created FOR a studio, kept independent of the row's display
 * title (which now varies with the studio's current task — see
 * `studioWorkspaceTitle` and `ensure`'s own comment on why the lookup can
 * never key on that string again).
 *
 * Never throws, either direction — a registry that can't be read or written
 * only costs a fallback to the path-basename match (see `findStudioWorktree`),
 * never a failure of `ensureStudioWorkspace` itself (property 1 above).
 *
 * `set` is async (#175): the real implementation re-reads the file fresh
 * under a registry-wide lock before merging this write in — see
 * `fileWorkspaceRegistry`'s own comment for the lost-update race that made
 * this necessary.
 */
export interface WorkspaceRegistry {
  get(studioId: string): string | undefined;
  set(studioId: string, worktreeId: string): Promise<void>;
}


export interface OrcaDeps {
  registry: WorkspaceRegistry;

  env: Record<string, string | undefined>;
  /** The resolved orca executable, or null when there is none on PATH. */
  hasBinary: () => string | null;
  /** One line, on stderr. Called at most once per ensureStudioWorkspace. */
  log: (line: string) => void;
  run: OrcaRun;
  /**
   * Board #42: runs `fn` with `studioId`'s check-then-act window held
   * exclusively — no OTHER `lock` call for the same id may run concurrently,
   * whether that other call is in this process or a different `fleet`
   * invocation entirely (see `fileLock`, the real implementation). This is
   * the actual fix for the duplicate-attach-terminal bug: `ensure()`'s
   * "does this studio already have one?" check and its "create one" action
   * are two separate orca round-trips with an `await` gap between them, and
   * NOTHING before this closed that gap — two `fleet` processes (e.g.
   * `fleet spawn` and `fleet tabs`, started moments apart by an operator or
   * automation) could both read "no attach terminal yet" before either had
   * created one, and both would then create one. `connected`-based
   * idempotency (board #6) is correct GIVEN a consistent read; it never
   * addressed two callers reading at once. Rejects (never hangs forever) if
   * the lock can't be acquired within its budget — `ensureStudioWorkspace`'s
   * one try/catch turns that into `{kind: "failed"}` the same as any other
   * orca failure, so this never introduces a new way to hang the caller.
   */
  lock: <T>(studioId: string, fn: () => Promise<T>) => Promise<T>;
}

export type WorkspaceOutcome =
  | { kind: "skipped"; why: string }
  | { kind: "exists"; closedDuplicates?: string[] }
  | { kind: "created"; closedDuplicates?: string[] }
  | { kind: "failed"; why: string };

// ---------------------------------------------------------------------------
// Name derivation.

/**
 * The sidebar row's name, derived from the studio id and nothing else — so two
 * calls for one studio always look at the same row, and no two studios can
 * look at the same row.
 *
 * The studio id is carried VERBATIM, "--" included. Flattening it (the obvious
 * "make it look like a branch name" move) is exactly what breaks injectivity:
 * `a--b-c` and `a-b--c` are different studios that both flatten to `a-b-c`,
 * and they would then share one sidebar row and one attach terminal. Git is
 * fine with a double hyphen in a branch name; collisions are not fine.
 */
export function studioWorkspaceName(id: string): string {
  return `studio-${id}`;
}

// ---------------------------------------------------------------------------
// Presence.

/**
 * "Is Orca actually here?" — BOTH halves are required:
 *
 *  - the orca binary resolves, and
 *  - this process is running under Orca, evidenced by `TERM_PROGRAM=Orca` (any
 *    Orca-managed terminal) or `ORCA_WORKTREE_ID` (an Orca-managed worktree,
 *    which also covers a shell that rewrote TERM_PROGRAM).
 *
 * The binary alone is not enough, and that is the point: `orca` is on the operator's
 * PATH in every terminal on the machine. Without the environment half, a
 * `fleet spawn` typed into iTerm or a cron job would start opening sidebar
 * rows in an app nobody is looking at. In CI and inside a studio container
 * neither half holds, so this is false and nothing runs.
 */
export function orcaPresent(deps: Pick<OrcaDeps, "env" | "hasBinary">): boolean {
  if (deps.hasBinary() === null) return false;
  return deps.env.TERM_PROGRAM === "Orca" || Boolean(deps.env.ORCA_WORKTREE_ID);
}

// ---------------------------------------------------------------------------
// One orca call, decoded.

/** One entry of `terminal list --json`'s array. Full measured key set (board
 *  #6's plan doc, real Orca 1.4.198): `branch, connected, executionHostId,
 *  handle, incarnationId, lastOutputAt, leafId, orphaned, preview, ptyId,
 *  tabId, title, worktreeId, worktreePath, writable`. Only the fields this
 *  file actually reads are typed here. */
interface OrcaTerminalEntry {
  handle?: string;
  title?: string;
  connected?: boolean;
  /** MEASURED field (see above). Not yet confirmed against a stale/crashed
   *  pty specifically, but its name and the rest of the measured set both
   *  point the same way: a terminal whose underlying process died without a
   *  clean detach. Ranks duplicates AND, since #124, gates `isHealthyAttach`:
   *  an orphaned attach is closed and replaced by `fleet tabs`, and reads
   *  `attach DEAD` in `fleet ls`. Undefined is treated as "not orphaned" —
   *  the conservative default (never closes a healthy terminal). */
  orphaned?: boolean;
  /** Same provenance and same two uses as `orphaned`. Undefined is treated as
   *  "writable". */
  writable?: boolean;
  /** Used only to break a tie between two duplicates that are otherwise
   *  equally healthy. Board #55: MEASURED as epoch-ms NUMBER on Orca
   *  1.4.209; an ISO string on older builds. Compared via Date. */
  lastOutputAt?: number | string;
  /** #124 item 7: the stray-attach sweep matches on it when no worktree row
   *  is left to select by. */
  worktreePath?: string;
  /** Board #55: which worktree the terminal lives in — `fleet ls`'s ROW
   *  column reads every terminal in ONE `terminal list` and groups by it. */
  worktreeId?: string;
}

interface OrcaEnvelope {
  result?: {
    repos?: { id?: string; displayName?: string; gitRemoteIdentity?: { canonicalKey?: string } | null }[];
    // `path` is MEASURED on real Orca (2026-09-24): the folder is
    // `studio-<id>` with hyphen runs folded (`studio-fleetflare-web-studio`
    // for `fleetflare--web-studio`), and a clashing name gets `-2`. Still
    // optional here: removeStudioWorkspace treats its absence as a reason to
    // REFUSE the destructive `worktree rm` call, never as license to fall
    // back to a `name:` selector — see that function's own doc comment.
    worktrees?: { id?: string; displayName?: string; path?: string }[];
    terminals?: OrcaTerminalEntry[];
    /** Orca's own "this page is not everything" flag. */
    truncated?: boolean;
    worktree?: { id?: string; displayName?: string };
    terminal?: { handle?: string; title?: string };
  };
}

// ---------------------------------------------------------------------------
// Which terminal is THE attach terminal — board #42.
//
// Board #6 fixed idempotency to key on `connected`, reasoning (its own
// comment, now corrected below) that the studio's worktree is single-purpose
// so ANY live terminal in it is proof the attach terminal already exists.
// MEASURED WRONG, twice, by the maestro that filed #42: an operator (or a
// leftover reattach shell) opening a plain shell in that same worktree also
// reports `connected: true`, and that shell is not `fleet attach <id>` —
// so `connected` alone both (a) makes `ensure()` believe a studio already
// has its attach terminal when it actually has none (the row then opens onto
// a bare shell forever), and (b) makes `fleet tabs` report a studio as
// covered when it is not (the exact same miscount, seen from the reconcile
// side).
//
// the operator's own fix, verbatim from the board comment: count a terminal as the
// attach terminal when its COMMAND is `fleet attach <id>`, never merely
// because SOME terminal exists and never merely because `connected` is true.
// `terminal list --json` does not expose a `command`/argv field at all
// (measured full key set above) — the closest available proxy is `title`,
// which board #6's own measurement already established reads back as the
// RUNNING PROCESS's short name (here, always "fleet", since `ensure` always
// creates the terminal with `--command "fleet attach <id>"`). A plain shell's
// process name is its shell ("zsh", "bash", ...), never "fleet" — so
// `title === "fleet"` is the exact, measurable stand-in for "this terminal is
// running some `fleet` command" that Orca's own schema makes available.
// Residual, narrower tradeoff (documented, not hidden): an operator manually
// running a DIFFERENT `fleet` subcommand (e.g. `fleet ls`) in this dedicated
// worktree would also read `title === "fleet"` and be miscounted as the
// attach terminal. Far rarer than "any terminal at all", and still the
// direction this file's design already accepts (worktree is single-purpose).
//
// #206: MEASURED live on Orca 1.4.209 (2026-09-24), an attach terminal's
// `title` passes through FOUR forms, all accepted:
//   - `fleet`                        process name (pre-#153 clients)
//   - `<id>`                         ensure's own --title/rename, for minutes
//                                    after create, before the OSC title lands
//   - `fleet <id> · waiting|live`    #153's OSC title (`attachTitle`)
//   - `fleet <id> · STALE …`         same, stale view
// `<id>` is an exact match; the #153 forms match only this studio's id.
const ATTACH_TERMINAL_TITLE = "fleet";

/** #206: THE attach-title rule — ensure, tabs and ls ROW all use it.
 *  Teardown closes every terminal by folder, any title (#135), so needs none. */
function isAttachTitle(title: string | undefined, id: string): boolean {
  return title === ATTACH_TERMINAL_TITLE || (Boolean(title) && title === id) || attachTitleState(id, title) !== null;
}

function isAttachTerminal(t: OrcaTerminalEntry, id: string): boolean {
  return t.connected === true && isAttachTitle(t.title, id);
}

/** #124 M2: ONE rule for "this studio has a working attach", shared by
 *  `fleet tabs` (keep vs replace) and `fleet ls`'s ROW `ok` — so the column
 *  never flags a problem its repair command would leave alone. */
function isHealthyAttach(t: OrcaTerminalEntry, id: string): boolean {
  return isAttachTerminal(t, id) && t.orphaned !== true && t.writable !== false;
}

/** Board #220: `lastOutputAt`'s own field comment (`OrcaTerminalEntry`) says
 *  epoch-ms NUMBER on Orca 1.4.209, an ISO string on older builds. `null` —
 *  read as the healthy default, never demoted for it (see
 *  `rankAttachTerminals`'s own comment) — when the field is absent or fails
 *  to parse either way. */
function lastOutputMs(t: OrcaTerminalEntry): number | null {
  if (t.lastOutputAt === undefined) return null;
  const ms = typeof t.lastOutputAt === "number" ? t.lastOutputAt : Date.parse(t.lastOutputAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Duplicates ranked best-first: prefer one that is not `orphaned` and is
 *  `writable`, then (#206) a #153 `live` client over any other present form
 *  and a `STALE` one last — "genuinely connected AND functional", per board
 *  #42's own reconciliation wording. A stale client must never beat a live one.
 *
 *  Board #220's own added tier, between liveness and the final tie-break: among
 *  terminals still tied after that (same badness AND liveness), DEMOTE one
 *  whose `lastOutputAt` is more than `ATTACH_STALE_MS` (90s) behind the MOST
 *  RECENT `lastOutputAt` in that SAME TIED GROUP — never a global newest, so a
 *  quiet-but-fine studio is never punished against a noisier one it shares no
 *  tier with. Rationale (the reviewer's own #220 framing): two clients of ONE
 *  shared tmux session normally see near-identical frames (this is exactly
 *  why #206 round 3, below, stopped comparing `lastOutputAt` at all — it
 *  couldn't tell two genuinely different clients apart on a near-identical
 *  reading); a gap this large instead means one of them stopped receiving
 *  frames entirely — frozen or wedged — without Orca ever marking it
 *  `orphaned`. Left unchecked, a pre-#153 client (titled bare `"fleet"`, no
 *  OSC-title staleness detection at all — see `isAttachTitle`) that crashed
 *  hours ago can beat a genuinely working duplicate purely by being OLDER.
 *  A terminal with no `lastOutputAt` at all (or an unparseable one) is never
 *  demoted for lacking the field — the same "missing fields read as the
 *  healthy default" convention this file already states for
 *  `orphaned`/`writable` on `OrcaTerminalEntry` (a brand-new client that
 *  hasn't had a chance to report output yet must not lose to a stale old one
 *  just for that).
 *
 *  Ties that remain (small or absent `lastOutputAt` gaps) keep the OLDEST
 *  (#206 round 3): a peer maestro may hold the handle `terminal create` gave
 *  it, and pruning that client kills the handle silently. Orca reports no
 *  creation time and handles are random UUIDs, so oldest = earliest in
 *  `terminal list` order (Orca's tab graph; new tabs append — UNMEASURED
 *  against a tab the operator reordered).
 *  Missing fields read as the healthy default (see OrcaTerminalEntry). */
function rankAttachTerminals(terms: OrcaTerminalEntry[], id: string): OrcaTerminalEntry[] {
  const badness = (t: OrcaTerminalEntry): number =>
    (t.orphaned === true ? 1 : 0) + (t.writable === false ? 1 : 0);
  const liveness = (t: OrcaTerminalEntry): number => {
    const state = attachTitleState(id, t.title);
    return state === "live" ? 0 : state === "stale" ? 2 : 1;
  };
  const tierKey = (t: OrcaTerminalEntry): string => `${badness(t)}:${liveness(t)}`;

  // The newest `lastOutputAt` WITHIN each badness+liveness tier — computed
  // once over the whole list, so every candidate is judged against its own
  // tied group, never a global newest.
  const newestInTier = new Map<string, number>();
  for (const t of terms) {
    const ms = lastOutputMs(t);
    if (ms === null) continue;
    const key = tierKey(t);
    const prior = newestInTier.get(key);
    if (prior === undefined || ms > prior) newestInTier.set(key, ms);
  }
  const demoted = (t: OrcaTerminalEntry): number => {
    const ms = lastOutputMs(t);
    if (ms === null) return 0; // nothing to judge by — healthy default, never demoted
    const newest = newestInTier.get(tierKey(t))!; // this candidate's own ms was folded in above
    return newest - ms > ATTACH_STALE_MS ? 1 : 0;
  };

  // Array.prototype.sort is stable: equal rank keeps list order.
  return [...terms].sort((a, b) =>
    badness(a) - badness(b) || liveness(a) - liveness(b) || demoted(a) - demoted(b));
}

/** An unfiltered `worktree list` / `terminal list`, ALL rows. Throws when the
 *  answer is partial (`truncated`) or not the expected array (unparseable
 *  output decodes to `{}`) — #124 M1/M3: an empty answer only proves absence
 *  when it is complete. */
async function fullList<K extends "worktrees" | "terminals">(
  deps: OrcaDeps, key: K, timeoutMs: number,
): Promise<NonNullable<NonNullable<OrcaEnvelope["result"]>[K]>> {
  const noun = key === "worktrees" ? "worktree" : "terminal";
  const res = (await orcaJson(deps, [noun, "list", ...LIST_ALL, "--json"], timeoutMs)).result;
  if (res?.truncated === true) throw new Error(`orca ${noun} list truncated`);
  const rows = res?.[key];
  if (!Array.isArray(rows)) throw new Error(`orca ${noun} list returned no ${key} array`);
  return rows as NonNullable<NonNullable<OrcaEnvelope["result"]>[K]>;
}

/** Throws on every failure — timeout, non-zero exit, unparseable output. The
 *  single catch in ensureStudioWorkspace turns that into one stderr line, so
 *  nothing below this point has to carry an error channel of its own. */
async function orcaJson(deps: OrcaDeps, args: string[], timeoutMs: number): Promise<OrcaEnvelope> {
  const what = `orca ${args[0]} ${args[1]}`;
  const res = await deps.run(args, timeoutMs);
  if (res.timedOut) throw new Error(`${what} timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (!res.ok) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
  try {
    return JSON.parse(res.stdout) as OrcaEnvelope;
  } catch {
    return {};
  }
}

/**
 * Studio id `<repo>--<role>` -> the Orca repo id to create the worktree in.
 *
 * Matched on the GIT REMOTE's own short name, with the display name only as a
 * fallback. The two disagree often enough to matter: Orca shows the acme
 * repo as "acme" while its remote is `acme-hq/acme-os`, and the studio
 * id is built from the remote (src/studio/repo.ts's repoIdSegment over
 * `slug.split("/")[1]`), so `acme-os--maestro` matches nothing by display
 * name. Returns null rather than guessing — a studio opened against the wrong
 * repo is worse than one with no sidebar row.
 *
 * Both candidate names go through repoIdSegment before the comparison, for
 * the same reason (board #21): since `.` and `_` fold onto `-`, Orca knows
 * `exampleorg.com` while the studio id carries `exampleorg-com`.
 * Comparing raw would resolve no repo, ensure() would throw "Orca knows no
 * repo", and a dotted repo's studio would run with NO sidebar row — the
 * invisible-agent failure this whole file exists to prevent.
 */
function resolveRepoId(envelope: OrcaEnvelope, repoSegment: string): string | null {
  const repos = envelope.result?.repos ?? [];
  const sameSegment = (name: string | undefined): boolean =>
    name !== undefined && repoIdSegment(name) === repoSegment;
  const byRemote = repos.find((r) => sameSegment((r.gitRemoteIdentity?.canonicalKey ?? "").split("/").pop()));
  const match = byRemote ?? repos.find((r) => sameSegment(r.displayName));
  return match?.id ?? null;
}

// ---------------------------------------------------------------------------
// The rule.

/**
 * Give studio `id` a visible Orca sidebar row, if it has none.
 *
 * ON FOCUS: nothing here passes `--focus` or `--activate`, on any call, ever
 * — not even for a single-studio invocation. The deliverable is the row being
 * THERE; revealing it is a separate thing, and the operator issued the spawn
 * from a terminal he is currently reading. `fleet tabs` is a batch by
 * construction and would yank his window once per studio. So the policy is
 * not "focus at most once", it is "never focus": the one command that wants
 * to look at a studio, `fleet attach`, already puts him in it.
 */
/**
 * Sidebar rows in Orca render at roughly file-tree width, not a wide pane —
 * call it 40-ish characters before the app itself starts eliding, though
 * this is a judgment call, not a live measurement (no Orca on this
 * container; see this feature's plan doc). `<repo> · #<n> ` already spends
 * some of that before the task title even starts, so the task-title half is
 * capped tighter: enough for a short repo name plus a 4-digit issue number
 * without the row wrapping or getting clipped somewhere this code doesn't
 * control. One constant, easy to retune later.
 */
const TASK_TITLE_MAX_CHARS = 32;

function truncateTaskTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= TASK_TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TASK_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** The newest task, by `updatedAt`, among those not `completed` — "newest"
 *  covers a task still `submitted`/waiting its turn, not only one actively
 *  `working`. Undefined when every candidate is `completed` (or there are
 *  none), which is the idle case in `studioWorkspaceTitle`. */
function newestNonCompleted(tasks: BoardTask[]): BoardTask | undefined {
  let best: BoardTask | undefined;
  for (const t of tasks) {
    if (t.state === "completed") continue;
    if (!best || t.updatedAt > best.updatedAt) best = t;
  }
  return best;
}

/**
 * The row's DISPLAY title (board #39) — the operator 2026-09-23: "name studios
 * after the task they are working on, not the generic role." Pure, no I/O:
 * every caller already has (or fetches) the studio's `BoardTask[]` (`fleet
 * task ls --studio <id>`) itself; see `ensureStudioWorkspace`'s own comment
 * for why the fetch lives at the call site rather than in this file.
 *
 * Filters to `assignee === id` defensively — correct whether the caller
 * already scoped the fetch with `?assignedTo=` or handed over an unfiltered
 * list. Prefers the task in `working` state (at most one — §2.2, a studio
 * is one task at a time); else the newest non-completed task; else idle.
 *
 * NEVER the lookup key — see `studioWorkspaceName`'s comment and `ensure`'s
 * own for why a title that changes with the task cannot be what finds the
 * row again (board #11, the duplicate-tab bug, is exactly what happens if
 * it is).
 */
export function studioWorkspaceTitle(id: string, tasks: BoardTask[]): string {
  const parsed = parseStudioId(id);
  const repo = parsed?.repo ?? id;
  // Issue #269 round 2: instance 1 is unmarked (byte-for-byte the pre-#269
  // title), instance n>1 gets a `#n` suffix on the ROLE — without this, the
  // idle title for a second pilot was identical to the first's, and Orca's
  // own sidebar gave no way to tell them apart at a glance.
  const role = parsed === null ? "studio" : parsed.instance > 1 ? `${parsed.role}#${parsed.instance}` : parsed.role;
  const assigned = tasks.filter((t) => t.assignee === id);
  const chosen = assigned.find((t) => t.state === "working") ?? newestNonCompleted(assigned);
  if (!chosen) return `${repo} · ${role} (idle)`;
  return `${repo} · #${chosen.number} ${truncateTaskTitle(chosen.title)}`;
}

export async function ensureStudioWorkspace(id: string, title: string, deps: OrcaDeps): Promise<WorkspaceOutcome> {
  if (!orcaPresent(deps)) {
    // Board #334: Orca is optional. With no binary, say so once — the studio
    // runs regardless and attaches from any terminal. Inside a studio
    // container (STUDIO_ID set) there is no Orca by design: stay quiet. A
    // binary present but a non-Orca terminal stays quiet too (see
    // orcaPresent's comment on why that skip is deliberate).
    if (deps.hasBinary() === null && !deps.env.STUDIO_ID) {
      deps.log(`orca not found on PATH — no Orca sidebar row for ${id}. Orca is optional; attach from any terminal with: fleet attach ${id}`);
    }
    return { kind: "skipped", why: "not running under Orca" };
  }
  try {
    // Board #42: the WHOLE check-then-act window — not just the terminal
    // half — runs under one per-studio lock, so a second `fleet` process
    // racing this one either sees the finished result or waits its turn,
    // never an interleaved half-read. See `OrcaDeps.lock`'s own comment for
    // why this, not a tighter guard, is the actual fix.
    return await deps.lock(id, () => ensure(id, title, deps));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.log(`${id}: no Orca workspace opened — ${why}`);
    return { kind: "failed", why };
  }
}

/**
 * Title-from-tasks + ensure, as one call — the only shape every single-studio
 * caller (spawn/provision/recycle/ff) ever used. The pair is the interface;
 * callers that already hold a title (reconcile's resolver) still call
 * `ensureStudioWorkspace` directly.
 */
export async function openStudioRow(id: string, tasks: BoardTask[], deps: OrcaDeps): Promise<WorkspaceOutcome> {
  return ensureStudioWorkspace(id, studioWorkspaceTitle(id, tasks), deps);
}

type OrcaWorktree = NonNullable<NonNullable<OrcaEnvelope["result"]>["worktrees"]>[number];

/**
 * Board #39's lookup, shared by every reader of a studio's row (board #55:
 * teardown and `fleet ls` had drifted onto the displayName-only match, which
 * a task-titled row never satisfies). Registry id first; the PATH-basename
 * fallback only for a registry entry that is missing (#175: lost to a
 * cross-process registry write race — see fileWorkspaceRegistry's own
 * comment) or was never recorded (a row ensured before #39).
 *
 * Board #175: this fallback used to match `displayName === studioWorkspaceName(id)`
 * — the row's DISPLAY TITLE, which board #39 (`ensure()` below) stamps with
 * the studio's CURRENT TASK on every single `ensure()` call. That fallback
 * therefore stopped matching ANYTHING the moment #39 shipped: a lost
 * registry entry now finds nothing, `ensure()` believes the studio has no
 * worktree, and creates a second one (`-2`) next to the real, orphaned one
 * (measured 2026-09-24: `fleetflare--scratch`'s registry entry vanished
 * between two `fleet` processes, and `fleet tabs` opened a duplicate).
 *
 * `w.path`'s basename is the stable key instead: `ensure()` below creates the
 * worktree with `--name studio-<id>`, Orca names the folder after it (hyphen
 * runs folded, MEASURED — see `studioFolderNames`), and nothing ever renames
 * a worktree's PATH the way #39 renames its display title — the path is
 * filesystem identity, the title is a cosmetic label.
 *
 * #193: the basename must EQUAL one of `studioFolderNames(id)` — never a
 * prefix or substring match. Teardown's destructive `worktree rm` removes
 * whatever this returns, and real folders sit one suffix apart: Orca's own
 * `-2` duplicate (`studio-x-web-2`) and a sibling studio
 * (`studio-x-web-studio` for `x--web-studio`) both START WITH
 * `studio-x-web`. test/bun/orca-workspace.test.ts pins each case.
 */
function findStudioWorktree(id: string, worktrees: OrcaWorktree[], registry: WorkspaceRegistry): OrcaWorktree | undefined {
  const storedId = registry.get(id);
  // Board #175 fix round: `studioWorkspaceName(id)` alone is the VERBATIM
  // name this code passed to `worktree create --name` — but real Orca folds
  // a run of hyphens in the id down to one when it names the folder on disk
  // (MEASURED 2026-09-24, `removeStudioWorkspace`'s own `studioFolderNames`:
  // studio `fleetflare--web-studio` lives at `.../studio-fleetflare-web-studio`,
  // NOT `.../studio-fleetflare--web-studio`). Checking only the verbatim
  // name meant this fallback could never match a real row either — the
  // exact class of bug #175 itself is about. `studioFolderNames` is the
  // SAME two-name set `removeWorkspace` already trusts for this identical
  // reason; reused, not reinvented.
  const stableNames = studioFolderNames(id);
  return (storedId ? worktrees.find((w) => w.id === storedId) : undefined)
    ?? worktrees.find((w) => w.path !== undefined && stableNames.includes(basename(w.path)));
}

async function ensure(id: string, title: string, deps: OrcaDeps): Promise<WorkspaceOutcome> {
  const name = studioWorkspaceName(id);
  const listed = await orcaJson(deps, ["worktree", "list", "--json"], LIST_TIMEOUT_MS);
  const worktrees = listed.result?.worktrees ?? [];

  // Board #39: look up by the Orca id THIS code stored, never by the row's
  // DISPLAY TITLE — the title now varies with the studio's current task, so
  // keying on it would create a second row every time the task changed. The
  // folder basename is the fallback for a registry entry that is missing
  // (lost, #175, or never recorded before #39); finding the row that way
  // HEALS it into the registry below rather than duplicating it.
  let existing = findStudioWorktree(id, worktrees, deps.registry);

  // The worktree half.
  let selector: string;
  let created = false;
  if (existing) {
    selector = existing.id ? `id:${existing.id}` : `name:${name}`;
    if (existing.id) await deps.registry.set(id, existing.id);
  } else {
    const parsed = parseStudioId(id);
    if (!parsed) throw new Error(`"${id}" is not a studio id`);
    const repoId = resolveRepoId(await orcaJson(deps, ["repo", "list", "--json"], LIST_TIMEOUT_MS), parsed.repo);
    if (repoId === null) throw new Error(`Orca knows no repo named "${parsed.repo}" (add it with: orca repo add)`);
    // --setup skip: this checkout exists to host one attach terminal, so the
    // repo's install/build hooks would be minutes of work for nothing.
    // --no-parent: a studio belongs to the fleet, not to whatever worktree
    // happened to spawn it, so it sits at the top level of the sidebar.
    const madeIt = await orcaJson(
      deps,
      ["worktree", "create", "--repo", `id:${repoId}`, "--name", name, "--no-parent", "--setup", "skip", "--json"],
      CREATE_TIMEOUT_MS,
    );
    const made = madeIt.result?.worktree;
    selector = made?.id ? `id:${made.id}` : `name:${name}`;
    if (made?.id) await deps.registry.set(id, made.id);
    created = true;
  }

  // Board #39: stamp the row with the studio's CURRENT task. Best-effort on
  // purpose -- a row carrying a stale title is cosmetic, while a studio that
  // fails to come up because a rename failed is not. The verb is
  // `set --display-name`; `orca worktree rename` DOES NOT EXIST and returns
  // "Unknown command" (verified against real Orca, 2026-09-23).
  try {
    await orcaJson(
      deps,
      ["worktree", "set", "--worktree", selector, "--display-name", title, "--json"],
      LIST_TIMEOUT_MS,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`fleet: ${id}: orca worktree set --display-name failed (title not stamped) -- ${why}`);
  }

  // The terminal half, checked separately: a row whose attach terminal was
  // closed is still a row, and treating the worktree's existence as proof of a
  // terminal is how a studio ends up with a sidebar entry that opens onto
  // nothing.
  //
  // Idempotency key: `isAttachTerminal` (board #42) — a terminal that is both
  // `connected` AND titled as an attach (the four forms at
  // `ATTACH_TERMINAL_TITLE`). Board #6 MEASURED on Orca 1.4.198 that `list`'s
  // `title` never reflects `--title`/rename; #206 MEASURED the opposite on
  // Orca 1.4.209 — `<id>` for minutes after create — so `title === id` is
  // one accepted form, never the only one. Not `connected` alone
  // either (board #6's own fix, MEASURED WRONG by board #42: a plain shell an
  // operator opens in this single-purpose worktree also reports `connected:
  // true`, so `connected` alone can satisfy this check with NO real attach
  // terminal ever created, or make `fleet tabs` believe a studio is covered
  // when it is not — see `isAttachTerminal`'s own comment for the measured
  // cases and why `title === "fleet"` is the closest available proxy for
  // "this terminal's command is `fleet attach <id>`" that Orca's schema
  // exposes).
  const terms = await orcaJson(deps, ["terminal", "list", "--worktree", selector, "--json"], LIST_TIMEOUT_MS);
  const attachTerminals = (terms.result?.terminals ?? []).filter((t) => isAttachTerminal(t, id));

  // Reconcile duplicates BEFORE deciding whether one already exists — board
  // #42's measured case A: a race (the exact one `deps.lock` above now
  // closes, plus any duplicate already on disk from before this fix shipped)
  // can leave MORE than one genuine attach terminal on one worktree. Two
  // tmux clients then fight over `window-size latest`, and the loser's pane
  // collapses to its one-line status bar — unreadable, not idle (this file's
  // header). Keep the best one (ranked, not merely first), close the rest,
  // and report every closed handle so the caller can say so loudly rather
  // than silently picking one (`fleet tabs`, via `TabsReport.deduped`).
  let closedDuplicates: string[] | undefined;
  if (attachTerminals.length > 1) {
    const [, ...extra] = rankAttachTerminals(attachTerminals, id);
    closedDuplicates = [];
    for (const t of extra) {
      if (!t.handle) continue;
      await orcaJson(deps, ["terminal", "close", "--terminal", t.handle, "--json"], LIST_TIMEOUT_MS);
      closedDuplicates.push(t.handle);
    }
  }

  // #124 M2: the survivor must be HEALTHY to count. A connected but
  // orphaned/unwritable attach answers no `terminal send` (#55 defect B) —
  // close it and fall through to create a working one.
  const kept = rankAttachTerminals(attachTerminals, id)[0];
  if (kept && !isHealthyAttach(kept, id) && kept.handle) {
    await orcaJson(deps, ["terminal", "close", "--terminal", kept.handle, "--json"], LIST_TIMEOUT_MS);
  }

  if (!created && kept && isHealthyAttach(kept, id)) {
    // The shortcut above only ever fires on a REPEAT call against a worktree
    // that already existed before this call started — never on the branch
    // that just created the worktree. See the comment just below for why.
    return { kind: "exists", closedDuplicates };
  }

  // Defensive handling for an UNCONFIRMED hypothesis (Acme CTO report; not
  // measurable from inside this container — no Orca here to check against).
  // Sometimes the extra tab reported is an EMPTY shell, not a `fleet attach`
  // session. Hypothesis: `orca worktree create` might open its own default
  // terminal as a side effect, before the `terminal create` call below ever
  // runs. If the shortcut above applied uniformly (including right after a
  // brand-new `worktree create`), that hypothesized default terminal would
  // also read `connected: true`, and this code would skip creating the REAL
  // `fleet attach <id>` terminal on the studio's very first call — an empty
  // shell forever, which would make the CTO's report worse, not better. So
  // on the `created` path (this call just made the worktree) the shortcut is
  // never taken and we always proceed to create the attach terminal below,
  // unconditionally. `terminal close` is now a CONFIRMED subcommand (board
  // #57's `removeWorkspace`, and board #42's duplicate-reconcile just above,
  // both call it) — but it is deliberately not used here to tidy up a
  // possible stray default terminal, because on this exact path nothing in
  // `terms` (fetched above, before this call ever created the REAL attach
  // terminal) can be told apart from a hypothesized stray by `isAttachTerminal`:
  // a bare shell from `worktree create`'s own possible side effect would not
  // carry an attach title and so is not even in `attachTerminals` to begin with,
  // and the reconcile pass above only ever runs on terminals that already
  // passed that filter. Residual, unverified-either-way risk: if the stray-
  // terminal hypothesis is true, a studio's first-ever call may leave one
  // extra, harmless, empty stray tab beside the real one — it does not recur
  // on every call (that's the bug fixed above) and it never blocks the real
  // attach terminal from being created.
  const made = await orcaJson(
    deps,
    ["terminal", "create", "--worktree", selector, "--title", id, "--command", `fleet attach ${id}`, "--json"],
    LIST_TIMEOUT_MS,
  );

  // Then stamp the title: it is what lets the operator read WHICH studio a tab
  // belongs to in Orca's own UI. MEASURED on Orca 1.4.198: `--title` on
  // create did not hold and `list` reported the process name "fleet", never
  // this rename. CONTRADICTED live on Orca 1.4.209 (#206, 2026-09-24): `list`
  // reports this `<id>` for minutes, until the #153 OSC title replaces it —
  // which is why `isAttachTitle` accepts `<id>`, else a second ensure in that
  // window stacks another client.
  const handle = made.result?.terminal?.handle;
  if (handle) await orcaJson(deps, ["terminal", "rename", "--terminal", handle, "--title", id, "--json"], LIST_TIMEOUT_MS);
  return { kind: "created", closedDuplicates };
}

// ---------------------------------------------------------------------------
// Teardown — board issue #57. `ensureStudioWorkspace` gives every running
// studio a visible sidebar row; `fleet destroy` stopping the container never
// removed it, leaving a dead attach terminal and a stale row that looks
// identical to a live studio. `removeStudioWorkspace` is the counterpart
// `cli/fleet.ts`'s `cmdDestroy` calls on a successful destroy — same injected
// `OrcaDeps`, same "never fails its caller" posture as `ensureStudioWorkspace`
// above (a destroy that stopped the container must never exit non-zero
// because Orca cleanup afterward is absent, wedged, or errors).

export type ContextSalvageDeps = SalvageDestination;

/** `~/fleet-teardown-salvage` — durable, outside any worktree a `rm` could
 *  ever reach, so a salvage never lands somewhere the NEXT teardown deletes. */
export function defaultSalvageDestination(): ContextSalvageDeps {
  return { root: join(homedir(), "fleet-teardown-salvage"), now: () => new Date() };
}

export type WorkspaceRemovalOutcome =
  | { kind: "skipped"; why: string }
  /** No row. `closedAttach`: stray `fleet attach` terminals found by path
   *  and closed — a live one reconnects and boots a new container. */
  | { kind: "absent"; closedAttach: string[]; survivingPaths: string[] }
  /** #124 item 7: the lookup failed or was partial — absence NOT proven. */
  | { kind: "unverified"; why: string }
  | { kind: "removed"; salvage: SalvageOutcome }
  | { kind: "refused"; why: string }
  | { kind: "failed"; why: string };

export async function removeStudioWorkspace(
  id: string, deps: OrcaDeps, salvageDest: ContextSalvageDeps = defaultSalvageDestination(),
): Promise<WorkspaceRemovalOutcome> {
  if (!orcaPresent(deps)) return { kind: "skipped", why: "not running under Orca" };
  try {
    return await removeWorkspace(id, deps, salvageDest);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { kind: "failed", why };
  }
}

/** Folder basenames Orca may have given studio `id`'s worktree: the name
 *  verbatim, and with hyphen runs folded (MEASURED 2026-09-24: studio
 *  `fleetflare--web-studio` lives at `.../studio-fleetflare-web-studio`). */
function studioFolderNames(id: string): string[] {
  const name = studioWorkspaceName(id);
  return [name, name.replace(/-+/g, "-")];
}

async function removeWorkspace(id: string, deps: OrcaDeps, salvageDest: ContextSalvageDeps): Promise<WorkspaceRemovalOutcome> {
  const name = studioWorkspaceName(id);
  let existing: OrcaWorktree | undefined;
  try {
    existing = findStudioWorktree(id, await fullList(deps, "worktrees", LIST_TIMEOUT_MS), deps.registry);
  } catch (err) {
    return { kind: "unverified", why: err instanceof Error ? err.message : String(err) };
  }
  if (!existing) {
    // #124 item 7, LIVE 2026-09-24 16:01Z: "teardown already complete" was
    // printed while the studio's `fleet attach` terminal lived on — it
    // reconnected and booted a new billing container. No row is not proof:
    // sweep every terminal for an attach in this studio's folder first.
    let terms: OrcaTerminalEntry[];
    try {
      terms = await fullList(deps, "terminals", LIST_TIMEOUT_MS);
    } catch (err) {
      return { kind: "unverified", why: err instanceof Error ? err.message : String(err) };
    }
    // By folder, ANY title (#135 review): the live orphaned PTY — tab-less,
    // an invisible reconnecting client — reports title null. The found-row
    // path below closes every terminal too.
    const folders = studioFolderNames(id);
    const closedAttach: string[] = [];
    const survivingPaths = new Set<string>();
    for (const t of terms) {
      const path = t.worktreePath ?? "";
      if (!t.handle || !folders.includes(path.split("/").pop() ?? "")) continue;
      await orcaJson(deps, ["terminal", "close", "--terminal", t.handle, "--json"], LIST_TIMEOUT_MS);
      closedAttach.push(t.handle);
      survivingPaths.add(path);
    }
    return { kind: "absent", closedAttach, survivingPaths: [...survivingPaths] };
  }

  // Close the attach terminal first — by `id:`, a read/administrative
  // selector, not the destructive call this file's by-path rule is about.
  // Runs even if the worktree's path later turns out unknown: a dead
  // terminal handle is worth closing regardless of whether the worktree
  // itself can be safely removed below.
  if (existing.id) {
    const terms = await orcaJson(deps, ["terminal", "list", "--worktree", `id:${existing.id}`, "--json"], LIST_TIMEOUT_MS);
    for (const t of terms.result?.terminals ?? []) {
      if (t.connected === true && t.handle) {
        await orcaJson(deps, ["terminal", "close", "--terminal", t.handle, "--json"], LIST_TIMEOUT_MS);
      }
    }
  }

  const path = existing.path;
  if (!path) {
    return {
      kind: "refused",
      why: `worktree "${name}" has no reported path from Orca — refusing to remove it by name (a "name:" `
        + `selector also matches branch names and has destroyed a live agent mid-task in a real incident); `
        + `remove it yourself once you have confirmed its absolute path: orca worktree rm --worktree "path:<abs>"`,
    };
  }

  // Salvage BEFORE removal, always — `.context/` is gitignored evidence a
  // blind `rm` would destroy with no trace. A failed salvage refuses the
  // removal rather than proceeding blind; see context-salvage.ts's header.
  const salvage = salvageContext(path, id, salvageDest);
  if (salvage.kind === "refused") {
    return {
      kind: "refused",
      why: `${salvage.why} — worktree "${name}" (${path}) NOT removed: has `
        + `${salvage.inventory.screenshotCount} screenshot(s) + ${salvage.inventory.contextFileCount} `
        + `context file(s) in .context/`,
    };
  }

  // BY PATH, NEVER BY NAME. See the refusal branch above and this file's
  // header for why — never construct a `name:` selector for this call.
  await orcaJson(deps, ["worktree", "rm", "--worktree", `path:${path}`, "--force", "--json"], CREATE_TIMEOUT_MS);
  return { kind: "removed", salvage };
}

/** One line per fact worth telling the operator — `cli/fleet.ts` prints each
 *  through the same `console.error("fleet: " + line)` channel `ensure()`'s
 *  own failures already use. Pure so it is unit-testable without a fake
 *  Orca run at all. */
export function describeWorkspaceRemoval(id: string, outcome: WorkspaceRemovalOutcome): string[] {
  switch (outcome.kind) {
    case "skipped":
      return [];
    case "absent":
      if (!outcome.closedAttach.length) return [`${id}: no Orca worktree or attach terminal found — teardown complete`];
      // A terminal in the studio folder proves the worktree survives — the
      // lookup missed it. Name it and its by-PATH removal.
      return [
        `${id}: closed terminal(s) ${outcome.closedAttach.join(", ")} in a studio worktree the lookup missed `
          + "— a live attach restarts the container",
        ...outcome.survivingPaths.map((p) => `${id}: worktree survives at ${p}; remove it: orca worktree rm --worktree "path:${p}"`),
      ];
    case "unverified":
      return [`${id}: ${couldNotVerify(id, outcome.why)}`];
    case "removed": {
      const lines = [`${id}: Orca worktree and attach terminal removed`];
      if (outcome.salvage.kind === "salvaged") {
        lines.push(
          `${id}: salvaged .context/ (${outcome.salvage.inventory.screenshotCount} screenshot(s), `
            + `${outcome.salvage.inventory.contextFileCount} context file(s)) to ${outcome.salvage.destination}`,
        );
      }
      return lines;
    }
    case "refused":
      return [`${id}: worktree NOT removed — ${outcome.why}`];
    case "failed":
      return [`${id}: worktree teardown failed — ${couldNotVerify(id, outcome.why)}`];
  }
}

function couldNotVerify(id: string, why: string): string {
  return `could not verify teardown: ${why}; close any attach terminal for ${id} by hand — a live attach restarts the container`;
}

/**
 * Remove + describe, as one call — the only shape every teardown caller
 * (destroy, reap) ever used. Returns the lines so the caller just prints them;
 * `removeStudioWorkspace`'s default salvage destination flows through
 * unchanged, since no caller passes one.
 */
export async function closeStudioRow(id: string, deps: OrcaDeps): Promise<string[]> {
  return describeWorkspaceRemoval(id, await removeStudioWorkspace(id, deps));
}

// ---------------------------------------------------------------------------
// fleet ls's ROW column — board #55 defect B, #57 item 4. The Orca row is
// where the operator looks at a studio; `fleet ls` must say when it lies.
// Stopped + row = teardown unfinished. Running + no healthy attach = a
// studio whose agent never answers a `terminal send`.

export function classifyStudioRow(
  studio: Pick<StudioStatus, "id" | "state" | "containerRunningSince">,
  worktree: { id?: string } | undefined,
  terminals: OrcaTerminalEntry[],
): string {
  // #124 N2: "stopped" with a live container is billing (#95) — its row is
  // the only local sign. Judge it as running; never invite removing it.
  const running = studio.state !== "stopped" || Boolean(studio.containerRunningSince);
  if (!running) return worktree ? "STALE row" : "none";
  if (!worktree) return "NO row";
  // #299: never a bare "-" — that read as a verdict. Says what is missing.
  if (!worktree.id) return "? no id";
  const attach = terminals.filter((t) => t.worktreeId === worktree.id && isAttachTitle(t.title, studio.id));
  const healthy = attach.filter((t) => isHealthyAttach(t, studio.id));
  // #206: a STALE client is present and reconnecting itself — flagged, never
  // replaced, so `fleet tabs` stacks no second client beside it.
  if (healthy.some((t) => attachTitleState(studio.id, t.title) !== "stale")) return "ok";
  if (healthy.length) return "attach STALE";
  return attach.length ? "attach DEAD" : "NO attach";
}

/** `rows` per studio id; `footer` is null on a full answer, else ONE stdout
 *  line naming why every row reads `?`. */
export interface StudioRows {
  rows: Map<string, string>;
  footer: string | null;
}

/** Two orca calls for the whole table. Outside Orca or on any orca failure
 *  every row reads `?` and the footer says which (#299: the old bare `-`
 *  looked like a verdict, and the failure reason went to stderr only, lost
 *  under `fleet ls 2>&1 | grep`). A read-only listing never fails on this. */
export async function readStudioRows(studios: StudioStatus[], deps: OrcaDeps): Promise<StudioRows> {
  const unknown = (why: string): StudioRows => ({
    rows: new Map(studios.map((s) => [s.id, "?"])),
    footer: `ROW ?: ${why}`,
  });
  if (deps.hasBinary() === null) return unknown("orca binary not found on PATH — no local Orca row checked");
  if (!orcaPresent(deps)) {
    return unknown("not running under Orca (TERM_PROGRAM is not Orca, no ORCA_WORKTREE_ID) — no local Orca row checked");
  }
  try {
    const [worktrees, terms] = await Promise.all([
      fullList(deps, "worktrees", ROW_TIMEOUT_MS), fullList(deps, "terminals", ROW_TIMEOUT_MS),
    ]);
    return {
      rows: new Map(studios.map((s) => [s.id, classifyStudioRow(s, findStudioWorktree(s.id, worktrees, deps.registry), terms)])),
      footer: null,
    };
  } catch (err) {
    return unknown(`Orca did not answer — ${err instanceof Error ? err.message : String(err)}; re-run fleet ls`);
  }
}

/**
 * Board #220: the read-only counterpart a coordinator actually needed — a
 * blocked lead's Orca terminal `handle` (the identifier `orca terminal
 * send`/similar takes), without running `fleet tabs`. `fleet tabs` is a
 * RECONCILING command (creates/closes/renames terminals, #206) and stacks an
 * extra attach client as a side effect just to answer a read; Orca's own
 * titles are also often ambiguous or truncated (`'..re-web-studio'`, a bare
 * `'fleet'`), so `fleet tabs`'s own output does not reliably say which
 * terminal belongs to which studio either.
 *
 * Same template as `readStudioRows` just above — the SAME two `worktree
 * list`/`terminal list` reads, scoped to one studio's worktree — and the
 * same "never fails its caller" posture as every other entry point in this
 * file: `null`, never a throw, when Orca is absent, the studio has no
 * worktree, no healthy attach terminal exists for it, or any orca call
 * fails. Strictly read-only: makes NO `terminal create`/`close`/`rename`
 * call, ever — only the two LIST calls above.
 */
export async function findAttachHandle(id: string, deps: OrcaDeps): Promise<string | null> {
  if (!orcaPresent(deps)) return null;
  try {
    const [worktrees, terms] = await Promise.all([
      fullList(deps, "worktrees", ROW_TIMEOUT_MS), fullList(deps, "terminals", ROW_TIMEOUT_MS),
    ]);
    const worktree = findStudioWorktree(id, worktrees, deps.registry);
    if (!worktree?.id) return null;
    const candidates = terms.filter((t) => t.worktreeId === worktree.id && isHealthyAttach(t, id));
    if (candidates.length === 0) return null;
    return rankAttachTerminals(candidates, id)[0]?.handle ?? null;
  } catch (err) {
    deps.log(`${id}: attach handle lookup failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// fleet tabs.

export interface TabsReport {
  /** Studios that got a row (or a repaired terminal) on this run. */
  opened: string[];
  /** Studios that already had one. */
  existing: string[];
  /** Studios deliberately or unavoidably passed over, each with the reason. */
  skipped: { id: string; why: string }[];
  /**
   * Board #42, requirements 2 and 3: studios where MORE than one connected
   * attach terminal was found and reconciled down to one. Always populated
   * when it happens — never folded silently into `opened`/`existing` — so a
   * recurrence of the duplicate-terminal bug is loud, the same way a
   * `skipped` studio is loud, rather than a studio quietly ending up on the
   * wrong one of two tmux clients again.
   */
  deduped: { id: string; closed: string[] }[];
}

/**
 * The reconcile pass: what makes the rule true for studios that are ALREADY
 * up, not only ones spawned after this shipped.
 *
 * Stopped studios are skipped and never opened — a stopped container costs
 * nothing and spends nothing, so a sidebar row for it is noise, which is the
 * opposite of what this feature is for. Everything else gets one, including
 * `provisioning` and `degraded`: both are containers that exist and burn.
 *
 * The duplicate-reconcile itself (board #42) lives inside `ensure()`, not
 * here — every call site gets it, not only `fleet tabs` — this loop only
 * reads `closedDuplicates` back off the outcome to report it loudly.
 */
export async function reconcileStudioWorkspaces(
  studios: StudioStatus[],
  // Board #39: a resolver, not a title — `fleet tabs` reconciles many studios
  // and each row's title is that studio's own current task.
  titleFor: (id: string) => string,
  deps: OrcaDeps,
): Promise<TabsReport> {
  const report: TabsReport = { opened: [], existing: [], skipped: [], deduped: [] };
  for (const s of studios) {
    if (s.state === "stopped") {
      report.skipped.push({ id: s.id, why: "stopped" });
      continue;
    }
    const outcome = await ensureStudioWorkspace(s.id, titleFor(s.id), deps);
    if (outcome.kind === "created") report.opened.push(s.id);
    else if (outcome.kind === "exists") report.existing.push(s.id);
    else report.skipped.push({ id: s.id, why: outcome.why });
    if ((outcome.kind === "created" || outcome.kind === "exists") && outcome.closedDuplicates?.length) {
      report.deduped.push({ id: s.id, closed: outcome.closedDuplicates });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Issue #216: the printed plan `fleet tabs` shows BEFORE it touches anything.
//
// `previewStudioWorkspace` answers the SAME "does this studio already have a
// workspace?" question `ensure()` (above) answers for itself before ever
// creating one — one read-only `worktree list --json` plus `findStudioWorktree`,
// the exact lookup `ensure()`'s own `existing` local uses at line ~515.
// Reusing it here rather than inventing a second way to ask is deliberate: two
// independent answers to "does it exist" could disagree, and a plan that
// disagrees with the run it precedes would be worse than no plan at all.
//
// This is deliberately SHALLOWER than `ensure()`'s full decision (which also
// inspects the worktree's terminal for a HEALTHY attach, board #42/#124): a
// worktree that exists but whose attach terminal is missing or unhealthy
// still previews as "has one" here, even though the real run would then
// repair it (an "opened" outcome). Checking that too would mean the preview
// itself makes the `terminal list` call `ensure()` makes — doubling this
// read-only pass's Orca I/O for a distinction the issue's own output format
// does not ask for (`open` / `has one` / `skipped: reason`, not a health
// verdict). The coarser question is what `reconcileStudioWorkspaces` skips
// for free too (`state === "stopped"`, no Orca call at all), which is why
// `planStudioWorkspaces` below mirrors that same skip.

export type WorkspacePreview =
  | { kind: "open" }
  | { kind: "has one" }
  | { kind: "skipped"; why: string };

export async function previewStudioWorkspace(id: string, deps: OrcaDeps): Promise<WorkspacePreview> {
  if (!orcaPresent(deps)) return { kind: "skipped", why: "not running under Orca" };
  try {
    const listed = await orcaJson(deps, ["worktree", "list", "--json"], LIST_TIMEOUT_MS);
    const worktrees = listed.result?.worktrees ?? [];
    return findStudioWorktree(id, worktrees, deps.registry) ? { kind: "has one" } : { kind: "open" };
  } catch (err) {
    return { kind: "skipped", why: err instanceof Error ? err.message : String(err) };
  }
}

export type TabsPlanEntry =
  | { id: string; kind: "open" }
  | { id: string; kind: "has one" }
  | { id: string; kind: "skipped"; why: string };

/**
 * The plan `fleet tabs` prints before it calls `reconcileStudioWorkspaces`
 * for real — same "stopped is skipped for free, everything else is asked
 * about" shape as that function's own loop, on purpose: this is meant to be
 * called on the exact studio list (already repo-scoped) `fleet tabs` is
 * about to reconcile, so the two loops can never drift into naming a
 * different set of studios.
 */
export async function planStudioWorkspaces(studios: StudioStatus[], deps: OrcaDeps): Promise<TabsPlanEntry[]> {
  const plan: TabsPlanEntry[] = [];
  for (const s of studios) {
    if (s.state === "stopped") {
      plan.push({ id: s.id, kind: "skipped", why: "stopped" });
      continue;
    }
    const preview = await previewStudioWorkspace(s.id, deps);
    plan.push(preview.kind === "skipped" ? { id: s.id, kind: "skipped", why: preview.why } : { id: s.id, kind: preview.kind });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The real wiring.

/** Spawns the orca CLI, killing it at `timeoutMs`. Never throws: a spawn that
 *  cannot even start reads as a failed call, which the caller already handles
 *  identically to a failed command. */
export function orcaRunner(bin: string): OrcaRun {
  return async (args, timeoutMs) => {
    let timedOut = false;
    try {
      const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return { ok: code === 0 && !timedOut, stdout, stderr, timedOut };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut };
    }
  };
}

// ---------------------------------------------------------------------------
// The lock's real wiring — board #42. `~/.fleet/locks/`, same directory
// convention as board #39's `~/.fleet/orca-workspaces.json`: small, local,
// Mac-side, per-machine state, not a credential.

const LOCK_DIR = join(homedir(), ".fleet", "locks");

/** One studio id -> one filesystem-safe lock filename. Studio ids already
 *  carry `--`, which is a fine filename character, but stay conservative
 *  (letters/digits/dash/underscore only) rather than assume every possible
 *  id is a safe path segment. */
export function lockFileName(studioId: string): string {
  return `${studioId.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`;
}

/**
 * File-backed lock, exclusive create (`wx` — fails with `EEXIST` if the file
 * already exists) as the acquire, `unlink` as the release. This is what
 * makes the mutual exclusion hold ACROSS PROCESSES, not just within one —
 * the actual gap board #42 is about (two separate `fleet` invocations, e.g.
 * `fleet spawn` and `fleet tabs`, are two separate OS processes with no
 * shared memory to put an in-process mutex in). `dir` is a parameter (not
 * baked in) purely so `test/bun/orca-workspace.test.ts` can point this at a
 * throwaway tmpdir and prove the real mechanism, not just a fake standing in
 * for it; `fileLock` below is what `defaultOrcaDeps()` actually wires,
 * always against `LOCK_DIR`.
 *
 * Bounded on both ends, matching this file's property 5: polls up to
 * `LOCK_WAIT_MS` (throws past that — the caller's existing try/catch turns
 * it into `{kind: "failed"}`, never a hang) and treats a lock file older
 * than `LOCK_STALE_MS` as abandoned by a holder that crashed mid critical-
 * section, stealing it rather than honouring it forever.
 */
export async function fileLockAt<T>(
  dir: string, studioId: string, fn: () => Promise<T>, budget: LockBudget = STUDIO_LOCK_BUDGET,
): Promise<T> {
  const path = join(dir, lockFileName(studioId));
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + budget.waitMs;
  for (;;) {
    try {
      writeFileSync(path, `${process.pid}`, { flag: "wx" });
      break; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > budget.staleMs) {
          unlinkSync(path); // abandoned by a crashed holder — steal it
          continue;
        }
      } catch {
        continue; // raced the holder's own release; just retry the acquire
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${Math.round(budget.waitMs / 1000)}s waiting for another fleet command's lock on "${studioId}"`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Already gone (raced a stale-lock steal from a THIRD caller past the
      // deadline above) — the lock is released either way, fine.
    }
  }
}

function fileLock<T>(studioId: string, fn: () => Promise<T>): Promise<T> {
  return fileLockAt(LOCK_DIR, studioId, fn);
}

/** What every command in cli/ passes. `ORCA_CLI_COMMAND` is honoured because
 *  Orca exports it for managed WSL sessions, where plain `orca` is wrong. */
// ---------------------------------------------------------------------------
// The registry's real wiring — board #39. Small JSON file, `~/.fleet/` same
// as `~/.fleet/credentials` (cli/fleet.ts): the established spot for small,
// local, Mac-side state that isn't a credential.

const WORKSPACE_REGISTRY_PATH = join(homedir(), ".fleet", "orca-workspaces.json");

/** One pseudo-studio-id: `fileLockAt`'s own mutual exclusion, reused whole
 *  rather than reinvented, to serialize the registry's OWN read-modify-write
 *  — see `fileWorkspaceRegistry`'s doc comment for the race this closes. Not
 *  a real studio id (never collides with one: studio ids are always
 *  `<repo>--<role>`, which this contains no `--` in). */
const REGISTRY_LOCK_ID = "orca-workspace-registry-file";

function readRegistryFile(path: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * File-backed `WorkspaceRegistry`. Never throws either direction — a
 * missing/corrupt file just reads as empty (falls through to
 * `findStudioWorktree`'s path-basename fallback lookup); a write failure is
 * swallowed (the next process falls back the same way) — see the
 * interface's own comment for why that's the right degrade, not a hard
 * failure.
 *
 * Board #175: the PREVIOUS version cached its first read for the whole
 * process and blind-overwrote the file on every `set` — a plain, unlocked
 * read-modify-write. The #42 per-studio lock (`deps.lock`) does not cover
 * this: it serializes `ensure()`'s own check-then-act for ONE studio id,
 * so two `fleet` processes ensuring DIFFERENT studios (`ff`, `fleet spawn`,
 * `fleet tabs`, `fleet provision`, `fleet recycle` — `fleet ls` only reads)
 * take DIFFERENT locks and can freely interleave their registry writes. Measured
 * shape: process A loads {x: idX}, process B loads the same {x: idX}, B
 * writes {x: idX, y: idY}, A — still holding its stale in-memory snapshot —
 * writes {x: idX} right over it, and B's studio y entry is gone. `set` now
 * re-reads the file FRESH, under ONE registry-wide lock every writer takes
 * (`REGISTRY_LOCK_ID`, `fileLockAt`'s own cross-process mutual exclusion —
 * reused, not reinvented, same posture #42's own comment already argues
 * for), merges this one key in, and writes via a same-directory temp file +
 * `renameSync` — an atomic replace, so a process killed mid-write can never
 * leave a half-written, corrupt registry file for the next reader to trip
 * over. `get` reads fresh every call too, for the same reason: a cached
 * value can go stale the instant a DIFFERENT process's `set` lands.
 */
export function fileWorkspaceRegistry(path: string, lockDir: string = LOCK_DIR): WorkspaceRegistry {
  return {
    get: (studioId) => readRegistryFile(path)[studioId],
    // Board #175 fix round: `set` must NEVER reject — the interface's own
    // doc comment ("never a failure of ensureStudioWorkspace itself") holds
    // for every writer of this port, and `fileLockAt` itself is NOT
    // exempt: it throws past LOCK_WAIT_MS when the registry-wide lock stays
    // held (a wedged/very slow holder). Before this fix that throw
    // propagated straight out of `ensure()`'s own `await deps.registry.set(...)`
    // and turned a studio whose worktree/terminal were created just fine
    // into a REPORTED FAILURE — over a lock timeout on a best-effort cache.
    // The write itself was already best-effort (the inner try/catch); the
    // lock acquisition now is too.
    set: async (studioId, worktreeId) => {
      try {
        await fileLockAt(lockDir, REGISTRY_LOCK_ID, async () => {
          const data = readRegistryFile(path);
          data[studioId] = worktreeId;
          mkdirSync(dirname(path), { recursive: true });
          const tmp = `${path}.tmp-${process.pid}`;
          writeFileSync(tmp, JSON.stringify(data, null, 2));
          renameSync(tmp, path);
        }, REGISTRY_LOCK_BUDGET);
      } catch {
        // Best-effort persistence — see this function's own doc comment.
      }
    },
  };
}

export function defaultOrcaDeps(): OrcaDeps {
  const bin = process.env.ORCA_CLI_COMMAND || "orca";
  return {
    env: process.env as Record<string, string | undefined>,
    hasBinary: () => Bun.which(bin),
    log: (line) => console.error(`fleet: ${line}`),
    run: orcaRunner(bin),
    lock: fileLock,
    registry: fileWorkspaceRegistry(WORKSPACE_REGISTRY_PATH),
  };
}
