// Mac CLI argv parsing — Fleet Spawn P3, Task 3. Pure (argv in, a plain
// discriminated result out), so it is directly unit-testable under vitest —
// unlike the rest of cli/fleet.ts, which is never imported from test/: that
// file carries genuine bun-only globals (Bun.file et al., inside
// loadCredentials), which only type-check under cli/tsconfig.json's own
// "bun" types, not this repo's root tsconfig (workers-types). Living here
// instead sidesteps that boundary entirely — same reason src/studio/frames.ts
// (the WS frame encode/decode `fleet attach` needs) lives here rather than in
// cli/fleet.ts itself, and is tested directly rather than through the CLI.
//
// cli/fleet.ts's main() is the one caller; it turns each variant below into
// a credentials load + one of
// cmdLs/cmdAttach/cmdPaste/cmdSpawn/cmdProvision/cmdRecycle/cmdTask*.
//
// Board task #131: `TASK_STATES`/`isTaskState` (src/board/types.ts) are pure
// constants/types with no I/O, safe to import across this file's own
// tsconfig boundary — same precedent as task #125's onboard.ts importing
// `StudioStatus`/`RepoReach` types across module lines (that file's own
// header). `transitionTask` itself is NOT imported here or anywhere in this
// module: this file only validates argv shape, never calls the Worker.
import { TASK_STATES, isTaskState, type TaskState } from "../board/types";
import { LIVENESS_RULE } from "./recycle-cost";

