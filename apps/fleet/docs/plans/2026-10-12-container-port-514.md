# Plan — CONTAINER_PORT: one name for the platform's 8080 (refs #514)

Sweep-14 §S14-F10 (docs/maintainability/2026-10-12-magic-numbers-sweep-14.md,
parent #485): port 8080 re-typed 4x — defaultPort on both Container subclasses
(agents/do.ts:179, deploy/do.ts:211), deploy/do.ts containerFetch calls
(:234, :271), runtime.ts:49's silent default. sleepAfter stays per-class
(20m vs 5m — real divergence, it is config).

## Change (behavior identical — every value still 8080)

- runtime.ts: `export const CONTAINER_PORT = 8080;` next to ContainerRuntime.
- agents/do.ts: `defaultPort = CONTAINER_PORT;` (import from ./runtime).
- deploy/do.ts: `defaultPort = CONTAINER_PORT;` + both containerFetch ports
  (import CONTAINER_PORT from ../agents/runtime).
- runtime.ts ContainerRuntime ctor: `port: number = CONTAINER_PORT`.

## TDD

RED pin test/bun/container-port.test.ts landed (c706a04). GREEN: fold above,
`bun test test/bun/container-port.test.ts` 3/3, touched vitest files pass,
`bun run check` + `bun run english-check` alone (gate budget). Two-way door.
