import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAESTRO = readFileSync(join(import.meta.dir, "../../../../fleet/blueprint/studios/maestro/studio.md"), "utf8");

// Board issue #250, scope add 1 (operator ruling, 2026-10-06): maestro is
// ALWAYS LOCAL. The junior decision used to be owned by the cloud
// `maestro` studio's own rulebook, written straight into its body — that
// body is now a stub (a cloud studio provisioned with this role stops and
// escalates instead of operating), so the junior-decision prose this test
// used to pin here moved to the LOCAL maestro's own rulebook, the
// `maestro-playbook` skill (its "Junior" ownership is implicit in "Maestro
// never writes deliverable code... dispatches" — the junior skill itself,
// `skills/junior/SKILL.md`, states "the maestro decides" directly). This
// file now pins the stub's own escalation shape instead.

test("maestro studio.md is a stub that escalates rather than operating", () => {
  expect(MAESTRO).toContain("maestro is ALWAYS LOCAL");
  expect(MAESTRO).toContain("intent: escalate");
  expect(MAESTRO).toContain("status: blocked");
  expect(MAESTRO).not.toContain("## Junior — your call, per task");
});

test("maestro frontmatter does not list the junior skill", () => {
  const frontmatter = MAESTRO.split("---")[1] ?? "";
  expect(frontmatter).not.toMatch(/\bjunior\b/);
});
