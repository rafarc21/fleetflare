import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/env";
import {
  writeProxyOn, writeModeFor, resolveWriteMode, readTokenEnvName, studioReadToken, studioCredential,
  STUDIO_READ_PERMISSIONS, containerToken,
} from "../src/write-proxy/mode";

// Issue #7: which credential a studio holds. Fake owners only (example-org).

const REPO = "example-org/demo";
const envOf = (vars: Record<string, string>) => vars as unknown as Env;
// #13 review: off unless the work repo is listed. Every fixture below lists REPO.
const ON = { FLEET_WRITE_PROXY_REPOS: "example-org/demo" };
const APP = { ...ON, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_INSTALLATION_ID: "2" };

describe("writeProxyOn", () => {
  it("malformed entries (a URL, a .git suffix) are logged and never match", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(writeProxyOn({ FLEET_WRITE_PROXY_REPOS: "https://github.com/example-org/demo, example-org/demo.git" }, REPO)).toBe(false);
    const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("https://github.com/example-org/demo");
    expect(logged).toContain("example-org/demo.git");
    err.mockRestore();
  });

  it("is off unless the work repo is on FLEET_WRITE_PROXY_REPOS (deploy changes nothing)", () => {
    expect(writeProxyOn({}, REPO)).toBe(false);
    expect(writeProxyOn({ FLEET_WRITE_PROXY_REPOS: "" }, REPO)).toBe(false);
    expect(writeProxyOn({ FLEET_WRITE_PROXY_REPOS: "example-org/other" }, REPO)).toBe(false);
    expect(writeProxyOn({ FLEET_WRITE_PROXY_REPOS: "example-org/other, Example-Org/Demo" }, REPO)).toBe(true);
  });
});

describe("writeModeFor", () => {
  it("unlisted repo = direct, whatever the visibility and provider", () => {
    const off = envOf({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_INSTALLATION_ID: "2" });
    expect(writeModeFor(off, REPO, false)).toBe("direct");
    expect(writeModeFor(envOf({ GITHUB_TOKEN: "w" }), REPO, true)).toBe("direct");
  });
  it("listed: App + private = direct; public or PAT = proxy", () => {
    expect(writeModeFor(envOf(APP), REPO, true)).toBe("direct");
    expect(writeModeFor(envOf(APP), REPO, false)).toBe("proxy");
    expect(writeModeFor(envOf({ ...ON, GITHUB_TOKEN: "w" }), REPO, true)).toBe("proxy");
  });
});

describe("resolveWriteMode", () => {
  it("public repo = proxy", async () => {
    expect(await resolveWriteMode(envOf(APP), REPO, async () => false)).toBe("proxy");
  });
  it("confirmed private repo on the App (repo-scoped token) = direct", async () => {
    expect(await resolveWriteMode(envOf(APP), REPO, async () => true)).toBe("direct");
  });
  it("confirmed private repo on a PAT = proxy: the PAT also writes the owner's public repos", async () => {
    expect(await resolveWriteMode(envOf({ ...ON, GITHUB_TOKEN: "w" }), REPO, async () => true)).toBe("proxy");
  });
  it("a visibility lookup that throws reads as public = proxy (fail closed)", async () => {
    expect(await resolveWriteMode(envOf(APP), REPO, async () => { throw new Error("github down"); })).toBe("proxy");
  });
  it("repo not listed = direct without asking visibility", async () => {
    const isPrivate = vi.fn(async () => false);
    expect(await resolveWriteMode(envOf({ ...APP, FLEET_WRITE_PROXY_REPOS: "" }), REPO, isPrivate)).toBe("direct");
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
  const env = envOf({ ...ON, GITHUB_TOKEN: "write", GITHUB_READ_TOKEN: "read" });

  it("direct = the write credential, as before #7", async () => {
    const app = envOf(APP);
    const mint = vi.fn(async () => "write-minted");
    expect(await studioCredential(app, REPO, "direct", mint)).toBe("write-minted");
    expect(mint).toHaveBeenCalledWith(app, REPO);
  });

  it("proxy: a failed read mint = null (credential cleared), never a stale write token", async () => {
    const mint = vi.fn(async () => { throw new Error("mint 500"); });
    expect(await studioCredential(envOf(APP), REPO, "proxy", mint)).toBeNull();
  });

  it("proxy = the read credential", async () => {
    const mint = vi.fn(async () => "write-minted");
    expect(await studioCredential(env, REPO, "proxy", mint)).toBe("read");
  });

  it("proxy with no read token = null, never the write PAT", async () => {
    const mint = vi.fn(async () => "write-minted");
    expect(await studioCredential(envOf({ ...ON, GITHUB_TOKEN: "write" }), REPO, "proxy", mint)).toBeNull();
  });
});

// Review of #7, blocker 1: every OTHER token that rides into the container
// (blueprint clone, memory clone, rescue) goes through this, so a PAT fleet
// never hands the write PAT over under a "read" label.
describe("containerToken", () => {
  it("App: the repo-scoped mint, narrowed as asked", async () => {
    const mint = vi.fn(async () => "ghs_x");
    const app = envOf(APP);
    expect(await containerToken(app, REPO, "example-org/blueprint", { contents: "read" }, mint)).toBe("ghs_x");
    expect(mint).toHaveBeenCalledWith(app, "example-org/blueprint", { permissions: { contents: "read" } });
  });

  it("PAT + read: the read PAT, else null -- never the write PAT", async () => {
    const mint = vi.fn(async () => "write");
    expect(await containerToken(envOf({ ...ON, GITHUB_TOKEN: "write", GITHUB_READ_TOKEN: "read" }), REPO, REPO, { contents: "read" }, mint)).toBe("read");
    expect(await containerToken(envOf({ ...ON, GITHUB_TOKEN: "write" }), REPO, REPO, { contents: "read" }, mint)).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });

  it("PAT + write: null (a PAT cannot be scoped to one repo)", async () => {
    const mint = vi.fn(async () => "write");
    expect(await containerToken(envOf({ ...ON, GITHUB_TOKEN: "write", GITHUB_READ_TOKEN: "read" }), REPO, REPO, { contents: "write" }, mint)).toBeNull();
  });

  it("work repo not listed: the pre-#7 mint", async () => {
    const mint = vi.fn(async () => "write");
    const off = envOf({ GITHUB_TOKEN: "write" });
    expect(await containerToken(off, REPO, "example-org/blueprint", { contents: "read" }, mint)).toBe("write");
  });
});
