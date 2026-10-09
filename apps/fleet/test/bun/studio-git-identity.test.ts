import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STUDIO_GIT_IDENTITY, studioGitIdentity, gitIdentityCmd, gitIdentityEnv,
} from "../../src/studio/credentials";

/**
 * Issue #283: a studio's git identity is set by the Worker on every
 * credential write (provision and each refresh), from operator config with a
 * generic public-safe default — never from the operator's GitHub App bot
 * identity (FLEET_BOT_NAME/_EMAIL, `<app-slug>[bot]`), which is private and
 * on the leak denylist. Asks REAL git what identity the command leaves.
 */
function runInHome(cmd: string, env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "git-identity-"));
  try {
    const base = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { ...base, ...env } });
    const get = (k: string) =>
      spawnSync("git", ["config", "--global", k], { encoding: "utf8", env: base }).stdout.trim();
    return { code: r.status, stderr: r.stderr, name: get("user.name"), email: get("user.email") };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("studioGitIdentity", () => {
  test("defaults to the generic public-safe identity", () => {
    expect(STUDIO_GIT_IDENTITY).toEqual({
      name: "fleet-studio", email: "fleet-studio@users.noreply.github.com",
    });
    expect(studioGitIdentity({})).toEqual(STUDIO_GIT_IDENTITY);
  });

  test("never derives from the App bot identity, even when it is the only one configured", () => {
    const env = { FLEET_BOT_NAME: "acme-app[bot]", FLEET_BOT_EMAIL: "1+acme-app[bot]@users.noreply.github.com" };
    expect(studioGitIdentity(env)).toEqual(STUDIO_GIT_IDENTITY);
  });

  test("operator config wins when it is a plain identity", () => {
    expect(studioGitIdentity({ FLEET_STUDIO_GIT_NAME: "acme-dev", FLEET_STUDIO_GIT_EMAIL: "dev@acme.example" }))
      .toEqual({ name: "acme-dev", email: "dev@acme.example" });
  });

  test("a configured identity that IS the App bot falls back to the default", () => {
    const bot = { FLEET_BOT_NAME: "acme-app[bot]", FLEET_BOT_EMAIL: "acme-app[bot]@users.noreply.github.com" };
    // copied verbatim from the bot vars
    expect(studioGitIdentity({ ...bot, FLEET_STUDIO_GIT_NAME: bot.FLEET_BOT_NAME, FLEET_STUDIO_GIT_EMAIL: bot.FLEET_BOT_EMAIL }))
      .toEqual(STUDIO_GIT_IDENTITY);
    // any `[bot]` shape, App slug or not
    expect(studioGitIdentity({ FLEET_STUDIO_GIT_NAME: "other[bot]", FLEET_STUDIO_GIT_EMAIL: "dev@acme.example" }))
      .toEqual(STUDIO_GIT_IDENTITY);
    // same value as the bot name, no `[bot]` suffix
    expect(studioGitIdentity({ FLEET_BOT_NAME: "acme-app", FLEET_STUDIO_GIT_NAME: "acme-app", FLEET_STUDIO_GIT_EMAIL: "dev@acme.example" }))
      .toEqual(STUDIO_GIT_IDENTITY);
  });

  test("half-set, empty or malformed config falls back as a pair, never mixed", () => {
    expect(studioGitIdentity({ FLEET_STUDIO_GIT_NAME: "acme-dev" })).toEqual(STUDIO_GIT_IDENTITY);
    expect(studioGitIdentity({ FLEET_STUDIO_GIT_NAME: "", FLEET_STUDIO_GIT_EMAIL: "" })).toEqual(STUDIO_GIT_IDENTITY);
    expect(studioGitIdentity({ FLEET_STUDIO_GIT_NAME: "acme-dev", FLEET_STUDIO_GIT_EMAIL: "no-at-sign" })).toEqual(STUDIO_GIT_IDENTITY);
    expect(studioGitIdentity({ FLEET_STUDIO_GIT_NAME: "a\nb", FLEET_STUDIO_GIT_EMAIL: "dev@acme.example" })).toEqual(STUDIO_GIT_IDENTITY);
  });
});

describe("gitIdentityCmd (real git)", () => {
  test("sets the global identity from env; the command text carries no identity", () => {
    const id = { name: "it's \"quoted\" $(touch pwned)", email: "dev@acme.example" };
    const cmd = gitIdentityCmd();
    expect(cmd).not.toContain("fleet-studio");
    const r = runInHome(cmd, gitIdentityEnv(id));
    expect(r.code).toBe(0);
    expect(r.name).toBe(id.name);
    expect(r.email).toBe(id.email);
  });

  test("overwrites whatever identity a previous incarnation or agent left", () => {
    const r = runInHome(
      `git config --global user.name 'acme-app[bot]' && git config --global user.email x@y && ${gitIdentityCmd()}`,
      gitIdentityEnv(studioGitIdentity({ FLEET_BOT_NAME: "acme-app[bot]" })),
    );
    expect(r.code).toBe(0);
    expect(r.name).toBe("fleet-studio");
    expect(r.email).toBe("fleet-studio@users.noreply.github.com");
  });
});
