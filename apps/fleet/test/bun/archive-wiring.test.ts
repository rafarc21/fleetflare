import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #367 round 3 (review HOLD fix, item 1) — `runShipTickWithObservation`'s
// OWN `archive` parameter has behavior tests (test/studio.observation-tick.
// test.ts) proving it does the right thing WHEN SUPPLIED. Nothing proved the
// real wiring at `StudioDO.shipTranscript()` (the actual scheduled callback)
// still HANDS it that argument at all — the reviewer measured this directly:
// deleting the `{ doneRecords: ..., resolveOpsRepo: ... }` argument from that
// one call site left the full suite (331/331) green. A silent regression here
// means every completion record archived on the periodic tick (not only at
// teardown) — the entire point of #367 — quietly stops happening, with no
// test noticing.
//
// Same source-pin idiom as test/bun/wake-gate-wiring.test.ts: read do.ts's
// own text and assert the actual call site, rather than only the exported
// pure function's behavior. StudioDO cannot be constructed under
// vitest-pool-workers, so this is the only practical way to pin the wiring
// short of a full Worker integration test.
describe("do.ts StudioDO.shipTranscript() — archive wiring (#367 round 3)", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/studio/do.ts"), "utf8"); // test-lies-check: allow — StudioDO cannot be constructed under vitest-pool-workers (see the comment above), so this file's own documented source pin

  const methodStart = src.indexOf("async shipTranscript(): Promise<void> {");
  const methodEnd = src.indexOf("\n  }\n", methodStart);
  const method = src.slice(methodStart, methodEnd);

  test("shipTranscript() is where we think it is", () => {
    expect(methodStart).toBeGreaterThan(-1);
    expect(method).toContain("runShipTickWithObservation(");
  });

  test("its runShipTickWithObservation( call passes an archive config, not just the leading positional args", () => {
    const callStart = method.indexOf("runShipTickWithObservation(");
    const call = method.slice(callStart, method.indexOf(");", callStart));
    // The 6th (archive) parameter: doneRecords + resolveOpsRepo. Deleting
    // either -- or the whole argument -- must fail this test even though
    // runShipTickWithObservation() itself still type-checks fine (the
    // parameter is optional) and every OTHER test keeps passing.
    expect(call).toContain("doneRecords:");
    expect(call).toContain("resolveOpsRepo:");
    expect(call).toContain("this.doneRecordPorts()");
  });
});
