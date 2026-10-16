// #1148 (refs #1135): the watchdog's cron glue with the gate runner off. The
// FLEET_GATE_RUNNER switch is the operator's off switch for the gate, so the
// sweep must not read or write a run while it is off (#1148 review, LOW 5).
import { describe, it, expect } from "vitest";
import type { Env } from "../src/env";
import { redLegIn, sweepGateRunsFromEnv } from "../src/gate/watchdog-env";

/** An R2 archive fake: keys are stored with their state, and list() honours the prefix. */
function fakeArchive(states: Record<string, string>) {
  return {
    async list({ prefix }: { prefix: string }) {
      return { objects: Object.keys(states).filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async get(key: string) {
      const state = states[key];
      return state === undefined ? null : { json: async <T>() => ({ state }) as T };
    },
  };
}

const PREFIX = "gate/acme/example/runs/7/gate-x/";

describe("redLegIn: a leg is red only when its last attempt is red (#1150 review item 1)", () => {
  it("a leg red on its first try and green on its retry is not a red leg (no false red)", async () => {
    const archive = fakeArchive({ [`${PREFIX}shard-lint.json`]: "failure", [`${PREFIX}shard-lint.retry.json`]: "success" });
    expect(await redLegIn(archive, PREFIX)).toBe(false);
  });

  it("a leg red on its first try and red on its retry is a red leg", async () => {
    const archive = fakeArchive({ [`${PREFIX}shard-lint.json`]: "failure", [`${PREFIX}shard-lint.retry.json`]: "failure" });
    expect(await redLegIn(archive, PREFIX)).toBe(true);
  });

  it("a red first try whose retry was lost stays a red leg (#1119)", async () => {
    const archive = fakeArchive({ [`${PREFIX}shard-lint.json`]: "failure" });
    expect(await redLegIn(archive, PREFIX)).toBe(true);
  });

  it("another run's red leg under a different prefix is not read", async () => {
    const archive = fakeArchive({ "gate/acme/example/runs/7/gate-y/shard-lint.json": "failure" });
    expect(await redLegIn(archive, PREFIX)).toBe(false);
  });
});

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
