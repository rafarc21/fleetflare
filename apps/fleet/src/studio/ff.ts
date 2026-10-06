// `ff` — spawn-or-attach in two letters (P4 design §2.13 decision 13, §10).
//
// the operator types `ff <role>` in a repo folder and lands in a working
// claude session for that repo's role. Nothing else typed. This file is the
// DECISION half of that command: which studio does `ff` mean, and may it be
// attached to yet.
//
// Board issue #250 (maestro is ALWAYS LOCAL, never a cloud studio): bare
// `ff` and `ff maestro` both resolve to the role "maestro" and both REFUSE
// here — see ffDecision's own leading check — instead of spawning or
// attaching to a cloud studio that would immediately stop and escalate
// anyway (fleet/blueprint/studios/maestro/studio.md is a stub for exactly
// that case). The maestro-playbook skill's Role section has the full rule.
//
// Pure — argv and registry rows in, a plain discriminated result out — for
// exactly the reason src/studio/cli-args.ts is: cli/ff.ts (like cli/fleet.ts)
// carries bun-only globals and is never imported from test/, so anything left
// in it is untestable. The impure half — one `git` subprocess, the
// authenticated fetches, the wait loop, the attach — lives there.
//
// `ff` adds no server-side machinery whatsoever. Every action below maps onto
// a route the Worker already serves and cli/fleet.ts already calls:
// GET /studio/ (ls), POST /studio/spawn (spawn), POST /studio/:id/provision
// (provision), GET /studio/:id/status (the wait), and the terminal WS
// (attach).

import { buildStudioId, isIdSegment, nextFreeInstance, parseStudioId } from "./ids";
import { TASK_TITLE_MAX } from "../board/brief";
import type { StudioStatus } from "./types";

/** Bare `ff` means the Maestro by the §2.13 grammar — but board issue #250
 *  (maestro is ALWAYS LOCAL, never a cloud studio) makes that role a
 *  refusal now, not a spawn target: see ffDecision's leading check. This
 *  constant stays "maestro" because that is still the role the grammar
 *  resolves an omitted role to; it is ffDecision, one level down, that
 *  turns that resolution into a refusal rather than a spawn-or-attach. */
export const DEFAULT_FF_ROLE = "maestro";

export const FF_USAGE =
  `usage: ff [<role>] [--new] ["<task>" | <issue-number>]   (role defaults to "${DEFAULT_FF_ROLE}", which refuses — see ff --help; name a real role)`;

export const FF_HELP = [
  "ff — spawn-or-attach the studio for the repo you are standing in.",
  "",
  `  ff              REFUSES — "${DEFAULT_FF_ROLE}" runs locally only, never as a`,
  "                  cloud studio (board issue #250). Same for `ff maestro`",
  "                  explicitly. Start a local maestro session instead.",
  "  ff <role>       another role, e.g. web-studio, release-studio, ...",
  '  ff <role> "<task>"  file that task on the board, assign it to that studio,',
  "                  spawn the studio FOR it, wait, attach",
  "  ff <role> <n>   ADOPT existing issue #n: assign it to that studio, reset it",
  "                  to submitted, spawn the studio FOR it, wait, attach.",
  "                  Works on a bare issue filed by hand from a phone.",
  '  ff <role> --new "<task>"  a SECOND (third, ...) studio for that role in this',
  "                  repo, on the lowest free instance number: <repo>--<role>--2,",
  "                  --3, and so on. Never attaches to an existing one.",
  "  ff --help       this text",
  "",
  "All studios share ONE Claude account: --new lets more of them run at the same",
  "time, it does not buy more capacity, and a session limit stops all of them.",
  "",
  "The repo comes from `git remote origin` in the current directory; outside a",
  "git repo, ff falls back to the fleet's default repo. A studio that is not",
  "provisioned is provisioned first — ff waits for it and never attaches to a",
  "half-built container.",
  "",
  "Both task forms need a repo: the task is assigned to <repo>--<role>, and",
  "outside a git repo there is no such name to assign it to.",
  "",
  "Adoption refuses a task another studio already holds — moving one is",
  "Maestro's call: fleet task assign <n> <role>.",
  "",
  "Once attached, ctrl-] detaches (the studio keeps running).",
  "",
  "Related: fleet task new | fleet task ls | fleet ls | fleet recycle <id>",
].join("\n");

