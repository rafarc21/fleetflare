import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #59: a cloud maestro's brief assumed the operator's Mac verbs
// (`provision --fresh-session`, `destroy`, `task new --studio` with a junior
// flag). Its container has the studio binary instead. The rulebook must say
// which verbs exist there, and what the envelope does NOT do.

const MAESTRO = readFileSync(join(import.meta.dir, "../../../../fleet/blueprint/studios/maestro/studio.md"), "utf8");
const BIN = readFileSync(join(import.meta.dir, "../../container/studio-fleet"), "utf8");

test("maestro rulebook names the in-container verbs it actually has", () => {
  expect(MAESTRO).toContain("### Your `fleet` is not the operator's `fleet`");
  for (const verb of ["fleet task new --studio", "fleet task assign", "fleet resume", "fleet spawn"]) {
    expect(MAESTRO).toContain(verb);
  }
});

test("every verb the rulebook promises is a verb the binary parses", () => {
  expect(BIN).toContain('if (sub === "new") {');
  expect(BIN).toContain('if (sub === "assign") {');
  expect(BIN).toContain('argv[0] !== "resume"');
});

test("the rulebook says filing spawns nothing, and nothing acts on a request envelope", () => {
  expect(MAESTRO).toContain("Filing a task spawns nothing.");
  expect(MAESTRO).not.toContain("Worker spawns the studio from the filed task");
  expect(MAESTRO).toContain("Nothing reads that envelope for you and acts on it");
});

test("review round 1: the rulebook says resume needs a parked studio, and never to retry one", () => {
  expect(MAESTRO).toContain("`fleet destroy --park`");
  expect(MAESTRO).toContain("Never retry a resume");
});

test("the rulebook says the in-container task new refuses a junior", () => {
  expect(MAESTRO).toContain("The in-container `fleet task new` refuses `junior: true`");
});
