// Issue #53: `fleet reap [--idle 30m] [--repo owner/name] [--dry-run|--apply]`
// and the `fleet ls` idle line. Idle studios (turn finished, lead waiting at
// the prompt) bill for hours and emit ZERO events — a monitor that watches
// PRs and board state stays silent through all of it (measured: 22 of 23
// studios idle 33-81 min, one repo, 2026-09-29).
//
// Pure core, every read and write injected (`ReapDeps`), so the whole policy
// is provable against fakes — same shape as runRescueAll (cli/fleet.ts).
// cli/fleet.ts owns the real wiring.
//
// THE POLICY, one poll:
//   1. Registry DERIVED each poll: GET /studio/ + one board listing for the
//      scope repo. Never a hand-kept list (a hand list went stale and alarmed
//      on 100+ dead entries — the issue's own measurement).
//   2. Board-read floor: a listing that throws, or that returns fewer than
//      half the rows of the last good read, reaps NOTHING this poll. The
//      listing is state=all (closed tasks keep their state labels), so its
//      row count only grows in normal use; a sudden drop is a bad read.
//   3. STALL alarm: running + IDLE >= 10m WITH a live task -> one line, at
//      most once per 15m per studio. Runs in dry-run too.
//   4. Reap candidate: running + IDLE >= threshold + NO live task + no member
//      alert + not backing off. Dry-run (the default) prints the candidates
//      and stops there.
//   5. --apply, per candidate, one at a time:
//        a. rescue-push (POST /rescue). Anything but a clean ok -> skip,
//           back off 30m. Never --discard-unsynced, never --force.
//        b. live read (GET /inspect): the DO's own activity (90s budget)
//           must still say idle since >= threshold, AND this capture of the
//           pane must read idle with no member row under the footer and no
//           background shells. Anything else -> skip.
//        c. fresh per-studio task read, right before destroy: a task filed
//           since the listing wins the race. Read failure -> skip.
//        d. destroy WITHOUT --force: the Worker re-checks open tasks (fail
//           closed) and re-runs rescue (409 on a confirmed failure). Refused
//           or unknown outcome -> back off 30m.
import type { StudioStatus } from "../src/studio/types";
import type { Activity } from "../src/studio/activity";
import { readActivityFrame, agentPanelRows } from "../src/studio/activity";
import type { BoardTask } from "../src/board/types";
import { studioLabel, TERMINAL_TASK_STATES } from "../src/board/types";
import { parseStudioId } from "../src/studio/ids";
import { repoIdSegment } from "../src/studio/repo";
export { parseIdleDuration } from "../src/studio/cli-args";
import { ACTIVITY_DO_STALE_SECONDS, ACTIVITY_MIRROR_STALE_SECONDS, formatAge } from "./readiness-format";

/** A studio whose rescue or destroy did not go through is left alone this long. */
export const REAP_BACKOFF_MS = 30 * 60_000;
/** IDLE this long WITH a live task is a stall worth a line. */
export const STALL_AFTER_MS = 10 * 60_000;
/** One STALL line per studio per this window. */
export const STALL_ALARM_EVERY_MS = 15 * 60_000;
/** `fleet reap`'s default threshold: long on purpose. `--idle 5m` opts lower. */
export const REAP_DEFAULT_IDLE_MS = 30 * 60_000;
/** The live pane capture must be at least this fresh to count as evidence. */
export const REAP_CAPTURE_MAX_AGE_MS = 120_000;

export interface ReapFlags {
  /** false = dry-run (the default): report only. */
  apply: boolean;
  idleMs: number;
  /** owner/name. Only this repo's studios are ever read for reap or touched. */
  repo: string;
}

/** Local memory between polls. Everything in it is pruned to the registry. */
export interface ReapState {
  /** studio id -> ISO instant before which it is not attempted again. */
  backoffUntil: Record<string, string>;
  /** studio id -> ISO instant of its last STALL line. */
  stallAlarmAt: Record<string, string>;
  /** repo -> row count of the last board listing that passed the floor. */
  boardRows: Record<string, number>;
}

export function emptyReapState(): ReapState {
  return { backoffUntil: {}, stallAlarmAt: {}, boardRows: {} };
}

/** GET /studio/:id/inspect, reduced to what reap reads. `capturedAt` is epoch
 *  seconds, the container's clock. `activity` is the DO's own (not the D1 mirror). */
export type ReapInspect =
  | { ok: true; tail: string; capturedAt: number | null; activity: Activity | null }
  | { ok: false; message: string };

export type ReapDestroyResult =
  | { outcome: "destroyed" }
  | { outcome: "refused" | "unknown"; message: string };

export interface ReapDeps {
  now: () => Date;
  listStudios: () => Promise<StudioStatus[]>;
  /** Every task of the scope repo (state=all). Throws on any failure. */
  listBoard: () => Promise<BoardTask[]>;
  /** Tasks carrying this studio's label. Throws on any failure. */
  studioTasks: (id: string) => Promise<BoardTask[]>;
  inspect: (id: string) => Promise<ReapInspect>;
  rescue: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  destroy: (id: string) => Promise<ReapDestroyResult>;
  loadState: () => Promise<ReapState>;
  saveState: (state: ReapState) => Promise<void>;
  log: (line: string) => void;
}

