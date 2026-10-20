import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { recordStudio, listStudios } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// Local destroy: POST /studio/:id/destroy on a `host:"local"` row must flip
// the D1 row to stopped and return it — never dispatch to the container DO.
// The fake STUDIO namespace here throws if `destroyStudio` is ever reached,
// so "did not call the container" is proven by the 200, not asserted by a spy.

const LOCAL_ID = "websites--web-studio";

function localRow(id: string = LOCAL_ID): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: "operator", spawnTokenHash: null,
    repoSlug: "acme-org/websites", host: "local", localPath: "/tmp/websites",
  };
}

function throwingStudio(): Env["STUDIO"] {
  return {
    idFromName: (n: string) => n as unknown as DurableObjectId,
    get: () => ({
      destroyStudio: () => {
        throw new Error("local destroy must never reach the container DO");
      },
    }),
  } as unknown as Env["STUDIO"];
}

function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /studio/:id/destroy — local row", () => {
  it("flips the D1 row to stopped, returns it, and never calls the container", async () => {
    await recordStudio(env, localRow());
    const testEnv = { ...env, STUDIO: throwingStudio(), AGENT_REPO: "acme-org/websites" } as unknown as Env;

    const res = await handleStudio(
      authorizedReq(`/studio/${LOCAL_ID}/destroy`, { method: "POST" }), testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe(LOCAL_ID);
    expect(body.state).toBe("stopped");
    // The local identity survives the stop — destroy-by-path, never a container teardown.
    expect(body.host).toBe("local");
    expect(body.localPath).toBe("/tmp/websites");

    const row = (await listStudios(env)).find((s) => s.id === LOCAL_ID);
    expect(row?.state).toBe("stopped");
    expect(row?.host).toBe("local");
  });

  it("?park=true still parks: parked recorded on the flipped row", async () => {
    await recordStudio(env, localRow());
    const testEnv = { ...env, STUDIO: throwingStudio(), AGENT_REPO: "acme-org/websites" } as unknown as Env;

    const res = await handleStudio(
      authorizedReq(`/studio/${LOCAL_ID}/destroy?park=true`, { method: "POST" }), testEnv,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).parked).toBe(true);
    expect(((await listStudios(env)).find((s) => s.id === LOCAL_ID))?.parked).toBe(true);
  });

  it("a cloud row still dispatches to the container destroy port (the local branch never shadows it)", async () => {
    const destroyStudio = vi.fn(async () => ({
      ok: true as const,
      status: { id: "websites--pilot", state: "stopped" } as StudioStatus,
    }));
    const testEnv = {
      ...env,
      AGENT_REPO: "acme-org/websites",
      STUDIO: { idFromName: (n: string) => n, get: () => ({ destroyStudio }) },
    } as unknown as Env;
    await recordStudio(env, {
      id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });

    const res = await handleStudio(
      authorizedReq("/studio/websites--pilot/destroy", { method: "POST" }), testEnv,
    );

    expect(res.status).toBe(200);
    expect(destroyStudio).toHaveBeenCalledTimes(1);
  });
});