/**
 * The second positional, which is two different things (P5 §3's adoption).
 *
 * A bare number means an EXISTING issue: `ff web-studio 42` points the studio
 * at issue 42, whatever shape it arrived in — the operator's phone, an old untriaged
 * issue, a task whose studio died. Anything else is a NEW task to file.
 *
 * The two are told apart by shape rather than by a flag, because the shapes do
 * not overlap in practice: nobody files a task whose entire title is "42", and
 * a flag would put ceremony on the command whose whole point is having none.
 * `#42` is accepted too — that is how an issue number is written everywhere
 * else, and the alternative is a usage error for typing it correctly.
 */
export type FfTask =
  | { kind: "new"; text: string }
  | { kind: "adopt"; number: number };

export type FfArgs =
  /** Issue #269: `newInstance` is `--new` — spawn a FRESH instance of this
   *  role on the lowest free number rather than attaching to the one that is
   *  already there. False for every invocation written before #269, which is
   *  what makes the flag purely additive. */
  | { cmd: "ff"; role: string; task: FfTask | null; newInstance: boolean }
  | { cmd: "help" }
  | { cmd: "usage"; message: string };

/** Issue #269's `--new`, recognised by EXACT token anywhere in argv rather
 *  than by position: `ff --new`, `ff pilot --new` and `ff pilot --new "fix X"`
 *  all read the same, and an operator should not have to remember which side
 *  of the role it goes on. Exact-match only, so a task that merely CONTAINS
 *  the word (`ff pilot "drop the --new flag"` — one quoted argv entry) is
 *  untouched. */
const NEW_INSTANCE_FLAG = "--new";

/**
 * What `ff <role> "<task>"` fills in for the two brief sections the operator
 * did not type.
 *
 * §5 makes objective + output format + boundaries a hard floor, and
 * src/board/brief.ts refuses a task missing any of them — deliberately, since
 * a team gets no conversation to repair a bad spec with. A one-liner supplies
 * exactly one of the three, so the other two have to come from somewhere.
 *
 * They are NOT invented here. Both are the fleet's own standing contract,
 * already written into every studio's role prompt: report by envelope comment
 * on the issue, open the PR, never merge or deploy, stay in your own repo.
 * Restating them on the issue makes the contract visible on the board (and
 * editable there) instead of implicit in a prompt nobody reading the issue can
 * see. `ff` prints both when it files, so the operator can narrow them on the
 * issue itself; a task that needs different ones is what `fleet task new` is
 * for.
 */
export const FF_DEFAULT_OUTPUT =
  "PR against this repo, plus one envelope comment on this issue carrying " +
  "result, evidence, artifacts and status. The comment is the report.";

export const FF_DEFAULT_BOUNDARIES =
  "This repo only. No merge, no deploy — print an APPROVAL REQUEST block and " +
  "stop. Do not touch another studio's task, and never label, close or reopen " +
  "this issue: the Worker is the single writer of task state.";

/** The full brief `ff <role> "<task>"` files. Pure, so the exact wording that
 *  lands on a real issue is the wording a test asserts on. */
export function ffTaskBrief(task: string, assignee: string): {
  title: string; objective: string; outputFormat: string; boundaries: string; assignee: string; pendingSpawn: true;
} {
  return {
    title: task,
    objective: task,
    outputFormat: FF_DEFAULT_OUTPUT,
    boundaries: FF_DEFAULT_BOUNDARIES,
    assignee,
    // Issue #81: filed before its studio exists; the Worker allows that here.
    pendingSpawn: true,
  };
}

/**
 * `argv` is `process.argv.slice(2)`. At most TWO positionals: a role, which
 * must be a valid studio-id segment (ids.ts's grammar — the same check the
 * role half of a studio id has to pass anyway, applied here so a typo is a
 * local usage error instead of a round trip that ends in a 400), and a task
 * one-liner.
 *
 * The task is free text and gets exactly two checks, both of which exist to
 * fail LOCALLY rather than after a task has been filed: it must not be blank,
 * and it must fit GitHub's issue-title limit, which brief.ts would otherwise
 * reject server-side. Everything else about it is the board's business.
 *
 * A third positional is refused rather than ignored — an unquoted task
 * ("ff web-studio fix the header") arrives as several argv entries, and
 * silently taking only the first word would file a task saying "fix".
 *
 * Issue #269's `--new` is lifted out FIRST, before any of the positional
 * counting below, so it costs that grammar nothing: with the flag removed,
 * `ff pilot --new "fix X"` is the exact argv shape `ff pilot "fix X"` already
 * was, and the "quote your task" error still counts only real positionals.
 */
