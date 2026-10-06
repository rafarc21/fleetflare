#!/usr/bin/env bun
/**
 * `ff` — spawn-or-attach in two letters (P4 design §2.13 decision 13, §10).
 *
 * the operator types `ff <role>` in a repo folder and lands in a working claude
 * session for that repo's role. Nothing else typed, almost the whole product
 * surface — EXCEPT the role `maestro`: board issue #250 (maestro is ALWAYS
 * LOCAL, never a cloud studio) means bare `ff` and `ff maestro` both refuse
 * instead of spawning, since the role they'd resolve to is maestro. See
 * src/studio/ff.ts's ffDecision for the refusal and the maestro-playbook
 * skill's Role section for why.
 *
 *   ff <role>            this repo's web-studio / release-studio / ...
 *   ff <role> "<task>"   file that task, spawn the studio FOR it, attach
 *   ff <role> <n>        adopt existing issue #n, spawn the studio FOR it, attach
 *   ff --help
 *
 * COMPOSITION, not new machinery. Every piece already existed and is reused
 * as-is: cli/fleet.ts's credential loading, repo detection and attach client;
 * the Worker's existing /studio/ (ls), /studio/spawn, /studio/:id/provision
 * and /studio/:id/status routes, plus (for the task form) the board's own
 * POST /studio/board/tasks that `fleet task new` already calls.
 *
 * The task form is two acts fused into one command, and the ORDER matters:
 * file the task first (it is the durable artifact, and it carries the studio
 * assignment), then spawn the studio naming that task NUMBER. This side never
 * sends brief text to a spawn — the Worker reads the issue itself and refuses
 * a task not assigned to the studio it is building.
 *
 * The one rule this file exists to enforce: NEVER attach to a studio that is
 * not provisioned. Attaching onto a container whose bring-up had not finished
 * is what made a working fleet look dead for hours (2026-08-25) — so a studio
 * that is not provisioned is provisioned first, waited for with a visible
 * progress line and a bounded timeout, and on timeout this command says what
 * was missing and exits non-zero rather than attaching anyway.
 *
 * The decision itself is pure and unit-tested in src/studio/ff.ts; this file
 * is the I/O around it (see that file's header for why the split exists).
 */
import {
  loadCredentials, accessHeaders, studioUrl, boardUrl, detectRepo, cmdAttach, type Credentials,
  listStudioTasks,
} from "./fleet";
import { ensureStudioWorkspace, defaultOrcaDeps, studioWorkspaceTitle } from "./orca-workspace";
import { repoIdSegment } from "../src/studio/repo";
import {
  parseFfArgs, ffDecision, ffTaskBrief, parseVerdict, verdictOutcome, ffTimeoutLines, ffAttachGate,
  FF_HELP, type ProvisionedVerdict, type VerdictOutcome, type FfDecision, type FfTask,
} from "../src/studio/ff";
import type { StudioStatus } from "../src/studio/types";
import type { BoardTask } from "../src/board/types";
import { formatAssignWake } from "./task-format";
import { repairFailureLine } from "./repair-failure";
import { postTaskNew, taskNewFailureLine } from "./task-new-retry";
import type { AssignWakeReport } from "../src/board/assign-wake";

// ---------------------------------------------------------------------------
// Timings. A spawn is a container boot + clone + bring-up, so the ceiling is
// generous; what matters is that it EXISTS and that the wait is never silent.

/** Whole bring-up budget, measured from the moment ff starts spawning or
 *  provisioning — the blocking POST and the status poll after it share it. */
const WAIT_TIMEOUT_MS = 240_000;
/** Between status reads while waiting. Each read prints one line. */
const POLL_MS = 5_000;
/** Heartbeat while a POST is in flight — spawn/provision block for the whole
 *  bring-up, and silence during 60s of that reads as a hang. */
const TICK_MS = 5_000;

