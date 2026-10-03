import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram/webhook";
import { handleGithubWebhook } from "./github/webhook";
import { AGENTS, telegramConfig } from "./agents/registry";
import { getFlag, setFlag } from "./state";
import { sendCard } from "./telegram/api";
import { staleTasks, rearmKey, alertedKey, shouldAlert } from "./tasks/watchdog";
import type { TaskRecord } from "./tasks/loop";
import { handleStudio, handleFleetSpawn } from "./studio/routes";
import { listStudios } from "./studio/registry";
import { getStudioStubForRow } from "./studio/profile";
import { isWatchMinute, watchStoppedContainers } from "./studio/container-watch";
import { handleBoard, handleFleetBoard } from "./board/routes";
import { handleMemory } from "./memory/routes";
import { handleFleetJunior } from "./junior/route";
import { handleJuniorUsageStats } from "./junior/usage";
import { handleFleetGh } from "./write-proxy/gh-route";
import { handleFleetGit } from "./write-proxy/git-worker";
import { recordWorkerException } from "./exceptions";

export { AgentDO } from "./agents/do";
// A container class declared in wrangler.jsonc without a matching export
// here fails boot for the entire Worker — Day 1 Task 4 hit exactly this.
export { DeployDO } from "./deploy/do";
// Task 5, Step 0: this export was blocked through Task 4 because
// @cloudflare/sandbox (StudioDO's base class) statically imports `tracing`
// from "cloudflare:workers", an export the then-pinned test-pool workerd
// (1.20260310.1) did not provide — merely loading this module threw, so the
// export broke every test in the suite. Resolved by upgrading the test pool
// to a workerd that has it (see task-5-report.md's Step 0 section for the
// exact version bisect); `wrangler deploy` needs this line, since a
// container class declared in wrangler.jsonc without a matching export here
// fails boot for the entire Worker. Issue #107: StudioBigDO (a same-shape
// subclass, see do.ts's own comment) needs this same export the moment its
// wrangler.jsonc containers[] entry lands.
export { StudioDO, StudioBigDO } from "./studio/do";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // #168 sensor 4 (issue #188), option (b): ONE outer try/catch around this
    // entire body (`handleFetch`, below), catching anything that escapes
    // every route handler. On catch: record it to D1 (never throws — see
    // exceptions.ts's own doc comment for the never-throws contract), then
    // rethrow the SAME error unchanged — this wrapper adds a side effect,
    // never a change in what the caller sees. `ctx` is threaded through so
    // recordWorkerException can hand its own prune off to `ctx.waitUntil`
    // (operator fix-first review, PR #198) instead of awaiting it inline.
    try {
      return await handleFetch(req, env, ctx, url);
    } catch (err) {
      await recordWorkerException(env.DB, url.pathname, err, Date.now(), ctx);
      throw err;
    }
  },

  /**
   * Runs every minute (wrangler.jsonc's triggers.crons). Answers the one
   * question nothing else can: has a task's own DO schedule stopped firing?
   * Pure I/O — reads every agent's heartbeat, hands the records to
   * staleTasks() to decide which are stale, re-arms each one, and alerts
   * once per stale episode (shouldAlert/alertedKey, tasks/watchdog.ts —
   * Carve-out C, final-review fix wave). staleTasks() and shouldAlert() are
   * exhaustively unit tested (test/watchdog.test.ts); this glue — including
   * the alertedKey read/set, which lives here rather than in watchdog.ts —
   * is covered too (test/index.test.ts), via the same hand-built AGENT
   * binding telegram/webhook.ts's tests already use in place of a live
   * AgentDO: scheduled() takes env as a plain parameter, so nothing here
   * requires constructing one.
   *
   * #168 sensor 4 (issue #188), option (b): same outer try/catch as
   * `fetch` above, around the ENTIRE body (`handleScheduled`, below) —
   * catching anything that escapes past `handleScheduled`'s own several
   * LOCAL try/catch blocks (those are untouched; this only catches what
   * already gets past them). `route` is the literal "scheduled" — no URL
   * exists in a cron invocation. Same `ctx` threading into
   * `recordWorkerException` as `fetch` above, for the same `ctx.waitUntil`
   * reason (operator fix-first review, PR #198).
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      await handleScheduled(controller, env, ctx);
    } catch (err) {
      await recordWorkerException(env.DB, "scheduled", err, Date.now(), ctx);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // P4 §5's board (GitHub Issues), mounted INSIDE the `/studio` prefix and
  // therefore BEFORE it: the Cloudflare Access app is scoped to that path,
  // so a `/board/` prefix of its own would reach this Worker with no Access
  // JWT and 401 every CLI request. See src/board/routes.ts's own header.
  // It cannot shadow a studio route — a studio id always contains `--`
  // (src/studio/ids.ts), so the literal `board` is not one.
  if (url.pathname.startsWith("/studio/board/")) return handleBoard(req, env);
  // P5 §9's memory pass, mounted on BOTH credential surfaces from one
  // handler — `/studio/memory` behind Access for the Mac CLI, `/fleet/memory`
  // behind a spawn token for the Release Studio at sprint close. Before the
  // `/studio/` prefix for the same reason the board is, and it cannot shadow
  // a studio route: a studio id always contains `--` (src/studio/ids.ts), so
  // the literal `memory` is not one.
  if (url.pathname.startsWith("/studio/memory")) return handleMemory(req, env);
  // Issue #218: the fleet junior stats read, Access-gated like every other
  // /studio/* route. Mounted before the `/studio/` catch-all for the same
  // reason `/studio/board/` and `/studio/memory` are above — a studio id
  // always contains `--` (studio/ids.ts), so the literal `junior` is not one.
  if (url.pathname === "/studio/junior/usage") return handleJuniorUsageStats(req, env);
  if (url.pathname.startsWith("/studio/")) return handleStudio(req, env);
  if (url.pathname.startsWith("/fleet/memory")) return handleMemory(req, env);
  // P4a-2: the studio's own read of its own board, spawn-token
  // authenticated. Same Access-less `/fleet/` prefix as spawn below, for
  // the same reason — a container holds one credential and it is not an
  // Access service token. First because handleFleetSpawn 404s every path
  // but `/fleet/spawn`; the two cannot overlap (`tasks` is not `spawn`),
  // so this is ordering for readability, not a hazard.
  // Junior (Workers AI delegation): spawn-token authenticated like
  // /fleet/tasks, before the /fleet/ catch-all. 404s itself unless
  // FLEET_JUNIOR is on for the calling studio's repo; 403 unless the
  // studio's live task carries the maestro's `junior` label.
  if (url.pathname === "/fleet/junior") return handleFleetJunior(req, env, ctx);
  // Issue #7: the write proxy -- a public-repo studio's only push and gh
  // write path.
  // Spawn-token authenticated, before the /fleet/ catch-all.
  if (url.pathname === "/fleet/gh") return handleFleetGh(req, env);
  if (url.pathname.startsWith("/fleet/git/")) return handleFleetGit(req, env);
  if (url.pathname.startsWith("/fleet/tasks")) return handleFleetBoard(req, env);
  // Fleet Spawn P3, R-P3-7: the machine surface, deliberately OUTSIDE the
  // `/studio` prefix the Cloudflare Access app is scoped to — a container
  // holds a spawn token, not an Access service token. Distinct prefixes, so
  // this can neither shadow nor be shadowed by the branch above; it mirrors
  // that mount exactly (prefix in, one handler out) and answers 404 itself
  // for any /fleet/ path other than /fleet/spawn.
  if (url.pathname.startsWith("/fleet/")) return handleFleetSpawn(req, env);
  const tg = url.pathname.match(/^\/tg\/([a-z0-9-]+)$/);
  // Board #334: the legacy Telegram surface exists only when it is on.
  if (tg && req.method === "POST" && telegramConfig(env)) {
    return handleTelegramWebhook(req, env, tg[1]);
  }
  if (url.pathname === "/gh" && req.method === "POST") {
    // Board issue #198: ctx is what lets handleGithubWebhook's own
    // autoCloseOnPromote (Path 1 AND Path 2, both phases) run via
    // ctx.waitUntil AFTER this handler has already returned its Response
    // — see that function's own doc comment for the latency this fixes.
    // `Date.now` is passed as a live clock reference, NOT invoked here —
    // the auto-close path needs to keep calling it to measure elapsed
    // time against its own ~25s budget, not read one frozen snapshot.
    return handleGithubWebhook(req, env, Date.now, ctx);
  }
  if (url.pathname === "/health") {
    return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

async function handleScheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  // Board #334: the AgentDO watchdog is part of the legacy Telegram
  // surface — off, nobody polls AgentDO (its container never starts).
  // The studio container-watch below runs either way.
  const telegram = telegramConfig(env);
  if (telegram) {
    const records: (TaskRecord | null)[] = [];
    for (const agent of AGENTS) {
      try {
        const stub = env.AGENT.get(env.AGENT.idFromName(agent.id));
        const res = await stub.fetch("https://agent/heartbeat");
        const { task } = (await res.json()) as { task: TaskRecord | null };
        records.push(task);
      } catch (err) {
        console.error(`heartbeat read failed for ${agent.id}`, err);
        records.push(null);
      }
    }

    const now = Date.now();
    for (const { task, staleMs } of staleTasks(records, now)) {
      const key = rearmKey(task.taskId);
      const attempts = Number((await getFlag(env.DB, key)) ?? "0") + 1;
      await setFlag(env.DB, key, String(attempts), now);
      try {
        const stub = env.AGENT.get(env.AGENT.idFromName(task.agentId));
        await (await stub.fetch("https://agent/rearm", { method: "POST" })).text();
      } catch (err) {
        console.error("re-arm failed", err);
      }
      // Alert on the second failure, not the first: one missed schedule is a
      // hiccup, two in a row is the fleet going deaf — which is exactly what
      // cost two silent days before.
      //
      // Carve-out C (final-review fix wave): gated on alertedKey too, or
      // this re-sends the identical message every single minute for as long
      // as the task stays stuck — a muted alert is exactly the failure §12
      // exists to prevent. Set only after a successful send, so a delivery
      // failure is retried next minute instead of silenced for good.
      if (shouldAlert(attempts, (await getFlag(env.DB, alertedKey(task.taskId))) === "1")) {
        try {
          await sendCard(
            telegram.token, task.chatId,
            `WATCHDOG: task ${task.taskId} has not polled for ${Math.round(staleMs / 1000)}s. ` +
            `Re-arm attempt ${attempts} did not take.`,
          );
          await setFlag(env.DB, alertedKey(task.taskId), "1", now);
        } catch (err) {
          // sendCard throws on any Telegram-side failure (api.ts's call()
          // helper checks the JSON body's `ok` field, not just HTTP status).
          // The re-arm attempt above already ran regardless of this send —
          // a failed alert must not make the whole cron invocation report
          // failure for what is, relative to the re-arm, a cosmetic loss.
          console.error("watchdog alert delivery failed", err);
        }
      }
    }
  }

  // Issue #95: every 5th minute, ask each stopped studio's DO whether its
  // container is running anyway (observation only — see container-watch.ts).
  // AFTER the watchdog above: a hung DO call here must not delay a re-arm.
  if (isWatchMinute(controller.scheduledTime ?? Date.now())) {
    try {
      await watchStoppedContainers(
        await listStudios(env), (s) => getStudioStubForRow(env, s).watchContainer(),
      );
    } catch (err) {
      console.error("container watch sweep failed", err);
    }
  }
}