export function parseFfArgs(argv: string[]): FfArgs {
  const newInstance = argv.includes(NEW_INSTANCE_FLAG);
  const [first, ...rest] = argv.filter((a) => a !== NEW_INSTANCE_FLAG);
  if (first === "--help" || first === "-h") return { cmd: "help" };
  if (rest.length > 1) {
    return {
      cmd: "usage",
      message: `a task must be ONE argument — quote it: ff ${first} "${rest.join(" ")}"\n${FF_USAGE}`,
    };
  }
  if (first === undefined) return { cmd: "ff", role: DEFAULT_FF_ROLE, task: null, newInstance };
  if (!isIdSegment(first)) return { cmd: "usage", message: FF_USAGE };
  if (rest.length === 0) return { cmd: "ff", role: first, task: null, newInstance };
  const task = rest[0].trim();
  if (task === "") return { cmd: "usage", message: `the task is empty\n${FF_USAGE}` };
  // P5 §3: an issue NUMBER adopts, it does not file. Checked before the
  // title-length rules below, which are about a title this form never writes.
  const number = /^#?(\d+)$/.exec(task);
  if (number !== null) {
    const n = Number(number[1]);
    if (n <= 0) return { cmd: "usage", message: `#${n} is not an issue number\n${FF_USAGE}` };
    return { cmd: "ff", role: first, task: { kind: "adopt", number: n }, newInstance };
  }
  if (task.length > TASK_TITLE_MAX) {
    return {
      cmd: "usage",
      message: `the task is ${task.length} chars, over GitHub's ${TASK_TITLE_MAX}-char issue title limit — ` +
        `file it with \`fleet task new\` instead\n${FF_USAGE}`,
    };
  }
  return { cmd: "ff", role: first, task: { kind: "new", text: task }, newInstance };
}

/**
 * What `ff` treats as "safe to attach to".
 *
 * The notion of provisioned this reuses is do.ts's recycle check
 * (provisionedCheckCmd: repo checkout present AND claude running in `tmux
 * studio:claude`) — but this side of the wire can only read what the registry
 * publishes, and no route exposes that container probe to a client. So:
 * `running` with a clean `error` is the ONLY shape that reads as provisioned,
 * and everything else is provisioned first.
 *
 * That deliberately includes `state: "running"` with a non-null `error`,
 * which is exactly the shape recycle writes when its own check came back
 * inconclusive ("provisioned, but NOT verified: ..."). Unverified is not
 * proof, and re-provisioning is idempotent and cheap; attaching to a bare
 * container is what made a working fleet look dead for hours.
 */
export function isProvisioned(row: StudioStatus | null | undefined): boolean {
  return row !== null && row !== undefined && row.state === "running" && row.error === null;
}

/** Longest reason text this module will carry onto a single line. */
const REASON_MAX = 200;

/** Whitespace-collapsed and capped, so a multi-line container error cannot
 *  turn one progress line into a screenful (the same `replace(/\s+/g, " ")`
 *  treatment cli/fleet.ts's own ERROR column gives). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, REASON_MAX);
}

/** One line, always: the studio's state and — when there is one — why it is
 *  not provisioned. */
export function describeState(row: StudioStatus | null | undefined): string {
  if (row === null || row === undefined) return "not in the registry";
  if (row.error === null) return row.state;
  return `${row.state}: ${oneLine(row.error)}`;
}

export type FfDecision =
  /** Provisioned already — attach now, no waiting. */
  | { kind: "attach"; id: string }
  /** No such studio. `id` is null ONLY when this folder names no repo: the
   *  Worker then derives the id from the fleet's default repo (which this
   *  side does not know) and returns it.
   *
   *  Issue #269: `instance` is present only on the `--new` path, where it is
   *  the number THIS side allocated and the number the spawn request must
   *  carry. Absent means the ordinary instance-1 spawn, whose request omits
   *  the field entirely and is byte-identical to the pre-#269 one. */
  | { kind: "spawn"; id: string | null; instance?: number }
  /** It exists but is not provisioned. `reason` is describeState's line. */
  | { kind: "provision"; id: string; reason: string }
  /** Nothing can be decided without guessing. `message` says why. */
  | { kind: "error"; message: string };

