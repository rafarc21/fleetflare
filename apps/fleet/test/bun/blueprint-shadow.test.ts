import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blueprintCredentialWriteCmd, credentialWriteCmd, tokenEnv,
  blueprintCredentialDropCmd, blueprintShadowDropCmd, BLUEPRINT_CREDENTIAL_PATH,
} from "../../src/studio/credentials";

/**
 * Issue #1187 — when the blueprint repo IS the work repo, the URL-scoped
 * blueprint helper answers for the work repo's own push URL with the
 * read-only, never-refreshed 1 h blueprint token, so every push dies on 403
 * then 401. Asked of git itself, same method as blueprint-credential.test.ts:
 * which password does `git credential fill` hand back after each drop.
 *
 * The refresh-heal drop (blueprintShadowDropCmd) must unset ONLY the work
 * repo's own two helper keys and only when their value names the blueprint
 * file — a legit other-repo blueprint credential must survive it untouched.
 */

const WORK_REPO = "acme-org/sample";
const BLUEPRINT_REPO = "acme-org/websites";
const WORK_TOKEN = "github_pat_workTokenForTheWorkRepo";
const BLUEPRINT_TOKEN = "ghs_blueprintTokenForTheBlueprintRepo";

/** Both commands hardcode /workspace, which no test host has. Only the
 *  credential FILE location is rewritten — the config KEY and the helper
 *  ordering, the things under test, stay byte-identical. */
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

function run(
  cmd: string, dir: string, env: Record<string, string>, token?: string,
): { code: number; stderr: string } {
  const r = Bun.spawnSync({
    cmd: ["bash", "-c", localize(cmd, dir)], env: { ...env, ...(token ? tokenEnv(token) : {}) },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

/** A container-shaped git setup: the work-repo credential first, then the
 *  blueprint credential for `blueprint` on top (defaults to the work repo —
 *  the shadow configuration the fix targets). */
function setup(
  dir: string, env: Record<string, string>, blueprint: string = WORK_REPO,
): void {
  mkdirSync(join(dir, ".config", "gh"), { recursive: true });
  for (const [cmd, token] of [
    [credentialWriteCmd(), WORK_TOKEN], [blueprintCredentialWriteCmd(blueprint), BLUEPRINT_TOKEN],
  ] as const) {
    const r = run(cmd, dir, env, token);
    if (r.code !== 0) throw new Error(`setup command failed: ${r.stderr}`);
  }
}

function fresh(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-bpshadow-"));
  const env = gitEnv(dir);
  setup(dir, env);
  return { dir, env };
}

function passwordFor(url: string, env: Record<string, string>): string {
  const r = Bun.spawnSync({
    cmd: ["git", "credential", "fill"], stdin: Buffer.from(`url=${url}\n\n`),
    env, stdout: "pipe", stderr: "pipe",
  });
  return /password=(.*)/.exec(r.stdout.toString())?.[1] ?? "";
}

const workUrl = `https://github.com/${WORK_REPO}.git`;
const blueprintUrl = `https://github.com/${BLUEPRINT_REPO}.git`;

describe("blueprintCredentialDropCmd, asked of git", () => {
  test("after the drop the work repo's push URL gets the WORK token, not the blueprint one", () => {
    const { dir, env } = fresh();
    try {
      // The shadow this fix exists for: blueprint == work repo, so the scoped
      // helper answers the work URL with the read-only blueprint token.
      expect(passwordFor(workUrl, env)).toBe(BLUEPRINT_TOKEN);
      const r = run(blueprintCredentialDropCmd(WORK_REPO), dir, env);
      expect(r.code).toBe(0);
      expect(passwordFor(workUrl, env)).toBe(WORK_TOKEN);
      expect(existsSync(localize(BLUEPRINT_CREDENTIAL_PATH, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idempotent: a second drop run exits 0 with nothing left to remove", () => {
    const { dir, env } = fresh();
    try {
      expect(run(blueprintCredentialDropCmd(WORK_REPO), dir, env).code).toBe(0);
      const again = run(blueprintCredentialDropCmd(WORK_REPO), dir, env);
      expect(again.code).toBe(0);
      expect(passwordFor(workUrl, env)).toBe(WORK_TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a shadow keyed under the repo's OTHER casing is dropped too", () => {
    // fresh() writes the blueprint credential for the lowercase WORK_REPO —
    // what a prior provision with a lowercase blueprint.repo would have left.
    // The drop is called with the mixed-case form (the current blueprint.repo),
    // so the lowercase key is what a case-sensitive drop misses.
    const { dir, env } = fresh();
    try {
      expect(passwordFor(workUrl, env)).toBe(BLUEPRINT_TOKEN);
      const r = run(blueprintCredentialDropCmd("Acme-Org/Sample"), dir, env);
      expect(r.code).toBe(0);
      expect(passwordFor(workUrl, env)).toBe(WORK_TOKEN);
      expect(existsSync(localize(BLUEPRINT_CREDENTIAL_PATH, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("blueprintShadowDropCmd (the refresh heal), asked of git", () => {
  test("heals a live shadow: the work URL goes back to the work token and the file is gone", () => {
    const { dir, env } = fresh();
    try {
      expect(passwordFor(workUrl, env)).toBe(BLUEPRINT_TOKEN);
      const r = run(blueprintShadowDropCmd(WORK_REPO), dir, env);
      expect(r.code).toBe(0);
      expect(passwordFor(workUrl, env)).toBe(WORK_TOKEN);
      expect(existsSync(localize(BLUEPRINT_CREDENTIAL_PATH, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a legit OTHER-repo blueprint credential survives the heal untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-bpshadow-"));
    const env = gitEnv(dir);
    try {
      setup(dir, env, BLUEPRINT_REPO);
      const r = run(blueprintShadowDropCmd(WORK_REPO), dir, env);
      expect(r.code).toBe(0);
      expect(passwordFor(blueprintUrl, env)).toBe(BLUEPRINT_TOKEN);
      expect(passwordFor(workUrl, env)).toBe(WORK_TOKEN);
      expect(existsSync(localize(BLUEPRINT_CREDENTIAL_PATH, dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idempotent on a clean container: exits 0, removes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-bpshadow-"));
    const env = gitEnv(dir);
    try {
      mkdirSync(join(dir, ".config", "gh"), { recursive: true });
      run(credentialWriteCmd(), dir, env, WORK_TOKEN);
      expect(run(blueprintShadowDropCmd(WORK_REPO), dir, env).code).toBe(0);
      expect(passwordFor(workUrl, env)).toBe(WORK_TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repo-name guards", () => {
  test("both drops refuse a repo name that could break out of the shell", () => {
    expect(() => blueprintCredentialDropCmd("acme-org/a'b")).toThrow();
    expect(() => blueprintCredentialDropCmd("acme-org/a b")).toThrow();
    expect(() => blueprintShadowDropCmd("acme-org/a'b")).toThrow();
    expect(() => blueprintShadowDropCmd("acme-org/a b")).toThrow();
  });
});