// ---------------------------------------------------------------------------
// Output. Same convention cli/fleet.ts uses: progress and errors on stderr
// (stdout belongs to the attached terminal), one short line per state change.

function say(line: string): void {
  console.error(`ff: ${line}`);
}

function fail(line: string): never {
  console.error(`ff: ${line}`);
  process.exit(1);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Elapsed seconds, for a progress line. */
function secs(sinceMs: number): number {
  return Math.round((Date.now() - sinceMs) / 1000);
}

/** Heartbeat for a long blocking call. Returns its own stopper — the interval
 *  must be cleared or it keeps the process alive after the work is done. */
function ticker(what: string): () => void {
  const started = Date.now();
  const timer = setInterval(() => say(`${what}... (${secs(started)}s)`), TICK_MS);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// The four calls, each one already-existing route, each in cli/fleet.ts's own
// shape: authenticated fetch, non-2xx reported with status + body, exit 1.

async function listStudios(creds: Credentials): Promise<StudioStatus[]> {
  const res = await fetch(new URL("/studio/", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) fail(`could not list studios: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as StudioStatus[];
}

/** The registry's own view. `null` on any failure rather than an exit: this
 *  is only ever the FALLBACK signal now (see fetchVerdict), and a single blip
 *  mid-bring-up is not a reason to abandon a container that is coming up
 *  fine. Read only when the container check reached no verdict, so the happy
 *  path costs one request, not two. */
async function fetchStatus(creds: Credentials, id: string): Promise<StudioStatus | null> {
  try {
    const res = await fetch(studioUrl(creds, id, "/status"), { headers: accessHeaders(creds) });
    if (!res.ok) return null;
    return (await res.json()) as StudioStatus;
  } catch {
    return null;
  }
}

/**
 * GET /studio/:id/provisioned — the container's own answer: repo checkout
 * present AND claude running in `tmux studio:claude`. The same check recycle
 * gates on, with none of recycle's destruction.
 *
 * Every failure mode maps to INCONCLUSIVE, never to a verdict about the
 * studio: a non-2xx (including the 404 a Worker that predates this route
 * gives), an unparseable body, a network error. That is what keeps `ff`
 * usable when the check itself is broken or not deployed — the caller falls
 * back to the registry signal and says so.
 */
async function fetchVerdict(creds: Credentials, id: string): Promise<ProvisionedVerdict> {
  try {
    const res = await fetch(studioUrl(creds, id, "/provisioned"), { headers: accessHeaders(creds) });
    if (!res.ok) {
      return { kind: "inconclusive", reason: `check route ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return parseVerdict(await res.json());
  } catch (err) {
    return { kind: "inconclusive", reason: `check unreachable: ${errText(err)}` };
  }
}

/** One check, plus the registry row ONLY when the check reached no verdict.
 *  verdictOutcome owns what the pair means; this is just the two reads. */
async function readOutcome(creds: Credentials, id: string): Promise<VerdictOutcome> {
  const verdict = await fetchVerdict(creds, id);
  const row = verdict.kind === "inconclusive" ? await fetchStatus(creds, id) : null;
  return verdictOutcome(verdict, row);
}

/**
 * POST /studio/spawn — the operator spawn cmdSpawn already uses, with the
 * detected repo riding along exactly as it does there (omitted entirely when
 * this folder names none, so the Worker's own default is the single source of
 * that fallback). Returns the child's id, which for the no-repo case is the
 * ONLY way to learn it: it is derived from env.AGENT_REPO, which no route
 * publishes.
 *
 * A 409 whose body is spawn.ts's own "studio exists" is NOT a failure here:
 * it means something created the studio between this command's `ls` and its
 * spawn (a second `ff`, a concurrent `fleet spawn`). The studio we wanted now
 * exists, so the right move is to fall through to the wait — as long as we
 * can name it, which is exactly when the repo was detected.
 */
async function spawnStudio(
  creds: Credentials, role: string, repoSlug: string | null, knownId: string | null,
  task: number | null, instance: number | "next" | undefined,
): Promise<string> {
  const stop = ticker(`spawning ${knownId ?? role}`);
  try {
    const res = await fetch(new URL("/studio/spawn", creds.workerUrl), {
      method: "POST",
      headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
      // `task` is the issue NUMBER, never the brief text: the Worker reads the
      // issue itself and verifies it is assigned to the studio it is about to
      // build. This side cannot write a lead's system prompt, only name a task.
      //
      // Issue #281: `--new` sends `"next"` — the Worker allocates the
      // instance, and ffSpawnNew labels the task only AFTER this returns the
      // id. (#269 allocated client-side and labelled first, so two concurrent
      // `--new` both labelled for the same number and the loser's task landed
      // on the winner's studio.) Omitted entirely without `--new`, so that
      // request is byte-identical to the pre-#269 one.
      body: JSON.stringify({
        role, ...(repoSlug ? { repo: repoSlug } : {}), ...(task === null ? {} : { task }),
        ...(instance === undefined ? {} : { instance }),
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).trim();
      // The wait-for-it recovery is for the ORDINARY path, where a 409 means
      // "the studio you asked for is already there" and waiting is exactly
      // right. On `--new` it would mean "someone took the number you
      // allocated", and waiting would drop the operator into a studio they did
      // not ask for — so that case fails and says to run it again.
      if (res.status === 409 && body === "studio exists" && knownId !== null && instance === undefined) {
        say(`${knownId} was created by something else just now — waiting for it`);
        return knownId;
      }
      if (res.status === 409 && body === "studio exists" && instance !== undefined) {
        fail(`${knownId ?? role} ${instance === "next" ? "the next free instance" : `instance ${instance}`} ` +
          "was just taken by another spawn — run it again");
      }
      fail(`spawn failed: ${res.status} ${body.slice(0, 300)}`);
    }
    return ((await res.json()) as StudioStatus).id;
  } finally {
    stop();
  }
}

/**
 * POST /studio/:id/provision — the same idempotent re-provision `fleet
 * provision` runs, and the operator's own proven recovery for a studio that
 * is not provisioned. The body carries the detected repo only when this
 * command derived the id FROM that repo (the Worker refuses a repo that
 * disagrees with the id); otherwise it is bodyless, which resolves to
 * whatever repo the studio is already bound to.
 */
async function provisionStudio(
  creds: Credentials, id: string, repoSlug: string | null, task: number | null,
): Promise<void> {
  const stop = ticker(`provisioning ${id}`);
  try {
    const res = await fetch(studioUrl(creds, id, "/provision"), {
      method: "POST",
      headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(repoSlug ? { repo: repoSlug } : {}), ...(task === null ? {} : { task }),
      }),
    });
    if (!res.ok) fail(repairFailureLine("provision", res.status, await res.text(), "provision failed"));
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// The task, for `ff <role> "<task>"`.

/**
 * Files the one-liner on the board, assigned to `studioId`, and returns the
 * issue number the spawn/provision call then names.
 *
 * Filed BEFORE the studio is built, deliberately. The issue is the durable
 * half of this command: if the spawn then fails, the task is still on the
 * board under that studio's own label, visible to `fleet task ls` and to the
 * next `ff <role>` — which is strictly better than losing what the operator
 * asked for because a container did not come up.
 *
 * The two brief sections the operator did not type are printed, not hidden:
 * they are defaults (see src/studio/ff.ts's FF_DEFAULT_*), the issue is
 * editable, and an operator who cannot see what was filed on his behalf
 * cannot correct it.
 */
/**
 * `retryDelaysMs`/`sleep` are exposed only so test/bun/ff-file-task-retry.test.ts
 * can drive a real retry without a real wait — `main()` below calls this with
 * neither, which is what keeps production on postTaskNew's own defaults.
 */
export async function fileTask(
  creds: Credentials, repoSlug: string | null, studioId: string, task: string,
  retryDelaysMs?: number[], sleep?: (ms: number) => Promise<void>,
): Promise<number> {
  const brief = ffTaskBrief(task, studioId);
  // Issue #147: same duplicate risk #139/PR #142 fixed for `fleet task new` —
  // an upstream 5xx (a 520, a dropped connection) after GitHub already
  // created the issue looked like a failure, the operator reran `ff`, and
  // that filed a SECOND issue and spawned a SECOND studio. One key per
  // invocation, the body built once and replayed unchanged: the Worker
  // resolves a replay of a create that already landed to the existing issue.
  const key = crypto.randomUUID();
  const res = await postTaskNew((body) => fetch(boardUrl(creds, "/tasks"), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body,
  }), repoSlug ? { ...brief, repo: repoSlug } : brief, key, retryDelaysMs, sleep);
  if (!res.ok) fail(taskNewFailureLine(res.status, await res.text(), key));
  const filed = (await res.json()) as BoardTask & { wake?: AssignWakeReport; pathWarnings?: string[] };
  say(`filed #${filed.number} -> ${studioId}`);
  say(`  ${filed.url}`);
  say(`  output format and boundaries defaulted — edit the issue to narrow them`);
  // Board issue #41: filing WITH an assignee is an assignment, so the Worker
  // wakes it. On this path the studio usually does not exist yet (the task is
  // filed BEFORE the spawn, deliberately — see this function's own header),
  // and the refusal saying so is exactly right: the spawn below is what gives
  // that lead its first turn, carrying this brief in its system prompt.
  const wake = formatAssignWake(filed.wake);
  if (wake !== null) say(`  ${wake}`);
  // Board issue #112 / #70 ask 8: one advisory line per path-claim overlap.
  for (const w of filed.pathWarnings ?? []) say(`  ${w}`);
  return filed.number;
}

/**
 * `ff <role> <n>` — ADOPTION (P5 §3). Points the studio at an issue that
 * already exists, whatever shape it arrived in.
 *
 * The Worker does every write: it stamps `studio:<repo>--<role>`, resets the
 * state to `submitted`, and comments the lineage. This side sends a number
 * and a studio id and nothing else — same rule the task form follows, and the
 * reason there is no `gh issue edit` anywhere in this file.
 *
 * Refused (409) when another studio already holds it, and the refusal names
 * the verb that CAN move it. Taking a task off another studio silently, from a
 * two-letter command, is the drift class this whole board exists to prevent.
 */
async function adoptTask(
  creds: Credentials, repoSlug: string | null, studioId: string, number: number,
): Promise<number> {
  const res = await fetch(boardUrl(creds, `/tasks/${number}/adopt`), {
    method: "POST",
    headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
    body: JSON.stringify({ assignee: studioId, ...(repoSlug ? { repo: repoSlug } : {}) }),
  });
  if (!res.ok) fail(`could not adopt #${number}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const adopted = (await res.json()) as BoardTask & { wake?: AssignWakeReport };
  say(`adopted #${adopted.number} -> ${studioId} (${adopted.state})`);
  say(`  ${adopted.url}`);
  say(`  ${adopted.title}`);
  // Board issue #41, and board issue #158: the Worker wakes the studio an
  // adoption points at, and says whether it landed. Present on every
  // successful adoption now, including one that changes nothing on the
  // board itself (#158's same-studio nudge) — the wake fires either way.
  const wake = formatAssignWake(adopted.wake);
  if (wake !== null) say(`  ${wake}`);
  return adopted.number;
}

// ---------------------------------------------------------------------------
// The wait. The hard requirement of this whole command.

/**
 * Polls until the studio reads provisioned, or the budget runs out. Returns
 * false on timeout, having already printed what was missing and how to retry
 * — the caller exits non-zero. It never returns "attach anyway", and it never
 * waits without printing.
 *
 * `startedAt` is when the bring-up began, NOT when this loop did: the
 * spawn/provision POST blocks for most of a bring-up, and a timeout that
 * started counting only afterwards would be a second full budget on top of an
 * already-slow one.
 */
async function waitProvisioned(creds: Credentials, id: string, startedAt: number): Promise<boolean> {
  let lastNote = "no check has run yet";
  for (;;) {
    const outcome = await readOutcome(creds, id);
    // "unverified" proceeds deliberately: the check could not reach a verdict
    // AND the registry says running+clean. Waiting out the full budget on a
    // check that is itself broken would make `ff` unusable — a strictly worse
    // failure than the one the check prevents — so it goes, and says why.
    if (outcome.kind === "provisioned" || outcome.kind === "unverified") {
      say(`${id}: ${outcome.note} — attaching`);
      return true;
    }
    lastNote = outcome.note;
    if (Date.now() - startedAt >= WAIT_TIMEOUT_MS) {
      for (const line of ffTimeoutLines(id, lastNote, secs(startedAt))) say(line);
      return false;
    }
    say(`${id}: ${outcome.note} — waiting (${secs(startedAt)}s)`);
    await Bun.sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// The attach, and the one case that must not attach.

/**
 * The single exit of every successful path: open the sidebar row, then attach
 * — unless there is no terminal to attach INTO, in which case say so and
 * return.
 *
 * ffAttachGate owns the decision and the wording (see its doc comment for the
 * 2026-09-23 measurement that put it there). This function owns only the two
 * I/O halves: reading whether each end of THIS process is a tty, and doing
 * nothing further when it is not.
 *
 * The Orca row is opened on BOTH paths, deliberately. the operator's rule — a studio
 * that is up owes the sidebar a row — is about the studio, not about this
 * process: the row is what survives a detach, and a run with no terminal is
 * the run most likely to leave nothing else behind. On a container, where
 * there is no Orca binary, ensureStudioWorkspace is already a no-op.
 */
async function attachOrHandOff(creds: Credentials, id: string, task: number | null): Promise<void> {
  const rowTasks = await listStudioTasks(creds, id);
  await ensureStudioWorkspace(id, studioWorkspaceTitle(id, rowTasks), defaultOrcaDeps());
  const gate = ffAttachGate(
    { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true }, id, task,
  );
  if (gate.kind === "handoff") {
    for (const line of gate.lines) say(line);
    return;
  }
  return cmdAttach(creds, id);
}

// ---------------------------------------------------------------------------
// `--new` with a task — issue #281

export interface FfSpawnNewDeps {
  /** Spawn with the Worker allocating the instance; the child's id. */
  spawn(): Promise<string>;
  /** waitProvisioned: true once the studio is up. */
  wait(id: string): Promise<boolean>;
  file(id: string, text: string): Promise<number>;
  adopt(id: string, number: number): Promise<number>;
}

/**
 * `ff <role> --new ["<task>"]`: SPAWN first, the Worker allocating the
 * instance; wait for the studio; only THEN file or adopt the task, against the
 * id the spawn returned. `stale` is what ffDecision computed from a listing
 * other `--new` calls may have read too: it is never used to label a task.
 *
 * The lead therefore hears about the task through the assignment's wake
 * (board #41) rather than its boot prompt — the same delivery the attach path
 * relies on — and a studio that never comes up gets no task at all (null).
 */
export async function ffSpawnNew(
  stale: Extract<FfDecision, { kind: "spawn" }>, task: FfTask | null, deps: FfSpawnNewDeps, role = "<role>",
): Promise<{ id: string; task: number | null } | null> {
  const id = await deps.spawn();
  if (id !== stale.id) say(`--new: the Worker allocated ${id} (this listing said ${stale.id ?? "none"})`);
  if (!(await deps.wait(id))) {
    // #294 r2: the timeout lines above say the STUDIO failed; say what
    // happened to the TASK too, and the retry that does not leave `id`
    // running beside a fresh instance.
    if (task !== null) {
      say(task.kind === "new"
        ? `task NOT filed: "${task.text}" — ${id} never came up`
        : `issue #${task.number} NOT adopted (still where it was) — ${id} never came up`);
      const again = task.kind === "new" ? `ff ${role} --new "${task.text}"` : `ff ${role} --new ${task.number}`;
      say(`  retry: fleet destroy ${id}   then: ${again}`);
    }
    return null;
  }
  if (task === null) return { id, task: null };
  const number = task.kind === "new" ? await deps.file(id, task.text) : await deps.adopt(id, task.number);
  return { id, task: number };
}

// ---------------------------------------------------------------------------
// entry point

async function main(): Promise<void> {
  const parsed = parseFfArgs(process.argv.slice(2));
  if (parsed.cmd === "help") {
    console.log(FF_HELP);
    return;
  }
  if (parsed.cmd === "usage") {
    console.error(parsed.message);
    process.exit(1);
  }

  // Argument shape is settled before credentials are touched — same ordering
  // cli/fleet.ts's main() uses, so a typo'd role never surfaces as an
  // unrelated broken-credentials error.
  const creds = await loadCredentials();

  const detected = await detectRepo();
  let segment: string | null = null;
  if (detected.slug !== null) {
    const short = detected.slug.split("/")[1];
    segment = repoIdSegment(short);
    // A repo whose short name cannot be an id segment even after the fold
    // (`.`/`_` -> `-`, repo.ts's repoIdSegment) is refused here rather than
    // silently falling back to the fleet default:
    // falling back would attach the operator to a DIFFERENT repo's studio, which is
    // the silent-wrong-target failure the whole repo-detection feature exists
    // to remove. The wording matches repo.ts's own 400 for the same case.
    if (segment === null) {
      fail(`repo "${detected.slug}" cannot name a studio: "${short}" is not a valid id segment ` +
        "(lowercase alphanumerics joined by single hyphens; dots and underscores fold to hyphens)");
    }
    say(`repo ${detected.slug} (from git remote origin)`);
  } else {
    say(`${detected.reason} — using the fleet's default repo`);
  }

  const decision = ffDecision(
    await listStudios(creds), segment, parsed.role, detected.slug, parsed.newInstance,
  );

  if (decision.kind === "error") fail(decision.message);

  // `ff <role> "<task>"`. The task is assigned to a studio id, so this form
  // needs one — and outside a git repo `ff` cannot derive it (the fleet's
  // default repo is deployment config no route publishes; see ffDecision).
  // Refusing by name beats filing a task against a studio the operator did
  // not mean.
  // Issue #281: `--new` files its task only after the spawn (ffSpawnNew).
  const isNew = decision.kind === "spawn" && decision.instance !== undefined;
  let task: number | null = null;
  if (parsed.task !== null && !isNew) {
    if (decision.id === null) {
      fail("a task needs a studio to assign it to, and this folder names no repo — " +
        `cd into the repo you mean, or file it with: fleet task new --title ... (role "${parsed.role}")`);
    }
    task = parsed.task.kind === "new"
      ? await fileTask(creds, detected.slug, decision.id, parsed.task.text)
      : await adoptTask(creds, detected.slug, decision.id, parsed.task.number);
  }

  // Started here, not after the branch: the budget the wait loop enforces
  // covers the whole bring-up, and on the attach path below the check itself
  // is already part of it.
  const startedAt = Date.now();
  let id: string;
  if (decision.kind === "attach") {
    // The registry says this one is up. Before attaching, ASK THE CONTAINER:
    // the registry only records what provisioning last CLAIMED, and the
    // 2026-08-25 incident is precisely a container reporting `state: running`
    // over an empty /workspace. One extra request on the happy path, and it
    // is the request that makes "attach fast" safe rather than hopeful.
    const outcome = await readOutcome(creds, decision.id);
    if (outcome.kind === "provisioned" || outcome.kind === "unverified") {
      say(`${decision.id}: ${outcome.note} — attaching`);
      // A brief reaches a lead through its SYSTEM PROMPT, which is written
      // once, when claude launches (container/studio-bringup.sh only launches
      // it when the pane is still bash). This studio is already up and
      // running something, so there is nothing to inject into — and a studio
      // is one task at a time by design (§2.2).
      //
      // Board issue #41: the assignment above now WAKES this studio, which is
      // the automatic version of what this used to ask the operator to type.
      // The hint stays as the fallback for the cases the wake refuses (a lead
      // whose pane is a bare shell, a container that would not answer) — the
      // `woke the studio:` / `NO WAKE —` line printed above says which.
      if (task !== null) {
        say(`${decision.id} is already running — it did NOT boot with this brief; the wake above is how it hears about it.`);
        // Board issue #213: provision/restart/recycle now all deliver the
        // assigned task on bring-up (deliverAssignedTaskOnBringup, src/studio/
        // do.ts), not just recycle — so any of the three is a real fallback,
        // not only the heaviest one.
        say(`  if that said NO WAKE, tell it: fleet task show ${task}   (or provision/recycle the studio to boot it on the task)`);
      }
      // the operator's rule: a studio that is up owes the sidebar a row. `ff` attaches
      // in THIS terminal, which disappears the moment he detaches — the row is
      // what survives that, so it is opened even on the fast attach path.
      return attachOrHandOff(creds, decision.id, task);
    }
    // The container disagrees with the registry (or nothing can be read at
    // all). Same repair as any other unprovisioned studio: provision, wait,
    // then attach — never attach on a "bare" answer.
    say(`${decision.id}: ${outcome.note} — provisioning it`);
    await provisionStudio(creds, decision.id, segment === null ? null : detected.slug, task);
    id = decision.id;
  } else if (decision.kind === "spawn") {
    if (isNew) {
      say(`--new: spawning the next free "${parsed.role}" instance (the Worker allocates it)`);
      const spawned = await ffSpawnNew(decision, parsed.task, {
        spawn: () => spawnStudio(creds, parsed.role, detected.slug, null, null, "next"),
        wait: (newId) => waitProvisioned(creds, newId, startedAt),
        file: (newId, text) => fileTask(creds, detected.slug, newId, text),
        adopt: (newId, number) => adoptTask(creds, detected.slug, newId, number),
      }, parsed.role);
      if (spawned === null) process.exit(1);
      if (spawned.task !== null) {
        say(`  if the wake above said NO WAKE, tell it: fleet task show ${spawned.task}`);
      }
      return attachOrHandOff(creds, spawned.id, spawned.task);
    }
    say(`no ${decision.id ?? `${parsed.role} studio`} in the fleet yet — spawning it`);
    id = await spawnStudio(creds, parsed.role, detected.slug, decision.id, task, decision.instance);
  } else {
    say(`${decision.id} exists but is not provisioned (${decision.reason}) — provisioning it`);
    await provisionStudio(creds, decision.id, segment === null ? null : detected.slug, task);
    id = decision.id;
  }

  // waitProvisioned prints its own "— attaching" line on the way out (it is
  // the one that knows WHETHER the container confirmed it or the status
  // fallback did), so there is nothing to add here.
  if (!(await waitProvisioned(creds, id, startedAt))) process.exit(1);
  // The spawn/provision paths, same rule and same reason as the attach path
  // above. Placed AFTER the wait so the sidebar row's own `fleet attach` never
  // opens onto a container that is still coming up.
  return attachOrHandOff(creds, id, task);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`ff: ${errText(err)}`);
    process.exit(1);
  });
}
