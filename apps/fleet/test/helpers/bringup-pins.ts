import { expect } from "vitest";
import { env } from "cloudflare:test";

// container/studio-bringup.sh is shell, not a TS module — workerd has no
// filesystem and bash cannot be imported, so its source arrives as a
// binding (vitest.config.ts) and suites pin load-bearing fragments as text.
// These helpers are that one spelling; the pins themselves stay in each
// consumer's own describes, each with its own WHY.

/** The pinned source text of container/studio-bringup.sh. */
export function bringupSrc(): string {
  return env.TEST_STUDIO_BRINGUP_SRC;
}

/** Pins a load-bearing fragment: assert the bring-up source contains it. */
export function expectBrings(fragment: string): void {
  expect(bringupSrc()).toContain(fragment);
}

/** Pins an ABSENCE: assert the bring-up source dropped a known-bad fragment. */
export function expectBringsNot(fragment: string): void {
  expect(bringupSrc()).not.toContain(fragment);
}