export type CliCommand =
  // Issue #37: `fresh` opts into a live container check per studio before the
  // table is printed. Bare `fleet ls` stays one D1 read — the issue's own
  // ruling is explicit ("Do NOT make `fleet ls` always check live — it fans
  // out an exec per studio"), because this is the first command an operator
  // runs when something looks wrong and it must stay instant.
  | { cmd: "ls"; fresh: boolean }
  // Board task #125: a pure, read-only preflight for a repo the fleet has
  // never talked to before — run from inside ANY git repo, not necessarily
  // this one. Zero-argument, same grammar as `ls`.
  | { cmd: "onboard" }
  // studio must be visible in Orca's sidebar.
  //
  // Issue #216: 2026-09-24 an operator ran bare `fleet tabs` meaning to fix
  // its OWN studio's row and it reconciled the ENTIRE fleet instead — every
  // repo, every other maestro's studios too, stacking duplicate attach
  // clients on rows nobody asked to touch. `repo` scopes to one repo's
  // studios the same way `fleet spawn` already resolves a repo dynamically
  // (cwd's git remote by default, `--repo <owner/repo>` to override); `all`
  // is today's fleet-wide behaviour, now something you must explicitly ask
  // for rather than the only thing this verb can do; `yes` skips the
  // confirmation prompt a fleet-wide run otherwise asks for.
  //
  // `repo` is the RAW `--repo` value, unresolved — cli-args.ts has no
  // `detectRepo` (a real `git` subprocess) to call and stays pure/testable
  // without one; cmdTabs (cli/fleet.ts) resolves it, and falls back to
  // detectRepo() only when neither `repo` nor `all` was given.
  | { cmd: "tabs"; repo: string | null; all: boolean; yes: boolean }
  // Board #220: `--print-handle` is a distinct, read-only sub-mode — print
  // the studio's healthy Orca attach terminal handle and exit, never opening
  // the interactive WebSocket attach. See cli/fleet.ts's `cmdPrintAttachHandle`.
  | { cmd: "attach"; id: string; printHandle?: boolean }
  | { cmd: "paste"; id: string }
  // Issue #269: `--new` asks for a FRESH instance of this role in this repo —
  // `<repo>--<role>--2`, `--3`, ... on the lowest free number — instead of
  // instance 1, which is what a bare `fleet spawn <role>` still means (409 when
  // it already exists, exactly as before). Same bespoke "no value, just
  // presence" shape `destroy --force` and `recycle --discard-unsynced` use.
  | { cmd: "spawn"; role: string; newInstance: boolean }
  | { cmd: "provision"; id: string }
  // Issue #37: one studio, checked LIVE, right now. The container check
  // (provision.ts's provisionedCheckCmd) always tested the right things;
  // until this verb, nothing exposed it on demand, so the only way to tell a
  // healthy studio from a dead one was a shell inside the container — which
  // is what turned a 2-of-4 partial outage into a reported total outage on
  // 2026-09-23. Read-only: checks and records a verdict, provisions nothing.
  | { cmd: "check"; id: string }
  // Board #140 (#94 follow-up): the sync guard (session-sync.ts's own
  // SESSION_MARK_KEY baseline) can get stuck comparing every new candidate
  // against a stale or wrong mark, displacing every sync indefinitely —
  // today only a 30-day age rule ever unsticks it. Issue #228 item 3: this
  // comment used to describe the ORIGINAL #140 design (delete the stored
  // mark so the next sync re-seeds its baseline fresh from R2's own
  // `latest`) — held in review because that design was a no-op in the exact
  // case it existed for: the re-seeded mark comes from the SAME `latest`
  // every candidate has been losing to, so the very next tick displaces the
  // very next candidate for the very same reason. The mechanism that
  // actually shipped (do.ts's `clearSessionGuard`, whose own doc comment
  // this now matches): arms session-sync.ts's SESSION_FORCE_KEY, a one-shot
  // override that makes the NEXT sync tick skip the mark/`poorerThan`
  // comparison entirely and force-upload its candidate over `latest` — after
  // first copying the `latest` it is about to overwrite to a
  // `sessions/<id>/superseded/<iso>.tar.gz` safety-net key, so the bypassed
  // comparison never silently destroys session history. A blank or
  // unreadable candidate still refuses (the override stays armed for a
  // later, real candidate to consume).
  | { cmd: "clear-session-guard"; id: string }
  // Board issue #47: a read-only container inspection that never attaches a
  // tmux client — pane_current_command for the claude window, whether the
  // checkout exists, and the last N pane lines via `tmux capture-pane -p`.
  // The point of this verb, distinct from `check`: `check`/`ls` answer a
  // ALIVE-or-DEAD verdict and nothing else, and the only way to see WHAT a
  // lead is actually doing has always been `fleet attach` — which corrupts
  // whatever a human is currently reading on that same shared pane (issue
  // #47's own measured incident). `inspect` is `attach` without the client.
  | { cmd: "inspect"; id: string }
  // Root-cause fix for the stranded-image bug: destroys the container and
  // re-provisions on the CURRENT image — see src/studio/do.ts's recycle()
  // for why provision/restart alone can never do this.
  // Issue #96: `discardUnsynced` is the only way past the failed-probe guard.
  | { cmd: "recycle"; id: string; discardUnsynced: boolean }
  // Board task #124: recycle can never leave a studio STOPPED — it always
  // reprovisions. `destroy` runs the same pre-destroy sequence (session
  // sync, rescue-push, learning-harvest — src/studio/destroy.ts) and then
  // leaves the container down. `force` is the ONLY boolean flag this CLI
  // parses (see parseCliArgs' own destroy case for why that stays a bespoke
  // check rather than a general boolean extension to parseFlags below,
  // which every other flag-taking verb here still goes through unchanged)
  // — it overrides the refusal that fires when this studio still carries an
  // open assigned board task.
  | { cmd: "destroy"; id: string; force: boolean; discardUnsynced: boolean }
  // P4 §5's board. Two words rather than one, because `task` is a noun with
  // three operations on it; flags rather than positionals, because a brief is
  // four fields and no positional order survives that.
  | { cmd: "task-new"; brief: TaskBriefArgs }
  | { cmd: "task-ls"; query: { milestone?: string; state?: string; assignedTo?: string } }
  | { cmd: "task-show"; number: number }
  // Board task #119: mechanically re-checks the newest §6 result envelope's
  // own `verification` block — a followability check, never a gate. Same
  // grammar as `task-show`.
  | { cmd: "task-verify"; number: number }
  // P5 §3's reassignment — Maestro's verb. Positionals, not flags, because
  // both are short and their order is obvious ("move 42 to release-studio");
  // `--why` is a flag because it is prose and optional.
  //
  // Issue #269: the second positional is a TARGET, not only a role. A bare
  // role still means instance 1 (unchanged), and it now also accepts
  // `<role>--<k>` (that role's instance k, resolved against the repo the
  // command is run in) and a full studio id, two- or three-segment (used as
  // typed, no repo resolution). The shape is validated here (ids.ts's
  // parseStudioTarget, via repo.ts's studioIdForTarget at the call site) so a
  // target that names no studio is a local refusal listing all three forms,
  // never a round trip that labels a task for a studio nobody runs.
  | { cmd: "task-assign"; number: number; target: string; why?: string }
  // Board task #131: the one CLI verb that moves a task OUT of `submitted`
  // — wraps the existing `transitionTask` route (board.ts:140), which is
  // already a compare-and-swap keyed on the state the caller believes the
  // task is in. `to` is validated against the full TASK_STATES vocabulary
  // at PARSE TIME (see parseTask's own "state" case below), so an unknown
  // target state is a usage error and never an avoidable network round
  // trip. `from` is not a CLI argument at all: cli/fleet.ts reads it live
  // (src/studio/task-state.ts's runTaskStateTransition), because a caller
  // typing what it BELIEVES the state to be is exactly the stale value the
  // route's own compare-and-swap exists to catch.
  | { cmd: "task-state"; number: number; to: TaskState }
  // Board issue #8: deterministic backfill for a task whose PR merged/
  // promoted to the default branch but was never auto-closed — the ONLY
  // coverage for a repo whose owner resolves to the token auth path, where
  // no webhook is ever sent at all (src/github/auth.ts's per-owner
  // routing). `apply: false` (bare, or the explicit `--dry-run` synonym) is
  // the default and only ever REPORTS; `apply: true` (`--apply`) performs
  // the real close through the same idempotent action a push webhook uses.
  | { cmd: "task-reap"; apply: boolean }
  // Issue #217: delete fleet/rescue/* branches that hold no work (older than
  // N days, and every commit already on the default branch or only tool
  // markers). Dry-run unless --apply.
  | { cmd: "rescue-gc"; apply: boolean; olderThanDays: number }
  // Issue #251: run the (now per-worktree) rescue-push exec against every
  // studio CURRENTLY RUNNING — the pre-image-deploy gate this whole feature
  // exists for. `repo` scopes to one repo (same `owner/repo` shape `--repo`
  // already takes elsewhere); `dryRun` lists what WOULD be rescued without
  // execing or pushing anything. Never touches a stopped studio: an exec
  // would start it (the same #113 F1 reason `destroy` already guards).
  | { cmd: "rescue-all"; repo: string | null; dryRun: boolean }
  // P5 §9's memory pass. Two words for the same reason `task` is: `memory` is
  // a noun with operations on it, and the survey is the one you run first.
  | { cmd: "memory-ls" }
  | { cmd: "memory-compact" }
  // The whole surface, written for an agent to read. A verb rather than a
  // flag, so it reads like every other command AND so the VERBS table below
  // can be typed against this union — which is what stops the help drifting.
  | { cmd: "help" }
  | { cmd: "usage"; message: string };

