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
//   2. Board-read floor: a listing that throws, returns 0 rows, or returns
//      fewer than half the rows of the last good read reaps NOTHING this
//      poll. So does a state file that cannot be trusted (floor unknown).
//      The listing is state=all (closed tasks keep their state labels), so
//      its row count only grows in normal use; a sudden drop is a bad read.
//   3. STALL alarm: running + IDLE >= 10m WITH a live task -> one line, at
//      most once per 15m per studio. Runs in dry-run too.
//   4. Reap candidate: running + repoSlug == scope repo + IDLE >= threshold
//      + NO live task + no member alert + not backing off. Dry-run (the
//      default) prints the candidates and stops there.
//   5. --apply, per candidate, one at a time:
//        a. live pre-check (GET /inspect, see e). Not idle -> skip, no rescue.
//        b. rescue-push (POST /rescue). Anything but a clean ok -> skip,
//           back off 30m. Never --discard-unsynced, never --force.
//        c. fresh per-studio task read: a task filed since the listing wins
//           the race. Read failure -> skip.
//        d. FINAL live read, the call right before destroy, answering within
//           30s (review F1: no slow call may sit in that gap).
//        e. a live read passes only when the DO's own activity (90s budget)
//           says idle since >= threshold, the capture reads idle, the input
//           box holds an empty prompt, no member row sits under the footer,
//           and the footer/status carry no counter or running work.
//        f. destroy WITHOUT --force: the Worker re-checks open tasks (fail
//           closed) and re-runs rescue (409 on a confirmed failure). Refused
//           or unknown outcome -> back off 30m.
//      3 live-read refusals in a row also back off 30m.
//
// Named residual: the Worker's destroy itself (probe, sync, rescue, stop)
// takes seconds to minutes and never checks for a turn. A turn that starts
// inside that window is rescued by destroy's own rescue unless that rescue
// dies with an unconfirmed error (issue #62).
import type { StudioStatus } from "../src/studio/types";
import type { Activity } from "../src/studio/activity";
import { readActivityFrame, agentPanelRows } from "../src/studio/activity";
import type { BoardTask } from "../src/board/types";
import { studioLabel, LIVE_TASK_STATES } from "../src/board/types";
import { footerAtBottom, aboveAgentPanel, RULE_LINE } from "../src/studio/failover";
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
/** Review F1: the FINAL live read (the call right before destroy) must answer
 *  within this, or the gap it leaves before destroy is not bounded. */
export const REAP_LIVE_READ_MAX_MS = 30_000;
/** This many live-read refusals in a row back a studio off (review item 6). */
export const REAP_REFUSALS_BEFORE_BACKOFF = 3;

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
  /** lowercased repo -> row count of the last board listing that passed the floor. */
  boardRows: Record<string, number>;
  /** studio id -> live-read refusals in a row while a candidate. */
  refusals: Record<string, number>;
}

export function emptyReapState(): ReapState {
  return { backoffUntil: {}, stallAlarmAt: {}, boardRows: {}, refusals: {} };
}

/** GET /studio/:id/inspect, reduced to what reap reads. `capturedAt` is epoch
 *  seconds, the container's clock. `activity` is the DO's own (not the D1 mirror). */
export type ReapInspect =
  | { ok: true; tail: string; capturedAt: number | null; activity: Activity | null }
  | { ok: false; message: string };

export type ReapDestroyResult =
  | { outcome: "destroyed" | "already-stopped" | "in-progress" }
  | { outcome: "refused" | "unknown"; message: string };

/** Issue #86: a destroy that did not answer "destroyed" raced another one
 *  (an operator's) when the row, read right after, is stopped or reports a
 *  destroy in flight. Either is the outcome reap wanted. Else null. */
export function destroyRaceOutcome(
  row: { state: StudioStatus["state"]; destroyInFlight?: boolean } | null,
): "already-stopped" | "in-progress" | null {
  if (row === null) return null;
  if (row.state === "stopped") return "already-stopped";
  return row.destroyInFlight === true ? "in-progress" : null;
}

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
  /** Throws when the state cannot be trusted (corrupt, wrong shape): reap then
   *  treats the board floor as unknown and reaps nothing this poll. */
  loadState: () => Promise<ReapState>;
  saveState: (state: ReapState) => Promise<void>;
  /** Refreshes the run lock (cli/fleet.ts withReapLock). Called once per
   *  candidate: a run with several candidates can outlast the lock's stale
   *  threshold. A throw stops the run — its lock can no longer be trusted. */
  heartbeat?: () => Promise<void>;
  log: (line: string) => void;
}

