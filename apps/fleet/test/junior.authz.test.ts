// apps/fleet/test/junior.authz.test.ts
//
// PR #9 review, blocker B1: the maestro's per-task junior authorization must
// live somewhere a studio's own GitHub token can never write — see
// src/junior/authz.ts's own header for the full argument. This file proves
// the D1-backed record directly, isolated from the board/route wiring that
// test/junior.route.test.ts exercises end to end.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { recordJuniorAuthorization, isJuniorAuthorized, revokeJuniorAuthorization } from "../src/junior/authz";

const REPO = "acme-org/websites";
const STUDIO = "websites--web-studio";
const OTHER = "websites--release-studio";

describe("junior authz (D1-backed, not a GitHub label)", () => {
  it("unauthorized when no record exists", async () => {
    expect(await isJuniorAuthorized(env.DB, REPO, 1, STUDIO)).toBe(false);
  });

  it("authorized once recorded for the exact repo/task/studio", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, REPO, 42, STUDIO)).toBe(true);
  });

  it("does not authorize a different studio for the same task", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, REPO, 42, OTHER)).toBe(false);
  });

  it("does not authorize the same studio for a different task number", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, REPO, 43, STUDIO)).toBe(false);
  });

  it("does not authorize the same task number in a different repo", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    expect(await isJuniorAuthorized(env.DB, "acme-org/other", 42, STUDIO)).toBe(false);
  });

  it("#10: revoked records stop authorizing; other tasks keep theirs", async () => {
    await recordJuniorAuthorization(env.DB, REPO, 42, STUDIO, 1000);
    await recordJuniorAuthorization(env.DB, REPO, 43, STUDIO, 1000);
    await revokeJuniorAuthorization(env.DB, REPO, 42);
    expect(await isJuniorAuthorized(env.DB, REPO, 42, STUDIO)).toBe(false);
    expect(await isJuniorAuthorized(env.DB, REPO, 43, STUDIO)).toBe(true);
  });

  it("survives a hand-written record that is not valid JSON — fails closed, never throws", async () => {
    await env.DB.prepare(
      `INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`,
    ).bind(`junior-auth:${REPO}:99`, "{not json", 1000).run();
    expect(await isJuniorAuthorized(env.DB, REPO, 99, STUDIO)).toBe(false);
  });
});