/**
 * The whole of `ff`'s branching, in one place.
 *
 * `role === "maestro"` refuses before any of the below — board issue #250,
 * maestro is ALWAYS LOCAL, never a cloud studio. See that check's own
 * comment for why it subsumes the `--new` singleton refusal this used to
 * need separately.
 *
 * `repoSegment` is the detected repo's short name as an id segment
 * (repo.ts's repoIdSegment), or null when the current folder names no GitHub
 * repo at all. With one, the studio id is `<repo>--<role>` — the same
 * derivation `fleet spawn` already uses, so `ff` can never name a studio
 * `fleet ls` would not.
 *
 * Without one, the id cannot be derived: the fleet default repo is
 * deployment config (env.AGENT_REPO) that no route publishes. Two honest
 * answers replace guessing at it — the registry already holds exactly one
 * studio for this role (use it), or it holds none (spawn with no repo and
 * let the Worker name the child from its own default). More than one is the
 * only case with no honest answer, and it refuses by name rather than
 * picking.
 *
 * `repoSlug` is the SAME repo `repoSegment` was folded from (null alongside
 * it), and it is here for one reason: since board #21, `.` and `_` fold onto
 * `-` (repo.ts's repoIdSegment), so `o/a.b` and `o/a-b` reach for the same
 * segment. The Worker refuses the second SPAWN of a contested segment with a
 * 409 (repo.ts's claimedBy), but this path never asks the Worker to resolve a
 * repo at all — it attaches. Without the check below, `ff` inside `o/a.b`
 * would silently drop the operator into a studio checked out from `o/a-b`.
 *
 * `newInstance` is issue #269's `--new`, and it short-circuits everything
 * else: the answer is always a SPAWN, on the lowest free instance number for
 * this repo+role, and never an attach. That is the whole point of the flag —
 * an operator who types it wants a second lead working beside the first, so
 * landing in the first one's session would be the one outcome that cannot be
 * what they meant.
 *
 * `--new` therefore REQUIRES a repo, unlike every other `ff` form: the
 * allocation is per repo+role, and the fleet default repo is deployment config
 * this side cannot see. Guessing would allocate against the wrong repo's
 * studios and hand back a number that is already taken in the right one.
 */
export function ffDecision(
  rows: StudioStatus[], repoSegment: string | null, role: string, repoSlug: string | null,
  newInstance = false,
): FfDecision {
  // Board issue #250: maestro is ALWAYS LOCAL — a Claude Code session on
  // the operator's own machine, never a cloud studio `ff` would spawn or
  // attach to. Refused before anything else below (the "--new" singleton
  // check this used to need, and every ordinary spawn/attach/provision
  // branch), so bare `ff` (defaults to "maestro"), `ff maestro`, and
  // `ff maestro --new` all refuse the same way, regardless of repo or
  // instance. A cloud studio mistakenly provisioned with this role would
  // stop and escalate immediately anyway — see
  // fleet/blueprint/studios/maestro/studio.md, now a stub for exactly that
  // case — so there is nothing here `ff` could usefully spawn or attach to.
  if (role === "maestro") {
    return {
      kind: "error",
      message: "maestro runs locally, not as a cloud studio — start it from your own " +
        "machine (see docs/setup.md's local-maestro note), never with ff",
    };
  }
  if (newInstance) {
    if (repoSegment === null) {
      return {
        kind: "error",
        message: `--new allocates the next "${role}" instance for ONE repo, and this folder names ` +
          "none — cd into the repo you mean",
      };
    }
    const instance = nextFreeInstance(rows.map((r) => r.id), repoSegment, role);
    return { kind: "spawn", id: buildStudioId({ repo: repoSegment, role, instance }), instance };
  }
  let id: string | null;
  if (repoSegment !== null) {
    id = buildStudioId({ repo: repoSegment, role });
  } else {
    // Issue #281: one studio per repo -- its instance 1, the studio `ff <role>`
    // has always meant, or its lowest remaining instance. Once instances
    // exist, "more than one" no longer means "more than one repo".
    const perRepo = new Map<string, { id: string; instance: number }>();
    for (const r of rows) {
      const p = parseStudioId(r.id);
      if (p?.role !== role) continue;
      const held = perRepo.get(p.repo);
      if (held === undefined || p.instance < held.instance) perRepo.set(p.repo, { id: r.id, instance: p.instance });
    }
    const candidates = [...perRepo.values()].map((c) => c.id).sort();
    if (candidates.length > 1) {
      return {
        kind: "error",
        message: `this folder names no repo, and "${role}" runs in ${candidates.length} repos — pick one:\n` +
          candidates.map((c) => `  fleet attach ${c}\n`).join("") +
          `or cd into that repo and run: ff ${role}`,
      };
    }
    id = candidates[0] ?? null;
  }

  const row = id === null ? undefined : rows.find((r) => r.id === id);
  if (row === undefined) return { kind: "spawn", id };

  // A row that predates dynamic repo selection carries `repoSlug: null` — it
  // was cloned from the fleet default, and there is nothing to disagree with.
  // Only a row that NAMES a different repo is a collision.
  if (repoSlug !== null && row.repoSlug !== null
      && row.repoSlug.toLowerCase() !== repoSlug.toLowerCase()) {
    return {
      kind: "error",
      message: `${row.id} is checked out from "${row.repoSlug}", not "${repoSlug}" — ` +
        "dots and underscores fold to hyphens in a studio id, so these two repos reach for " +
        "the same studio; rename one repo or run it in its own fleet",
    };
  }

  if (isProvisioned(row)) return { kind: "attach", id: row.id };
  return { kind: "provision", id: row.id, reason: describeState(row) };
}

