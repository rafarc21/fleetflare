# Plan — #377 S3-F10 describe-title deprovenance (safe subset)

Refs https://github.com/rafarc21/fleetflare/issues/377. Title-only text cleanup,
zero test-body edits. Source finding:
docs/maintainability/2026-10-11-test-sweep-3.md S3-F10.

## Problem

27 describe TITLES in three GLM-OK test files carry review-round provenance
("issue #284 round 2", "maestro correction #3 rewrite", "review BLOCKER 2") —
history, not behavior. A reader scanning failures cannot tell WHICH BEHAVIOR
broke from which review round produced the test. BODY comments stay: they are
load-bearing (they record the measured failure that motivated the test).

## Scope

ONLY these files, ONLY the `describe("...")` first-string-literal argument:

- apps/fleet/test/github.webhook.test.ts (6 titles)
- apps/fleet/test/studio.observation-tick.test.ts (15 titles)
- apps/fleet/test/cli.fleet.test.ts (6 titles)

OUT: studio.session.test.ts, rescue-push.test.ts,
studio.account-failover.test.ts, bun/git-wrapper.test.ts (Claude lane). No
other files. Zero `it()` titles, zero body comments, zero code.

## Steps

1. Backend Developer applies the exact title table (lead supplied all 27
   old->new pairs; no member judgment needed), one commit.
2. Gate: the three suites' vitest runs pass; `bun run english-check` clean;
   `git diff` shows ONLY describe-title lines.
3. Code Reviewer, fresh context, read-only: Spec axis (did titles change
   exactly the 27 lines, nothing else?) + Standards axis. Max 2 rounds.
4. PR, refs #377, refs #359.

## Boundaries

- Titles do not gate tests — no behavior change possible; still run the three
  suites to prove collection still parses.
- Heavy gates: the three suite files run under `bun run test`
  (vitest-pool-workers, minutes-scale). Run ALONE, one at a time, never
  alongside another gate. Do NOT run the full vitest suite here — CI owns it.
- `bun run english-check` is cheap, run after the title commit.
- No bundler build, no tsc needed (string literals only).