/** What `fleet task new` collects. `milestone` is spelled `--sprint` on the
 *  command line and `milestone` on the wire: §5 rules sprint = milestone, so
 *  the operator surface speaks the domain word and GitHub keeps its own. */
export interface TaskBriefArgs {
  title: string;
  objective: string;
  outputFormat: string;
  boundaries: string;
  milestone?: string;
  /** Spelled `--studio` on the command line and `assignee` on the wire: the
   *  operator names a STUDIO, and that is the domain word (§5's assignment
   *  label carries a studio id). Absent = an unassigned task, which is a real
   *  thing to file at a sprint meeting before anyone takes it. */
  assignee?: string;
  /** Issue #278: `--repo <owner/name>`. Overrides the CWD-detected repo
   *  (cli/fleet.ts's `cmdTaskNew`, same override-wins-over-detection
   *  precedence `fleet tabs`'s own `--repo` already establishes for itself).
   *  Absent = file into whatever `detectRepo()` resolves from the CWD's git
   *  remote, today's unchanged default. */
  repo?: string;
}

/**
 * Every verb this CLI dispatches, with the help text for it — ONE table, and
 * the type is what keeps it honest: the key type is the CliCommand union minus
 * its two non-verbs, so adding a command without adding its help is a
 * compile error, not a doc that quietly goes stale. `CLI_USAGE` and
 * `fleet help` are both rendered from here; neither is hand-maintained.
 *
 * The audience is an AGENT. Any claude session — on the operator's Mac or inside a
 * studio — should be able to type `fleet help` and discover the whole surface
 * without reading this file. So `summary` says what the verb DOES and what it
 * costs, not just what it is named.
 */
export interface VerbHelp {
  /** Argument shape as it is typed, e.g. "<id>". Empty when the verb takes none. */
  args: string;
  /** One line. What it does, and anything expensive or irreversible about it. */
  summary: string;
}