/**
 * What `ff` prints instead of attaching when the bring-up budget runs out.
 *
 * Three things, all required and none of them optional under pressure: WHICH
 * studio, WHAT was missing (describeState's last line), and the EXACT command
 * to retry — a timeout that says only "timed out" leaves the operator with
 * nothing to type, which is how a fleet that is one command away from healthy
 * gets read as dead.
 *
 * Lives here rather than inline in cli/ff.ts so the wording is asserted by a
 * test: this text is the entire product of the failure path.
 */
export function ffTimeoutLines(id: string, lastSeen: string, elapsedSeconds: number): string[] {
  return [
    `gave up after ${elapsedSeconds}s — ${id} is still not provisioned, so NOT attaching`,
    `last seen: ${lastSeen}`,
    `retry with: fleet provision ${id}`,
    `if it stays bare, the container is stranded: fleet recycle ${id}`,
  ];
}

/** Whether each end of this process is a real terminal. Node reports `isTTY`
 *  as `undefined` (not `false`) on a pipe, so the caller coerces. */
export interface TtyEnds {
  stdin: boolean;
  stdout: boolean;
}

export type FfAttachGate =
  /** A real terminal on both ends — attach, as `ff` always has. */
  | { kind: "attach" }
  /** No terminal. Say what happened and stop; never attach, never hang. */
  | { kind: "handoff"; lines: string[] };

/**
 * May this run attach? (Issue #43, part 1.)
 *
 * MEASURED 2026-09-23 on acme-os: `ff web-studio 2565` run from a
 * background shell (TTY=??) was still attached two hours later, holding a
 * tmux client at 80 columns — and with the bring-up's `window-size latest`,
 * that one stray client pinned the pane size for every other client on the
 * session. Killing the process did NOT give the size back; tmux held 80
 * columns until the operator's own attach terminal was closed and rebuilt.
 *
 * Both ends are required, and half a terminal is not one: without a tty on
 * stdin there is nothing to type with (and no ctrl-] to ever detach with, so
 * the attach is unkillable from the inside), and without a tty on stdout the
 * client cannot know its own size, so under frames.ts's size-declaration rule
 * it may declare none — leaving it attached at whatever width someone else set
 * while it paints escape sequences into a pipe nobody renders.
 *
 * An agent invoking `ff <role> <n>` from a background shell is a NORMAL thing
 * to do — the task form exists for exactly that — so this is a MESSAGE and a
 * clean exit, never a refusal that reads as failure and never a hang. The
 * spawn/provision/file-the-task work the run already did is real and is kept;
 * only the attach is dropped.
 */
