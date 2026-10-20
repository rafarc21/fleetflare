import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { recordStudio, listStudios } from "../src/studio/registry";
import { fakeBlueprintFiles } from "./helpers/blueprint-fixture";
import { decodeRolePrompt } from "./helpers/routes-studio-harness";
import { base64EncodeUtf8 } from "../src/base64";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// POST /studio/local/spawn — the operator's local spawn. Same Access-gated
// lane as /studio/spawn, same runSpawn core, but provisionChild writes a D1
// row (host:"local") instead of dispatching to a container DO, and the
// response carries the decoded bring-up env (prompt/allowedTools/effort)
// for the CLI to launch claude with. The fake STUDIO namespace throws if any
// DO method is reached, so "no container" is proven by the 200, not a spy.

const REPO_SLUG = "acme-org/websites";

const FAKE = fakeBlueprintFiles({
  repo: REPO_SLUG, ref: "v1.0.0",
  roles: ["pilot", "release", "scratch", "cto"],
  roleMd: {
    name: "release", prompt: "You are release. Merge carefully.",
    allowedTools: "Bash(git *) Edit", reportsTo: "cto",
  },
  edges: { pilot: ["release"], operator: ["cto", "pilot", "scratch", "release"] },
});

function fakeFetchFile() {
  return async (_repo: string, path: string, _ref: string): Promise<string> => {
    if (path.endsWith("fleet.json")) return FAKE.fleetJson;
    if (path.endsWith("org.json")) return FAKE.orgJson;
    if (path.includes("/studios/")) throw new Error(`fetch ${path} failed (404): not found`);
    return FAKE.roleMd;
  };
}

function localSpawnReq(body: unknown, method = "POST") {
  return new Request("https://x/studio/local/spawn", {
    method,
    body: method === "POST" ? JSON.stringify(body) : undefined,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
  });
}

function noContainerEnv(): Env {
  const throwingStub = () => {
    throw new Error("local spawn must never reach the container DO");
  };
  return {
    ...env,
    AGENT_REPO: REPO_SLUG,
    STUDIO: {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => ({ provision: throwingStub, wakeStudio: throwingStub, destroyStudio: throwingStub }),
    },
  } as unknown as Env;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /studio/local/spawn", () => {
  it("401 without an Access header (real verifyAccess, not mocked)", async () => {
    const res = await handleStudio(
      new Request("https://x/studio/local/spawn", {
        method: "POST", body: JSON.stringify({ role: "release", local: true, localPath: "/tmp/x" }),
      }),
      noContainerEnv(), fakeFetchFile(),
    );
    expect(res.status).toBe(401);
  });

  it("405 on a non-POST method", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const res = await handleStudio(
      localSpawnReq(null, "GET"), noContainerEnv(), fakeFetchFile(),
    );
    expect(res.status).toBe(405);
  });

  it("400 when local is truthy but localPath is not a non-empty string", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const res = await handleStudio(
      localSpawnReq({ role: "release", local: true }), noContainerEnv(), fakeFetchFile(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("localPath");
  });

  it("200 happy path: D1 row host:\"local\" with localPath, and the decoded bring-up env on the response", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const res = await handleStudio(
      localSpawnReq({ role: "release", local: true, localPath: "/tmp/websites" }),
      noContainerEnv(), fakeFetchFile(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus & {
      prompt: string; allowedTools: string; effort: string;
    };
    expect(body.id).toBe("websites--release");
    expect(body.state).toBe("running");
    expect(body.host).toBe("local");
    expect(body.localPath).toBe("/tmp/websites");
    expect(body.spawnedBy).toBe("operator");

    // The decoded bring-up env: the CLI launches claude with exactly this.
    expect(body.allowedTools).toBe("Bash(git *) Edit");
    expect(body.effort).toBe("");
    expect(body.prompt).toContain("You are release. Merge carefully.");

    // The row landed in D1, as a local row — no DO, no container.
    const row = (await listStudios(env)).find((s) => s.id === "websites--release");
    expect(row?.state).toBe("running");
    expect(row?.host).toBe("local");
    expect(row?.localPath).toBe("/tmp/websites");
  });

  it("resolveWorkRepo still verifies the repo: a repo outside the installation is refused before any write", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    // No reach seam passed: the default reachRepo mints against env, which
    // this fake env has no App for — resolveWorkRepo throws -> 503 for a
    // caller-supplied repo. What matters is the spawn never proceeds.
    const res = await handleStudio(
      localSpawnReq({ role: "release", local: true, localPath: "/tmp/x", repo: "attacker/payload" }),
      noContainerEnv(), fakeFetchFile(),
    );
    expect(res.status).not.toBe(200);
    expect((await listStudios(env)).some((s) => s.id === "websites--release")).toBe(false);
  });

  it("no local field is refused with a static body before any DO write", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const res = await handleStudio(
      localSpawnReq({ role: "release", localPath: "/tmp/x" }), noContainerEnv(), fakeFetchFile(),
    );
    expect(res.status).toBe(400);
    expect((await listStudios(env)).some((s) => s.id === "websites--release")).toBe(false);
  });

  it("a second local spawn of the same role 409s (id already claimed in D1)", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, {
      id: "websites--release", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null,
      repoSlug: REPO_SLUG, host: "local", localPath: "/tmp/websites",
    });

    const res = await handleStudio(
      localSpawnReq({ role: "release", local: true, localPath: "/tmp/websites" }),
      noContainerEnv(), fakeFetchFile(),
    );
    expect(res.status).toBe(409);
  });
});

// Sanity: the fake fixture's release role prompt round-trips through the
// decoder the production response uses — guards the fixture, not the route.
describe("fixture decoder", () => {
  it("decodeRolePrompt inverts the base64 the bring-up env carries", () => {
    const b64 = base64EncodeUtf8("You are release. Merge carefully.");
    expect(decodeRolePrompt(b64)).toBe("You are release. Merge carefully.");
  });
});