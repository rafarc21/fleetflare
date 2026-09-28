import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAESTRO = readFileSync(join(import.meta.dir, "../../../../fleet/blueprint/studios/maestro/studio.md"), "utf8");

test("maestro rulebook owns the junior decision", () => {
  expect(MAESTRO).toContain("## Junior — your call, per task");
  expect(MAESTRO).toContain("fleet task new");
  expect(MAESTRO).toContain("--junior");
  expect(MAESTRO).toContain("You never call the junior yourself");
});

test("maestro frontmatter does not list the junior skill", () => {
  const frontmatter = MAESTRO.split("---")[1] ?? "";
  expect(frontmatter).not.toMatch(/\bjunior\b/);
});
