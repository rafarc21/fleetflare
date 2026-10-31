// Board #1448 — the Worker-side wiring for the auto-park sweep. Split from
// auto-park.ts (the pure, DI'd decision core) the same way llm/model-quality-
// cron.ts is split from llm/model-quality.ts: this file touches Env, the
// board API, the studio stub and D1, all of which only resolve under
// @cloudflare/workers-types — keeping it out of auto-park.ts lets
// test/bun/auto-park.test.ts compile under bun's reduced "types": ["bun"].
//
// Only ever imported from src/index.ts's handleScheduled (the minute cron),
// same as sweepGateRunsFromEnv/drainPendingGateRuns.
import { githubBoardApi } from "../board/routes";
import { listTasks } from "../board/board";
import { createComment } from "../board/api";
import { repoTokenMinter } from "../github/auth";
import { listStudios } from "./registry";
import { getStudioStubForRow } from "./profile";
import { autoParkSweep, DEFAULT_AUTO_PARK_IDLE_MINUTES, type AutoParkSweepDeps } from "./auto-park";
import type { Env } from "../env";

/**
 * One auto-park pass over every running studio. Off unless env.FLEET_AUTO_PARK
 * is exactly "on" (same posture FLEET_AUTO_FAILOVER/FLEET_TELEGRAM use); the
 * idle budget is env.AUTO_PARK_IDLE_MINUTES, falling back to 30 on absence or
 * garbage. `park` is `destroyStudio(false, false, true)` — the exact
 * `fleet destroy <id> --park` path (rescue first, resumable, awaiting_merge
 * waived by the open-task gate), so a rescue that cannot confirm unsynced work
 * refuses and is reported, never forced. A board read that fails answers
 * null and the core fails closed (skipped).
 */
export async function autoParkSweepFromEnv(env: Env, now: Date = new Date()): Promise<void> {
  if (env.FLEET_AUTO_PARK !== "on") return;

  const parsed = Number.parseInt(env.AUTO_PARK_IDLE_MINUTES ?? "", 10);
  const idleThresholdMs =
    (Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTO_PARK_IDLE_MINUTES) * 60_000;
  const api = githubBoardApi(env);

  const deps: AutoParkSweepDeps = {
    enabled: true,
    idleThresholdMs,
    now: () => now,
    listStudios: () => listStudios(env, now),
    openTasks: async (studio) => {
      const repo = studio.repoSlug ?? env.AGENT_REPO;
      const result = await listTasks(api, repo, { assignedTo: studio.id });
      if (!result.ok) return null;
      return result.value
        .filter((t) => t.open)
        .map((t) => ({ number: t.number, state: t.state }));
    },
    park: async (studio) => {
      try {
        const outcome = await getStudioStubForRow(env, studio).destroyStudio(false, false, true);
        return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    comment: async (studio, taskNumber, body) => {
      const repo = studio.repoSlug ?? env.AGENT_REPO;
      const token = await repoTokenMinter(env)(repo);
      await createComment(token, repo, taskNumber, body);
    },
    log: (line) => console.log(line),
  };

  await autoParkSweep(deps);
}