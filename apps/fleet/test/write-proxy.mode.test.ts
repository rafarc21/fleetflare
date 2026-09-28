import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/env";
import {
  writeProxyOn, resolveWriteMode, readTokenEnvName, studioReadToken, studioCredential,
  STUDIO_READ_PERMISSIONS,
} from "../src/write-proxy/mode";

// Issue #7: which credential a studio holds. Fake owners only (example-org).

const REPO = "example-org/demo";
const envOf = (vars: Record<string, string>) => vars as unknown as Env;

describe("writeProxyOn", () => {
  it("is on unless FLEET_WRITE_PROXY is exactly off", () => {
    expect(writeProxyOn({})).toBe(true);
    expect(writeProxyOn({ FLEET_WRITE_PROXY: "" })).toBe(true);
    expect(writeProxyOn({ FLEET_WRITE_PROXY: "on" })).toBe(true);
    expect(writeProxyOn({ FLEET_WRITE_PROXY: "off" })).toBe(false);
  });
});

describe("resolveWriteMode", () => {
  it("public repo = proxy", async () => {
    expect(await resolveWriteMode({}, REPO, async () => false)).toBe("proxy");
  });
  it("confirmed private repo = direct", async () => {
    expect(await resolveWriteMode({}, REPO, async () => true)).toBe("direct");
  });
  it("a visibility lookup that throws reads as public = proxy (fail closed)", async () => {
    expect(await resolveWriteMode({}, REPO, async () => { throw new Error("github down"); })).toBe("proxy");
  });
  it("kill switch = direct without asking visibility", async () => {
    const isPrivate = vi.fn(async () => false);
    expect(await resolveWriteMode({ FLEET_WRITE_PROXY: "off" }, REPO, isPrivate)).toBe("direct");
    expect(isPrivate).not.toHaveBeenCalled();
  });
});

describe("studioReadToken", () => {
  it("names the per-owner read secret", () => {
    expect(readTokenEnvName("example-org")).toBe("GITHUB_READ_TOKEN_EXAMPLE_ORG");
  });

  it("App path mints a repo-scoped token narrowed to read", async () => {
    const mint = vi.fn(async () => "ghs_read");
    const env = envOf({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_INSTALLATION_ID: "2" });
    expect(await studioReadToken(env, REPO, mint)).toBe("ghs_read");
    expect(mint).toHaveBeenCalledWith(env, REPO, { permissions: STUDIO_READ_PERMISSIONS });
    expect(Object.values(STUDIO_READ_PERMISSIONS).every((v) => v === "read")).toBe(true);
  });

  it("PAT path prefers the owner's read token, then GITHUB_READ_TOKEN, never the write PAT", async () => {
    const mint = vi.fn(async () => "never");
    expect(await studioReadToken(envOf({
      GITHUB_TOKEN: "write", GITHUB_READ_TOKEN: "shared-read", GITHUB_READ_TOKEN_EXAMPLE_ORG: "own-read",
    }), REPO, mint)).toBe("own-read");
    expect(await studioReadToken(envOf({ GITHUB_TOKEN: "write", GITHUB_READ_TOKEN: "shared-read" }), REPO, mint))
      .toBe("shared-read");
    expect(await studioReadToken(envOf({ GITHUB_TOKEN: "write" }), REPO, mint)).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("studioCredential", () => {
  const env = envOf({ GITHUB_TOKEN: "write", GITHUB_READ_TOKEN: "read" });

  it("direct mode = the write credential, as before #7", async () => {
    const mint = vi.fn(async () => "write-minted");
    expect(await studioCredential(env, REPO, { isPrivate: async () => true, mint })).toBe("write-minted");
    expect(mint).toHaveBeenCalledWith(env, REPO);
  });

  it("proxy mode = the read credential", async () => {
    const mint = vi.fn(async () => "write-minted");
    expect(await studioCredential(env, REPO, { isPrivate: async () => false, mint })).toBe("read");
  });

  it("proxy mode with no read token = null, never the write PAT", async () => {
    const mint = vi.fn(async () => "write-minted");
    const bare = envOf({ GITHUB_TOKEN: "write" });
    expect(await studioCredential(bare, REPO, { isPrivate: async () => false, mint })).toBeNull();
  });
});
