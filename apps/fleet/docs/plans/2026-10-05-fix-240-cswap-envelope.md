# Fix `fleet accounts` reading every slot as `cswap-missing` (board issue #240)

## The bug

Live on the real Worker + CLI (post-#232 merge), `fleet accounts` reads
EVERY slot as `cswap-missing`, even when `cswap` is installed and working.
Real `cswap list --json` prints an envelope OBJECT
(`{schemaVersion, activeAccountNumber, accounts}`), never the bare array
`readCswapList` (`cli/accounts.ts`) required. `test/fixtures/cswap-list.ts`
invented the bare-array shape, so the whole test suite passed against a
shape that never matched what the real tool emits.

## The fix

- `cli/accounts-format.ts` gained a new pure `parseCswapListOutput(stdout)`
  (Bun/node-free, so it's directly vitest-testable, unlike `readCswapList`
  itself, which is bun-only — it runs the real subprocess). Accepts the real
  `{schemaVersion: 1, accounts: [...]}` envelope, still tolerates a bare
  array (the old shape — cheap to keep), requires `schemaVersion === 1`
  (an unrecognized version never silently guesses at a possibly-changed
  shape), and reads `available: false` with a descriptive reason otherwise
  (unparseable JSON, bad schema version naming the version seen, or a
  malformed envelope missing/mistyped `accounts`).
- `cli/accounts.ts`'s `readCswapList` now just runs the subprocess
  (special-casing ENOENT as `"binary not found on PATH"`) and hands stdout
  to `parseCswapListOutput`.
- The `reason` now rides through `buildAccountsSnapshot`/`doSync` as
  `AccountsSnapshot.cswapUnavailableReason` / `SyncResult.cswapUnavailableReason`,
  and `printSnapshot` surfaces it once per snapshot (never per slot) via
  `console.error("cswap: <reason>")` — stderr, so the existing `--json`
  bare-array contract is never put at risk by this.
- `test/fixtures/cswap-list.ts`: `CSWAP_LIST_FIXTURE` (bare `CswapAccount[]`)
  is kept as-is — `claude-swap.test.ts`'s own `joinAccountsToCswap` calls take
  that shape directly, one layer above the subprocess read. Added
  `CSWAP_LIST_ENVELOPE` — the same five accounts wrapped in the real
  envelope — for tests that exercise the parsing/subprocess layer.
- `test/bun/accounts-cli.test.ts`'s fake `cswap` binary (`writeFakeCswap`)
  now prints exactly whatever payload it's handed (a small local `envelope()`
  helper wraps an ad-hoc accounts subset where needed) — every existing test
  in that file now exercises the real envelope shape, which is itself
  further proof of the fix (they all failed before it, RED-verified).

## Reason wording landed on

- binary not found: `binary not found on PATH` → surfaced as
  `cswap: binary not found on PATH`.
- bad schema version: `` unsupported schemaVersion: `${JSON.stringify(v)}` `` →
  e.g. `cswap: unsupported schemaVersion: 2`.
- malformed envelope (no/mistyped `accounts`): `malformed output (no accounts array)` →
  `cswap: malformed output (no accounts array)`.

## Review

Per the maestro's own dispatch on issue #240: small, bounded, TDD, one PR —
light review (maestro verifies directly), no separate code-review/QA round.
