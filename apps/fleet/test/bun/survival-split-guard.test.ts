import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Issue #697 (S26-F10): the survival-delivery test split's file-set guard.
 * The split must land as a pure move: the old monolith gone, exactly the two
 * named halves present. node:fs in the bun lane — workerd cannot host it. */
describe("survival split file set (#697)", () => {
  const testDir = join(import.meta.dir, "..");
  test("the old monolith is gone and both halves exist (#697)", () => {
    expect(existsSync(join(testDir, "studio.survival-delivery.test.ts"))).toBe(false);
    expect(existsSync(join(testDir, "studio.survival-input.test.ts"))).toBe(true);
    expect(existsSync(join(testDir, "studio.survival-retry.test.ts"))).toBe(true);
  });
});
