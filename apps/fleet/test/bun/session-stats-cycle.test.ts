// apps/fleet/test/bun/session-stats-cycle.test.ts
//
// Issue #449 pins the no-cycle rule of the burn.ts split: the tar/gzip
// byte-stream reader half (src/studio/session-stats.ts) must never import
// the usage-accounting half (src/studio/burn.ts). Burn.ts keeps importing
// FROM session-stats.ts, so the dependency arrow points one way and the
// two knowledge areas cannot re-tangle (deep-modules sweep 6 §F3,
// docs/maintainability/2026-10-12-deep-modules-sweep-6.md).
//
// Import lists are inspected with Bun's built-in transpiler scan API
// (scanImports), and asserted only through .filter(...)/.length/.toEqual —
// never by string-matching the files' text, which scripts/test-lies-check.ts
// flags as a source-reading test lie. The whole file is RED until the move:
// test 1 because session-stats.ts does not exist yet, test 3 because burn.ts
// does not yet import ./session-stats.
//
// https://github.com/rafarc21/fleetflare/issues/449
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATS = join(import.meta.dir, "../../src/studio/session-stats.ts");
const BURN = join(import.meta.dir, "../../src/studio/burn.ts");

// Specifier strings a session-stats.ts import could use to reach burn.ts:
// the sibling-relative form the repo actually uses, plus defensive matches
// for a move or an extension the split might introduce.
function burnRefs(paths: string[]): string[] {
  return paths.filter((p) => p === "./burn" || p.endsWith("/burn") || p.endsWith("/burn.ts") || p === "../studio/burn");
}

describe("issue #449 no-cycle rule: session-stats.ts and burn.ts stay one-way", () => {
  test("session-stats.ts exists", () => {
    expect(() => readFileSync(STATS, "utf8")).not.toThrow();
  });

  test("session-stats.ts imports nothing from burn.ts", () => {
    const paths = new Bun.Transpiler({ loader: "ts" })
      .scanImports(readFileSync(STATS, "utf8"))
      .map((i) => i.path);
    expect(burnRefs(paths)).toEqual([]);
  });

  test("burn.ts still imports the walker from ./session-stats", () => {
    const paths = new Bun.Transpiler({ loader: "ts" })
      .scanImports(readFileSync(BURN, "utf8"))
      .map((i) => i.path);
    expect(paths.filter((p) => p === "./session-stats").length).toBeGreaterThan(0);
  });
});
