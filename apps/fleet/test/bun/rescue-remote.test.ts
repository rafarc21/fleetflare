// Issue #1 piece 5: where rescue pushes go. `FLEET_RESCUE_REMOTE` (owner/name,
// a PRIVATE repo) resolves to a URL + a scoped token in exec env; unset,
// malformed or a failed mint all fall back to origin, loudly — rescue never
// loses data over configuration.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolveRescueRemote, resolveRescueTarget, RESCUE_TOKEN_ENV } from "../../src/studio/rescue";

let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => { errSpy = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); });

function logged(): string {
  return errSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

describe("resolveRescueRemote", () => {
  test("owner/name → the slug, trimmed", () => {
    expect(resolveRescueRemote({ FLEET_RESCUE_REMOTE: " acme/rescue-vault \n" })).toBe("acme/rescue-vault");
  });
  test("unset or blank → null", () => {
    expect(resolveRescueRemote({})).toBeNull();
    expect(resolveRescueRemote({ FLEET_RESCUE_REMOTE: "  " })).toBeNull();
  });
  test("malformed → null, logged", () => {
    expect(resolveRescueRemote({ FLEET_RESCUE_REMOTE: "https://github.com/acme/x" })).toBeNull();
    expect(logged()).toContain("FLEET_RESCUE_REMOTE");
  });
});

describe("resolveRescueTarget", () => {
  test("set: https URL for the slug, token minted FOR that repo, passed as exec env only", async () => {
    const minted: string[] = [];
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async (repo) => {
      minted.push(repo);
      return "ghs_fake";
    });
    expect(minted).toEqual(["acme/rescue-vault"]);
    expect(t).toEqual({ remoteUrl: "https://github.com/acme/rescue-vault.git", env: { [RESCUE_TOKEN_ENV]: "ghs_fake" } });
    expect(RESCUE_TOKEN_ENV).toBe("FLEET_RESCUE_TOKEN");
  });

  test("unset: origin (empty target), and says loudly that origin may be public", async () => {
    let called = false;
    const t = await resolveRescueTarget({}, async () => { called = true; return "x"; });
    expect(t).toEqual({});
    expect(called).toBe(false);
    expect(logged()).toMatch(/FLEET_RESCUE_REMOTE is unset.*origin.*public/);
  });

  test("mint fails: falls back to origin (never lose data), loudly", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async () => {
      throw new Error("422 nope");
    });
    expect(t).toEqual({});
    expect(logged()).toMatch(/acme\/rescue-vault.*422 nope.*origin/);
  });
});
