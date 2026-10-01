import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { resolveMemoryRepo, MEMORY_CLONE_DIR, MEMORY_TOKEN_ENV, memoryCloneCmd } from "../src/memory/store";
import { githubMemoryDeps } from "../src/memory/routes";
import type { Env } from "../src/env";

// Issue #341 (public-release prereq for #335): harvested learnings no longer
// land in the fleet repo. ONE setting, FLEET_OPS_REPO (owner/name), names the
// store every memory writer and reader uses; unset = memory off. The store
// keeps the fleet/memory/ layout (the migration preserves the prefix).

describe("resolveMemoryRepo", () => {
  it("unset or empty: memory is off", () => {
    expect(resolveMemoryRepo({})).toBeNull();
    expect(resolveMemoryRepo({ FLEET_OPS_REPO: "" })).toBeNull();
    expect(resolveMemoryRepo({ FLEET_OPS_REPO: "   " })).toBeNull();
  });

  it("owner/name: that repo", () => {
    expect(resolveMemoryRepo({ FLEET_OPS_REPO: "rafarc21/fleet-memory" })).toBe("rafarc21/fleet-memory");
    expect(resolveMemoryRepo({ FLEET_OPS_REPO: " rafarc21/fleet-memory " })).toBe("rafarc21/fleet-memory");
  });

  it("anything else is off, and logged — never a guess at a repo", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of ["fleet-memory", "a/b/c", "a b/c", "https://github.com/a/b", "a/b;rm"]) {
        expect(resolveMemoryRepo({ FLEET_OPS_REPO: bad })).toBeNull();
      }
      expect(errors).toHaveBeenCalledTimes(5);
      expect(errors.mock.calls[0]!.join(" ")).toContain("FLEET_OPS_REPO");
    } finally {
      errors.mockRestore();
    }
  });

  // MEMORY_REF's real behavior coverage: provision.ts's resolveMemoryIndex is
  // its only real consumer — test/studio.provision.test.ts's "the index is
  // fetched at the store's default branch (HEAD)" test hardcodes this exact
  // literal against the real fetchBlueprintFile call.
});

describe("memoryCloneCmd", () => {
  const cmd = memoryCloneCmd("rafarc21/fleet-memory");

  it("clones the store into MEMORY_CLONE_DIR, swapped in whole", () => {
    expect(cmd).toContain("https://github.com/rafarc21/fleet-memory.git");
    expect(cmd).toContain(MEMORY_CLONE_DIR);
  });

  // MEMORY_CLONE_DIR's real behavior coverage: the HARDCODED literal, not
  // the import, so a drift between the constant and memoryCloneCmd's own
  // default `dir` is caught — not just a re-assertion of the constant.
  it("with no dir override, the default clone target is the literal /opt/memory", () => {
    expect(memoryCloneCmd("rafarc21/fleet-memory")).toContain("d='/opt/memory'");
  });

  it("the token rides the exec env by NAME, never the command text", () => {
    expect(cmd).toContain(`\${${MEMORY_TOKEN_ENV}}`);
    // #346: through a credential helper, never an http header in argv.
    expect(cmd).toContain("credential.helper=!f()");
    expect(cmd).not.toContain("extraheader");
    expect(cmd).not.toMatch(/gh[sop]_|x-access-token:[A-Za-z0-9]/);
  });

  it("never fails provisioning: a failed clone is a stderr line and exit 0", () => {
    expect(cmd).toContain("memory clone skipped");
    expect(cmd).not.toMatch(/(^|[;&|(\s])exit\b/);
  });
});

// Moved from test/config.fleet-repo.test.ts (deleted by #329: that file pinned
// the real DEPLOYED wrangler.jsonc via `env` from "cloudflare:test", and the
// real config no longer lives in this repo at all — see wrangler.test.jsonc's
// own header). These two prove the REAL wiring: githubMemoryDeps(env).memoryRepo()
// is resolveMemoryRepo applied to the real Env, not a fleet.json fetch.
describe("githubMemoryDeps(env).memoryRepo — wired to resolveMemoryRepo, never fleet.json", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** Serves a plausible fleet.json and records every URL asked for, so a call
   *  that shouldn't happen fails loudly (empty `urls`) rather than silently. */
  function stubGithub(): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      if (url.includes("/contents/fleet.json")) {
        return new Response(JSON.stringify({ blueprint: { repo: "rafarc21/fleetflare", ref: "main" } }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }) as typeof globalThis.fetch;
    return { urls };
  }

  it("FLEET_OPS_REPO set: that repo, and no fleet.json fetch", async () => {
    const stub = stubGithub();
    const testEnv = { ...env, FLEET_OPS_REPO: "rafarc21/fleet-memory" } as unknown as Env;
    expect(await githubMemoryDeps(testEnv).memoryRepo()).toBe("rafarc21/fleet-memory");
    expect(stub.urls).toEqual([]);
  });

  it("FLEET_OPS_REPO unset: memory off (null), even though fleet.json names a blueprint repo", async () => {
    const stub = stubGithub();
    const testEnv = { ...env, FLEET_OPS_REPO: undefined } as unknown as Env;
    expect(await githubMemoryDeps(testEnv).memoryRepo()).toBeNull();
    expect(stub.urls).toEqual([]);
  });
});
