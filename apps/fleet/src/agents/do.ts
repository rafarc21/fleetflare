import { Container } from "@cloudflare/containers";
import type { Env } from "../env";
import { advanceTask, type TaskRecord, type LoopDeps, type LoopOutcome } from "../tasks/loop";
import { clearRearm } from "../tasks/watchdog";
import { ContainerRuntime, type AgentRuntime, type StartTaskInput } from "./runtime";
import { telegramConfig } from "./registry";

const POLL_SECONDS = 5;
const TASK_KEY = "task";
// advanceTask() declares a task dead and returns kind:"terminal" exactly
// when task.failedPolls reaches this. Shared (not duplicated) so the value
// fed to advanceTask and the inference in shouldAbortOnTerminal below can't
// drift apart.
const MAX_FAILED_POLLS = 3;

interface StartBody { task: TaskRecord; prompt: string; repo: string; ref: string; ghToken: string }

/**
 * Maps the /start POST body to the runtime's startTask() input. Pure and
 * exported so prompt fidelity — the operator's message reaching startTask()
 * unaltered — is unit-testable with FakeRuntime: a live AgentDO cannot be
 * constructed under vitest-pool-workers (see test/telegram.webhook.test.ts's
 * "Known gap" note), so this is the seam. This is the successor to Day 1's
 * deleted "passes the operator's text through to the runtime unchanged" —
 * see test/agents.do.test.ts.
 */
export function toStartInput(body: StartBody): StartTaskInput {
  return {
    taskId: body.task.taskId, prompt: body.prompt,
    repo: body.repo, ref: body.ref, ghToken: body.ghToken,
  };
}

/**
 * True exactly when a terminal outcome came from advanceTask's
 * dead-container path (repeated status() failures), never from any other
 * terminal branch: every other terminal branch resets failedPolls to 0
 * (done/failed/pending approval, right after a successful status() call) or
 * leaves it at its pre-call value, which advanceTask guarantees is always <
 * MAX_FAILED_POLLS on entry — it goes terminal the instant the count would
 * reach the threshold. So this can only be true on the dead-container path.
 * Extracted (fix round 1, Important 3) so the inference — and the abort
 * decision it gates — is unit-testable without a real AgentDO; see
 * test/agents.do.test.ts.
 */
export function shouldAbortOnTerminal(out: { task: TaskRecord }): boolean {
  return out.task.failedPolls >= MAX_FAILED_POLLS;
}

/**
 * Parses MAX_TASK_SECONDS, falling back to DEFAULT_MAX_TASK_SECONDS for
 * anything that isn't a finite number — not just when the var is unset.
 * A bare `Number(this.env.MAX_TASK_SECONDS ?? 900)` yields NaN on a typo'd
 * value, and advanceTask's budget check, `(now - start)/1000 >
 * maxTaskSeconds`, is false for every comparison against NaN — silently
 * disabling the only cost ceiling on an opus agent (spec §11 calls this the
 * largest unattended money unknown). Extracted so the guard is
 * unit-testable without a real AgentDO, same reason as the functions above.
 */
export const DEFAULT_MAX_TASK_SECONDS = 900;

export function parseMaxTaskSeconds(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_MAX_TASK_SECONDS);
  return Number.isFinite(n) ? n : DEFAULT_MAX_TASK_SECONDS;
}

/** pollOnce's result. A superset of LoopOutcome's "continue"/"terminal" plus
 *  "error" for when advance() itself threw. */
export interface PollOutcome {
  kind: "continue" | "terminal" | "error";
  task: TaskRecord;
}

/**
 * One pollTask cycle's result, decided WITHOUT touching storage or the
 * scheduler — pollTask (below) is the only caller, and performs the actual
 * this.ctx.storage / this.schedule side effects against what this returns.
 * A plain function taking deps as parameters, exactly like advanceTask
 * itself (the third `advance` parameter defaults to the real advanceTask
 * and exists only so a test can inject a throwing stand-in).
 *
 * Exists so the failure mode Important 2 (fix round 1) found is
 * unit-testable without a real AgentDO: an uncaught throw from advanceTask
 * — an unguarded D1 write inside it (appendEvent, createApproval) is the
 * likely cause — must produce kind:"error", never propagate. The Container
 * library's own alarm() (node_modules/@cloudflare/containers/dist/lib/
 * container.js:843-853) wraps the scheduled callback in try/catch, logs,
 * and then deletes the firing schedule row UNCONDITIONALLY, whether the
 * callback threw or not. pollTask only ever creates the NEXT "pollTask"
 * schedule after seeing a result (below), so letting a throw propagate
 * uncaught means: no schedule survives, TASK_KEY is never cleared, no poll
 * ever fires again, the operator is never told, and every later /start
 * 409s forever — un-healable by sleepAfter, since DO storage survives
 * container stop and hibernation. Rescheduling with the pre-poll task on
 * error, instead of wedging, can duplicate some already-written D1 state on
 * retry if advanceTask threw partway through (loop.ts has no idempotency
 * keys beyond the webhook's own update_id dedupe) — a strictly better
 * failure mode than "silently dead forever."
 */
