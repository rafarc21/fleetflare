import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getDeployTarget } from "../src/deploy/targets";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM deploy_targets").run();
  await env.DB.prepare(
    `INSERT INTO deploy_targets (id, project, repo, ref, workdir, command, secrets, env)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    "websites:beta:staging", "websites", "acme-org/websites", "staging",
    "sites/beta", "bun install && bun run build", '["CLOUDFLARE_DEPLOY_TOKEN"]', "staging",
  ).run();
});

describe("deploy targets", () => {
  it("reads a target and parses its secret list", async () => {
    const t = await getDeployTarget(env.DB, "websites:beta:staging");
    expect(t?.workdir).toBe("sites/beta");
    expect(t?.secrets).toEqual(["CLOUDFLARE_DEPLOY_TOKEN"]);
  });

  it("returns null for an unknown id rather than a default", async () => {
    expect(await getDeployTarget(env.DB, "websites:beta:production")).toBeNull();
  });
});