export const VERBS: Record<Exclude<CliCommand["cmd"], "usage" | "help">, VerbHelp> = {
  ls: {
    args: "[--fresh]",
    summary: "Every studio: id, repo, state, READY (provisioned/bare/\"?\" unknown, do.ts's periodic container check — the registry's own state/error can be stale, trust READY; READY may also read replaced/unreachable/unverified, issue #85, when the ship tick's own evidence contradicts the last container-side check), SESSION (resumed/fresh/LOST/\"?\", whether the live lead actually continued its history or started over, plus how old the last shipped snapshot is), CHECKED (how old that verdict is — up to 300s by default), tailnet host, burn, last activity (git commits — a quiet LAST ACTIVITY column means no recent commits, not that the studio is unhealthy; check READY/SESSION for that), error. Read-only. --fresh re-checks every studio live first (one container exec each, slower) instead of reading the last recorded verdict.",
  },
  onboard: {
    args: "",
    summary: "Preflight this folder's repo for the fleet: detected from git remote, reachable & writable by the fleet's GitHub credential, ~/.fleet/credentials present and the Worker answers, and whether a studio already exists for it. Prints a paste-ready brief once the first three pass. Pure read-only — never spawns, recycles, files a task, or mutates anything. Exits non-zero on any hard failure.",
  },
  tabs: {
    args: "[--repo <owner/repo> | --all] [--yes]",
    summary: "Give this repo's studios that are not stopped their own row in Orca's sidebar, each with a live `fleet attach` terminal. Scoped to the CWD's git remote by default (same detection as `fleet spawn`); --repo <owner/repo> overrides it; --all opts into the WHOLE fleet, explicitly (issue #216: no longer the only behaviour). Refuses, never falls back to --all, when the CWD names no repo and neither flag is given. Prints the plan (open / has one / skipped: reason) before acting; a fleet-wide run (--all) without --yes asks to confirm first and touches nothing on anything but an explicit yes. Reconcile only: opens what is missing, touches what already has one not at all, never steals focus, and does nothing outside Orca.",
  },
  attach: {
    args: "<id> [--print-handle]",
    summary: "Open the studio's live terminal (its tmux `claude` window). ctrl-] detaches; the studio keeps running. `--print-handle` is a distinct read-only mode (board #220): prints the studio's healthy Orca attach terminal handle (or `none`) and exits — no WebSocket, no raw terminal mode, no Worker call. Use it, never `fleet tabs`, to find the handle for `orca terminal send`.",
  },
  paste: {
    args: "<id>",
    summary: "Upload the Mac clipboard image into the studio and print the in-container path. ctrl-v does this inline while attached.",
  },
  spawn: {
    args: "<role> [--new]",
    summary: "Create a studio for <role> in the repo you are standing in (maestro, web-studio, release-studio, pilot, scratch). Boots a container. Issue #269: `--new` creates an ADDITIONAL studio for that role on the lowest free instance number (<repo>--<role>--2, --3, ...) instead of refusing because instance 1 exists. All studios share ONE Claude account: more instances run more leads concurrently, they do not buy more capacity, and a session limit hits every one of them.",
  },
  provision: {
    args: "<id>",
    summary: "Re-run clone + bring-up on the studio's EXISTING container. Heals a half-built studio; does not pick up a new image. Re-checks readiness before answering, so the row it prints is the studio as it is NOW, not the last recorded verdict.",
  },
  check: {
    args: "<id>",
    summary: "Ask the CONTAINER, right now: clone present, harness files in place, and claude running in tmux studio:claude. Records the verdict so `fleet ls` shows it too. Read-only — provisions nothing, destroys nothing, and never switches a tmux window (nothing an operator attaching later can see). ALIVE-or-DEAD only: pane_current_command reads \"claude\" for a lead mid-turn, a lead stopped waiting on subagents, AND a lead dead at a shell prompt — it can never tell you a studio is WORKING.",
  },
  "clear-session-guard": {
    args: "<id>",
    summary: "Arm a one-shot override so the NEXT sync uploads the container's current session over R2's latest WITHOUT the usual richness comparison, unsticking a guard frozen displacing every candidate. \"Next sync\" is not only the periodic 300s tick: restart, recycle, and destroy each run their own pre-teardown sync first, and whichever one runs FIRST consumes the override — force-uploading the studio's last session before teardown. The old latest is preserved first under sessions/<id>/superseded/<iso>.tar.gz before it's overwritten, so nothing is silently lost. Still refuses a blank or unreadable candidate (the override stays armed for the next real one). One-shot: consumed by the sync that actually uploads, so ordinary comparisons resume right after. Destroying a studio whose container is NOT running never syncs at all (nothing to rescue) — the override stays armed, unconsumed, until this studio's next sync.",
  },
  inspect: {
    args: "<id>",
    summary: "Read a studio WITHOUT attaching: pane_current_command for tmux studio:claude, whether the checkout exists, and the last ~60 pane lines via `tmux capture-pane -p`. Never opens the pty, never sends a keystroke, never resizes the shared terminal — the corruption `fleet attach` risks on an operator's own live view. Refuses a STOPPED studio outright (reading it would start its container and bill silently).",
  },
  recycle: {
    args: "<id> [--discard-unsynced]",
    summary: "Destroy the container and reprovision on the CURRENT image, then verify and report THAT verdict. The only way an image change reaches a running studio. Loses the container filesystem; the session is rescued first. If the container cannot answer, nothing can be rescued: recycle REFUSES (409) and names the age of the last synced snapshot it would restore. --discard-unsynced proceeds anyway, discarding everything since. " + LIVENESS_RULE,
  },
  destroy: {
    args: "<id> [--force] [--discard-unsynced]",
    summary: "Stop a studio for good: same pre-teardown rescue as recycle, but does NOT reprovision. Refuses if an open board task is still assigned to it, unless --force. A running container that cannot answer cannot be rescued: destroy REFUSES (409) and names the age of the last synced snapshot, unless --discard-unsynced (or --force). A container that is not running is destroyed without any exec — its disk is already gone and an exec would boot it.",
  },
  "task-new": {
    args: "new --title T --objective O --output F --boundaries B [--sprint S] [--studio ID] [--repo owner/name]",
    summary: "File one board task (a GitHub issue) for the repo you are standing in, or for --repo <owner/name> when given (issue #278) — overrides CWD detection, so a wrong-directory run or an assignment to a studio on another repo can name the right repo explicitly instead of filing (or dispatching) into the wrong one. All four brief sections are required.",
  },
  "task-ls": {
    args: "ls [--sprint S] [--state submitted|working|input_required|completed|failed|canceled] [--studio ID]",
    summary: "List board tasks for the repo you are standing in.",
  },
  "task-show": {
    args: "show <n>",
    summary: "One task: its brief and every comment, including studio envelopes.",
  },
  "task-verify": {
    args: "verify <n>",
    summary: "Mechanically re-check the newest result envelope's verification block (url + steps) and post ONE classifying comment. Read-only: never gates, never moves task state, never closes anything.",
  },
  "memory-ls": {
    args: "ls",
    summary: "Fleet memory, measured: every index line, plus each file's citation count, age and verdict (promote / keep / demote / hold). Read-only.",
  },
  "memory-compact": {
    args: "compact",
    summary: "Run the compaction pass. Proposal JSON on STDIN (empty = rebuild the index only). Opens a PR against the blueprint repo; merges INDEX LINES and MOVES files to archive/ — never deletes one.",
  },
  "task-assign": {
    args: "assign <n> <role | role--k | studio-id> [--why R]",
    summary: "Move task <n> to another studio: old studio label off, new one on, state back to submitted, lineage commented (from, to, when, why). Earlier comments stay — they are what the previous studio did. A bare role means that role's FIRST instance in the repo you are standing in; issue #269 also accepts `pilot--2` (that role's instance 2, same repo) and a full studio id (`websites--pilot`, `websites--pilot--2`), which needs no repo context at all.",
  },
  "task-state": {
    args: `state <n> <to: ${TASK_STATES.join("|")}>`,
    summary: "Move task <n> to a new board state via the Worker's own compare-and-swap: reads the CURRENT state first and sends it as \"from\", so a stale caller gets the route's own 409 verbatim instead of overwriting someone else's write. Operator-invoked only — nothing auto-closes a task.",
  },
  "rescue-gc": {
    args: "[--older-than N] [--dry-run|--apply]",
    summary: "Clean up fleet/rescue/* branches that hold no work: older than N days (default 14) AND every commit already on the default branch, or a diff of nothing but tool markers (.claude/worktrees). Real work is kept however old. Bare (or --dry-run) only REPORTS would-delete/kept(why); --apply deletes.",
  },
  "rescue-all": {
    args: "[--repo owner/repo] [--dry-run]",
    summary: "Run rescue-push against every studio that is RUNNING OR DEGRADED — the pre-image-deploy gate: an image rollout replaces every studio's container with no rescue mechanism of its own running. Commits and pushes uncommitted work (main checkout and every member git worktree, each to its own fleet/rescue/... ref), plus every local branch not checked out anywhere and every stash entry holding unpushed work (repo-wide, so a member subagent's own stash or an abandoned branch is never invisible), and prints what it saved, or 'nothing to rescue' for a clean one. A push rejected non-fast-forward (a branch moved on origin) retries once to a freshly generated ref before it counts as a failure. Prints 'skipped <id> (<state>)' for a stopped/provisioning studio and 'skipped <id>: container not running' for a stale registry answer — neither is a failure. --repo scopes to one repo; --dry-run lists which studios WOULD be rescued without execing or pushing anything. Exits non-zero only on a genuine rescue failure.",
  },
  "task-reap": {
    args: "reap [--dry-run|--apply]",
    summary: "Deterministic backfill: every open task whose latest envelope names a PR now on the default branch. Bare (or --dry-run) only REPORTS would-close/skipped(why); --apply actually closes the GitHub issue and moves the board to completed, the SAME idempotent action a push webhook uses. The only coverage for a repo on the token auth path, where no webhook is ever sent.",
  },
};

