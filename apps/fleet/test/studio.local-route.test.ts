import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { runResume, type ResumeDeps, type SpawnParent } from "../src/studio/spawn";
import { recordStudio, listStudios } from "../src/studio/registry";
import { fakeBlueprintFiles } from "./helpers/blueprint-fixture";
import { decodeRolePrompt } from "./helpers/routes-studio-harness";
import { base64EncodeUtf8 } from "../src/base64";
import { __resetOrgCacheForTests, __resetFleetJsonCacheForTests } from "../src/studio/org";
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
  // org.json/fleet.json are cached process-wide keyed by repo@ref — every
  // test in this file shares REPO_SLUG@v1.0.0, so a later test's own
  // fixture must not be served the stale cache an earlier one populated.
  __resetOrgCacheForTests();
  __resetFleetJsonCacheForTests();
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

function authorizedReq(path: string, method = "POST") {
  return new Request(`https://x${path}`, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
  });
}

// A STUDIO namespace whose EVERY verb throws — the local row's guard must
// return before any container RPC, so "no DO call" is proven by the 409.
function containerThrowingEnv(): Env {
  const throwIt = () => {
    throw new Error("a local row must never reach the container DO");
  };
  return {
    ...env,
    AGENT_REPO: REPO_SLUG,
    STUDIO: {
      idFromName: (n: string) => n as unknown as DurableObjectId,
      get: () => ({
        provision: throwIt, restartStudio: throwIt, recycle: throwIt, checkNow: throwIt,
        wakeStudio: throwIt, destroyStudio: throwIt,
      }),
    },
  } as unknown as Env;
}

describe("POST /studio/local/spawn — shared id allocation with cloud rows (S3)", () => {
  it("a cloud instance-1 row makes a local `instance: \"next\"` spawn take instance 2", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    // CLOUD row: state running, host ABSENT — the lowest-free-n scan must
    // count it, so the local spawn lands on --2, never --1.
    await recordStudio(env, {
      id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: REPO_SLUG,
    });

    const res = await handleStudio(
      localSpawnReq({ role: "pilot", local: true, localPath: "/tmp/websites", instance: "next" }),
      noContainerEnv(), fakeFetchFile(),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).id).toBe("websites--pilot--2");
  });
});

