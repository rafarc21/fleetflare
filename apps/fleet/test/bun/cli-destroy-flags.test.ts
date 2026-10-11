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
  test("cmdDestroy builds its path from every flag (issue #59 adds --park, #332 adds --strict-unmerged)", () => {
    expect(body("async function cmdDestroy(")).toContain("destroyPath(force, discardUnsynced, park, strictUnmerged)");
  });

  test("the dispatcher hands cmdDestroy the parsed discard, park and strict-unmerged flags", () => {
    expect(src).toContain(
      "cmdDestroy(creds, parsed.id, parsed.force, parsed.discardUnsynced, parsed.park === true, parsed.strictUnmerged === true)",
    );
  });

  // Board issue #332: the strict refusal must fire CLIENT-side, BEFORE any
  // destroy request — a refusal that let the destroy through would not be a
  // refusal. Pinned by position within cmdDestroy's own body, the same
  // source-pin technique this file's own header documents.
  test("#332: the strict refusal prints and exits BEFORE requestDestroy fires", () => {
    const fn = body("async function cmdDestroy(");
    const refusal = fn.indexOf("strictRefusalLines(");
    const destroy = fn.indexOf("requestDestroy(");
    expect(refusal).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(destroy);
  });

  // #332: the non-blocking warning belongs to the CONFIRMED-stopped path
  // only — printing a "still has N unmerged PRs" line for a destroy whose
  // outcome is unknown would be a claim this side cannot make.
  test("#332: the park warning prints only inside the confirmed teardown block", () => {
    const fn = body("async function cmdDestroy(");
    const teardown = fn.indexOf("if (report.teardown)");
    const warning = fn.indexOf("parkWarningLines(");
    expect(teardown).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(teardown);
  });
});
