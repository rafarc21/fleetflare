# Plan — CONTAINER_PORT: one name for the Containers platform's 8080 (refs #514)

Sweep-14 finding S14-F10 (parent #485, doc
docs/maintainability/2026-10-12-magic-numbers-sweep-14.md §S14-F10). The
platform port 8080 is re-typed 4x: `defaultPort = 8080` per Container subclass
(agents/do.ts:179, deploy/do.ts:211), deploy/do.ts's two containerFetch calls
(:234, :271), and runtime.ts:49's silent default parameter that must agree.
sleepAfter stays per-class — values diverge (20m vs 5m), it is config.

## Change (behavior identical — every value still 8080)

- `apps/fleet/src/agents/runtime.ts`: `export const CONTAINER_PORT = 8080;`
  next to ContainerRuntime (module owns the container wire protocol).
- `agents/do.ts` AgentDO: `defaultPort = CONTAINER_PORT;` (import from ./runtime).
- `deploy/do.ts` DeployDO: `defaultPort = CONTAINER_PORT;` + both containerFetch
  ports (import from ../agents/runtime).
- `runtime.ts` ContainerRuntime ctor: `port: number = CONTAINER_PORT`.

## TDD

1. RED: new `apps/fleet/test/bun/container-port.test.ts` (bun:test, in the
   bun-test suite like session-stats-cycle.test.ts): three tests — (a) fake
   Container feeds ContainerRuntime, call startTask, containerFetch receives
   CONTAINER_PORT (8080) as port arg; (b) same fake, ctor override 1234 →
   fetch receives 1234 (default is a default, not hardcoded); (c) wiring pin,
   Bun.Transpiler.scanImports: agents/do.ts and deploy/do.ts each import
   ./runtime or ../agents/runtime and those import paths contain
   "CONTAINER_PORT" specifier — same idiom as session-stats-cycle.test.ts.
   Test file body never reads src/ file text (test-lies-check rule).
2. GREEN: the 4-site fold above.
3. `bun run bun-test test/bun/container-port.test.ts` and
   `bun run test -- agents runtime deploy` pass; `bun run check`;
   `bun run english-check` — each one at a time (heavy-gate budget).

## Bounds

~30 changed lines, one PR. Two-way door. No DO behavior change, no deploy lane.
