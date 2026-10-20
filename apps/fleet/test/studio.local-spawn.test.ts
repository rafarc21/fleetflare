import { describe, it, expect } from "vitest";
import { readLocalRequest, liveStudioCount } from "../src/studio/spawn";
import { localRowStatus } from "../src/studio/local-spawn";
import type { StudioStatus } from "../src/studio/types";

// Local studio = studio, backend half. Pure unit tests for the three pieces
// the local path adds: readLocalRequest (the wire shape), liveStudioCount
// (local rows never count toward the cap — they are not containers), and
// localRowStatus (the running local row). No D1, no env — same posture as
// test/studio.destroy.test.ts, which imports only the pure functions it asserts.

function row(id: string, overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

describe("readLocalRequest", () => {
  it("absent/null -> undefined (cloud, byte-compat)", () => {
    expect(readLocalRequest({})).toBeUndefined();
    expect(readLocalRequest({ role: "pilot" })).toBeUndefined();
    expect(readLocalRequest({ local: null })).toBeUndefined();
    expect(readLocalRequest({ local: undefined })).toBeUndefined();
    expect(readLocalRequest(null)).toBeUndefined();
    expect(readLocalRequest(undefined)).toBeUndefined();
  });

  it("valid -> the local shape", () => {
    expect(readLocalRequest({ local: true, localPath: "/tmp/websites" }))
      .toEqual({ local: true, localPath: "/tmp/websites" });
  });

  it("malformed -> null (local truthy but localPath not a non-empty string)", () => {
    for (const bad of [
      { local: true },
      { local: true, localPath: "" },
      { local: true, localPath: 42 },
      { local: true, localPath: null },
      { local: true, localPath: {} },
    ]) {
      expect(readLocalRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("liveStudioCount", () => {
  it("excludes a running local row — local studios are not containers", () => {
    const cloud = row("websites--pilot");
    const local = row("websites--local", { host: "local", localPath: "/tmp/x" });
    expect(liveStudioCount([cloud, local])).toBe(1);
  });

  it("a stopped local row is also excluded (it was never live)", () => {
    const local = row("websites--local", { host: "local", state: "stopped" });
    expect(liveStudioCount([local])).toBe(0);
  });
});

describe("localRowStatus", () => {
  it("builds a running local row", () => {
    expect(localRowStatus("websites--pilot", {
      repo: "websites", role: "pilot", spawnedBy: "operator",
      repoSlug: "acme-org/websites", host: "local", localPath: "/tmp/websites",
    })).toEqual({
      id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null,
      error: null, lastRefreshError: null, burn: null, spawnedBy: "operator",
      repoSlug: "acme-org/websites", spawnTokenHash: null, host: "local", localPath: "/tmp/websites",
    });
  });

  it("seeds leadType from the config, absent when the config carries none", () => {
    expect(localRowStatus("websites--pilot", { repo: "websites", role: "pilot", leadType: "glm" }).leadType)
      .toBe("glm");
    expect(localRowStatus("websites--pilot", { repo: "websites", role: "pilot" }).leadType).toBeUndefined();
  });
});