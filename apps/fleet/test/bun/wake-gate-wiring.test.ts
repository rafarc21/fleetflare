import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #144 fix pass C: every runGatedWake call site in do.ts hands the gate the
// switch record AND the first sighting. A site that forgets either silently
// re-parses seen text (#127) or refuses a wake the switch already explained.
// A source pin: StudioDO cannot be constructed under vitest-pool-workers.
describe("do.ts runGatedWake call sites", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8"); // test-lies-check: allow — StudioDO cannot be constructed under vitest-pool-workers (see the comment above), so this file's own documented source pin
  const calls = src.split("runGatedWake(").slice(1).map((rest) => rest.slice(0, rest.indexOf("prompt")));

  test("there are exactly 3", () => {
    expect(calls).toHaveLength(3);
  });

  test("each passes switchedBlock and limitSighting", () => {
    for (const c of calls) {
      expect(c).toContain("switchedBlock:");
      expect(c).toContain("limitSighting:");
    }
  });

  // Fix pass D (#170): ONE reader for the sighting key. A site that reaches
  // into `ctx.storage.get(...)` by hand duplicates the key and the `?? null`,
  // and the day the key moves that site reads nothing and re-parses seen text.
  test("each reads the sighting through limitSightingIn", () => {
    for (const c of calls) {
      expect(c).toContain("limitSightingIn(");
    }
  });
});
