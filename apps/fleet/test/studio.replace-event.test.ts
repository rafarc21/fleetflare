import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { runShipTickWithObservation } from "../src/studio/do";
import { OBSERVED_KEY, emptyObserved, getObserved, type Observed } from "../src/studio/observed";
import type { ShipDeps } from "../src/studio/transcript";
import type { FleetEvent } from "../src/events/schema";
import { fakeStorage as doStorage } from "./helpers/do-storage";
import { methodBody } from "./helpers/src-pin";

// ---------------------------------------------------------------------------
// Issue #1146 — one board event per replace, emitted by the ship tick at the
// moment it first sees the container's incarnation token go missing or
// foreign. The builder is pinned in studio.new-incarnation-heal.test.ts; this
// file pins the WIRING: runShipTickWithObservation calls its onReplaced hook
// once per replace, and never for a container still answering with our token.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-16T16:39:03.000Z");
const STUDIO_ID = "acme--web-studio";
const OLD_TOKEN = "11111111-2222-3333-4444-555555555555";

function shipStdout(token: string) {
  return {
    code: 0,
    stdout: ["---FLEET-BOOTID---", "", "---FLEET-STAT---", "-1", "---FLEET-INCARNATION---", token].join("\n"),
    stderr: "",
  };
}

function storageWith(observed: Observed) {
  const s = doStorage({ [OBSERVED_KEY]: observed });
  return { ...s, map: s.map as Map<string, unknown> };
}

describe("runShipTickWithObservation — onReplaced (issue #1146)", () => {
  it("a container that comes back with no incarnation token emits exactly one replace event", async () => {
    const storage = storageWith({ ...emptyObserved(), incarnation: OLD_TOKEN });
    const onReplaced = vi.fn(async (_ev: FleetEvent) => {});
    const deps: ShipDeps = { exec: vi.fn(async () => shipStdout("")), r2Put: vi.fn(async () => {}), now: () => T0 };

    await runShipTickWithObservation(
      deps, storage as never, STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, onReplaced,
    );

    expect(onReplaced).toHaveBeenCalledTimes(1);
    const ev = onReplaced.mock.calls[0][0];
    expect(ev.from).toBe(STUDIO_ID);
    expect(ev.kind).toBe("report");
    expect(ev.body).toContain(OLD_TOKEN);
    expect(ev.body).toContain("no incarnation");
    expect((await getObserved(storage as never)).replacedAt).toBe(T0.toISOString());
  });

  it("the replacement stays bare on the next tick: no second event for the same replace", async () => {
    const storage = storageWith({ ...emptyObserved(), incarnation: OLD_TOKEN });
    const onReplaced = vi.fn(async (_ev: FleetEvent) => {});
    const deps: ShipDeps = { exec: vi.fn(async () => shipStdout("")), r2Put: vi.fn(async () => {}), now: () => T0 };

    await runShipTickWithObservation(
      deps, storage as never, STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, onReplaced,
    );
    await runShipTickWithObservation(
      deps, storage as never, STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, onReplaced,
    );

    expect(onReplaced).toHaveBeenCalledTimes(1);
  });

  it("a container still answering with the DO's own token emits nothing", async () => {
    const storage = storageWith({ ...emptyObserved(), incarnation: OLD_TOKEN });
    const onReplaced = vi.fn(async (_ev: FleetEvent) => {});
    const deps: ShipDeps = { exec: vi.fn(async () => shipStdout(OLD_TOKEN)), r2Put: vi.fn(async () => {}), now: () => T0 };

    await runShipTickWithObservation(
      deps, storage as never, STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, onReplaced,
    );

    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("a failing event write never costs the tick its own verdict", async () => {
    const storage = storageWith({ ...emptyObserved(), incarnation: OLD_TOKEN });
    const onReplaced = vi.fn(async () => { throw new Error("D1 unavailable"); });
    const deps: ShipDeps = { exec: vi.fn(async () => shipStdout("")), r2Put: vi.fn(async () => {}), now: () => T0 };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runShipTickWithObservation(
      deps, storage as never, STUDIO_ID, undefined, undefined, undefined, undefined, undefined, undefined, onReplaced,
    )).resolves.toBeDefined();

    expect((await getObserved(storage as never)).replacedAt).toBe(T0.toISOString());
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

const doSrc: string = env.TEST_STUDIO_DO_SRC;

describe("review #1152 — the replace rearm is jittered, not a fixed delay", () => {
  it("shipTranscript rearms syncSession with replaceHealDelaySeconds()", () => {
    const body = methodBody(doSrc, "  async shipTranscript(");
    expect(body).toContain('this.rearm("syncSession", replaceHealDelaySeconds())');
  });
});