function inScope(s: StudioStatus, repo: string): boolean {
  if (s.repoSlug) return s.repoSlug.toLowerCase() === repo.toLowerCase();
  const segment = repoIdSegment(repo.split("/")[1] ?? repo);
  return segment !== null && parseStudioId(s.id)?.repo === segment;
}

/** Live = open AND not in a terminal board state. A drifted task (no state
 *  label) stays live: fail closed, same rule as openAssignedTasks. */
function liveTasksOf(id: string, tasks: BoardTask[]): BoardTask[] {
  const label = studioLabel(id);
  return tasks.filter((t) =>
    (t.assignee === id || t.labels.includes(label))
    && t.open && !(t.state !== null && TERMINAL_TASK_STATES.includes(t.state)));
}

/** The D1-mirrored activity, only when fresh and IDLE; else null. */
function mirroredIdleMs(s: StudioStatus, now: Date): number | null {
  const a = s.observed?.activity;
  if (!a || a.state !== "idle") return null;
  const observed = Date.parse(a.observedAt);
  const since = Date.parse(a.since);
  if (!Number.isFinite(observed) || !Number.isFinite(since)) return null;
  if (now.getTime() - observed > ACTIVITY_MIRROR_STALE_SECONDS * 1000) return null;
  return Math.max(0, now.getTime() - since);
}

function describeNotIdle(s: StudioStatus, now: Date): string {
  const a = s.observed?.activity;
  if (!a) return "activity unknown";
  const observed = Date.parse(a.observedAt);
  if (!Number.isFinite(observed) || now.getTime() - observed > ACTIVITY_MIRROR_STALE_SECONDS * 1000) {
    return "activity stale";
  }
  return a.state;
}

function idleWord(ms: number): string {
  return `IDLE ${formatAge(ms / 1000)}`;
}

/** `fleet ls`'s alarm line: running studios idle >= 10m, or null. Stateless. */
export function formatIdleAlarm(studios: StudioStatus[], now: Date): string | null {
  const idle = studios
    .filter((s) => s.state === "running")
    .map((s) => ({ id: s.id, ms: mirroredIdleMs(s, now) }))
    .filter((x): x is { id: string; ms: number } => x.ms !== null && x.ms >= STALL_AFTER_MS)
    .sort((a, b) => b.ms - a.ms);
  if (idle.length === 0) return null;
  return `IDLE >= ${formatAge(STALL_AFTER_MS / 1000)} (billing, lead waiting at the prompt): `
    + idle.map((x) => `${x.id} ${idleWord(x.ms)}`).join(", ")
    + " — `fleet reap` (dry-run) shows which have no open task and could be stopped";
}

/** Why the live read does NOT prove idle, or null when it does. */
function liveReadRefusal(read: ReapInspect, idleMs: number, now: Date): string | null {
  if (!read.ok) return `live read failed: ${read.message}`;
  if (read.capturedAt === null || now.getTime() - read.capturedAt * 1000 > REAP_CAPTURE_MAX_AGE_MS) {
    return "live capture missing or old";
  }
  const a = read.activity;
  if (!a) return "DO activity unknown";
  const observed = Date.parse(a.observedAt);
  if (!Number.isFinite(observed) || now.getTime() - observed > ACTIVITY_DO_STALE_SECONDS * 1000) {
    return "DO activity stale";
  }
  if (a.state !== "idle") return `DO activity says ${a.state}`;
  const since = Date.parse(a.since);
  if (!Number.isFinite(since) || now.getTime() - since < idleMs) return "DO activity idle for less than the threshold";
  const frame = readActivityFrame(read.tail);
  if (frame.kind !== "idle") return `live pane reads ${frame.kind}`;
  const members = (agentPanelRows(read.tail) ?? "").split("\n")
    .filter((l) => l.trim() !== "" && !/^\s*(?:❯\s*)?[●◯⏺]\s+main\s*$/.test(l));
  if (members.length > 0) return "live pane shows a member row under the footer";
  if (/\b\d+ (?:background )?shells?\b/.test(read.tail)) return "live pane shows background shells running";
  return null;
}