/** Review F4: owner/name must match exactly. A row with no repoSlug (an old
 *  studio, cloned from the fleet default) is never in scope: its id segment
 *  drops the owner, so two orgs' same-named repos would collide. */
function inScope(s: StudioStatus, repo: string): boolean {
  return s.repoSlug !== null && s.repoSlug !== undefined && s.repoSlug.toLowerCase() === repo;
}

/** Live = open AND in a state a studio still owns work for; a drifted/no-
 *  label task still counts as live, fail closed. Board issue #110: this used
 *  to be "open AND not terminal", a two-bucket model that broke the moment
 *  `awaiting_merge` added a third bucket (neither terminal nor live — the
 *  lead's part is done, so this studio is idle even though the issue stays
 *  open until merge). Positive membership in LIVE_TASK_STATES is the fix,
 *  same one openAssignedTasks (src/board/board.ts) makes for the same
 *  reason. */
function liveTasksOf(id: string, tasks: BoardTask[]): BoardTask[] {
  const label = studioLabel(id);
  return tasks.filter((t) =>
    (t.assignee === id || t.labels.includes(label))
    && t.open && (t.state === null || LIVE_TASK_STATES.includes(t.state)));
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
  return chromeRefusal(read.tail);
}

/** Words in claude's chrome that mean something still runs under the lead. */
const RUNNING_WORDS = /running|background|shells?\b|monitors?\b|tasks?\b|agents? working/i;

/**
 * Review F2/F3: the chrome around the input box. The input box must hold ONLY
 * an empty `❯` row (typed-but-unsent text is an operator mid-sentence). The
 * footer must carry no counter at all (`7 shells`, `2 monitors`, anything
 * with a digit — an unknown counter is unknown, so skip), and neither the
 * footer nor the last status row may mention running/background work.
 */