/** `fleet ls`, `fleet task show <n>` — the command line for one verb. */
function verbLine(cmd: string, help: VerbHelp): string {
  const name = cmd.startsWith("task-") ? "task" : cmd.startsWith("memory-") ? "memory" : cmd;
  return `fleet ${name}${help.args ? " " + help.args : ""}`;
}

/** The short form, printed on a usage error. Derived, never typed twice. */
export const CLI_USAGE =
  "usage: " +
  Object.entries(VERBS).map(([cmd, help]) => verbLine(cmd, help)).join("\n       ") +
  "\n       fleet help";

/**
 * `fleet help` — the whole fleet surface, written for an agent to read.
 *
 * Covers the two OTHER binaries as well, because an agent that can only
 * discover this one still cannot find its way around: `ff` is the two-letter
 * spawn-or-attach on the Mac, and inside a studio container `fleet` is a
 * DIFFERENT binary (container/studio-fleet) with its own smaller verb set. A
 * help text that pretended those did not exist would send a studio agent
 * hunting for a `fleet ls` that does not exist there.
 */
export function renderHelp(): string {
  const entries = Object.entries(VERBS);
  // Fixed column, not the longest line: `fleet task new` carries six flags,
  // and letting it set the width pushes every other summary off the screen.
  // Anything longer than the column gets its summary on the next line instead.
  const COL = 22;
  const pad = (s: string) => s.padEnd(COL);
  const row = (line: string, summary: string) =>
    line.length > COL ? `  ${line}\n  ${" ".repeat(COL)}  ${summary}` : `  ${pad(line)}  ${summary}`;
  const rows = entries.map(([cmd, help]) => row(verbLine(cmd, help), help.summary));
  return [
    "fleet — the Mac cockpit for the studio fleet.",
    "",
    "A STUDIO is one cloud container running one claude session (the lead) plus its",
    "member subagents. Its id is <repo>--<role>, e.g. websites--web-studio. Leads",
    "never implement: a PreToolUse hook refuses their Edit/Write and their",
    "file-writing Bash forms, so implementation is dispatched to members.",
    "",
    "COMMANDS",
    ...rows,
    row("fleet help", "This text."),
    "",
    "ff — spawn-or-attach in two letters, from inside a repo folder.",
    "",
    row("ff", "Attach this repo's maestro, spawning it first if it does not exist."),
    row("ff <role>", "Same, for another role (web-studio, release-studio, ...)."),
    row('ff <role> "<task>"', "File the task, spawn the studio FOR it, wait, attach."),
    row("ff --help", "ff's own help."),
    "",
    "INSIDE A STUDIO CONTAINER, `fleet` is a different, smaller binary:",
    "  fleet spawn <role>     spawn a peer studio, within this studio's org-chart edges",
    "  fleet task ls          the tasks assigned to THIS studio, nobody else's",
    "  fleet task show <n>    one of them, with its brief and comments",
    "  fleet task report <n>  post this studio's result envelope (JSON on stdin)",
    "There is no ls, attach or recycle there: a studio does not drive the fleet.",
    "",
    "NOTES FOR AGENTS",
    "  - ACTIVITY (fleet ls) answers working-or-stopped (WORKING/IDLE/WAITING MEMBERS/",
    "    LIMIT, read from the pane itself); READY only ever answers alive-or-dead.",
    "  - Repo is detected from the current directory's git origin remote. fleet task",
    "    acts on that repo; fleet ls is fleet-wide.",
    "  - The Worker is the single writer of task state. Never open or relabel a task",
    "    with gh: it lands invisible to the board and to every studio.",
    "  - provision reuses the container, recycle replaces it. An image change reaches",
    "    a running studio only through recycle.",
    "  - A studio is not attachable until it reports provisioned. ff waits for that,",
    "    fleet attach does not.",
    "  - Credentials come from ~/.fleet/credentials (chmod 600).",
  ].join("\n");
}

