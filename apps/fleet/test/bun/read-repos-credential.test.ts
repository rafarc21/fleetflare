import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialWriteCmd, readReposCredentialClearCmd, readReposCredentialWriteCmd, tokenEnv,
  READ_REPOS_TOKEN_PATH,
} from "../../src/studio/credentials";

/**
 * Issue #291 — the read-only sibling-repo credential, asked of git itself
 * (same method as blueprint-credential.test.ts: which password does
 * `git credential fill` hand back for a URL). The helper must answer ONLY for
 * the listed repos; every other github.com URL keeps the work credential.
 */

const WORK_TOKEN = "ghs_workTokenForTheOneWorkRepo";
const READ_TOKEN = "ghs_readOnlyTokenForSiblings";
const LISTED = ["acme-org/alpha", "acme-org/beta"];

function localize(cmd: string, dir: string): string {
  return cmd.replaceAll("/workspace/", `${dir}/`);
}

function gitEnv(dir: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    HOME: dir,
    GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"),
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function run(cmd: string, dir: string, env: Record<string, string>, token?: string): void {
  const r = Bun.spawnSync({
    cmd: ["bash", "-c", localize(cmd, dir)], env: { ...env, ...(token ? tokenEnv(token) : {}) },
    stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`command failed: ${r.stderr.toString()}`);
}

function setup(repos: string[] = LISTED): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-readcred-"));
  const env = gitEnv(dir);
  mkdirSync(join(dir, ".config", "gh"), { recursive: true });
  run(credentialWriteCmd(), dir, env, WORK_TOKEN);
  run(readReposCredentialWriteCmd(repos), dir, env, READ_TOKEN);
  return { dir, env };
}

function passwordFor(url: string, env: Record<string, string>): string {
  const r = Bun.spawnSync({
    cmd: ["git", "credential", "fill"], stdin: Buffer.from(`url=${url}\n\n`), env, stdout: "pipe", stderr: "pipe",
  });
  return /password=(.*)/.exec(r.stdout.toString())?.[1] ?? "";
}

function withSetup(fn: (env: Record<string, string>, dir: string) => void, repos?: string[]): void {
  const { dir, env } = setup(repos);
  try { fn(env, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("readReposCredentialWriteCmd, asked of git", () => {
  test("a listed repo gets the READ token — .git and suffixless URLs both", () => withSetup((env) => {
    for (const repo of LISTED) {
      expect(passwordFor(`https://github.com/${repo}.git`, env)).toBe(READ_TOKEN);
      expect(passwordFor(`https://github.com/${repo}`, env)).toBe(READ_TOKEN);
    }
  }));

  test("an UNLISTED sibling never gets the read token", () => withSetup((env) => {
    expect(passwordFor("https://github.com/acme-org/secret.git", env)).not.toBe(READ_TOKEN);
    expect(passwordFor("https://github.com/acme-org/secret", env)).not.toBe(READ_TOKEN);
  }));

  test("a name that merely STARTS with a listed one is unlisted", () => withSetup((env) => {
    expect(passwordFor("https://github.com/acme-org/alpha-private.git", env)).not.toBe(READ_TOKEN);
    expect(passwordFor("https://github.com/acme-org/alphabet", env)).not.toBe(READ_TOKEN);
  }));

  test("the work repo keeps the work token — the read helper never touches it", () => withSetup((env) => {
    expect(passwordFor("https://github.com/acme-org/websites.git", env)).toBe(WORK_TOKEN);
  }));

  test("the read token also lands in a 0600 file for gh/curl (never in env, never in argv)", () => withSetup((_env, dir) => {
    const path = localize(READ_REPOS_TOKEN_PATH, dir);
    expect(readFileSync(path, "utf8")).toBe(READ_TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readReposCredentialWriteCmd(LISTED)).not.toContain(READ_TOKEN);
  }));

  test("a refresh with a SHORTER list drops the repos no longer granted", () => withSetup((env, dir) => {
    run(readReposCredentialWriteCmd(["acme-org/beta"]), dir, env, READ_TOKEN);
    expect(passwordFor("https://github.com/acme-org/alpha.git", env)).not.toBe(READ_TOKEN);
    expect(passwordFor("https://github.com/acme-org/beta.git", env)).toBe(READ_TOKEN);
  }));

  test("clear removes every read helper and the token file; the work credential survives", () => withSetup((env, dir) => {
    run(readReposCredentialClearCmd(), dir, env);
    for (const repo of LISTED) expect(passwordFor(`https://github.com/${repo}.git`, env)).not.toBe(READ_TOKEN);
    expect(passwordFor("https://github.com/acme-org/websites.git", env)).toBe(WORK_TOKEN);
    expect(() => readFileSync(localize(READ_REPOS_TOKEN_PATH, dir))).toThrow();
  }));

  test("clear is safe when nothing was ever granted", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-readcred-"));
    try {
      const env = gitEnv(dir);
      run(credentialWriteCmd(), dir, env, WORK_TOKEN);
      run(readReposCredentialClearCmd(), dir, env);
      expect(passwordFor("https://github.com/acme-org/websites.git", env)).toBe(WORK_TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to build a command for a repo name that could break out of the shell", () => {
    expect(() => readReposCredentialWriteCmd(["acme-org/a'b"])).toThrow();
    expect(() => readReposCredentialWriteCmd(["acme-org/a b"])).toThrow();
  });
});