describe("POST /studio/local/spawn — members decoded (S1)", () => {
  const STUDIO_MD = `---
name: web-studio
title: Web Studio
lead: Web Designer
skills: [frontend-design]
secrets: []
mcp: []
allowedTools: Bash(git *) Edit Write
---
You are the Web Designer, lead of Web Studio. Dispatch members; never implement.`;
  const MEMBER_MD = `---
name: backend-developer
description: implements backend steps dispatched by the lead
tools: Read, Edit, Write
---
You are the Backend Developer of Web Studio. Implement exactly the dispatched step.`;
  const MEMBER_LISTING = JSON.stringify([
    { name: "backend-developer.md", path: "fleet/blueprint/studios/web-studio/members/backend-developer.md", type: "file" },
  ]);
  const STUDIO_FAKE = fakeBlueprintFiles({
    repo: REPO_SLUG, ref: "v1.0.0",
    roles: ["web-studio"],
    roleMd: { name: "web-studio", prompt: "unused", allowedTools: "Bash(git *) Edit Write" },
    edges: { operator: ["web-studio"] },
  });
  function studioFetchFile() {
    return async (_repo: string, path: string, _ref: string): Promise<string> => {
      if (path.endsWith("fleet.json")) return STUDIO_FAKE.fleetJson;
      if (path.endsWith("org.json")) return STUDIO_FAKE.orgJson;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return MEMBER_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/backend-developer.md") return MEMBER_MD;
      throw new Error(`fetch ${path} failed (404): not found`);
    };
  }

  it("returns each member body DECODED — plain markdown, never its base64", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const res = await handleStudio(
      localSpawnReq({ role: "web-studio", local: true, localPath: "/tmp/websites" }),
      noContainerEnv(), studioFetchFile(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus & { members?: Record<string, string> };
    expect(body.members?.["backend-developer.md"]).toBe(MEMBER_MD);
    expect(body.members?.["backend-developer.md"]).not.toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("POST /studio/local/spawn — orphan running row (T1a)", () => {
  // Serves fleet.json/org.json (runSpawn's own policy fetch needs them) but
  // throws a NON-404 for the studio probe, so resolveBringupEnv fails AFTER
  // runSpawn already wrote the running row.
  function throwingBringupFetchFile() {
    return async (_repo: string, path: string, _ref: string): Promise<string> => {
      if (path.endsWith("fleet.json")) return FAKE.fleetJson;
      if (path.endsWith("org.json")) return FAKE.orgJson;
      if (path.includes("/studios/")) throw new Error("bring-up exploded (simulated)");
      return FAKE.roleMd;
    };
  }

  it("flips the just-written row to stopped and 500s, never leaving a running orphan", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    const res = await handleStudio(
      localSpawnReq({ role: "release", local: true, localPath: "/tmp/websites" }),
      noContainerEnv(), throwingBringupFetchFile(),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/bring-up|bring up|failed|resolve/i);
    const row = (await listStudios(env)).find((s) => s.id === "websites--release");
    expect(row?.state).toBe("stopped");
    expect(row?.host).toBe("local");
  });
});

describe("container-only verbs refuse a host:\"local\" row (T2)", () => {
  function localRow(id: string): StudioStatus {
    return {
      id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null,
      repoSlug: REPO_SLUG, host: "local", localPath: "/tmp/websites",
    };
  }

  it("provision refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));

    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/provision"), containerThrowingEnv(),
    );

    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("recycle refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));

    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/recycle"), containerThrowingEnv(),
    );

    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("status refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/status", "GET"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("provisioned refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/provisioned", "GET"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("rescue refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/rescue"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("inspect refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/inspect", "GET"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("wake refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/wake"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("ws/terminal refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/ws/terminal", "GET"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("terminal refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/terminal", "GET"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("paste refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/paste"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });

  it("clear-session-guard refuses without a DO call, naming fleet destroy", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, localRow("websites--web-studio"));
    const res = await handleStudio(
      authorizedReq("/studio/websites--web-studio/clear-session-guard"), containerThrowingEnv(),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("container");
    expect(text).toContain("fleet destroy");
  });
});

describe("POST /studio/:id/provision — stopped local row re-materializes (item 7)", () => {
  it("a stopped host:\"local\" row resumes via the local bring-up response, never a DO call", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, {
      id: "websites--release", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null,
      repoSlug: REPO_SLUG, host: "local", localPath: "/tmp/websites",
    });

    const res = await handleStudio(
      authorizedReq("/studio/websites--release/provision"), containerThrowingEnv(), fakeFetchFile(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus & { prompt: string; allowedTools: string; localPath?: string | null };
    expect(body.state).toBe("running");
    expect(body.host).toBe("local");
    expect(body.localPath).toBe("/tmp/websites");
    expect(body.allowedTools).toBe("Bash(git *) Edit");
    expect(body.prompt).toContain("You are release. Merge carefully.");

    const row = (await listStudios(env)).find((s) => s.id === "websites--release");
    expect(row?.state).toBe("running");
    expect(row?.host).toBe("local");
  });

  it("a caller-supplied repo cannot rebind the resume — the bound repo wins", async () => {
    vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
    await recordStudio(env, {
      id: "websites--release", state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null,
      repoSlug: REPO_SLUG, host: "local", localPath: "/tmp/websites",
    });

    const res = await handleStudio(
      new Request("https://x/studio/websites--release/provision", {
        method: "POST",
        body: JSON.stringify({ repo: "other-org/websites" }),
        headers: { "Cf-Access-Jwt-Assertion": "test-jwt" },
      }),
      containerThrowingEnv(), fakeFetchFile(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus & { prompt: string };
    // The prompt still resolves the ROW's bound repo (REPO_SLUG's role md says
    // "You are release. Merge carefully."), not the caller's other-org repo.
    expect(body.prompt).toContain("You are release. Merge carefully.");
  });
});

// Issue #59: `resume: true` on /fleet/spawn starts a STOPPED studio. A local
// row has NO container, so a machine resume must refuse and name the local
// path (fleet provision), never reach the claim or a container DO.
describe("runResume — a local row is container-only (item 7)", () => {
  const MAESTRO: SpawnParent = { id: "websites--maestro", repo: "websites", role: "maestro", repoSlug: REPO_SLUG };

  function localResumeDeps(rows: StudioStatus[]): { deps: ResumeDeps; provisioned: number; claimed: number } {
    let provisionCount = 0;
    let claimCount = 0;
    const deps: ResumeDeps = {
      listStudios: async () => rows,
      fetchPolicy: async () => ({
        org: { edges: { maestro: ["release"] }, gates: {} },
        roles: ["maestro", "release", "pilot", "scratch", "cto"],
      }),
      provisionChild: async () => {
        provisionCount += 1;
        return rows[0]!;
      },
      resolveBrief: async () => ({ ok: false, status: 500, message: "unused" }),
      notifyMaestro: async () => {},
      assignModel: async () => {},
      maxStudios: 100,
      claimStudioId: async () => null,
      claimStopped: async () => {
        claimCount += 1;
        return async () => {};
      },
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    };
    return { deps, get provisioned() { return provisionCount; }, get claimed() { return claimCount; } };
  }

  const localStoppedRow = (id = "websites--release"): StudioStatus => ({
    id, state: "stopped", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null,
    repoSlug: REPO_SLUG, host: "local", localPath: "/tmp/websites",
    parked: true, stoppedAt: "2026-09-01T00:00:00.000Z",
  });

  it("a local stopped row 409s the resume and never claims or provisions", async () => {
    const h = localResumeDeps([localStoppedRow()]);
    const res = await runResume(h.deps, MAESTRO, { role: "release" });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("local studio");
    expect(text).toContain("fleet provision");
    expect(h.provisioned).toBe(0);
    expect(h.claimed).toBe(0);
  });

  it("a non-local stopped row still resumes", async () => {
    const nonLocal = { ...localStoppedRow(), host: undefined };
    const h = localResumeDeps([nonLocal]);
    const res = await runResume(h.deps, MAESTRO, { role: "release" });
    expect(res.status).toBe(200);
    expect(h.provisioned).toBe(1);
    expect(h.claimed).toBe(1);
  });
});