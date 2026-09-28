import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getFlag, setFlag } from "../src/state";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("fleet_state", () => {
  it("returns null for an unset key", async () => {
    expect(await getFlag(env.DB, "paused")).toBeNull();
  });

  it("sets and overwrites", async () => {
    await setFlag(env.DB, "paused", "1", 1000);
    expect(await getFlag(env.DB, "paused")).toBe("1");
    await setFlag(env.DB, "paused", "0", 2000);
    expect(await getFlag(env.DB, "paused")).toBe("0");
  });
});
