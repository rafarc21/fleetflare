// #1148 (refs #1135): the watchdog's cron glue with the gate runner off. The
// FLEET_GATE_RUNNER switch is the operator's off switch for the gate, so the
// sweep must not read or write a run while it is off (#1148 review, LOW 5).
import { describe, it, expect } from "vitest";
import type { Env } from "../src/env";
import { sweepGateRunsFromEnv } from "../src/gate/watchdog-env";

describe("sweepGateRunsFromEnv: the gate runner's off switch stops the sweep before any read (#1148 review, LOW 5)", () => {
  it("FLEET_GATE_RUNNER off: the sweep returns nothing and never touches the index or the engine", async () => {
    const untouched = () => { throw new Error("touched while the gate runner is off"); };
    const env = {
      FLEET_GATE_RUNNER: "off",
      GATE_RUNNER_REPOS: "acme/example",
      DB: { prepare: untouched },
      GATE_WORKFLOW: { create: untouched, get: untouched },
    } as unknown as Env;
    expect(await sweepGateRunsFromEnv(env)).toEqual([]);
  });
});
