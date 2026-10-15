import { expect } from "vitest";

// StudioDO is container-backed and CANNOT be constructed under
// vitest-pool-workers, so suites pin its wiring as source text instead:
// do.ts arrives as the TEST_STUDIO_DO_SRC binding (read into a string on the
// Node side by vitest.config.ts, the same wiring as TEST_STUDIO_BRINGUP_SRC
// — see helpers/bringup-pins.ts). Sweep-43 F8 (#885): four suites carried the
// same 4-line slice idiom as local copies with two delimiter spellings;
// this helper is that one spelling, while the pins themselves stay in each
// consumer's own describes, each with its own WHY. Before migrating the ten
// follow-up files named in the plan (they all spell the old "\n  }\n"), re-run
// the census in docs/superpowers/plans/2026-10-15-s43f8-src-pin-method-body-885.md's
// "Delimiter normalization risk" section — it is the check that proves the
// normalization moves no pinned slice.

/**
 * Slices one method's body out of pinned source text: from the first
 * occurrence of `sig` (matched as a plain substring) to the first following
 * `"\n  }"`, excluding the close. `sig` should carry the method's own
 * leading indentation — that is how a caller pins the method level, e.g.
 * `"  private deps(): ProvisionDeps {"` selects the class method rather
 * than a same-named top-level function — recommended, not required. A
 * `sig` that is not unique pins the first match. Both failure modes assert
 * rather than return junk: a missing signature and a missing close each
 * fail the test (a `-1` end would make `slice(start, -1)` return the file
 * tail, silently weakening every pin built on it).
 */
export function methodBody(src: string, sig: string): string {
  const start = src.indexOf(sig);
  expect(start, sig).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }", start);
  expect(end, sig).toBeGreaterThan(start);
  return src.slice(start, end);
}
