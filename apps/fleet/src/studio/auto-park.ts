// Board #1448: Worker scheduled auto-park. A running studio whose only open
// board task(s) sit at `awaiting_merge` and whose lead has been idle past
// N minutes is parked resumably — the same `destroyStudio(park=true)` path the
// operator's `fleet destroy <id> --park` takes, so rescue runs first and a
// later wake resumes it (StudioStatus.parked).
//
// Fail closed on every "do nothing" guard, the same discipline destroy.ts's
// runDestroy documents: a board read that cannot be confirmed is answered
// "skipped", never "park it anyway". The threshold and the off switch are the
// caller's (the Worker cron's `env`); this file is pure and DI'd so every rule
// is provable without a network (test/bun/auto-park.test.ts), the same shape
// cli/reap.ts's runReap and src/studio/task-reap.ts's runTaskReap already use.
import type { BoardTaskState } from "../board/types";
import type { StudioStatus } from "./types";

/** Env AUTO_PARK_IDLE_MINUTES default: park after a lead sits idle this long. */
export const DEFAULT_AUTO_PARK_IDLE_MINUTES = 30;

/** One open board task this studio is assigned. `state` null = drifted. */
export interface AutoParkOpenTask {
  number: number;
  state: BoardTaskState | null;
}

export type AutoParkOutcome =
  | { studioId: string; outcome: "parked"; taskNumber: number; idleMinutes: number }
  | { studioId: string; outcome: "skipped"; reason: string }
  | { studioId: string; outcome: "park-failed"; reason: string };

export interface AutoParkSweepDeps {
  /** The off switch (env FLEET_AUTO_PARK !== "on"). False = sweep is a no-op. */
  enabled: boolean;
  /** Idle budget in ms before a park (env AUTO_PARK_IDLE_MINUTES, default 30). */
  idleThresholdMs: number;
  now: () => Date;
  listStudios: () => Promise<StudioStatus[]>;
  /** Every OPEN task this studio is assigned, or null when the board read
   *  failed (fail closed). A drifted task (state null) is a "cannot confirm"
   *  signal, never a pass. */
  openTasks: (studio: StudioStatus) => Promise<AutoParkOpenTask[] | null>;
  /** Park exactly like `fleet destroy <id> --park`: rescue first, resumable.
   *  `ok: false` is a refusal (e.g. rescue could not confirm unsynced work). */
  park: (studio: StudioStatus) => Promise<{ ok: boolean; reason?: string }>;
  /** Log the park as a board comment on the task that was awaiting merge.
   *  The wiring resolves the board repo from the studio row (repoSlug ??
   *  AGENT_REPO), same as openTasks. */
  comment: (studio: StudioStatus, taskNumber: number, body: string) => Promise<void>;
  log: (line: string) => void;
}

/**
 * One sweep. For each running studio: confirm every open task is
 * `awaiting_merge` (none working/submitted/input_required/drifted), confirm
 * the lead has been idle past `idleThresholdMs`, then park. A refused park is
 * reported, never retried in the same pass — the next minute's sweep sees it
 * again, same as the container-watch/watchdog cron blocks.
 */
export async function autoParkSweep(deps: AutoParkSweepDeps): Promise<AutoParkOutcome[]> {
  if (!deps.enabled) return [];

  const now = deps.now();
  const studios = await deps.listStudios();
  const outcomes: AutoParkOutcome[] = [];

  for (const s of studios) {
    if (s.state !== "running") continue;

    const tasks = await deps.openTasks(s);
    if (tasks === null) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "board read failed — fail closed" });
      continue;
    }
    if (tasks.length === 0) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "no open task assigned" });
      continue;
    }
    const blocker = tasks.find((t) => t.state !== "awaiting_merge");
    if (blocker) {
      outcomes.push({
        studioId: s.id, outcome: "skipped",
        reason: blocker.state === null ? "open task is drifted — cannot confirm" : `open task is ${blocker.state}`,
      });
      continue;
    }

    const act = s.observed?.activity ?? null;
    if (act === null || act.state !== "idle") {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: `lead is ${act?.state ?? "unknown"}, not idle` });
      continue;
    }
    const idleMs = now.getTime() - Date.parse(act.since);
    if (!Number.isFinite(idleMs) || idleMs < deps.idleThresholdMs) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "lead idle below threshold" });
      continue;
    }

    const park = await deps.park(s);
    if (!park.ok) {
      outcomes.push({ studioId: s.id, outcome: "park-failed", reason: park.reason ?? "park refused" });
      continue;
    }

    const taskNumber = tasks[0].number;
    const idleMinutes = Math.floor(idleMs / 60_000);
    outcomes.push({ studioId: s.id, outcome: "parked", taskNumber, idleMinutes });
    deps.log(`auto-park: ${s.id} parked — lead idle ${idleMinutes}m, only awaiting_merge task(s)`);
    await deps.comment(
      s,
      taskNumber,
      `auto-park: ${s.id} parked — lead idle ${idleMinutes}m with only awaiting_merge task(s).`,
    );
  }

  return outcomes;
}