export async function pollOnce(
  deps: LoopDeps,
  task: TaskRecord,
  advance: (d: LoopDeps, t: TaskRecord) => Promise<LoopOutcome> = advanceTask,
): Promise<PollOutcome> {
  try {
    return await advance(deps, task);
  } catch (err) {
    console.error("advanceTask threw; rescheduling instead of wedging", err);
    return { kind: "error", task };
  }
}

/**
 * True exactly when pollTask's poll cycle actually completed — kind
 * "continue" or "terminal" — as opposed to "error" (advanceTask itself
 * threw; pollOnce's catch above returns the pre-poll task unmutated).
 *
 * Fix round 1 (task 10a review, Important finding): the schedule firing is
 * not, on its own, proof a poll happened. A persistent throw inside
 * advanceTask (an unguarded appendEvent/createApproval failure — report()
 * in tasks/loop.ts has no try/catch anywhere in its chain) makes pollOnce
 * return kind:"error" on every 5s retry, with lastHeartbeat frozen at its
 * pre-throw value. Clearing the re-arm counter on that outcome anyway — the
 * bug this replaces, which called clearRearm unconditionally before
 * pollOnce even ran — resets the counter faster than the 60s cron
 * (scheduled(), src/index.ts) can ever read two consecutive non-zero
 * values, making its attempts >= 2 alert structurally unreachable for
 * exactly the failure class the watchdog exists to catch, even though
 * staleTasks() keeps correctly flagging the task as stale on every tick.
 * See clearRearm's doc comment in tasks/watchdog.ts.
 *
 * Extracted so the decision is unit-testable without a real AgentDO — same
 * reason as shouldAbortOnTerminal/pollOnce above; pollTask's own call site is
 * now one call to pollAndClearRearm (below), which wraps this gated call —
 * see its doc comment for why the clearRearm step itself had to move into a
 * testable seam too.
 */
export function shouldClearRearm(result: { kind: PollOutcome["kind"] }): boolean {
  return result.kind !== "error";
}

/**
 * pollTask's single call per cycle: runs pollOnce, then — gated on
 * shouldClearRearm — clears the re-arm counter and the alert flag, and
 * returns pollOnce's result either way.
 *
 * The clearRearm step lives here, not as a second bare `await` in pollTask
 * itself, because it is a real network D1 write (clearRearm -> setFlag ->
 * INSERT ... ON CONFLICT) that can throw, and pollTask has no try/catch of
 * its own: an uncaught throw here would stop pollTask before it reaches its
 * own storage.put/schedule (continue) or storage.delete (terminal) calls
 * below, and the Container library's own alarm()
 * (node_modules/@cloudflare/containers/dist/lib/container.js:843-853)
 * deletes the firing schedule row UNCONDITIONALLY regardless of whether the
 * callback threw — so nothing would ever reschedule, TASK_KEY would never
 * clear, and every later /start would 409 forever. The exact wedge f970d85
 * fixed, reopened by this one remaining unguarded call.
 *
 * Folded into this seam, rather than guarded inline in pollTask, so it is
 * unit-testable the same way pollOnce itself is: pollTask, an AgentDO
 * method, cannot be constructed under vitest-pool-workers, but this plain
 * function taking `deps` can — see test/agents.do.test.ts.
 */
export async function pollAndClearRearm(
  deps: LoopDeps,
  task: TaskRecord,
  advance: (d: LoopDeps, t: TaskRecord) => Promise<LoopOutcome> = advanceTask,
): Promise<PollOutcome> {
  const result = await pollOnce(deps, task, advance);
  if (shouldClearRearm(result)) {
    try {
      await clearRearm(deps.db, task.taskId, deps.now);
    } catch (err) {
      console.error("clearRearm failed; leaving the task to reschedule anyway", err);
    }
  }
  return result;
}

