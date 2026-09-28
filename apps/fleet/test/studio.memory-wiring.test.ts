import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { StudioDO } from "../src/studio/do";

// #346 review item 3: the DO's own wiring of FLEET_OPS_REPO. A live StudioDO
// cannot be constructed under vitest-pool-workers; the REAL prototype methods
// run against a fake `this` (the studio.start-gate.test.ts technique). Pins
// that nothing falls back to AGENT_REPO (the fleet repo, going public) when
// FLEET_OPS_REPO is unset.
function doWith(vars: Partial<Env>): { memoryDeps(): { resolveMemoryRepo(): Promise<string | null> }; deps(): { memoryRepo?: string | null } } {
  const doObj = Object.create(StudioDO.prototype) as StudioDO;
  Object.assign(doObj, {
    env: { ...env, AGENT_REPO: "rafarc21/fleetflare", FLEET_OPS_REPO: undefined, ...vars },
    ctx: { id: { name: "fleetflare--pilot" }, storage: { get: async () => undefined, put: async () => {} } },
  });
  return doObj as unknown as ReturnType<typeof doWith>;
}

describe("#341/#346 — the DO wires FLEET_OPS_REPO, never the fleet repo", () => {
  it("memoryDeps: unset -> memory off (null), never AGENT_REPO", async () => {
    expect(await doWith({}).memoryDeps().resolveMemoryRepo()).toBeNull();
  });
  it("memoryDeps: set -> the ops repo", async () => {
    expect(await doWith({ FLEET_OPS_REPO: "rafarc21/fleetflare-ops" }).memoryDeps().resolveMemoryRepo()).toBe("rafarc21/fleetflare-ops");
  });
  it("provision deps: unset -> memoryRepo null, never AGENT_REPO", () => {
    expect(doWith({}).deps().memoryRepo ?? null).toBeNull();
  });
  it("provision deps: set -> the ops repo", () => {
    expect(doWith({ FLEET_OPS_REPO: "rafarc21/fleetflare-ops" }).deps().memoryRepo).toBe("rafarc21/fleetflare-ops");
  });
});

// #346 review item 1 (after #339): memory tokens are SCOPED to the ops repo
// and NARROWED to what each use needs -- the container clone reads, the
// Worker-side harvest writes. Asserted on the mint request GitHub receives.
describe("#346 — memory tokens are scoped to the ops repo and narrowed", () => {
  let pem: string;
  let realFetch: typeof globalThis.fetch;
  let mints: { url: string; body: Record<string, unknown> }[];
  beforeAll(async () => {
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
    pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
  });
  afterEach(() => { if (realFetch) globalThis.fetch = realFetch; });
  function stubGithub() {
    mints = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/access_tokens")) {
        mints.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json({ token: "ghs_scoped_fake" });
      }
      return Response.json({ content: { sha: "x" }, commit: { sha: "y" } }, { status: 201 });
    }) as typeof globalThis.fetch;
  }
  const appVars = (): Partial<Env> => ({
    GITHUB_APP_ID: "1111111", GITHUB_INSTALLATION_ID: "2222222", GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_TOKEN: undefined, GITHUB_REPO_AUTH: undefined, FLEET_OPS_REPO: "rafarc21/fleetflare-ops",
  } as unknown as Partial<Env>);

  it("container clone token: repositories [ops repo], contents:read only", async () => {
    stubGithub();
    const d = doWith(appVars()).deps() as unknown as { memoryToken: () => Promise<string> };
    expect(await d.memoryToken()).toBe("ghs_scoped_fake");
    expect(mints).toHaveLength(1);
    expect(mints[0]!.body).toEqual({ repositories: ["fleetflare-ops"], permissions: { contents: "read" } });
  });

  it("harvest write token: repositories [ops repo], contents:write only", async () => {
    stubGithub();
    const m = doWith(appVars()).memoryDeps() as unknown as {
      commitFile: (repo: string, path: string, content: string, message: string) => Promise<void>;
    };
    await m.commitFile("rafarc21/fleetflare-ops", "fleet/memory/fleetflare--pilot/x.md", "fact\n", "fleet: harvest learning (fleetflare--pilot)");
    expect(mints).toHaveLength(1);
    expect(mints[0]!.body).toEqual({ repositories: ["fleetflare-ops"], permissions: { contents: "write" } });
  });
});