/** Flags this CLI knows, per task subcommand. An unknown flag is a usage
 *  error and never ignored: a silently dropped `--sprint` puts a task on no
 *  sprint board at all, and nothing on screen would say so. */
const TASK_FLAGS: Record<string, readonly string[]> = {
  new: ["title", "objective", "output", "boundaries", "sprint", "studio", "repo"],
  ls: ["sprint", "state", "studio"],
  assign: ["why"],
};

/**
 * `--k v` and `--k=v`, both. Last occurrence of a repeated flag wins, the
 * ordinary shell convention. Returns the offending token instead of a map
 * when something is wrong — an unknown flag, a flag with no value, or a bare
 * positional where only flags belong.
 */
function parseFlags(argv: string[], allowed: readonly string[]): Record<string, string> | { bad: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) return { bad: token };
    const eq = token.indexOf("=");
    const key = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    if (!allowed.includes(key)) return { bad: token };
    let value: string | undefined;
    if (eq === -1) {
      value = argv[++i];
    } else {
      value = token.slice(eq + 1);
    }
    if (value === undefined) return { bad: token };
    flags[key] = value;
  }
  return flags;
}

function usage(message: string): CliCommand {
  return { cmd: "usage", message: `${message}\n${CLI_USAGE}` };
}

/** `fleet task <sub> ...`. Split out of parseCliArgs's switch because it is
 *  the only command with a second word, and folding two grammars into one
 *  switch reads as neither. */
function parseTask(argv: string[]): CliCommand {
  const [sub, ...rest] = argv;
  if (sub === "show") {
    const raw = rest[0];
    if (raw === undefined || !/^\d+$/.test(raw)) return usage("fleet task show needs an issue number");
    return { cmd: "task-show", number: Number(raw) };
  }
  if (sub === "verify") {
    const raw = rest[0];
    if (raw === undefined || !/^\d+$/.test(raw)) return usage("fleet task verify needs an issue number");
    return { cmd: "task-verify", number: Number(raw) };
  }
  if (sub === "assign") {
    // Two positionals, then flags — the only verb here with that shape, which
    // is why it is split out rather than folded into parseFlags's all-flags
    // grammar below.
    const [rawNumber, target, ...flagArgv] = rest;
    if (rawNumber === undefined || !/^\d+$/.test(rawNumber)) {
      return usage("fleet task assign needs an issue number: fleet task assign <n> <role>");
    }
    // `startsWith("--")` is what tells a missing positional from a flag, and it
    // survives issue #269 untouched: every target shape STARTS with a segment
    // (`pilot`, `pilot--2`, `websites--pilot--2`), so no valid target can begin
    // with the delimiter.
    if (target === undefined || target.startsWith("--")) {
      return usage("fleet task assign needs the role or studio to move it to: fleet task assign <n> <role>");
    }
    const flags = parseFlags(flagArgv, TASK_FLAGS.assign);
    if ("bad" in flags) return usage(`unexpected ${JSON.stringify(flags.bad)}`);
    const assign: CliCommand = { cmd: "task-assign", number: Number(rawNumber), target };
    if (flags.why !== undefined) assign.why = flags.why;
    return assign;
  }
  if (sub === "state") {
    // Board task #131: two positionals, same shape as `assign`'s first two
    // — an issue number, then a value. `to` is validated HERE, against the
    // closed TASK_STATES vocabulary, rather than deferred to the server: a
    // typo'd state name is a usage error with the vocabulary listed, not a
    // wasted round trip that the route would 400 on anyway.
    const [rawNumber, to] = rest;
    if (rawNumber === undefined || !/^\d+$/.test(rawNumber)) {
      return usage("fleet task state needs an issue number: fleet task state <n> <to>");
    }
    if (!isTaskState(to)) {
      return usage(
        `fleet task state needs a valid target state: fleet task state <n> <to> — one of ${TASK_STATES.join("|")}`,
      );
    }
    return { cmd: "task-state", number: Number(rawNumber), to };
  }
  if (sub === "reap") {
    // Zero positionals, one optional bare boolean flag — NOT the
    // two-positional-then-flags shape `assign` takes above. Same bespoke
    // "no value, just presence" check `destroy`'s own `--force` handling
    // uses in parseCliArgs' top-level switch (parseFlags below only knows
    // value-taking `--k v`/`--k=v` flags), adapted here since `reap` lives
    // inside parseTask's own grammar rather than the top-level one.
    if (rest.length === 0) return { cmd: "task-reap", apply: false };
    if (rest.length === 1 && rest[0] === "--dry-run") return { cmd: "task-reap", apply: false };
    if (rest.length === 1 && rest[0] === "--apply") return { cmd: "task-reap", apply: true };
    return usage(`unexpected ${JSON.stringify(rest[0])}`);
  }
  if (sub !== "new" && sub !== "ls") return usage(`unknown task command ${JSON.stringify(sub ?? "")}`);

  const parsed = parseFlags(rest, TASK_FLAGS[sub]);
  if ("bad" in parsed) return usage(`unexpected ${JSON.stringify(parsed.bad)}`);

  if (sub === "ls") {
    const query: { milestone?: string; state?: string; assignedTo?: string } = {};
    if (parsed.sprint !== undefined) query.milestone = parsed.sprint;
    if (parsed.state !== undefined) query.state = parsed.state;
    if (parsed.studio !== undefined) query.assignedTo = parsed.studio;
    return { cmd: "task-ls", query };
  }

  // Named one at a time so a half-written brief says WHICH section is
  // missing — the same rule src/board/brief.ts enforces server-side, applied
  // early enough to cost no round trip.
  for (const [flag, field] of [["title", "title"], ["objective", "objective"], ["output", "outputFormat"], ["boundaries", "boundaries"]] as const) {
    if (parsed[flag] === undefined || parsed[flag].trim() === "") {
      return usage(`fleet task new needs --${flag} (${field})`);
    }
  }
  const brief: TaskBriefArgs = {
    title: parsed.title, objective: parsed.objective,
    outputFormat: parsed.output, boundaries: parsed.boundaries,
  };
  if (parsed.sprint !== undefined) brief.milestone = parsed.sprint;
  if (parsed.studio !== undefined) brief.assignee = parsed.studio;
  if (parsed.repo !== undefined) brief.repo = parsed.repo;
  return { cmd: "task-new", brief };
}

