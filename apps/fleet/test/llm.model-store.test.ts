// apps/fleet/test/llm.model-store.test.ts
// Persistence layer for #717's model pool (spec 2026-10-13-model-pool-design),
// built on the existing fleet_state flag table — no migration. Same
// cloudflare:test convention as test/llm.anthropic-core.test.ts and
// test/llm.anthropic-stream.test.ts (split from the former llm.anthropic-route.test.ts, #919).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getAssignedModel, setAssignedModel, getModelStates, setModelState } from "../src/llm/model-store";
import { POOL } from "../src/llm/models";

describe("model store", () => {
  it("assignment round-trips for a pool model", async () => {
    await setAssignedModel(env.DB, "r--web-studio--49", POOL[1].id);
    expect(await getAssignedModel(env.DB, "r--web-studio--49")).toBe(POOL[1].id);
  });

  it("absent assignment reads null", async () => {
    expect(await getAssignedModel(env.DB, "r--web-studio--99")).toBeNull();
  });

  it("unknown stored id reads null (never trusted)", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`,
    ).bind("lead-model:r--x", "@cf/typo/x", Date.now()).run();
    expect(await getAssignedModel(env.DB, "r--x")).toBeNull();
  });

  it("set refuses unknown model", async () => {
    await expect(setAssignedModel(env.DB, "r--y", "@cf/typo/x")).rejects.toThrow(/unknown model/);
  });

  it("states default to active; set persists", async () => {
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("active");
    await setModelState(env.DB, POOL[2].id, "demoted");
    expect((await getModelStates(env.DB))[POOL[2].id]).toBe("demoted");
  });
});
