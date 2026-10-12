// Board #605, sweep 24 finding S24-F6 — seven names in inspect.ts had zero
// importers anywhere: internals with no callers stay un-exported, and the
// key-set pin below catches both leftovers and any future stray export.
import { describe, expect, test } from "bun:test";
import * as inspect from "../../src/studio/inspect";

// Type-only names (InspectSnapshot, InspectExec, InspectDeps, InspectOutcome)
// never appear on the JS module object; their un-export is enforced by
// `tsc --noEmit -p .` (a stray type import elsewhere is a compile error), so
// the assertions below cover the runtime consts and functions only.
describe("inspect module surface (board #605)", () => {
  test("the seven unused names are gone from the module object", () => {
    const m = inspect as unknown as Record<string, unknown>;
    expect(m["INSPECT_TARGET"]).toBeUndefined();
    expect(m["INCARNATION_SECTION"]).toBeUndefined();
    expect(m["BRINGUP_LOG_SECTION"]).toBeUndefined();
    expect(m["INSPECT_BRINGUP_LOG_LINES"]).toBeUndefined();
    expect(m["InspectSnapshot"]).toBeUndefined();
    expect(m["InspectExec"]).toBeUndefined();
    expect(m["InspectDeps"]).toBeUndefined();
  });

  test("every kept export is present with the shape callers rely on", () => {
    expect(inspect.CHECKOUT_PRESENT).toBe("FLEET_INSPECT_CHECKOUT_PRESENT");
    expect(inspect.CHECKOUT_MISSING).toBe("FLEET_INSPECT_CHECKOUT_MISSING");
    expect(inspect.TAIL_BEGIN).toBe("FLEET_INSPECT_TAIL_BEGIN");
    expect(typeof inspect.INSPECT_DEFAULT_TAIL_LINES).toBe("number");
    expect(typeof inspect.INSPECT_EXEC_MS).toBe("number");
    expect(typeof inspect.inspectCmd).toBe("function");
    expect(typeof inspect.parseInspectOutput).toBe("function");
    expect(typeof inspect.runInspect).toBe("function");
  });

  test("own keys equal exactly the kept set — nothing more, nothing less", () => {
    const kept = [
      "CHECKOUT_MISSING",
      "CHECKOUT_PRESENT",
      "INSPECT_DEFAULT_TAIL_LINES",
      "INSPECT_EXEC_MS",
      "TAIL_BEGIN",
      "inspectCmd",
      "parseInspectOutput",
      "runInspect",
    ];
    expect(Object.keys(inspect).sort()).toEqual(kept.sort());
  });
});
