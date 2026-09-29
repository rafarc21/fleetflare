// Issue #1 piece 5: where rescue pushes go. `FLEET_RESCUE_REMOTE` (owner/name,
// a PRIVATE repo) resolves to a URL + a scoped token in exec env; unset,
// malformed or a failed mint all fall back to origin, loudly. That origin
// push is leak-gated (blocker 2): a denylist hit refuses it.
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

const PUBLIC = async () => false;

describe("resolveRescueTarget", () => {
  test("set, public work repo: https URL for the slug, token minted FOR that repo, passed as exec env only", async () => {
    const minted: string[] = [];
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async (repo) => {
      minted.push(repo);
      return "ghs_fake";
    }, PUBLIC);
    expect(minted).toEqual(["acme/rescue-vault"]);
    expect(t).toEqual({ remoteUrl: "https://github.com/acme/rescue-vault.git", env: { [RESCUE_TOKEN_ENV]: "ghs_fake" } });
    expect(RESCUE_TOKEN_ENV).toBe("FLEET_RESCUE_TOKEN");
  });

  test("unset: origin (empty target), and says loudly the origin rescue is leak-gated", async () => {
    let called = false;
    const t = await resolveRescueTarget({}, async () => { called = true; return "x"; }, PUBLIC);
    expect(t).toEqual({});
    expect(called).toBe(false);
    expect(logged()).toMatch(/FLEET_RESCUE_REMOTE is unset.*origin.*leak-gated.*denylist hit or missing denylist refuses.*set FLEET_RESCUE_REMOTE/);
  });

  test("mint fails: falls back to leak-gated origin, loudly", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async () => {
      throw new Error("422 nope");
    }, PUBLIC);
    expect(t).toEqual({});
    expect(logged()).toMatch(/acme\/rescue-vault.*422 nope.*origin.*leak-gated.*denylist hit or missing denylist refuses.*set FLEET_RESCUE_REMOTE/);
  });

  // Issue #24: the archive exists for PUBLIC origins only. A private work
  // repo (any org) keeps its rescue on its own origin, never the archive.
  test("set, PRIVATE work repo: origin, no mint for the archive, logged", async () => {
    let minted = false;
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" },
      async () => { minted = true; return "x"; }, async () => true);
    expect(t).toEqual({});
    expect(minted).toBe(false);
    expect(logged()).toMatch(/work repo is private.*origin/);
  });

  test("set, visibility check throws: origin through the leak-gated wrapper, no mint, logged", async () => {
    let minted = false;
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" },
      async () => { minted = true; return "x"; }, async () => { throw new Error("503 visibility"); });
    expect(t).toEqual({});
    expect(minted).toBe(false);
    expect(logged()).toMatch(/503 visibility.*origin.*leak-gated/);
  });
});

// PR #42 review: provision's discovery resolves the same target every
// provision. The expected cases (unset, private work repo) are silent there;
// the push-path wording ("rescue pushes go to origin") would be false noise.
// Real failures (visibility, mint) still log, worded for discovery.
describe("resolveRescueTarget, purpose discovery", () => {
  test("unset: origin, nothing logged", async () => {
    expect(await resolveRescueTarget({}, async () => "x", PUBLIC, "discovery")).toEqual({});
    expect(logged()).toBe("");
  });

  test("private work repo: origin, no mint, nothing logged", async () => {
    let minted = false;
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" },
      async () => { minted = true; return "x"; }, async () => true, "discovery");
    expect(t).toEqual({});
    expect(minted).toBe(false);
    expect(logged()).toBe("");
  });

  test("visibility check throws: origin, logged as discovery, never as a rescue push", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" },
      async () => "x", async () => { throw new Error("503 visibility"); }, "discovery");
    expect(t).toEqual({});
    expect(logged()).toMatch(/rescue discovery: .*503 visibility.*origin only/);
    expect(logged()).not.toContain("rescue pushes");
  });

  test("mint fails: origin, logged as discovery, never as a rescue push", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" },
      async () => { throw new Error("422 nope"); }, PUBLIC, "discovery");
    expect(t).toEqual({});
    expect(logged()).toMatch(/rescue discovery: .*422 nope.*origin only/);
    expect(logged()).not.toContain("rescue pushes");
  });

  test("public work repo: same target as the push path", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async () => "ghs_fake", PUBLIC, "discovery");
    expect(t).toEqual({ remoteUrl: "https://github.com/acme/rescue-vault.git", env: { [RESCUE_TOKEN_ENV]: "ghs_fake" } });
  });
});
