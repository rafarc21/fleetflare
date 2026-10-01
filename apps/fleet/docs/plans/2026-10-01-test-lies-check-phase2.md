# Wiring test-lies-check in as a real failing gate (board issue #174, Phase 2)

Phase 1 (#164, `2026-10-01-test-lies-check-phase1.md`) built
`apps/fleet/scripts/test-lies-check.ts` as a report-only scan for three
shapes of "test lie" — tautological assertions, source-reading, and
own-module mocks — and deliberately never failed CI, by design, so the
check's real counts against this repo could be known before anyone
committed to a threshold. This is Phase 2: the backlog that report
surfaced is now cleared, the detector's one documented blind spot is
closed, and the script is wired in as a real failing gate.

## Clearing the backlog: two streams, two patterns

Two parallel work streams fixed every real finding Phase 1 found (37
tautological, plus the 2 genuine source-reading hits the derivation-chain
fix below uncovered), merged into this branch with no file overlap.

### Pattern 1 — real-behavior-test replacement (the majority)

For most of the 37 tautological findings
(`expect(SOME_CONST).toBe(<its own declared value>)`), the fix was to
replace the self-mirroring assertion with one that exercises the real
behavior the constant feeds — the same shape `time-budget.test.ts`'s
`AUTO_CLOSE_BUDGET_MS` pin already used as a model: assert against the
REAL default parameter / REAL computed result the constant drives, not a
restatement of the import. A drift between the constant and the behavior
it controls is now caught; a drift between the constant and itself never
was. Touched ~27 files under `apps/fleet/test/` (see
`origin/fix-174-tautological-fixes`'s own commits for the file-by-file
list — disjoint from every file this document's own stream touched).

### Pattern 2 — source-pinning + allowlist (2 of 3 StudioDO-coupled constants)

Three constants live behind `StudioDO`'s closure, unreachable by direct
import under `vitest-pool-workers` (`test/studio.*.test.ts` cannot
construct a real Durable Object): `REFRESH_SECONDS`,
`SURVIVAL_COMPARE_BASE`, and `BACKGROUND_SHELL_STALE_MS`.

- **`REFRESH_SECONDS`** (`test/studio.refresh.test.ts`) and
  **`SURVIVAL_COMPARE_BASE`** (`test/studio.survival-delivery.test.ts`)
  each got a real source-pinning test: read `src/studio/do.ts`'s own text
  and assert the exact call site that wires the constant in (e.g.
  `compareAhead(await token(), repo, SURVIVAL_COMPARE_BASE, branch)`)
  appears literally, so any drift in HOW `do.ts` wires the constant in
  breaks the test — not a tautology (it does not restate the constant's
  own value), but still a `readFileSync` + string-match against `src/`,
  which the source-reading detector correctly flags on the pattern alone.
  Both are marked with a trailing `// test-lies-check: allow —
  source-pinning, see comment above` escape comment, with the comment
  above explaining why `do.ts`'s closure makes this the only reachable
  real coverage.
- **`BACKGROUND_SHELL_STALE_MS`** (`test/studio.activity.test.ts`) turned
  out NOT to need this treatment: unlike the other two, its consumer
  (`applyActivityVerdict`) is reached through the EXPORTED
  `runShipTickWithObservation`, not locked behind the unconstructable
  `StudioDO` closure — `test/studio.do.test.ts`'s
  "runShipTickWithObservation — onStaleBackgroundShell (issue #106)"
  describe block already exercises the real 15-minute crossing (16min
  fires, 10min does not) against the real constant. Real coverage
  already existed; nothing needed fixing or allowlisting.

## Extending the source-reading detector: derivation chains

The Phase 1 doc's own "known, consequential limitation" section named the
gap directly: the captured-variable scan only matched the EXACT captured
name, with no dataflow tracking through a derived variable
(`src` → `method` (`src.slice(...)`) → `call` (`method.slice(...)`) →
`expect(call).toContain(...)`). `test/bun/archive-wiring.test.ts` and
`test/bun/wake-gate-wiring.test.ts` are exactly this shape. `findSourceReading`
now follows a bounded derivation chain — each hop must be a plain
`const`/`let` assignment taking the previous variable (or a call on it:
`.slice()`, `.split()`, `.indexOf()`, `.match()`, etc.) as its source,
never an unrelated expression — before checking whether the chain's last
link reaches `toContain`/`toMatch`/`.includes()`. This closed the gap that
previously hid real findings from the scan entirely; once it could see
them, both `archive-wiring.test.ts` and `wake-gate-wiring.test.ts` got the
same `// test-lies-check: allow — StudioDO cannot be constructed under
vitest-pool-workers …` escape comment `REFRESH_SECONDS`/
`SURVIVAL_COMPARE_BASE` already used, for the identical reason: a
documented, deliberate source pin standing in for real coverage the DO's
closure makes otherwise unreachable, not a test lie.

### Known, deliberately scoped-out: `env.TEST_STUDIO_DO_SRC`

Covered by `test/bun/test-lies-check.test.ts`'s own detector tests but
worth naming explicitly here so it is not lost: roughly a dozen
`test/studio.*.test.ts` files read `src/studio/do.ts` not via
`readFileSync`/`Bun.file(...).text()` directly, but through a
`env.TEST_STUDIO_DO_SRC` property access — a vitest-pool-workers
environment binding carrying the same source text, set up once outside any
one test file. This is a DIFFERENT idiom than the derivation chains closed
above (no `readFileSync`/`Bun.file` call site for the detector to even
start from — it is a property read on an opaque `env` object) and is
deliberately NOT covered by either detector today. It is real,
structurally identical risk to the `src/`-reading shape this check exists
to catch, just reached through a different syntactic door. Worth a future
issue of its own rather than folding into this one — named here so the
gap is tracked, not silently reintroduced as "already checked."

## The flip: report-only → failing gate

`scripts/test-lies-check.ts`'s `if (import.meta.main)` CLI block changed
from an unconditional `process.exit(0)` (Phase 1, #164 — "report-only,
never fails CI, regardless of what it finds") to
`process.exit(findings.length > 0 ? 1 : 0)` (Phase 2, #174). Every
detector's own "skip on uncertainty, never guess-and-flag" philosophy is
completely unchanged — only the CLI's exit behavior flipped, now that the
real count the backlog work above produced is 0 tautological, 0
source-reading, 0 own-module-mock.

Proved with a real RED/GREEN mutation against the live script: a single
throwaway `expect(AUTO_CLOSE_BUDGET_MS).toBe(25_000);` line added to the
already-green `test/time-budget.test.ts` made
`bun run scripts/test-lies-check.ts` list the finding and exit 1 (RED);
reverting the line (`git checkout -- test/time-budget.test.ts`) brought it
back to 0 findings and exit 0 (GREEN). No such mutation was left committed.

## Wired into the real CI gate

GitHub Actions is disabled in this repo; the real gate is the local-ci
daemon (`apps/fleet/scripts/localci/localci.sh`), which posts
`local-ci/fleet-check` and `local-ci/english` as commit statuses. A new
`lane test-lies-check bun run test-lies-check` sits in the `--lanes` block
alongside `check`/`vitest`, inside the `cd "$F"` (`apps/fleet`) fleet-check
scope — not inside the separate top-level `english()` lane, since this is
a test-quality gate, not an English-prose one. `summarize.ts` now reads
`test-lies-check.exit` the same way it already read `check.exit`: a
nonzero exit fails `local-ci/fleet-check` and is named in its description
(`test-lies-check FAILED`), rolled into the same `ok = install && check &&
testLiesCheck && vitest.ok && bun.ok` verdict every other lane already
feeds. Covered in `test/bun/localci-summarize.test.ts` (fixture-level:
`test-lies-check.exit` nonzero → `local-ci/fleet-check` failure,
`local-ci/english` unaffected) and `test/bun/localci-run.test.ts` (the
stubbed end-to-end harness: the lane is actually invoked as part of the
fleet-check sequence, skipped when no fleet path changed, and a nonzero
exit from it fails the run) — neither touches docker, tmux, or `gh` for
real.

The dormant `.github/workflows/fleet-check.yml` was deliberately left
untouched, not updated: pushing an edit to anything under
`.github/workflows/` was rejected by GitHub itself ("refusing to allow a
Personal Access Token to create or update workflow
`.github/workflows/fleet-check.yml` without `workflow` scope") — this
container's token lacks the `workflow` OAuth scope, which is a real
permission boundary, not something to work around from here. The edit was
drafted and verified locally, then reverted rather than left as an
unpushable commit. Adding the equivalent `Test-lies check` step (`bun run
test-lies-check`, next to the existing `Type check` step) is a follow-up
for whoever has `workflow` scope — either a token with that scope, or
applied by hand through the GitHub UI. Actions itself stays disabled
either way; this is purely so a human reading that file sees the real
gate reflected there too, once someone can push it.

## What changed, in one line

| Phase | CLI exit behavior | Findings | Wired into CI |
| --- | --- | --- | --- |
| 1 (#164) | always 0 | 37 tautological + 2 source-reading (3 total StudioDO-coupled were undercounted — see derivation-chain gap above) | no |
| 2 (#174) | `findings.length > 0 ? 1 : 0` | 0 | yes — `local-ci/fleet-check` |
