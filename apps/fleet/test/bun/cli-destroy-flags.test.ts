import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #129 review: `destroyPath` is unit-tested (test/cli.repair-failure.test.ts),
// but a call site passing `destroyPath(force, false)` would drop
// --discard-unsynced silently. cli/fleet.ts runs its CLI on import, so the
// call site is pinned by source, the same technique the DO pins use.
const src = readFileSync(join(import.meta.dir, "../../cli/fleet.ts"), "utf8");

function body(sig: string): string {
  const start = src.indexOf(sig);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n}\n", start));
}

describe("fleet destroy — every flag reaches the route", () => {
  test("cmdDestroy builds its path from every flag (issue #59 adds --park)", () => {
    expect(body("async function cmdDestroy(")).toContain("destroyPath(force, discardUnsynced, park)");
  });

  test("the dispatcher hands cmdDestroy the parsed discard and park flags", () => {
    expect(src).toContain("cmdDestroy(creds, parsed.id, parsed.force, parsed.discardUnsynced, parsed.park === true)");
  });
});
