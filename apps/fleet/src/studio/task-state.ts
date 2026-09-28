// Board task #131: `fleet task state <n> <to>` — the CLI verb that finally
// closes the loop `transitionTask` (src/board/board.ts:140) already
// enforces, already routed at POST /studio/board/tasks/<n>/state
// (src/board/routes.ts:256). Seven real tasks shipped and merged in one
// session while all seven still read `state=submitted` on the board, because
// nothing but a raw HTTP call could close them.
//
// This module is the "read current state, then POST" orchestration, pure
// and DI'd over the credentials type — the same precedent
// src/studio/onboard.ts's `OnboardDeps<C>` set (see that file's own header):
// this module never needs to know what a Credentials object looks like,
// only that the same opaque value flows from cli/fleet.ts's loadCredentials
// into getCurrentState/transition. No import from cli/fleet.ts, for the
// identical tsconfig-boundary reason onboard.ts's own header states —
// Bun.file only type-checks under cli/tsconfig.json's own "bun" types, not
// this file's root tsconfig (workers-types).
//
// DOES NOT change transitionTask, its route dispatch, or the
// compare-and-swap semantics in board.ts/routes.ts — this module only calls
// the existing route, twice (once to read the current state, once to write
// the transition). It is operator-invoked only: nothing here auto-closes a
// task on merge or on envelope receipt — that is a deliberately separate,
// NOT-made decision about who owns state transitions.

/** One HTTP round trip's answer, shared by both halves of the orchestration
 *  below: reading the current state and posting the transition return the
 *  exact same shape — "a state came back" or "it didn't, here's why". */
export type TaskStateFetchResult =
  | { ok: true; state: string }
  | { ok: false; status: number; message: string };

/** The orchestration's own result: `from`/`to` on success (what the CLI
 *  prints as the before -> after line), or the UNDERLYING failure, VERBATIM,
 *  from whichever half produced it. Never reformatted here — see this
 *  file's header: a stale-`from` 409 is transitionTask's own words, and
 *  paraphrasing it would defeat the reason the route names what it actually
 *  found. */
export type TaskStateResult =
  | { ok: true; from: string; to: string }
  | { ok: false; status: number; message: string };

export interface TaskStateDeps<C = unknown> {
  /** Reads the task's CURRENT state — whatever `fleet task show` already
   *  calls (see cli/fleet.ts's real implementation), reused rather than a
   *  new route. */
  getCurrentState: (creds: C, number: number) => Promise<TaskStateFetchResult>;
  /** POST /tasks/<n>/state — board.ts's transitionTask, the EXISTING route
   *  and its compare-and-swap, untouched by this feature. */
  transition: (creds: C, number: number, from: string, to: string) => Promise<TaskStateFetchResult>;
}

/**
 * Read-then-write, with no reformatting on either failure path.
 *
 * A `getCurrentState` failure is surfaced as-is: there is no `from` to send,
 * so `transition` is never called — the compare-and-swap the route runs is
 * still a single source of truth, not a value this orchestration ever
 * invents. A `transition` failure (most notably the route's own 409 when the
 * board moved between the read and the write) is likewise returned
 * UNCHANGED, `message` byte-identical to what the route sent.
 *
 * On success, `to` is read from the transition's OWN response rather than
 * echoing the caller's requested `to` back — the same "trust what was
 * actually written, not what was asked for" discipline transitionTask's own
 * return value follows.
 */
export async function runTaskStateTransition<C>(
  deps: TaskStateDeps<C>, creds: C, number: number, to: string,
): Promise<TaskStateResult> {
  const current = await deps.getCurrentState(creds, number);
  if (!current.ok) return current;
  const result = await deps.transition(creds, number, current.state, to);
  if (!result.ok) return result;
  return { ok: true, from: current.state, to: result.state };
}
