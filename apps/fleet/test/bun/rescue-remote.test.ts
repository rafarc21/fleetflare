// Issue #1 piece 5: where rescue pushes go. `FLEET_RESCUE_REMOTE` (owner/name,
// a PRIVATE repo) resolves to a URL + a scoped token in exec env; unset,
// malformed or a failed mint all fall back to origin, loudly. That origin
// push is leak-gated (blocker 2): a denylist hit refuses it.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolveRescueRemote, resolveRescueTarget, RESCUE_TOKEN_ENV } from "../../src/studio/rescue";
import { MintTokenError } from "../../src/github/app";

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
    // The literal env var name, not RESCUE_TOKEN_ENV's own computed key —
    // rescue.ts's shell credential helper (test/bun/rescue-push.test.ts's
    // "FLEET_RESCUE_TOKEN set/unset" coverage) reads this exact name from
    // the exec env, so a drift here is the real regression.
    expect(t).toEqual({ remoteUrl: "https://github.com/acme/rescue-vault.git", env: { FLEET_RESCUE_TOKEN: "ghs_fake" } });
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

  // Issue #7: the rescue token is a WRITE token handed to the container.
  // Only for a rescue repo confirmed private; no token to mint = origin.
  test("rescue repo not confirmed private: origin, token never minted", async () => {
    let minted = false;
    const mint = async () => { minted = true; return "ghs_fake"; };
    const slug = { FLEET_RESCUE_REMOTE: "acme/rescue-vault" };
    expect(await resolveRescueTarget(slug, mint, PUBLIC, "push", async () => false)).toEqual({});
    expect(await resolveRescueTarget(slug, mint, PUBLIC, "push", async () => { throw new Error("down"); })).toEqual({});
    expect(minted).toBe(false);
    expect(logged()).toMatch(/acme\/rescue-vault is not confirmed private.*origin/);
  });

  test("no token to mint (PAT fleet, no FLEET_RESCUE_GITHUB_TOKEN): origin, loudly", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async () => null, PUBLIC, "push", async () => true);
    expect(t).toEqual({});
    expect(logged()).toMatch(/no write token for acme\/rescue-vault.*FLEET_RESCUE_GITHUB_TOKEN.*origin/);
  });

  test("confirmed-private rescue repo + token: the private target", async () => {
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, async () => "ghs_fake", PUBLIC, "push", async () => true);
    expect(t.remoteUrl).toBe("https://github.com/acme/rescue-vault.git");
  });
});

// PR #236 review round 2, BLOCKER: rescueMintPermissions("push") now always
// asks for `workflows: write`. The App installation backing FLEET_RESCUE_REMOTE
// may never have been granted that permission (an unverified, operator-side
// fact) -- GitHub 422s the WHOLE mint when that happens, turning a rare
// "this push touches .github/workflows/*" failure into a universal one: every
// single rescue push would fall back to the leak-gated origin path. `mint` is
// now called with the permissions it should ask for, as a second argument, so
// resolveRescueTarget itself can retry once, narrower, on a mint rejection
// that is at least plausibly about the requested permissions.
describe("resolveRescueTarget, push-purpose mint retries without workflows on a mint rejection (PR #236 review, round 2)", () => {
  test("mint rejects {contents:write, workflows:write} with a 422 -> retries once with {contents:write} only, logs exactly one line, uses that narrower token for the push", async () => {
    const calls: Array<{ repo: string; permissions: unknown }> = [];
    const mint = async (repo: string, permissions: { contents: "read" | "write"; workflows?: "write" }) => {
      calls.push({ repo, permissions });
      if (permissions?.workflows !== undefined) throw new MintTokenError(422, "Validation Failed");
      return "ghs_narrow";
    };
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, mint, PUBLIC, "push", async () => true);
    expect(calls).toEqual([
      { repo: "acme/rescue-vault", permissions: { contents: "write", workflows: "write" } },
      { repo: "acme/rescue-vault", permissions: { contents: "write" } },
    ]);
    // The resulting token -- minted WITHOUT workflows -- is still used for
    // this push, not silently discarded in favor of falling back to origin.
    expect(t).toEqual({ remoteUrl: "https://github.com/acme/rescue-vault.git", env: { [RESCUE_TOKEN_ENV]: "ghs_narrow" } });
    expect(logged()).toMatch(/workflows.*grant App Workflows: write/);
  });

  test("discovery purpose never retries -- it never asks for workflows in the first place", async () => {
    let calls = 0;
    const mint = async (_repo: string, permissions: { contents: "read" | "write"; workflows?: "write" }) => {
      calls++;
      expect(permissions).toEqual({ contents: "read" });
      return "ghs_fake";
    };
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, mint, PUBLIC, "discovery");
    expect(calls).toBe(1);
    expect(t).toEqual({ remoteUrl: "https://github.com/acme/rescue-vault.git", env: { [RESCUE_TOKEN_ENV]: "ghs_fake" } });
    expect(logged()).toBe("");
  });

  test("the narrower retry ALSO fails -> falls back to origin exactly like any other mint failure (no infinite retry)", async () => {
    let calls = 0;
    const mint = async () => { calls++; throw new MintTokenError(422, "Validation Failed"); };
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, mint, PUBLIC, "push", async () => true);
    expect(calls).toBe(2);
    expect(t).toEqual({});
    expect(logged()).toMatch(/token mint for acme\/rescue-vault failed.*origin.*leak-gated/);
  });

  test("a non-422 mint failure never retries -- only a permissions-shaped rejection does", async () => {
    let calls = 0;
    const mint = async () => { calls++; throw new Error("network down"); };
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, mint, PUBLIC, "push", async () => true);
    expect(calls).toBe(1);
    expect(t).toEqual({});
  });

  test("a 422 that is NOT about workflows (e.g. the renamed-repo case mintRepoToken already retries internally) still only tries once here -- workflows was never requested", async () => {
    let calls = 0;
    const mint = async (_repo: string, permissions: { contents: "read" | "write"; workflows?: "write" }) => {
      calls++;
      expect(permissions.workflows).toBeUndefined();
      throw new MintTokenError(422, "Validation Failed");
    };
    const t = await resolveRescueTarget({ FLEET_RESCUE_REMOTE: "acme/rescue-vault" }, mint, PUBLIC, "discovery");
    expect(calls).toBe(1);
    expect(t).toEqual({});
  });
});