function chromeRefusal(tail: string): string | null {
  const lines = tail.replace(/\s+$/, "").split("\n");
  const footer = footerAtBottom(lines);
  if (footer < 0) return "live pane footer not found";
  if (/\d/.test(lines[footer]) || RUNNING_WORDS.test(lines[footer])) {
    return `live pane footer carries a counter: ${lines[footer].trim()}`;
  }
  const head = aboveAgentPanel(lines.join("\n")).split("\n");
  const status = [...head].reverse().find((l) => /^\s*✻ /.test(l));
  if (status && RUNNING_WORDS.test(status)) return `live pane status reports running work: ${status.trim()}`;
  let i = footer - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0 || !RULE_LINE.test(lines[i])) return "live pane input box not found";
  const bottom = i--;
  while (i >= 0 && !RULE_LINE.test(lines[i])) i--;
  if (i < 0) return "live pane input box not found";
  const box = lines.slice(i + 1, bottom).filter((l) => l.trim() !== "");
  if (box.length !== 1 || !/^\s*❯\s*$/.test(box[0])) return "live pane input box holds unsent text";
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
  // Review F5: a state that cannot be trusted loses the board floor. Reap
  // nothing this poll; the listing below becomes the new baseline.
  let floorUnknown = false;
  try {
    state = await deps.loadState();
  } catch (err) {
    deps.log(`fleet reap: state unreadable (${err instanceof Error ? err.message : String(err)}) — floor unknown, reaping nothing this poll`);
    state = emptyReapState();
    floorUnknown = true;
  }
  const repo = flags.repo.toLowerCase();
  // Registry-derived: forget every studio the registry no longer has.
  const known = new Set(studios.map((s) => s.id));
  for (const map of [state.backoffUntil, state.stallAlarmAt, state.refusals]) {
    for (const id of Object.keys(map)) if (!known.has(id)) delete map[id];
  }

  const running = studios.filter((s) => s.state === "running" && inScope(s, repo));
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
  // A repo that uses the board always has task history (state=all): zero rows
  // is a bad read, never "nothing assigned to anyone".
  if (board.length === 0) {
    deps.log("fleet reap: board read returned 0 rows — reaping nothing this poll");
    return exit(1);
  }
  const prevRows = state.boardRows[repo];
  if (prevRows !== undefined && board.length < Math.ceil(prevRows / 2)) {
    deps.log(
      `fleet reap: board read floor — ${board.length} row(s), last good read had ${prevRows}; ` +
        "reaping nothing this poll (delete the reap state file if the board really shrank)",
    );
    return exit(1);
  }
  state.boardRows[repo] = board.length;
  if (floorUnknown) return exit(1);

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
  const candidateIds = new Set(candidates.map((c) => c.s.id));
  for (const id of Object.keys(state.refusals)) if (!candidateIds.has(id)) delete state.refusals[id];

  if (!flags.apply) {
    for (const { s, idleMs } of candidates) {
      deps.log(`would reap ${s.id}: ${idleWord(idleMs)}, no open task (rescue, re-check live pane and board, then destroy)`);
    }
    deps.log(`fleet reap (dry-run): ${candidates.length} would be reaped; --apply to act`);
    return exit(0);
  }

  const backOff = (id: string, why: string) => {
    state.backoffUntil[id] = new Date(deps.now().getTime() + REAP_BACKOFF_MS).toISOString();
    delete state.refusals[id];
    deps.log(`skip ${id}: ${why} — backing off ${formatAge(REAP_BACKOFF_MS / 1000)}`);
  };
  const refused = (id: string, why: string) => {
    const n = (state.refusals[id] ?? 0) + 1;
    if (n >= REAP_REFUSALS_BEFORE_BACKOFF) { backOff(id, `${why} (${n} live-read refusals in a row)`); return; }
    state.refusals[id] = n;
    deps.log(`skip ${id}: ${why}`);
  };
  /** One live read, judged. Review F1: its own duration counts — a read that
   *  answers late leaves an unbounded gap before whatever comes next. */
  const liveRead = async (id: string): Promise<string | null> => {
    const askedAt = deps.now().getTime();
    const read = await deps.inspect(id);
    const answeredAt = deps.now();
    if (answeredAt.getTime() - askedAt > REAP_LIVE_READ_MAX_MS) return "live read answered too late";
    return liveReadRefusal(read, flags.idleMs, answeredAt);
  };
  for (const { s, idleMs } of candidates) {
    try {
      await deps.heartbeat?.();
    } catch (err) {
      deps.log(`fleet reap: run lock refresh failed (${err instanceof Error ? err.message : String(err)}) — stopping before ${s.id}`);
      return exit(1);
    }
    try {
      // Cheap pre-check first: a studio that is not idle right now gets no
      // rescue exec and no rescue branch (review item 6: noise).
      const pre = await liveRead(s.id);
      if (pre) { refused(s.id, pre); continue; }
      const rescue = await deps.rescue(s.id);
      if (!rescue.ok) { backOff(s.id, `rescue failed: ${rescue.error}`); continue; }
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
      // Review F1: the LAST read before destroy is the live one, so no board
      // read, rescue or other slow call sits between it and the destroy.
      const last = await liveRead(s.id);
      if (last) { refused(s.id, last); continue; }
      const result = await deps.destroy(s.id);
      if (result.outcome === "refused" || result.outcome === "unknown") {
        backOff(s.id, `destroy ${result.outcome}: ${result.message}`);
        continue;
      }
      delete state.backoffUntil[s.id];
      delete state.stallAlarmAt[s.id];
      delete state.refusals[s.id];
      if (result.outcome === "in-progress") {
        // Not retried while that destroy runs: a second rescue would race it.
        state.backoffUntil[s.id] = new Date(deps.now().getTime() + REAP_BACKOFF_MS).toISOString();
        deps.log(`REAPED ${s.id}: ${idleWord(idleMs)}, no open task, rescued; another destroy already in progress`);
        continue;
      }
      const how = result.outcome === "already-stopped" ? "already stopped by another destroy" : "destroyed";
      deps.log(`REAPED ${s.id}: ${idleWord(idleMs)}, no open task, rescued, ${how}`);
    } catch (err) {
      backOff(s.id, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return exit(0);
}
