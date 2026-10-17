---
# Plan: #1178 — pin the R2-recovered clone retry and the non-cause R2 error

## Problem

Two coverage gaps in apps/fleet/test/bun/gate-leg-run.test.ts, from the #1175 review:

1. Clone-via-R2 is unpinned: #1175 only tested install failed through the R2
   prefix. Mutating only the clone branch of `isRetryable` (dropping
   `stripped.startsWith("clone failed:")`) keeps 54/54 green.
2. Nothing pins that an R2-recovered error whose underlying text is NOT an
   install/clone cause stays final: mutating `isRetryable` to return true for
   every error (over-broad retry) keeps 54/54 green.

## Tests (both added to the `runLegStep: clone failure retries once (#1104)` describe block, after the `.retry.json` evidence-key test, ~line 505)

1. Clone-via-R2 recovered, retried, passes on retry: dispatch throws
   (transport loss), readResult returns
   `{ state: "error", description: CLONE }` where CLONE is the block's existing
   `"clone failed: fatal: remote-curl: bad line length character"`. Assert
   state success, description `flaky: passed on retry; first: result read from R2 after transport loss: <CLONE>`, step names `["start-lint", "retry-lint"]`, sent 2.
2. R2-prefixed error with an unrelated cause stays final: dispatch throws,
   readResult returns `{ state: "error", description: "disk quota exceeded" }`.
   Assert state error, description `result read from R2 after transport loss: disk quota exceeded`, exactly one step call `["start-lint"]`, sent 1.

## Mutants each must catch (run both, RED first, then revert and GREEN)

- Mutant A (test 1): in leg-run.ts isRetryable delete `|| stripped.startsWith("clone failed:")`.
- Mutant B (test 2): in leg-run.ts isRetryable change the final return to `return true;`.

## Verify

- `bun test test/bun/gate-leg-run.test.ts` — both mutants RED with the new tests, 54+2 GREEN without them.
- `bun run check` from apps/fleet — heavy gate, run alone.

## Blast radius

Test-only. No src change ships.
---