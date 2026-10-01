import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STUDIO = readFileSync(join(import.meta.dir, "../../../../fleet/blueprint/studios/web-studio/studio.md"), "utf8");

test("lead routes Standards-axis findings to a fresh-context refactor step that commits, not comments (#166)", () => {
  expect(STUDIO).toMatch(/refactor step/i);
  expect(STUDIO).toMatch(/fresh.context/i);
  expect(STUDIO).toMatch(/commits? the fix/i);
});

test("Spec-axis findings and genuine questions still go back as comments, not silently reworked", () => {
  expect(STUDIO).toMatch(/comment/i);
});

test("refactor step still respects push discipline and the one-heavy-gate-at-a-time rule", () => {
  expect(STUDIO.toLowerCase()).toContain("push discipline");
  expect(STUDIO.toLowerCase()).toMatch(/one.heavy.gate/);
});
