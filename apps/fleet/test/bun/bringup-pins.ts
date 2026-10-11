import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// container/studio-bringup.sh is shell, not a TS module — it can't be
// imported, only read as text and pinned. Same one spelling as the workerd
// lane's test/helpers/bringup-pins.ts (which gets the text as a binding;
// bun has a filesystem and reads the file); the pins themselves stay in
// each consumer's own describes, each with its own WHY.

/** The pinned source text of container/studio-bringup.sh. */
export function bringupSrc(): string {
  return readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
}

/** Pins a load-bearing fragment: assert the bring-up source contains it. */
export function expectBrings(fragment: string): void {
  expect(bringupSrc()).toContain(fragment);
}

/** Pins an ABSENCE: assert the bring-up source dropped a known-bad fragment. */
export function expectBringsNot(fragment: string): void {
  expect(bringupSrc()).not.toContain(fragment);
}