export class AgentDO extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20m";

  envVars = {
    CLAUDE_CODE_OAUTH_TOKEN: this.env.CLAUDE_CODE_OAUTH_TOKEN,
    AGENT_WORKDIR: "/workspace",
    // Threaded so the model is a config change (edit env, redeploy), not a
    // container rebuild. container/server.ts carries the same default.
    AGENT_MODEL: this.env.AGENT_MODEL ?? "claude-opus-5",
  };

  private runtime: AgentRuntime | undefined;

  /** Only for a real instance under runInDurableObject. advanceTask's own
   *  `runtime` parameter is the seam the unit tests use. */
  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  private rt(): AgentRuntime {
    return this.runtime ?? new ContainerRuntime(this);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/start" && req.method === "POST") {
      const body = (await req.json()) as StartBody;
      // One task per agent (spec §11). The container also returns 409, but
      // refusing here is what keeps a second inbound message from costing a
      // second opus turn — by the time the container answers, it has started.
      const inFlight = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
      if (inFlight) {
        return Response.json({ busy: true, taskId: inFlight.taskId }, { status: 409 });
      }
      await this.ctx.storage.put(TASK_KEY, body.task);
      await this.rt().startTask(toStartInput(body));
      await this.schedule(POLL_SECONDS, "pollTask", { taskId: body.task.taskId });
      return Response.json({ started: body.task.taskId });
    }
    if (url.pathname === "/abort" && req.method === "POST") {
      this.deleteSchedules("pollTask");
      await this.ctx.storage.delete(TASK_KEY);
      try {
        await this.rt().abort();
      } catch (err) {
        // Fix round 1, Important 4: fleet-side state is already cleared
        // above (schedule gone, TASK_KEY gone) — a throw here must not
        // tell Task 6's /stop caller the stop failed when it already
        // mostly succeeded. Same pattern as pollTask's terminal-path abort
        // below, and webhook.ts's paused notice.
        console.error("abort on /stop failed", err);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/rearm" && req.method === "POST") {
      // Called by scheduled()'s cron handler (src/index.ts) when staleTasks()
      // decides this task's schedule stopped firing. Re-reads the stored
      // TaskRecord rather than trusting the caller's own view of it — the
      // record here is authoritative — and reschedules exactly the same way
      // /start does.
      const task = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
      if (!task) {
        return Response.json({ rearmed: false });
      }
      // Guard against a false-positive stale read (a slow-but-not-dead
      // container, clock skew): if the original "pollTask" schedule is
      // actually still alive, schedule() below would add a SECOND
      // independent row alongside it rather than replace it — the library
      // always inserts a fresh id (dist/lib/container.js:467-468,
      // generateId(9) every call, no dedup by callback name) — leaving two
      // live schedules double-polling this task from here on. Same idiom
      // /abort already uses just above.
      this.deleteSchedules("pollTask");
      await this.schedule(POLL_SECONDS, "pollTask", { taskId: task.taskId });
      return Response.json({ rearmed: true, taskId: task.taskId });
    }
    if (url.pathname === "/heartbeat") {
      const task = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
      return Response.json({ task: task ?? null });
    }
    return new Response("not found", { status: 404 });
  }

  /** Scheduled callback. Named, not an alarm() override — Container owns alarm(). */
  async pollTask(_payload: { taskId: string }): Promise<void> {
    const task = await this.ctx.storage.get<TaskRecord>(TASK_KEY);
    if (!task) return; // aborted or already terminal

    // Explicit, because a poll is activity: without this a task that runs
    // longer than sleepAfter has its container stopped underneath it.
    this.renewActivityTimeout();

    const result = await pollAndClearRearm(
      {
        db: this.env.DB,
        runtime: this.rt(),
        // Board #334: reachable only through /tg or the cron, both off unless Telegram is.
        botToken: telegramConfig(this.env)?.token ?? "",
        now: Date.now(),
        maxTaskSeconds: parseMaxTaskSeconds(this.env.MAX_TASK_SECONDS),
        maxFailedPolls: MAX_FAILED_POLLS,
      },
      task,
    );

    if (result.kind === "terminal") {
      // advanceTask's dead-container path (repeated status() failures) is
      // the one terminal branch that never calls runtime.abort() itself,
      // unlike its budget-exceeded branch — Task 3's review deferred the
      // decision to this file. Decided: mirror the budget path and call it
      // here too, so a container that might still be running (a live
      // claude process behind an intermittently-failing status() call)
      // doesn't keep burning cost for the rest of sleepAfter after the
      // operator has already been told the task is lost. abort() only
      // signals the container's claude process (container/server.ts's
      // POST /abort does current?.kill()) — it does not stop or destroy
      // the container itself, so a container that turns out not to have
      // been dead keeps its --continue transcript for its next task,
      // matching the operator's ruling to preserve cross-task continuity.
      //
      // Gated on this.ctx.container.running (fix round 1, Important 1):
      // ContainerRuntime.abort() goes through containerFetch, which — per
      // container.js:536-539 — cold-starts the container if it is not
      // already running or healthy. Calling abort() unconditionally on a
      // container this branch has just given up on for being UNREACHABLE
      // would invert the cost rationale above: it can START a FRESH
      // container (the container/server.ts current?.kill() mentioned above
      // is then a no-op on that brand-new process — killing nothing), renew
      // ITS activity timeout on the way through (containerFetch always does
      // that once a request lands), and leave it idling unwatched for up to
      // another sleepAfter. `running` is read off the raw platform binding
      // (this.ctx.container, a public property — the same flag
      // containerFetch checks internally via its own private wrapper around
      // the identical object), so this check adds no round trip and cannot
      // itself start anything.
      if (shouldAbortOnTerminal(result) && this.ctx.container?.running) {
        try {
          await this.rt().abort();
        } catch (err) {
          // Same reason status() just failed: likely to fail again. Must
          // not block clearing the task — the operator is already told.
          console.error("abort after dead container failed", err);
        }
      }
      await this.ctx.storage.delete(TASK_KEY);
      return;
    }
    // "continue" (advanceTask's own polling loop) and "error" (advanceTask
    // itself threw — see pollOnce) both mean: not resolved yet, try again.
    await this.ctx.storage.put(TASK_KEY, result.task);
    await this.schedule(POLL_SECONDS, "pollTask", { taskId: result.task.taskId });
  }
}