/**
 * `argv` is `process.argv.slice(2)` — the command and its one positional
 * arg, nothing else (no flags today). A command that needs an arg but didn't
 * get one reads as `usage`, same outcome as an unrecognised command, so a
 * caller need not special-case "known command, missing arg" — both funnel
 * through the identical usage-and-exit-1 path cli/fleet.ts's old bare
 * `usage()` function used.
 */
export function parseCliArgs(argv: string[]): CliCommand {
  const [cmd, arg] = argv;
  switch (cmd) {
    // Three spellings, one verb: an agent reaching for --help must not get a
    // usage error telling it to read the help it just asked for.
    case "help":
    case "--help":
    case "-h":
      return { cmd: "help" };
    // Issue #37: `--fresh` is read from anywhere after the verb (there is no
    // positional to collide with), keeping `ls`'s own long-standing "a stray
    // extra token is ignored" grammar exactly as it was for everything else.
    case "ls":
      return { cmd: "ls", fresh: argv.slice(1).includes("--fresh") };
    case "onboard":
      return { cmd: "onboard" };
    // Issue #216: `--repo <owner/repo>` (value form or `--repo=value`),
    // `--all`, `--yes`, in any order — same "an unrecognised token is a
    // usage error, never silently ignored" posture `destroy`'s bespoke
    // parse above already takes, because a flag typo here (`--al`) must
    // never quietly widen a repo-scoped run to the whole fleet.
    case "tabs": {
      const rest = argv.slice(1);
      let repo: string | null = null;
      let all = false;
      let yes = false;
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token === "--all") { all = true; continue; }
        if (token === "--yes") { yes = true; continue; }
        if (token === "--repo") {
          const value = rest[++i];
          if (value === undefined) return usage("--repo needs a value");
          repo = value;
          continue;
        }
        if (token.startsWith("--repo=")) { repo = token.slice("--repo=".length); continue; }
        return usage(`unexpected ${JSON.stringify(token)}`);
      }
      if (repo !== null && all) return usage("--repo and --all are mutually exclusive");
      return { cmd: "tabs", repo, all, yes };
    }
    // Board #220: `--print-handle` — same bespoke "no value, just presence"
    // shape `destroy`'s own `--force` handling (below) already uses, since a
    // second positional flag with no value is not something `parseFlags`
    // knows how to parse.
    case "attach": {
      if (!arg || arg === "--print-handle") return { cmd: "usage", message: CLI_USAGE };
      const rest = argv.slice(2);
      if (rest.length === 0) return { cmd: "attach", id: arg };
      if (rest.length === 1 && rest[0] === "--print-handle") return { cmd: "attach", id: arg, printHandle: true };
      return usage(`unexpected ${JSON.stringify(rest[0])}`);
    }
    case "paste":
      return arg ? { cmd: "paste", id: arg } : { cmd: "usage", message: CLI_USAGE };
    // Issue #269: same bespoke shape as `recycle --discard-unsynced` above and
    // `destroy --force` below, same reasons.
    case "spawn": {
      if (!arg || arg === "--new") return { cmd: "usage", message: CLI_USAGE };
      const rest = argv.slice(2);
      if (rest.length === 0) return { cmd: "spawn", role: arg, newInstance: false };
      if (rest.length === 1 && rest[0] === "--new") return { cmd: "spawn", role: arg, newInstance: true };
      return usage(`unexpected ${JSON.stringify(rest[0])}`);
    }
    case "provision":
      return arg ? { cmd: "provision", id: arg } : { cmd: "usage", message: CLI_USAGE };
    // Issue #96: same bespoke shape as `destroy --force` below, same reasons.
    case "recycle": {
      if (!arg || arg === "--discard-unsynced") return { cmd: "usage", message: CLI_USAGE };
      const rest = argv.slice(2);
      if (rest.length === 0) return { cmd: "recycle", id: arg, discardUnsynced: false };
      if (rest.length === 1 && rest[0] === "--discard-unsynced") return { cmd: "recycle", id: arg, discardUnsynced: true };
      return usage(`unexpected ${JSON.stringify(rest[0])}`);
    }
    case "check":
      return arg ? { cmd: "check", id: arg } : { cmd: "usage", message: CLI_USAGE };
    case "clear-session-guard":
      return arg ? { cmd: "clear-session-guard", id: arg } : { cmd: "usage", message: CLI_USAGE };
    case "inspect":
      return arg ? { cmd: "inspect", id: arg } : { cmd: "usage", message: CLI_USAGE };
    // Board task #124: `fleet destroy <id> [--force]`. Only `arg` (the id)
    // and an optional trailing `--force` are read; anything else after the
    // id is a usage error, the same "an unknown flag is never silently
    // ignored" posture parseFlags' own doc comment states for the flag-table
    // verbs. A bespoke check rather than routing through parseFlags: that
    // function only knows value-taking `--k v`/`--k=v` flags, and `--force`
    // takes no value — extending it for this one boolean flag would cost
    // more than the four lines below.
    //
    // Code review round: `arg === "--force"` (the id was OMITTED and
    // `--force` slid into its slot, e.g. bare `fleet destroy --force`) is
    // its own usage error, caught BEFORE the `!arg` check below would ever
    // see it — `arg` is truthy here (`"--force"` is a non-empty string), so
    // without this explicit check the flag string would silently become the
    // id, exactly the "trailing token other than --force" case this block's
    // own comment already says must never be silently ignored, just at the
    // position 0 (id) instead of position 1 (rest[0]).
    case "destroy": {
      if (!arg || arg === "--force" || arg === "--discard-unsynced") return { cmd: "usage", message: CLI_USAGE };
      const rest = argv.slice(2);
      const flags = new Set(rest);
      const unknown = rest.find((t) => t !== "--force" && t !== "--discard-unsynced");
      if (unknown !== undefined) return usage(`unexpected ${JSON.stringify(unknown)}`);
      if (flags.size !== rest.length) return usage("a flag was given twice");
      return { cmd: "destroy", id: arg, force: flags.has("--force"), discardUnsynced: flags.has("--discard-unsynced") };
    }
    // Issue #217.
    case "rescue-gc": {
      let apply: boolean | null = null;
      let olderThanDays = 14;
      const rest = argv.slice(1);
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]!;
        if (t === "--apply" || t === "--dry-run") {
          if (apply !== null) return usage("give --apply or --dry-run once");
          apply = t === "--apply";
          continue;
        }
        const m = /^--older-than(?:=(.*))?$/.exec(t);
        if (!m) return usage(`unexpected ${JSON.stringify(t)}`);
        const raw = m[1] ?? rest[++i];
        if (raw === undefined || !/^\d+$/.test(raw)) return usage("--older-than needs a whole number of days");
        olderThanDays = Number(raw);
      }
      return { cmd: "rescue-gc", apply: apply ?? false, olderThanDays };
    }
    // Issue #251.
    case "rescue-all": {
      const rest = argv.slice(1);
      let repo: string | null = null;
      let dryRun = false;
      for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (token === "--dry-run") { dryRun = true; continue; }
        if (token === "--repo") {
          const value = rest[++i];
          if (value === undefined) return usage("--repo needs a value");
          repo = value;
          continue;
        }
        if (token.startsWith("--repo=")) { repo = token.slice("--repo=".length); continue; }
        return usage(`unexpected ${JSON.stringify(token)}`);
      }
      return { cmd: "rescue-all", repo, dryRun };
    }
    case "task":
      return parseTask(argv.slice(1));
    // Bare `fleet memory` is an alias for `fleet memory ls` — the survey is
    // the only thing you can safely do without thinking, so it is what an
    // operator who typed half a command gets.
    case "memory":
      if (arg === undefined || arg === "ls") return { cmd: "memory-ls" };
      if (arg === "compact") return { cmd: "memory-compact" };
      return usage(`unknown memory command ${JSON.stringify(arg)}`);
    default:
      return { cmd: "usage", message: CLI_USAGE };
  }
}