export function ffAttachGate(tty: TtyEnds, id: string, task: number | null): FfAttachGate {
  if (tty.stdin && tty.stdout) return { kind: "attach" };
  const missing = !tty.stdin && !tty.stdout
    ? "stdin and stdout are"
    : `${tty.stdin ? "stdout" : "stdin"} is`;
  return {
    kind: "handoff",
    lines: [
      `${id} is up — not attaching: no terminal (${missing} not a tty)`,
      ...(task === null ? [] : [`  it is pointed at #${task}`]),
      "  a client with no terminal cannot declare its own size, and the pty is shared —",
      "  one that guesses pins every other client to that guess, and never exits on its own",
      `  attach from a real terminal: fleet attach ${id}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The container check — `GET /studio/:id/provisioned` (routes.ts).
//
// This is what closed the gap `ff` first shipped with. Before the route
// existed, a client could only INFER provisioned-ness from `state`/`error`,
// and the 2026-08-25 incident is exactly a container reporting `state:
// running` over an empty /workspace. The route runs the SAME check recycle
// gates on (do.ts's checkProvisionedWithRetry -> provision.ts's
// provisionedCheckCmd: repo checkout present AND claude running in `tmux
// studio:claude`) and destroys nothing.

/**
 * The route's JSON, mirrored. Deliberately re-declared rather than imported
 * from do.ts: that module pulls in "@cloudflare/sandbox", which does not
 * resolve under cli/tsconfig.json's bun-only `types`. test/studio.ff.test.ts
 * pins the two shapes together with a two-way assignability check, so the
 * mirror cannot silently drift from the source.
 */
export type ProvisionedVerdict =
  | { kind: "provisioned" }
  | { kind: "bare"; reason: string }
  | { kind: "inconclusive"; reason: string };

/**
 * The route's body, defensively.
 *
 * Anything unrecognisable — a 404 from a Worker that predates the route, an
 * HTML error page, a shape from a future version — reads as INCONCLUSIVE, not
 * as a failed studio. That is the same rule the check itself follows (a check
 * that cannot reach a verdict says nothing about the studio) applied one
 * layer out, and it is what lets `ff` keep working against a Worker where
 * this route is not deployed yet.
 */
export function parseVerdict(raw: unknown): ProvisionedVerdict {
  if (typeof raw === "object" && raw !== null) {
    const { kind, reason } = raw as { kind?: unknown; reason?: unknown };
    if (kind === "provisioned") return { kind: "provisioned" };
    if (kind === "bare" || kind === "inconclusive") {
      return { kind, reason: typeof reason === "string" ? oneLine(reason) : "no reason given" };
    }
  }
  return { kind: "inconclusive", reason: `unrecognised check response: ${oneLine(JSON.stringify(raw) ?? String(raw))}` };
}

export type VerdictOutcome =
  /** The container itself confirmed it. Attach. */
  | { kind: "provisioned"; note: string }
  /** The container itself said what is missing. Provision, or keep waiting. */
  | { kind: "not-provisioned"; note: string }
  /** No verdict, but the registry says running+clean — proceed on that, and
   *  say so, so a broken check can never make `ff` unusable. */
  | { kind: "unverified"; note: string }
  /** No verdict AND the registry does not say running either. Nothing here
   *  is evidence of anything; keep waiting / provision. */
  | { kind: "unknown"; note: string };

/**
 * Verdict + registry row -> what `ff` should do, and the exact line it says
 * while doing it.
 *
 * The inconclusive branch is the load-bearing one. A check that cannot run is
 * a statement about the CHECK; blocking on it would let one broken exec make
 * the fleet's only command unusable, which is a strictly worse failure than
 * the one this check prevents. So inconclusive falls back to the pre-route
 * signal (`state === "running"` and a clean `error`) and NAMES the fallback
 * in its own line — never silently.
 *
 * `note` deliberately carries no studio id: the caller prefixes it, and the
 * timeout report reuses it verbatim as "last seen".
 */
export function verdictOutcome(
  verdict: ProvisionedVerdict, row: StudioStatus | null | undefined,
): VerdictOutcome {
  if (verdict.kind === "provisioned") return { kind: "provisioned", note: "provisioned (container check)" };
  if (verdict.kind === "bare") return { kind: "not-provisioned", note: `not provisioned: ${verdict.reason}` };
  if (isProvisioned(row)) {
    return { kind: "unverified", note: `check inconclusive (${verdict.reason}) — trusting status: ${describeState(row)}` };
  }
  return { kind: "unknown", note: `check inconclusive (${verdict.reason}); status ${describeState(row)}` };
}
