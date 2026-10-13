// Operator routes for #717's model pool (spec 2026-10-13-model-pool-design,
// Task 5): list/assign/promote/demote. Auth lives at the mount point
// (handleStudio's verifyAccess, src/studio/routes.ts) — handleModelsRoute
// itself is the unauthenticated inner handler, called directly here, same
// convention as the mount-point comment for /studio/accounts* routes.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { handleModelsRoute } from "../src/llm/models-route";
import { POOL } from "../src/llm/models";

const post = (path: string, body: unknown) =>
  new Request(`https://x${path}`, { method: "POST", body: JSON.stringify(body) });

describe("models route", () => {
  it("assign by key then list shows it", async () => {
    expect(
      (await handleModelsRoute(post("/studio/models/assign", { studio: "r--web-studio--49", model: "kimi" }), env)).status,
    ).toBe(200);
    const list = (await (await handleModelsRoute(new Request("https://x/studio/models"), env)).json()) as any;
    expect(list.assignments["r--web-studio--49"]).toBe(POOL[1].id);
  });

  it("assign unknown model is 400", async () => {
    expect((await handleModelsRoute(post("/studio/models/assign", { studio: "r--a", model: "gpt4" }), env)).status).toBe(400);
  });

  it("demote then promote", async () => {
    await handleModelsRoute(post("/studio/models/demote", { model: "deepseek" }), env);
    let list = (await (await handleModelsRoute(new Request("https://x/studio/models"), env)).json()) as any;
    expect(list.models.find((m: any) => m.key === "deepseek").state).toBe("demoted");
    await handleModelsRoute(post("/studio/models/promote", { model: "deepseek" }), env);
    list = (await (await handleModelsRoute(new Request("https://x/studio/models"), env)).json()) as any;
    expect(list.models.find((m: any) => m.key === "deepseek").state).toBe("active");
  });
});