export async function runReap(flags: ReapFlags, deps: ReapDeps): Promise<{ exitCode: number }> {
  const now = deps.now();
  let studios: StudioStatus[];
  try {
    studios = await deps.listStudios();
  } catch (err) {
    deps.log(`fleet reap: could not list studios (${err instanceof Error ? err.message : String(err)}) — nothing done`);
    return { exitCode: 1 };
  }
  let state: ReapState;
  try {
    state = await deps.loadState();
  } catch (err) {
    deps.log(`fleet reap: state unreadable (${err instanceof Error ? err.message : String(err)}) — starting empty`);
    state = emptyReapState();
  }
  // Registry-derived: forget every studio the registry no longer has.
  const known = new Set(studios.map((s) => s.id));
  for (const map of [state.backoffUntil, state.stallAlarmAt]) {
    for (const id of Object.keys(map)) if (!known.has(id)) delete map[id];
  }

  const running = studios.filter((s) => s.state === "running" && inScope(s, flags.repo));
  const exit = async (code: number) => {
    await deps.saveState(state);
    return { exitCode: code };
  };

  let board: BoardTask[];
  try {
    board = await deps.listBoard();
  } catch (err) {
    deps.log(`fleet reap: board read failed (${err instanceof Error ? err.message : String(err)}) — reaping nothing this poll`);
    return exit(1);
  }
  const prevRows = state.boardRows[flags.repo];
  if (prevRows !== undefined && board.length < Math.ceil(prevRows / 2)) {
    deps.log(
      `fleet reap: board read floor — ${board.length} row(s), last good read had ${prevRows}; ` +
        "reaping nothing this poll (delete the reap state file if the board really shrank)",
    );
    return exit(1);
  }
  state.boardRows[flags.repo] = board.length;

  const candidates: { s: StudioStatus; idleMs: number }[] = [];
  for (const s of running) {
    const idleMs = mirroredIdleMs(s, now);
    const live = liveTasksOf(s.id, board);
    if (idleMs === null) {
      deps.log(`skip ${s.id}: ${describeNotIdle(s, now)}`);
      delete state.stallAlarmAt[s.id];
      continue;
    }
    if (live.length > 0) {
      const tasks = live.map((t) => `#${t.number}`).join(", ");
      if (idleMs >= STALL_AFTER_MS) {
        const last = Date.parse(state.stallAlarmAt[s.id] ?? "");
        if (!Number.isFinite(last) || now.getTime() - last >= STALL_ALARM_EVERY_MS) {
          deps.log(`STALL ${s.id}: ${idleWord(idleMs)} with open task ${tasks} — lead finished and waits, or is stuck`);
          state.stallAlarmAt[s.id] = now.toISOString();
        }
      } else {
        delete state.stallAlarmAt[s.id];
      }
      deps.log(`skip ${s.id}: ${idleWord(idleMs)}, open task ${tasks}`);
      continue;
    }
    delete state.stallAlarmAt[s.id];
    if (s.observed?.memberAlerts?.length) {
      deps.log(`skip ${s.id}: ${idleWord(idleMs)}, member alert present`);
      continue;
    }
    if (idleMs < flags.idleMs) {
      deps.log(`skip ${s.id}: ${idleWord(idleMs)} < ${formatAge(flags.idleMs / 1000)} threshold`);
      continue;
    }
    const until = Date.parse(state.backoffUntil[s.id] ?? "");
    if (Number.isFinite(until) && until > now.getTime()) {
      deps.log(`skip ${s.id}: backing off until ${state.backoffUntil[s.id]} after a failed rescue/destroy`);
      continue;
    }
    candidates.push({ s, idleMs });
  }

  if (!flags.apply) {
    for (const { s, idleMs } of candidates) {
      deps.log(`would reap ${s.id}: ${idleWord(idleMs)}, no open task (rescue, re-check live pane and board, then destroy)`);
    }
    deps.log(`fleet reap (dry-run): ${candidates.length} would be reaped; --apply to act`);
    return exit(0);
  }

  const backOff = (id: string, why: string) => {
    state.backoffUntil[id] = new Date(now.getTime() + REAP_BACKOFF_MS).toISOString();
    deps.log(`skip ${id}: ${why} — backing off ${formatAge(REAP_BACKOFF_MS / 1000)}`);
  };
  for (const { s, idleMs } of candidates) {
    try {
      const rescue = await deps.rescue(s.id);
      if (!rescue.ok) { backOff(s.id, `rescue failed: ${rescue.error}`); continue; }
      const refusal = liveReadRefusal(await deps.inspect(s.id), flags.idleMs, deps.now());
      if (refusal) { deps.log(`skip ${s.id}: ${refusal}`); continue; }
      let fresh: BoardTask[];
      try {
        fresh = await deps.studioTasks(s.id);
      } catch (err) {
        deps.log(`skip ${s.id}: fresh task read failed (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const live = liveTasksOf(s.id, fresh);
      if (live.length > 0) {
        deps.log(`skip ${s.id}: task ${live.map((t) => `#${t.number}`).join(", ")} filed since the listing`);
        continue;
      }
      const result = await deps.destroy(s.id);
      if (result.outcome !== "destroyed") { backOff(s.id, `destroy ${result.outcome}: ${result.message}`); continue; }
      delete state.backoffUntil[s.id];
      delete state.stallAlarmAt[s.id];
      deps.log(`REAPED ${s.id}: ${idleWord(idleMs)}, no open task, rescued, destroyed`);
    } catch (err) {
      backOff(s.id, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return exit(0);
}
