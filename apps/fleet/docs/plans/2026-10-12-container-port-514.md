# Plan — CONTAINER_PORT: one name for the platform's 8080 (refs #514)

Sweep-14 §S14-F10 (docs/maintainability/2026-10-12-magic-numbers-sweep-14.md,
parent #485): port 8080 re-typed 4x — defaultPort on both Container subclasses
(agents/do.ts, deploy/do.ts), deploy/do.ts containerFetch calls, runtime.ts's
silent default parameter. sleepAfter stays per-class (20m vs 5m — config).

## Change (behavior identical — every value still 8080)

- runtime.ts: `export const CONTAINER_PORT = 8080;` next to ContainerRuntime.
- agents/do.ts: `defaultPort = CONTAINER_PORT;` (import from ./runtime).
- deploy/do.ts: `defaultPort = CONTAINER_PORT;` + both containerFetch ports
  (import CONTAINER_PORT from ../agents/runtime).
- runtime.ts ContainerRuntime ctor: `port: number = CONTAINER_PORT`.

## TDD

RED pin test/bun/container-port.test.ts (c706a04) — behavioral default +
override tests plus an import-edge pin. GREEN fold (8e67220): 3/3 pin tests,
touched vitest files pass, `bun run check` + `bun run english-check` green.
Two-way door: revert restores four literals.