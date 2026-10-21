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
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { parseStudioId } from "../src/studio/ids";
import { repoIdSegment } from "../src/studio/repo";
import type { StudioStatus } from "../src/studio/types";
import type { BoardTask } from "../src/board/types";
import type { AssignWakeReport } from "../src/board/assign-wake";
import { salvageContext, type SalvageOutcome, type SalvageDestination } from "./context-salvage";
import { attachTitleState, ATTACH_STALE_MS } from "./attach-liveness";
import { errText } from "./diag";

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

interface LockBudget {
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

type OrcaRun = (args: string[], timeoutMs: number) => Promise<OrcaResult>;

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

type WorkspaceOutcome =
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
  /** The terminal's screen text (MEASURED on real Orca — see this interface's
   *  own doc comment). Read by `sendLocalWake` to confirm the claude TUI still
   *  owns the terminal's foreground before typing a wake into it. */
  preview?: string;
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
    // `path` on the SINGLE worktree result is MEASURED on real Orca (the
    // `worktree create` envelope carries it) — the local-studio path reads it
    // to know where the lead's project-scoped files land, without a second
    // `worktree list` round trip.
    worktree?: { id?: string; displayName?: string; path?: string };
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
 *  answer is partial (`truncated`) or not the expected array — #124 M1/M3: an
 *  empty answer only proves absence when it is complete. Unparseable output
 *  never gets this far: orcaJson itself throws (#516), so the shape check here
 *  only catches a parsed-but-wrong envelope (truncated / missing array). */
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
    throw new Error(`${what} printed unparseable JSON`);
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
    const why = errText(err);
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

// ---------------------------------------------------------------------------
// Fleet task #1248: the LOCAL studio worktree. A local studio (host:"local")
// runs on the operator's Mac, not in a container — so the worktree is created
// from a LOCAL clone (`path:<localPath>`), not from an Orca-managed repo id,
// and the lead is materialized PROJECT-SCOPED (the worktree's own .claude/),
// never into the global ~/.claude (board #20 cancelled the `fleet gates
// install` verb, so nothing may write the Mac's global settings.json).

/** The worktree create argv for a local studio — from a local clone, on the
 *  origin default branch, as a `claude` agent worktree. Pure so a test pins
 *  the exact tokens (`--repo path:`, `--base-branch origin/`, `--agent
 *  claude`) without a fake Orca run. */
export function localWorktreeCreateArgs(localPath: string, defaultBranch: string, id: string): string[] {
  return [
    "worktree", "create",
    "--repo", `path:${localPath}`,
    "--base-branch", `origin/${defaultBranch}`,
    "--agent", "claude",
    "--name", studioWorkspaceName(id),
    "--no-parent", "--setup", "skip", "--json",
  ];
}

/** The claude launch line the attach terminal runs. The prompt is passed by
 *  FILE — `"$(cat <file>)"` is expanded by the terminal's shell into ONE argv
 *  element, so the line stays a few hundred bytes however large the brief is
 *  (studio-bringup.sh's own issue #6 technique). Pure so a test pins it.
 *
 *  The `STUDIO_ID=<id>` env-assignment prefix is the ARMING SWITCH: on the
 *  operator's Mac STUDIO_ID is never set in the ambient environment (the cloud
 *  container arms the gate via its own process env, the Mac has none by
 *  default), so gates/lead-gate.sh's first line — `[ -n "${STUDIO_ID:-}" ] ||
 *  exit 0` — would exit 0 before ANY gate logic ran and the lead would be
 *  ungated. The prefix makes claude — and every hook subprocess it spawns —
 *  inherit STUDIO_ID, so the gate actually arms. It is a shell env-assignment
 *  prefix, valid for the `--command` string Orca runs.
 *
 *  Deliberately NO --dangerously-skip-permissions: this lead runs on the
 *  operator's own Mac, not a Firecracker microVM, so permission prompts stay
 *  on — the lead-gate PreToolUse hook (not --disallowedTools, which would
 *  starve members too) is the structural guard against the lead implementing,
 *  and the operator is present to approve the members' writes. */
export function localLaunchCommand(id: string, worktreePath: string, promptFilePath: string, allowedTools: string, effort: string): string {
  const args = [
    "claude",
    // The inner path is quoted too: a worktree path with a space must survive
    // the `$(cat ...)` expansion (the shell reads the path between the two
    // quotes), or the launch line breaks on the first space.
    "--append-system-prompt", `"$(cat "${promptFilePath}")"`,
    "--allowedTools", `"${allowedTools}"`,
  ];
  if (effort !== "") args.push("--effort", effort);
  // FLEET_WORKSPACE points session-reemit/completion-gate at the worktree's .fleet/, not the container /workspace default.
  return `STUDIO_ID=${id} FLEET_WORKSPACE="${worktreePath}" ${args.join(" ")}`;
}

/**
 * The fail-closed PreToolUse hook command, matcher `.*` — the SAME guarded
 * shape studio-bringup.sh writes for the cloud lead, but PROJECT-scoped:
 * `$CLAUDE_PROJECT_DIR` is claude's own pointer to the project root and is
 * stable however the lead `cd`'s around inside it, whereas `$PWD` is claude's
 * CURRENT directory — a lead that `cd`'d into a subdir made `$PWD` wrong, the
 * script read as "absent", and the `exit 2` refused every tool call (lead AND
 * members). A missing or non-executable hook refuses the call (`exit 2`, the
 * only code claude treats as block) rather than waving a write through.
 * Extracted so a test pins it verbatim.
 */
export function localLeadGateHookCommand(): string {
  return 'S="$CLAUDE_PROJECT_DIR/.claude/hooks/lead-gate.sh"; ' +
    '[ -x "$S" ] || { echo "lead-gate hook absent or not executable -- refusing (decision 11)" >&2; exit 2; }; ' +
    'exec "$S"';
}

/** Args for the `ensureLocalStudioWorktree` materialization step. */
export interface LocalStudioArgs {
  /** The Mac-side absolute path to the local clone the worktree is made from. */
  localPath: string;
  /** The plain default-branch name (resolved by the caller, e.g. `main`). */
  defaultBranch: string;
  /** The decoded role prompt (goes to `<worktree>/.fleet/working-set.md`). */
  prompt: string;
  /** The role's allowedTools string (comma/space grammar claude parses). */
  allowedTools: string;
  /** Role effort; "" means claude's own default, so no --effort is passed. */
  effort?: string;
  /** Decoded member map: `{ "<name>.md": "<raw md body>" }`. */
  members?: Record<string, string>;
  /** Skill names to symlink into the worktree's `.claude/skills`. */
  skills?: string[];
  /** Tier-0 completion gate: install the completion-gate Stop hook when the
   *  roster writes code (writesCode on the members). */
  completionGate?: boolean;
}

/**
 * Give a LOCAL studio its Orca worktree + attach terminal, and materialize
 * the lead into it. Same five properties as `ensureStudioWorkspace` (never
 * throws, no-op outside Orca, idempotent by the deterministic name, never
 * steals focus, bounded), plus one this path adds: the lead gate is FAIL-
 * CLOSED — if the hook copy or settings write cannot land, the whole thing
 * returns `{ kind: "failed" }` rather than booting an ungated lead.
 *
 * The lead is materialized PROJECT-SCOPED, under the worktree's own
 * `.claude/`, never the global `~/.claude/settings.json` (board #20 cancelled
 * that verb) — and the fail-closed hook command resolves the script by
 * `$CLAUDE_PROJECT_DIR/.claude/hooks/lead-gate.sh` so the SAME settings.json
 * bytes work no matter where the worktree actually lands on disk.
 */
export async function ensureLocalStudioWorktree(
  id: string, deps: OrcaDeps, args: LocalStudioArgs,
): Promise<WorkspaceOutcome> {
  if (!orcaPresent(deps)) {
    if (deps.hasBinary() === null && !deps.env.STUDIO_ID) {
      deps.log(`orca not found on PATH — no Orca sidebar row for ${id}. Orca is optional; attach from any terminal with: fleet attach ${id}`);
    }
    return { kind: "skipped", why: "not running under Orca" };
  }
  try {
    const name = studioWorkspaceName(id);

    // Fleet task #1259 item 7: a resume must REUSE the kept worktree, not
    // `worktree create` a second one. The default destroy KEEPS the worktree
    // (cli/fleet.ts's localTeardownDecision), so the row it built still exists
    // on disk; creating again would either clash on the name or leave a fresh
    // checkout beside the kept unsynced one the registry still points at.
    // A list we cannot read falls through to the create path below, exactly
    // as before this lookup existed.
    let existing: OrcaWorktree | undefined;
    try {
      existing = findStudioWorktree(id, await fullList(deps, "worktrees", LIST_TIMEOUT_MS), deps.registry);
    } catch {
      existing = undefined;
    }
    if (existing?.path) {
      await deps.registry.set(id, existing.id ?? "");
      materializeLocalLead(existing.path, args, deps);
      const selector = existing.id ? `id:${existing.id}` : `name:${name}`;

      // Fix 2 (#1259 round 3): reconcile against an already-live attach
      // terminal BEFORE creating one, exactly like `ensure()` does for the
      // container path. The default `fleet destroy` keeps both the worktree
      // AND its terminal (cli/fleet.ts's `localTeardownDecision` only closes
      // the terminal on an actual `remove`), so a resume that always created
      // a new terminal here could boot a SECOND lead claude process beside a
      // still-live one — double AI spend, two processes racing the same
      // checkout. `reconcileAttachTerminals` closes duplicates/unhealthy
      // survivors and returns the keeper; `isHealthyAttach` is the same
      // health gate `ensure()` already trusts.
      const { kept } = await reconcileAttachTerminals(id, selector, deps);
      if (kept && isHealthyAttach(kept, id)) {
        return { kind: "exists" };
      }

      const command = localLaunchCommand(id, existing.path, join(existing.path, ".fleet", "working-set.md"), args.allowedTools, args.effort ?? "");
      const term = await orcaJson(
        deps,
        ["terminal", "create", "--worktree", selector, "--title", id, "--command", command, "--json"],
        LIST_TIMEOUT_MS,
      );
      const handle = term.result?.terminal?.handle;
      if (handle) {
        await orcaJson(deps, ["terminal", "rename", "--terminal", handle, "--title", id, "--json"], LIST_TIMEOUT_MS);
      }
      return { kind: "created" };
    }

    const made = await orcaJson(
      deps,
      localWorktreeCreateArgs(args.localPath, args.defaultBranch, id),
      CREATE_TIMEOUT_MS,
    );
    const madeWorktree = made.result?.worktree;
    const selector = madeWorktree?.id ? `id:${madeWorktree.id}` : `name:${name}`;
    if (madeWorktree?.id) await deps.registry.set(id, madeWorktree.id);

    // The worktree's on-disk path — where the lead's files land. Orca reports
    // it on the create result; when it does not (or a list must be read),
    // resolve it from the worktree list, then refuse fail-closed if unknown:
    // an ungated lead is invisible, a missing worktree path is not.
    const worktreePath = madeWorktree?.path ?? (await findLocalWorktreePath(id, name, deps));
    if (!worktreePath) {
      throw new Error(`Orca did not report a path for worktree "${name}" — refusing to materialize the lead`);
    }

    materializeLocalLead(worktreePath, args, deps);

    const command = localLaunchCommand(id, worktreePath, join(worktreePath, ".fleet", "working-set.md"), args.allowedTools, args.effort ?? "");
    const term = await orcaJson(
      deps,
      ["terminal", "create", "--worktree", selector, "--title", id, "--command", command, "--json"],
      LIST_TIMEOUT_MS,
    );
    const handle = term.result?.terminal?.handle;
    if (handle) {
      await orcaJson(deps, ["terminal", "rename", "--terminal", handle, "--title", id, "--json"], LIST_TIMEOUT_MS);
    }
    return { kind: "created" };
  } catch (err) {
    const why = errText(err);
    deps.log(`${id}: no Orca workspace opened — ${why}`);
    return { kind: "failed", why };
  }
}

/** The worktree's on-disk path, from the create result already read, or the
 *  worktree list (matched by the deterministic name) when Orca's create
 *  envelope omitted it. Null when it cannot be resolved — the caller refuses. */
async function findLocalWorktreePath(id: string, name: string, deps: OrcaDeps): Promise<string | null> {
  const listed = await orcaJson(deps, ["worktree", "list", "--json"], LIST_TIMEOUT_MS);
  const worktrees = listed.result?.worktrees ?? [];
  const found = findStudioWorktree(id, worktrees, deps.registry);
  return found?.path ?? null;
}

/**
 * Fleet task #1248 review BLOCKER B1 (fix round): the studio's Orca worktree
 * on-disk `path`, for `cli/fleet.ts`'s local-destroy decision. The dirty/ahead
 * git reads must target THIS path — the Orca worktree, a different directory
 * created FROM the clone — never `report.status.localPath` (the SOURCE clone):
 * a clean source with a dirty worktree would still be deleted under
 * `--force --discard-unsynced`.
 *
 * Null (never a throw) when Orca is absent, there is no row for this studio,
 * or the lookup could not verify — the caller keeps the worktree. Same
 * "never fails its caller" posture as every other entry point here: one
 * try/catch, one deps.log line.
 */
export async function resolveStudioWorktreePath(id: string, deps: OrcaDeps): Promise<string | null> {
  if (!orcaPresent(deps)) return null;
  try {
    const worktrees = await fullList(deps, "worktrees", LIST_TIMEOUT_MS);
    return findStudioWorktree(id, worktrees, deps.registry)?.path ?? null;
  } catch (err) {
    deps.log(`${id}: worktree path lookup failed — ${errText(err)}`);
    return null;
  }
}

/**
 * Writes the lead's project-scoped files into the worktree. Fail-closed on
 * the gate: a hook copy or settings write that cannot land throws, and the
 * caller returns `{ kind: "failed" }` — never an ungated lead. The working
 * set, members and skills are best-effort (a lead that boots without them is
 * degraded; a lead that boots without the gate must not boot at all).
 */
function materializeLocalLead(worktreePath: string, args: LocalStudioArgs, deps: OrcaDeps): void {
  // The working set — the same prompt file container bring-up persists, so a
  // compaction can replay it, and the launch line reads it back by file.
  const fleetDir = join(worktreePath, ".fleet");
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(join(fleetDir, "working-set.md"), args.prompt);

  // Members -> native .claude/agents files, bytes verbatim. The map's keys
  // are already the member filenames ("<name>.md") — the same bundle shape
  // studio-blueprint.ts's studioBringupEnv carries to the container.
  const claudeDir = join(worktreePath, ".claude");
  if (args.members) {
    const agentsDir = join(claudeDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const [filename, raw] of Object.entries(args.members)) {
      writeFileSync(join(agentsDir, filename), raw);
    }
  }

  // Skills — symlink each name from THIS repo checkout's skills/<name> into
  // the worktree's .claude/skills, the same `ln -sfn` idempotent shape the
  // container uses (force + no-dereference). A missing source warns loudly
  // and is skipped; it never fails the boot.
  if (args.skills) {
    const skillsDir = join(claudeDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const skill of args.skills) {
      if (skill === "") continue;
      const source = join(import.meta.dir, "..", "..", "..", "skills", skill);
      const link = join(skillsDir, skill);
      if (!existsSync(source)) {
        deps.log(`declared skill "${skill}" resolves to NOTHING at ${source} — studio boots without it`);
        continue;
      }
      try {
        rmSync(link, { force: true });
        symlinkSync(source, link, "dir");
      } catch (err) {
        deps.log(`could not symlink skill "${skill}" — ${errText(err)}`);
      }
    }
  }

  // The lead gate — FAIL CLOSED. Copy the single-source hook script from THIS
  // checkout's gates/ into the worktree's .claude/hooks/, chmod 0755, then
  // write a PROJECT-scoped settings.json whose PreToolUse entry refuses
  // (exit 2) when the script is missing or not executable. Never touches
  // ~/.claude/settings.json. Throws on either failure: the caller's one catch
  // turns it into { kind: "failed" }, so no ungated lead ever boots.
  //
  // IS_MAESTRO is baked to `False` into the COPIED file's bytes, right after
  // the copy lands, never left as the repo-tracked placeholder. A local
  // studio is never maestro (maestro is refused locally), and its members ARE
  // real dispatched members, so `False` is the correct bake: their tool calls
  // get the unconditional non-maestro exemption and the lead's own write-
  // shaped calls are blocked. Same reason studio-bringup.sh bakes it into the
  // container's copy: tamper-with-the-bytes is the trust anchor, never
  // re-derived from a separate file at decision time — an earlier revision
  // read a plain file at runtime and a subagent could overwrite it via Bash.
  // Left unbaked, the placeholder's bare name is a python NameError -> exit 1
  // -> which PERMITS the call (only exit 2 blocks).
  const hooksDir = join(claudeDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookDest = join(hooksDir, "lead-gate.sh");
  const hookSource = join(import.meta.dir, "..", "..", "..", "gates", "lead-gate.sh");
  if (!existsSync(hookSource)) {
    throw new Error(`lead-gate source ${hookSource} missing — refusing to materialize an ungated lead (decision 11)`);
  }
  copyFileSync(hookSource, hookDest);
  chmodSync(hookDest, 0o755);
  const hookBytes = readFileSync(hookDest, "utf8");
  const placeholder = "IS_MAESTRO = __IS_MAESTRO_BOOL__";
  const occurrences = hookBytes.split(placeholder).length - 1;
  if (occurrences !== 1) {
    throw new Error(`lead-gate copy ${hookDest} carried the IS_MAESTRO placeholder ${occurrences} times, expected 1 — refusing to materialize an ungated lead (decision 11)`);
  }
  writeFileSync(hookDest, hookBytes.replace(placeholder, "IS_MAESTRO = False"));

  const settingsPath = localSettingsPath(worktreePath);
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) cfg = {};
  } catch {
    cfg = {};
  }
  const hooks = (cfg.hooks ?? {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];
  const entry = { matcher: ".*", hooks: [{ type: "command", command: localLeadGateHookCommand() }] };
  const merged = { ...cfg, hooks: { ...hooks, PreToolUse: [...pre, entry] } };
  // mkdir first — a settings write to a worktree whose .claude did not exist
  // (the members/skills blocks above may have skipped) must still land.
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

  // Item 1 (#1259): the container installs four more hooks than the local
  // path did. Copy each from gates/ (single source of truth, same as the
  // lead gate), chmod 0755, then merge its settings.json entry. The three
  // observability hooks fail OPEN (warn + skip on a missing source); the
  // completion gate fails CLOSED when completionGate is set — a code-writing
  // studio with no verification gate must not boot (Tier 0).
  const copyHook = (name: string, failClosed: boolean): string | null => {
    const src = join(import.meta.dir, "..", "..", "..", "gates", `${name}.sh`);
    if (!existsSync(src)) {
      if (failClosed) {
        throw new Error(`${name} source ${src} missing — refusing to materialize a lead with no verification gate (Tier 0)`);
      }
      deps.log(`declared hook "${name}" has no source at ${src} — studio boots without it`);
      return null;
    }
    const dest = join(hooksDir, `${name}.sh`);
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    return dest;
  };
  const failOpenCmd = (name: string) =>
    `S="$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.sh"; [ -x "$S" ] && exec "$S"; exit 0`;
  const failClosedCmd = (name: string, why: string) =>
    `S="$CLAUDE_PROJECT_DIR/.claude/hooks/${name}.sh"; ` +
    `[ -x "$S" ] || { echo "${name} hook absent or not executable -- refusing (${why})" >&2; exit 2; }; ` +
    `exec "$S"`;

  const hooksSettingsPath = localSettingsPath(worktreePath);
  let hooksCfg: Record<string, unknown>;
  try {
    hooksCfg = JSON.parse(readFileSync(hooksSettingsPath, "utf8")) as Record<string, unknown>;
    if (typeof hooksCfg !== "object" || hooksCfg === null || Array.isArray(hooksCfg)) hooksCfg = {};
  } catch {
    hooksCfg = {};
  }
  const hooksMap = (hooksCfg.hooks ?? {}) as Record<string, unknown>;
  const eventArr = (evt: string): unknown[] => {
    if (!Array.isArray(hooksMap[evt])) hooksMap[evt] = [];
    return hooksMap[evt] as unknown[];
  };
  const addHookEntry = (evt: string, command: string, matcher?: string) => {
    const entry = { ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", command }] };
    const arr = eventArr(evt);
    const name = command.match(/([a-z-]+)\.sh/)?.[1] ?? command;
    const filtered = arr.filter((e) => !JSON.stringify(e).includes(`${name}.sh`));
    filtered.push(entry);
    hooksMap[evt] = filtered;
  };

  if (copyHook("session-reemit", false)) addHookEntry("SessionStart", failOpenCmd("session-reemit"));
  if (copyHook("install-marker", false)) addHookEntry("PostToolUse", failOpenCmd("install-marker"), ".*");
  if (copyHook("activity-heartbeat", false)) {
    for (const evt of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
      addHookEntry(evt, failOpenCmd("activity-heartbeat"));
    }
  }
  if (args.completionGate) {
    if (copyHook("completion-gate", true)) addHookEntry("Stop", failClosedCmd("completion-gate", "Tier 0"));
  }
  writeFileSync(hooksSettingsPath, JSON.stringify({ ...hooksCfg, hooks: hooksMap }, null, 2));

  // Fleet task #1248 review BLOCKER B3: everything written above lives INSIDE
  // the worktree and is committable — a member `git add -A` would commit the
  // fail-closed settings.json (blocking every tool for anyone else using the
  // repo) and the private working set/house rules/brief into a public repo.
  // The fix is a per-repo exclusion in git's OWN `info/exclude`, never the
  // repo-tracked `.gitignore` (that would be a diff to push). Best-effort:
  // a failed exclude write logs and never fails the boot.
  appendLocalExcludeLines(worktreePath, deps);
}

/**
 * The B3 fix's exact lines, plus the git-port shape `appendLocalExcludeLines`
 * runs on. `git -C <worktree> rev-parse --path-format=absolute --git-path
 * info/exclude` resolves the worktree's exclude file as an ABSOLUTE path —
 * the bare `--git-path` form returns a path relative to the repo's git dir,
 * which `readFileSync`/`writeFileSync` below would resolve against THIS
 * process's cwd (wherever `fleet spawn --local` ran), not the worktree. For a
 * linked worktree git maps `info/exclude` to the common git dir's file, which
 * is the one git actually honours there. Appended idempotently: a line
 * already present is skipped, so a re-run never stacks duplicates. Never
 * throws.
 */
export interface LocalExcludeRun {
  (args: string[], cwd: string): { code: number | null; stdout: string; stderr: string };
}

export const LOCAL_EXCLUDE_LINES = [".fleet/", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/", ".claude/agents/", ".claude/skills/"];

export function appendLocalExcludeLines(worktreePath: string, deps: Pick<OrcaDeps, "log">, run: LocalExcludeRun = defaultLocalExcludeRun): void {
  try {
    const probe = run(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], worktreePath);
    const excludePath = probe.code === 0 ? probe.stdout.trim() : "";
    if (excludePath === "") throw new Error(probe.stderr.trim() || "git could not resolve the exclude path");
    const existing = readFileSync(excludePath, "utf8").split("\n");
    const add = LOCAL_EXCLUDE_LINES.filter((line) => !existing.includes(line));
    if (add.length > 0) writeFileSync(excludePath, [...existing, ...add].join("\n"));
  } catch (err) {
    // Best-effort on purpose: the gate above is fail-closed, but the
    // exclude is only a convenience against a member's later `git add -A` —
    // a boot must never fail because this write could not land.
    deps.log(`could not exclude the lead's files from git (${errText(err)})`);
  }
}

/**
 * Where the lead's project-scoped hooks config lands. `.git/info/exclude`
 * only hides UNTRACKED files, so a repo that COMMITS its own
 * `.claude/settings.json` would still show our writes as a dirty diff a
 * member's `git add -A` could commit. In that case write to
 * `.claude/settings.local.json` instead — Claude Code merges settings.json <
 * settings.local.json < --settings, so the hooks land identically without
 * touching the tracked file. The `git ls-files --error-unmatch` probe decides;
 * any failure (not a git repo, a read error) falls back to settings.json,
 * the pre-item-5 path — the gate still arms either way, since claude reads
 * both files.
 */
export function localSettingsPath(worktreePath: string, run: LocalExcludeRun = defaultLocalExcludeRun): string {
  const probe = run(["ls-files", "--error-unmatch", "--", ".claude/settings.json"], worktreePath);
  return probe.code === 0 ? join(worktreePath, ".claude", "settings.local.json") : join(worktreePath, ".claude", "settings.json");
}

function defaultLocalExcludeRun(args: string[], cwd: string): { code: number | null; stdout: string; stderr: string } {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
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
  const { selector, created } = await ensureWorktreeHalf(id, title, deps);
  const { kept, closedDuplicates } = await reconcileAttachTerminals(id, selector, deps);

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
  await createAttachTerminal(id, selector, deps);
  return { kind: "created", closedDuplicates };
}

async function ensureWorktreeHalf(id: string, title: string, deps: OrcaDeps): Promise<{ selector: string; created: boolean }> {
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
    const why = errText(err);
    console.error(`fleet: ${id}: orca worktree set --display-name failed (title not stamped) -- ${why}`);
  }

  return { selector, created };
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
async function reconcileAttachTerminals(
  id: string,
  selector: string,
  deps: OrcaDeps,
): Promise<{ kept: OrcaTerminalEntry | undefined; closedDuplicates: string[] | undefined }> {
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

  return { kept, closedDuplicates };
}

async function createAttachTerminal(id: string, selector: string, deps: OrcaDeps): Promise<void> {
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
function defaultSalvageDestination(): ContextSalvageDeps {
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
    const why = errText(err);
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
    return { kind: "unverified", why: errText(err) };
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
      return { kind: "unverified", why: errText(err) };
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
 * `salvageDest` forwards through to `removeStudioWorkspace` so a caller (or a
 * test) can redirect the salvage destination without mocking node:os.
 */
export async function closeStudioRow(
  id: string, deps: OrcaDeps, salvageDest: ContextSalvageDeps = defaultSalvageDestination(),
): Promise<string[]> {
  return describeWorkspaceRemoval(id, await removeStudioWorkspace(id, deps, salvageDest));
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
interface StudioRows {
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
    return unknown(`Orca did not answer — ${errText(err)}; re-run fleet ls`);
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
  return (await findAttachTerminal(id, deps))?.handle ?? null;
}

/** The ranked attach terminal for a studio — `findAttachHandle`, but returning
 *  the whole entry so a caller can also read the terminal's screen (`preview`).
 *  Same "never fails its caller" posture: null when Orca is absent, the studio
 *  has no worktree, no healthy attach terminal exists, or any orca call fails. */
export async function findAttachTerminal(id: string, deps: OrcaDeps): Promise<OrcaTerminalEntry | null> {
  if (!orcaPresent(deps)) return null;
  try {
    const [worktrees, terms] = await Promise.all([
      fullList(deps, "worktrees", ROW_TIMEOUT_MS), fullList(deps, "terminals", ROW_TIMEOUT_MS),
    ]);
    const worktree = findStudioWorktree(id, worktrees, deps.registry);
    if (!worktree?.id) return null;
    const candidates = terms.filter((t) => t.worktreeId === worktree.id && isHealthyAttach(t, id));
    if (candidates.length === 0) return null;
    return rankAttachTerminals(candidates, id)[0] ?? null;
  } catch (err) {
    deps.log(`${id}: attach handle lookup failed — ${errText(err)}`);
    return null;
  }
}

/**
 * Fleet task #1259 item 2: wake a LOCAL studio's lead. A local row has no
 * container, so the Worker's assign wake refuses with `{local:true}` and this
 * CLI turns that into the Orca equivalent of the container wake: resolve the
 * studio's healthy attach terminal and type the digest into it. Fail closed —
 * not under Orca, no healthy attach terminal, no claude session in that
 * terminal's foreground, or a failed send all report a refusal, never a
 * silent non-wake.
 *
 * The foreground check is the SAME rule the container's pane gate uses
 * (src/studio/wake.ts: `pane_current_command` reads `claude` when the TUI owns
 * the pane, `bash`/`zsh` when nothing runs). Orca exposes no
 * `terminal read --screen`, so the terminal's `preview` field (the screen text
 * `terminal list --json` already carries) stands in: it must contain one of
 * claude's own chrome glyphs, or the lead has exited to a bare shell and the
 * digest would be typed as a shell command (a `$(…)` in a title would then
 * expand on the operator's Mac).
 *
 * Fix 1 (#1259 round 4): round 3's fix-1b widened the control-byte strip
 * below into a shell-metacharacter strip too (`$`, backtick, backslash, `;`,
 * `|`, `&`, `<`, `>`), as defense-in-depth against an untrusted `digest`. That
 * strip is gone now — not because the threat stopped mattering, but because
 * the threat itself is gone BY CONSTRUCTION: `resolveLocalWake` (below) no
 * longer ever reads the Worker's `report.digest` field, so no caller of this
 * function on any production path can hand it attacker-shaped text in the
 * first place; see `resolveLocalWake`'s own comment. The older, narrower
 * control-byte strip stays — it was never specific to that threat and costs
 * nothing to keep.
 */
export async function sendLocalWake(id: string, digest: string, deps: OrcaDeps): Promise<AssignWakeReport> {
  if (!orcaPresent(deps)) {
    return {
      woke: false,
      reason: `${id} is a local studio but this is not an Orca session — no wake was sent. ` +
        `Wake it yourself with: fleet task show`,
    };
  }
  const clean = digest.replace(/[\x00-\x1f\x7f]/g, "");
  const term = await findAttachTerminal(id, deps);
  if (term === null || term.handle === undefined) {
    return { woke: false, reason: `${id} is a local studio with no healthy Orca attach terminal — no wake was sent` };
  }
  if (!looksLikeClaudeScreen(term.preview)) {
    return {
      woke: false,
      reason: `${id} is a local studio with no claude session in the terminal's foreground — ` +
        `the lead has exited; wake its lead yourself with: fleet task show`,
    };
  }
  try {
    const res = await deps.run(["terminal", "send", "--terminal", term.handle, "--text", clean, "--enter"], LIST_TIMEOUT_MS);
    if (res.timedOut || !res.ok) {
      return { woke: false, reason: `terminal send failed: ${(res.stderr || res.stdout).trim().slice(0, 200)}` };
    }
    return { woke: true, digest: clean };
  } catch (err) {
    return { woke: false, reason: errText(err) };
  }
}

/** Claude's own select-modal rule, drawn as a run of `▔` box-drawing glyphs
 *  above the modal's option rows. Those option rows are ALSO `❯`-prefixed —
 *  visually identical to the composer's own `❯` but semantically opposite
 *  ("this option is selected," not "safe to type into"). A modal glyph
 *  anywhere in the preview means refuse unconditionally, regardless of what
 *  the screen's last line looks like. */
const MODAL_RULE = /(▔)+/;

/** The composer row, tail-anchored: optional leading whitespace, an optional
 *  box-drawing `│` (with its own optional trailing whitespace) then `❯`.
 *  Mirrors wake.ts's `COMPOSER_ROW` discipline — the `?` binds to the WHOLE
 *  pipe-plus-whitespace group, never to just the pipe's last byte, so a
 *  multibyte `│` is never partially matched. */
const TAIL_COMPOSER_ROW = /^[ \t]*(│[ \t]*)?❯/;

/** A turn-marker / status row, same tail-anchored, pipe-tolerant shape as
 *  the composer row above — claude draws these while actively streaming a
 *  turn, when the composer itself is not on screen. */
const TAIL_TURN_MARKER_ROW = /^[ \t]*(│[ \t]*)?[⏺●]/;

/** The last non-empty line of a multi-line terminal preview, with trailing
 *  whitespace trimmed. A terminal preview can end in blank lines (cursor
 *  position padding, a trailing newline) that would otherwise hide the real
 *  last line of content from a tail-only check. Returns "" when every line
 *  is empty. */
function lastNonEmptyLine(preview: string): string {
  const lines = preview.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trimEnd();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * Does the attach terminal's screen text look like a live, idle-or-busy
 * claude session it is SAFE to type a wake digest into and press Enter?
 *
 * #1259 round 3 (measured, strict re-review @ a30e405b): the PRIOR version
 * of this check matched claude's chrome glyphs ANYWHERE in the last ~300
 * chars of screen text, so a claude session that had already exited still
 * read as "alive" for as long as its old transcript stayed inside that
 * window — a wake digest, including an attacker-shaped one carrying shell
 * metacharacters, got typed and submitted into whatever shell claude exited
 * into. A `▔` modal rule — drawn above a permission prompt's OWN `❯`-style
 * option rows — ALSO read as "alive, safe," so a wake could silently
 * auto-approve a pending tool call by submitting Enter into the modal.
 *
 * Fixed by splitting into two checks: a modal ANYWHERE in the preview always
 * refuses (never risk auto-approving a prompt); otherwise, only the terminal
 * screen's LAST non-empty line is checked against claude's own known chrome
 * shapes (composer row, turn-marker row) — an allowlist, never a denylist of
 * shell-prompt shapes, since those are infinitely customizable and cannot be
 * enumerated. Missing or empty preview text still fails closed, as before.
 */
function looksLikeClaudeScreen(preview: string | undefined): boolean {
  if (preview === undefined || preview === "") return false;
  if (MODAL_RULE.test(preview)) return false;
  const tail = lastNonEmptyLine(preview);
  return TAIL_COMPOSER_ROW.test(tail) || TAIL_TURN_MARKER_ROW.test(tail);
}

/**
 * The CLI half of item 2: swap a `{local:true}` assign-wake refusal for the
 * Orca terminal send that actually wakes the local lead. Everything else
 * passes through untouched, so a container studio's report is byte-identical
 * to before.
 *
 * Fix 1 (#1259 round 4): 3 prior review rounds built the text typed into the
 * terminal from the Worker's own `report.digest` field, which itself carries
 * board content (a task title, a `--why`) the Worker never fully controls —
 * round 3's own "strip these shell metacharacters" patch was chasing that
 * hole, and still missed a zsh glob-qualifier payload that needs none of the
 * stripped characters at all. The actual fix is upstream of any stripping:
 * this function never reads `report.digest` anymore, at all — it builds ONE
 * FIXED template from `taskNumber` alone, which it validates as a plain
 * positive integer before using it. No interpolated title, no interpolated
 * body, no interpolated anything board-sourced ever reaches the terminal —
 * the template has nothing in it a GitHub issue could have influenced except
 * the number itself, and that number is range-checked, not merely typed.
 * An invalid number (never expected from a real caller — see this file's own
 * 4 call sites, each one already holding the task's own `number` field) still
 * refuses rather than throws, matching every other refusal shape here.
 */
export async function resolveLocalWake(
  report: AssignWakeReport | undefined, studioId: string | null, taskNumber: number, deps: OrcaDeps,
): Promise<AssignWakeReport | undefined> {
  if (report && !report.woke && report.local === true && studioId !== null) {
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
      return { woke: false, reason: `invalid task number ${taskNumber} — no wake was sent` };
    }
    const digest = `Board task #${taskNumber} has a new message. Run: fleet task show ${taskNumber}`;
    return sendLocalWake(studioId, digest, deps);
  }
  return report;
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
// healthy workspace?" question `ensure()` (above) answers for itself before
// ever creating one — the same read-only `worktree list --json` + `findStudioWorktree`
// lookup `ensure()`'s own `existing` local uses, THEN the same `terminal list`
// + `isHealthyAttach` read `ensure()`'s `reconcileAttachTerminals` makes.
// Reusing both rather than inventing a second way to ask is deliberate: two
// independent answers to "does it exist" could disagree, and a plan that
// disagrees with the run it precedes would be worse than no plan at all.
//
// Issue #1225: the plan MUST judge the attach terminal too, not only the
// worktree. A worktree that survives an Orca restart while its attach
// terminal is lost leaves a studio that `fleet ls` ROW reads "NO attach" and
// `attach --print-handle` reads "none" — but the old worktree-only preview
// still printed "has one" for it, and the real run then had to repair it (an
// "opened" outcome). The printed plan contradicts the actions it precedes.
// So "open" now carries the SAME health verdict `classifyStudioRow` (the ROW
// column) gives: `open (no attach)` when the worktree's terminal list holds
// no attach title at all, `open (attach DEAD)` when one is present but not
// healthy (`orphaned` / `writable: false` / disconnected). Only a worktree
// with a healthy attach reads "has one".

type WorkspacePreview =
  | { kind: "open"; detail: "no attach" | "attach DEAD" | "no worktree" }
  | { kind: "has one" }
  | { kind: "skipped"; why: string };

export async function previewStudioWorkspace(id: string, deps: OrcaDeps): Promise<WorkspacePreview> {
  if (!orcaPresent(deps)) return { kind: "skipped", why: "not running under Orca" };
  try {
    const listed = await orcaJson(deps, ["worktree", "list", "--json"], LIST_TIMEOUT_MS);
    const worktrees = listed.result?.worktrees ?? [];
    const worktree = findStudioWorktree(id, worktrees, deps.registry);
    if (!worktree) return { kind: "open", detail: "no worktree" };
    // Same selector + same terminal read `ensure()`'s `reconcileAttachTerminals`
    // makes (scoped to the worktree, `isAttachTerminal` idempotency filter, then
    // `isHealthyAttach` health) — the plan must agree with the run it precedes,
    // so it asks the SAME question, never a second way to ask it.
    const selector = worktree.id ? `id:${worktree.id}` : `name:${studioWorkspaceName(id)}`;
    const terms = await orcaJson(deps, ["terminal", "list", "--worktree", selector, "--json"], LIST_TIMEOUT_MS);
    const attach = (terms.result?.terminals ?? []).filter((t) => isAttachTerminal(t, id));
    if (attach.length === 0) return { kind: "open", detail: "no attach" };
    return attach.some((t) => isHealthyAttach(t, id)) ? { kind: "has one" } : { kind: "open", detail: "attach DEAD" };
  } catch (err) {
    return { kind: "skipped", why: errText(err) };
  }
}

export type TabsPlanEntry =
  | { id: string; kind: "open"; detail: "no attach" | "attach DEAD" | "no worktree" }
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
    plan.push(preview.kind === "skipped"
      ? { id: s.id, kind: "skipped", why: preview.why }
      : preview.kind === "has one"
        ? { id: s.id, kind: "has one" }
        : { id: s.id, kind: "open", detail: preview.detail });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The real wiring.

/** Spawns the orca CLI, killing it at `timeoutMs`. Never throws: a spawn that
 *  cannot even start reads as a failed call, which the caller already handles
 *  identically to a failed command. */
function orcaRunner(bin: string): OrcaRun {
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
      return { ok: false, stdout: "", stderr: errText(err), timedOut };
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
    } catch (err) {
      // ENOENT is the raced stale-lock steal from a THIRD caller past the
      // deadline above — already released, fine. Anything else must log;
      // the held fn's result is unaffected either way.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") console.error(`orca: lock release failed at ${path}`, err);
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
