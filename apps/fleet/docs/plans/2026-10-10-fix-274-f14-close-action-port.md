# F14: delete `board/close-outcome.ts` shim by narrowing `close-action.ts` to a D1 port (board issue #274)

From the deep-modules sweep (#259 Part B1, finding F14). Behavior-preserving,
type-only. The sweep doc's literal suggestion ("`close-action.ts` takes
`{ DB: D1Database }`") does NOT survive contact with the real type packages —
verified in this container:

1. `D1Database` in `@cloudflare/workers-types` is an ambient global
   (`declare abstract class`, no top-level module exports at all), so it
   cannot be named-imported.
2. `bun-types` (what `cli/tsconfig.json` loads via `types: ["bun"]`) declares
   no `D1Database` — the NAME itself fails `tsc -p cli` wherever it appears
   in the cli project's import graph.
3. Even with close-action's param narrowed, its runtime import
   `src/events/log.ts` (lines 39, 51: `appendEvent`/`readSince` signatures)
   still spells the global name, so the shim could not be deleted anyway.

## The fix (all three verified facts addressed)

**`src/events/log.ts`** exports a structural port — the slice of D1's surface
these modules actually use — and takes it in both signatures:

```ts
/** Structural slice of D1's surface this module's callers need — every
 *  method of the ambient `D1Database` global, spelled structurally so this
 *  file type-checks under the non-Workers tsconfig projects (cli/,
 *  test-integration/, test/bun) that reach it through
 *  board/close-action.ts's runtime import. The real `D1Database` satisfies
 *  this structurally; nothing at any call site changes. */
export interface D1Port {
  prepare(query: string): {
    bind(...values: unknown[]): D1Port["prepare"] extends never ? never : {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run<T = Record<string, unknown>>(): Promise<{ meta: { changes: number } }>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}
```

(Implementation note: the concrete shape is a method-chaining interface
mirroring `D1PreparedStatement`'s `bind(...): this`-style chaining — written
as three nested interfaces `D1Port`, `D1PortStatement`, `D1PortResult` if the
inline conditional above is not clean TypeScript. What matters: no
`D1Database`/`D1PreparedStatement`/`D1Result` global names anywhere in the
file, and the real `D1Database` still satisfies it structurally.)

**`src/board/close-action.ts`:**

- Deletes `import type { Env } from "../env"` and the close-outcome import.
- Defines `export type CloseOutcome = "closed" | "already-closed" | "no-op";`
  at home in this file.
- Signature narrows `env: Env` → `db: D1Port` (imported type-only from
  `../events/log`), with the two `env.DB` uses (`:114`, `:178`) becoming
  `db` directly.
- Header comment rewritten: the shim's reason (board issue #157's
  build-constraint split) is now closed — state that the port IS the fix, the
  type is home, and the old shim file is deleted; keep the operational
  documentation of the function's own guarantees (dedup-last, backfill, etc.)
  untouched.

**`src/studio/task-reap.ts`:** `import type { CloseOutcome } from
"../board/close-outcome"` → `from "../board/close-action"`, and its comment
block explaining the shim workaround is updated to say the constraint is gone
(the type now lives at home, and close-action's graph carries no
workers-types-only names into non-Workers tsconfig projects).

**`src/board/close-outcome.ts`:** DELETED.

**Call sites of `closeTaskOnPromote`** (`src/board/routes.ts:400`,
`src/github/webhook.ts:412`): pass `env.DB` instead of `env` — the ONLY
runtime-visible change, a pure argument narrowing; every caller already holds
`env`.

**Tests:** `test/board.close-action.test.ts` passes `testEnv.DB` instead of
`testEnv`; its `import type { Env }` stays (it still uses `env` from
`cloudflare:test` for the DB binding). No other test changes — the change is
type-only from the runtime's point of view.

## Why no other graph file needs touching

Verified by grepping every file in the new cli-reachable graph
(board/board.ts, brief, envelope, types, api, path-overlap, github/api,
github/promote-close, github/reach, studio/repo, studio/ids, studio/types →
burn/observed/rate-limit/session-sync → archive/activity/member-alerts/
restarts/redact/rescue/rescue-gc/credentials/exec-deadline/tmux, time-budget,
events/schema): none references a workers-types-only global. `events/log.ts`
is the ONLY offender, which is why the port lives there.

## Verification (one gate at a time)

Baseline in this container (branch `fix-274-f14-close-action-port`):
`tsc -p cli` exit 0, root `tsc --noEmit` exit 0.

1. `tsc --noEmit -p cli` — the gate the shim existed for (proves the DO
   graph is not dragged in by task-reap's now-direct import).
2. Root `tsc --noEmit` (workers-types project: proves the real `D1Database`
   still satisfies the port, and nothing else broke).
3. `tsc --noEmit -p test` and `-p test-integration` and `-p container`.
4. `bun run check` is the aggregate; run once at the end if cheap.
5. Targeted vitest: `test/board.close-action.test.ts`,
   `test/studio.task-reap.test.ts`, `test/board.routes.test.ts`,
   `test/github.webhook.test.ts`, `test/events.log.test.ts`,
   `test/events.rules.test.ts`, `test/bun/` unaffected but spot-run if cheap.
6. One-way door check: diff touches none of `apps/fleet/scripts/merge-danger.ts`'s
   `ONE_WAY_GLOBS` → two-way.

## Out of scope (stays separate, per the sweep doc)

Moving auto-close orchestration out of `src/github/webhook.ts:306-523` —
webhook.ts holds signature verification; that is its own task.
