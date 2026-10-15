# S43-F8 body(sig) source-slice pin — helpers/src-pin.ts methodBody() (refs #885, refs #850)

Sweep 43 finding F8 (docs/maintainability/2026-10-14-dup-fixtures-sweep-43.md,
the census doc's own F8 section). Sibling precedent for a shared helper owning
a pin idiom: helpers/bringup-pins.ts (issue #136's source pins).

## Problem

Four suites pin `src/studio/do.ts` method bodies with the same 4-line idiom:
find the signature, assert it found, slice to the next 2-space close. Line
numbers below are PRE-CHANGE positions.

1. `apps/fleet/test/studio.provision.test.ts:926-930` — closure `body` inside
   one `it` (924), var `src` declared inside the same `it` (925, via an
   `(env as unknown as { TEST_STUDIO_DO_SRC: string })` cast), delimiter
   `"\n  }"` (929). Three call sites (932, 933, 935).
2. `apps/fleet/test/studio.wake-race.test.ts:123-127` — closure at
   describe level (describe at 121), var `src` (122), delimiter
   `"\n  }\n"` (126). Call sites 135 (a for-of over three signatures) and 140.
3. `apps/fleet/test/studio.exec-deadlines.test.ts` — var `doSrc` at module
   scope (13), delimiter `"\n  }\n"`, in FIVE places: a closure `body`
   (300-304, inside the `it` at 299 whose eight `body(...)` call sites are
   lines 305-312) PLUS four hand-rolled inline copies of the same idiom
   (290-292 inside the `it` at 288; 350-352; 364-366; 380-382).
4. `apps/fleet/test/studio.observation.test.ts:334-338` — closure at
   describe level (describe at 333), var `doSrc` at module scope (26),
   delimiter `"\n  }\n"` (337). Ten call sites (341, 351, 364, 370, 376, 382,
   390, 404, 414, 419).

Two delimiter spellings (`"\n  }"` vs `"\n  }\n"`), two variable names
(`src` vs `doSrc`), three placements — the divergence is cosmetic: both
delimiters work identically on do.ts's current formatting (shown below), so
every copy computes the same slice today.

## Fix

New `apps/fleet/test/helpers/src-pin.ts` exporting
`methodBody(src, sig)`. The helper owns its own `expect` (imported from
vitest, the helpers/bringup-pins.ts precedent — a helper can assert, the
caller does not have to wrap it in its own asserts), ONE normalized delimiter
`"\n  }"`, and asserts BOTH ends: signature found, and a close found after it.
Asserting the end matters — `indexOf` returning `-1` makes
`slice(start, -1)` mean "to the last character", so the old one-liner
(`src.slice(start, src.indexOf(...))` with no guard) handed back the whole
remainder of the file and a `.toContain` pin built on it could never fail.

Consumers keep a one-line local alias where they have many call sites
(`const body = (sig: string) => methodBody(doSrc, sig);`), so the call sites
themselves do not change. Pins stay in each consumer's own describes with
their own WHY comments — the helper is the one spelling of the slice, not
the new home of the pins.

## TDD order

1. Write `apps/fleet/test/helpers/src-pin.test.ts` FIRST, run it, see RED
   (module does not exist yet).
2. Add `helpers/src-pin.ts`, run the helper test, see GREEN.
3. Repoint the four consumers; re-run the four suites, same counts.

## Delimiter normalization risk

Normalizing `"\n  }\n"` to `"\n  }"` can only move a slice's end at or
BEFORE the old end: every `"\n  }\n"` match is also a `"\n  }"` match, so
the first `"\n  }"` after a signature is at or before the first
`"\n  }\n"`. The danger is a slice that silently SHORTENS.

Do NOT rest the safety claim on "the suites stay green" — that check is
one-sided: a shortened slice makes every `.toContain` pin pass at least as
easily, and it makes a NEGATIVE assertion pass silently too. The blast radius
of the repoint contains exactly one negative assertion:
`apps/fleet/test/studio.wake-race.test.ts:142`,
`expect(b).not.toContain("maestro sweep wake failed")` on the
`"  async sweepMaestro(): Promise<void> {"` slice. Green therefore proves
little; the dispositive check is the line census below (every number verified
on 2026-10-15 against `apps/fleet/src/studio/do.ts` at this branch):

- The lines where the two spellings disagree are 2-space closes NOT followed
  by a newline. The regex that captures the real set is `^  \}.` — `^  \}\S`
  is WRONG (it misses `  } catch (…) {`, `  } finally {`, `  } else {`).
  `grep -cE '^  \}.' src/studio/do.ts` = **54**, breaking down as: 26
  `  } catch`, 5 `  } finally`, 1 `  } else`, 18 `  };`, 4 other shapes
  (1 `  },`, 3 `  })`-family). The wrong `^  \}\S` regex would report only
  22 — the catch/finally/else lines are exactly the ones it drops.
- `export class StudioDO` is at line **5748**; the class's column-0 closing
  brace is at line **8623** (the last method, `pasteImage`, closes at 8622).
  Range: **5748-8623**.
- Distinguishing lines INSIDE that range: **zero**
  (`awk 'NR>=5748 && NR<=8623' src/studio/do.ts | grep -cE '^  \}.'` = 0).
  Nearest below the class: line 5674 (`  };`). Nearest above: line 8656
  (`  } catch (err) {`, inside the top-level `applyStudioGitSafetyPort`
  function).
- Every signature the four suites pin is a class method inside that range,
  occurring exactly once in the file:
  6023 `  private deps(): ProvisionDeps {`,
  6755 `  private refreshDeps(`,
  6788 `  private shipDeps(`,
  6807 `  private syncDeps(`,
  6865 `  private rescueTarget(`,
  6966 `  private failoverDeps(`,
  7204 `  private async provisionUngated(`,
  7434 `  async getStatusDetail(`,
  7443 `  async onStart(`,
  7463 `  async onStop(`,
  7561 `  private async restartUngated(`,
  8080 `  async destroyStudio(`,
  8200 `  async checkProvisioned(`,
  8304 `  async syncSession(`,
  8365 `  async wakeStudio(`,
  8398 `  async wakeStudioOnAssignment(`,
  8452 `  async inspect(`,
  8571 `  async sweepMaestro(): Promise<void> {`,
  8612 `  async watchContainer(`.

Conclusion: inside the StudioDO class every line starting with `  }` is a
bare `  }` at line end, so for every pinned signature both delimiter
spellings find the same first close — no pinned slice moves. Honest
framing: this is a property of do.ts TODAY, not a guarantee the helper can
make — a future `  } catch` inside a pinned method would shorten that
method's slice, and the green suites would not necessarily catch it. Green
suites are secondary confirmation only; this census is the check.

## Verification (serial, one gate at a time)

1. `cd apps/fleet && bun x vitest run test/helpers/src-pin.test.ts` — GREEN.
2. `cd apps/fleet && bun x vitest run test/studio.provision.test.ts
   test/studio.wake-race.test.ts test/studio.exec-deadlines.test.ts
   test/studio.observation.test.ts` — same 205 passed as before the repoint.
3. `cd apps/fleet && flock /tmp/fleet-gate.lock bun x tsc --noEmit -p test`
   (heavy, alone).
4. `cd apps/fleet && bun run scripts/english-check.ts` — clean.
5. `cd apps/fleet && bun run scripts/test-lies-check.ts` — clean.

## Scope guard

Test-only: one helper (`helpers/src-pin.ts`), one helper test
(`helpers/src-pin.test.ts`), and edits to the four existing consumer test
files. Nothing under `apps/fleet/src/` changes. If a suite goes RED because
the normalized delimiter slices short, STOP and report which signature and
which fragment fell out — never widen the delimiter back silently.

## Follow-up (NOT this task)

The same idiom lives in ten MORE files (grep counts, `indexOf("\n  }`-style
lines per file, verified 2026-10-15):
`studio.account-launched.test.ts` 9, `studio.refresh.test.ts` 6,
`studio.sweep.test.ts` 5, `agents.do.test.ts` 2,
`studio.rescue-token.test.ts` 2, then `deploy-do-port.test.ts`,
`studio.wake-gate.test.ts`, `studio.rate-limited.test.ts`,
`studio.backup-guard.test.ts`, `bun/archive-wiring.test.ts` at 1 each.
`bun/archive-wiring.test.ts` runs under `bun test`, not vitest, so its
`expect` import (`from "bun:test"`) differs — it cannot import this helper's
vitest `expect` unmodified.

Also consciously deferred: a `doSrc()` export owning the
`TEST_STUDIO_DO_SRC` binding, which would delete four caller `doSrc`/`src`
declarations and `studio.provision.test.ts`'s
`(env as unknown as { TEST_STUDIO_DO_SRC: string })` cast — out of #885's
shape (the census proposed only the slice helper), worth its own task.

## Push blocker

The studio token has no contents-write, so `git push` 403s: this branch is
local-only and the PR waits on the operator.
