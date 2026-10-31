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

/** Per-sweep cap on board reads: the sweep iterates running studios, but a
 *  board read per studio is the expensive leg, so past this many candidates
 *  the remaining studios are skipped, not read. Bounds the sweep's GitHub
 *  budget independent of how many studios are running. */
export const DEFAULT_MAX_BOARD_CALLS = 10;

/** Per-sweep cap on parks: a park is a multi-minute destroy (probe, sync,
 *  rescue-push, harvest), so at most this many studios are parked per tick.
 *  The rest wait for the next minute's sweep — see the in-flight guard. */
export const DEFAULT_MAX_PARKS = 2;

/** An `Activity.observedAt` older than this is a frozen pane, not evidence of
 *  idleness. 3 × the 30s ship-tick cadence (ship-cadence.ts) — the same
 *  "three consecutive ticks with no fresh observation is too stale to trust"
 *  shape activity.ts's HOOK_STALE_BUDGET_MS and readiness-format.ts's
 *  ACTIVITY_DO_STALE_SECONDS both derive from that cadence. A ticker outage
 *  freezes `observedAt`, and without this the frozen idle would park a live
 *  lead. */
export const AUTO_PARK_ACTIVITY_STALE_MS = 3 * 30 * 1000;

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
  /** An idle observation older than this is frozen, not idle. */
  activityStaleMs: number;
  /** Per-sweep cap on board reads. */
  maxBoardCalls: number;
  /** Per-sweep cap on parks. */
  maxParks: number;
  now: () => Date;
  listStudios: () => Promise<StudioStatus[]>;
  /** Every OPEN task this studio is assigned, or null when the board read
   *  failed (fail closed). A drifted task (state null) is a "cannot confirm"
   *  signal, never a pass. */
  openTasks: (studio: StudioStatus) => Promise<AutoParkOpenTask[] | null>;
  /** Park exactly like `fleet destroy <id> --park`: rescue first, resumable.
   *  `ok: false` is a refusal (e.g. rescue could not confirm unsynced work). */
  park: (studio: StudioStatus) => Promise<{ ok: boolean; reason?: string }>;
  /** True while a destroy/park is already in flight for this studio (the
   *  persisted DESTROYING_KEY marker, read from the studio DO). Overlapping
   *  cron ticks must never call destroyStudio twice on the same studio. */
  inFlight?: (studio: StudioStatus) => Promise<boolean>;
  /** Log the park as a board comment on the task that was awaiting merge.
   *  The wiring resolves the board repo from the studio row (repoSlug ??
   *  AGENT_REPO), same as openTasks. */
  comment: (studio: StudioStatus, taskNumber: number, body: string) => Promise<void>;
  log: (line: string) => void;
}

/**
 * One sweep. For each running studio: confirm the lead's idle observation is
 * FRESH and held past `idleThresholdMs` (the cheap, network-free check —
 * ordered first so a studio that is not yet idle costs no board read), then
 * confirm every open task is `awaiting_merge` (none working/submitted/
 * input_required/drifted), confirm no park is already in flight, then park.
 * A refused park is reported, never retried in the same pass — the next
 * minute's sweep sees it again, same as the container-watch/watchdog cron
 * blocks. Board reads and parks are capped per sweep so a fleet-wide outage
 * (or a mass of idle studios) cannot turn one tick into unbounded work.
 */
export async function autoParkSweep(deps: AutoParkSweepDeps): Promise<AutoParkOutcome[]> {
  if (!deps.enabled) return [];

  const now = deps.now();
  const studios = await deps.listStudios();
  const outcomes: AutoParkOutcome[] = [];
  let boardCalls = 0;
  let parks = 0;

  for (const s of studios) {
    if (s.state !== "running") continue;

    // Activity first: free, and the below-threshold case must never pay a
    // board read (review MUST #2). A stale observation is a frozen pane,
    // never trusted as idle (review MUST #1).
    const act = s.observed?.activity ?? null;
    if (act === null || act.state !== "idle") {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: `lead is ${act?.state ?? "unknown"}, not idle` });
      continue;
    }
    const observedAgeMs = now.getTime() - Date.parse(act.observedAt);
    if (!Number.isFinite(observedAgeMs) || observedAgeMs > deps.activityStaleMs) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "idle observation is stale" });
      continue;
    }
    const idleMs = now.getTime() - Date.parse(act.since);
    if (!Number.isFinite(idleMs) || idleMs < deps.idleThresholdMs) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "lead idle below threshold" });
      continue;
    }

    if (boardCalls >= deps.maxBoardCalls) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "board-call cap reached" });
      continue;
    }
    boardCalls += 1;

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

    if (deps.inFlight && (await deps.inFlight(s))) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "park already in flight" });
      continue;
    }

    if (parks >= deps.maxParks) {
      outcomes.push({ studioId: s.id, outcome: "skipped", reason: "park cap reached" });
      continue;
    }
    parks += 1;

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