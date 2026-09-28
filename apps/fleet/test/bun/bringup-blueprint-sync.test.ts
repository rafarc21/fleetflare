import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";

/**
 * Issue #11: bring-up cloned the blueprint only when /opt/blueprint/.git was
 * absent, so a skill added to the blueprint after the container booted never
 * appeared. `fleet provision` then marked the studio bare
 * (`skills-unresolvable`) until a recycle gave it a fresh container.
 *
 * blueprint_sync is the REAL function, extracted from
 * container/studio-bringup.sh. The GitHub URL it builds is redirected to a
 * local bare repo with git's own url.<base>.insteadOf, passed through
 * GIT_CONFIG_* env, so the clone and fetch lines run unchanged.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
const SYNC = () => extractShellFunc(BRINGUP, "blueprint_sync");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_NOSYSTEM: "1",
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: { ...process.env, ...GIT_ENV }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A blueprint upstream (bare repo served as github.com/example-org/blueprint) plus a work clone to push from. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-blueprint-sync-"));
  dirs.push(dir);
  const remotes = join(dir, "remotes");
  const bare = join(remotes, "example-org", "blueprint.git");
  const work = join(dir, "work");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(dir, "clone", "-q", bare, work);
  const addSkill = (name: string, branch = "main") => {
    mkdirSync(join(work, "skills", name), { recursive: true });
    writeFileSync(join(work, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", `add ${name}`);
    git(work, "push", "-q", "origin", `HEAD:${branch}`);
  };
  addSkill("first-skill");
  const checkout = join(dir, "opt-blueprint");
  const sync = (env: Record<string, string> = {}) => {
    const r = runSnippet({
      shell: "bash",
      env: {
        ...GIT_ENV,
        HOME: dir,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/",
        BLUEPRINT_REPO: "example-org/blueprint",
        ...env,
      },
      script: `set -euo pipefail\n${SYNC()}\nblueprint_sync ${JSON.stringify(checkout)}\necho SYNC_DONE\n`,
      timeout: 30000,
    });
    expect(r.parentAlive).toBe(true);
    return r;
  };
  return { dir, bare, work, checkout, addSkill, sync, has: (s: string) => existsSync(join(checkout, "skills", s, "SKILL.md")) };
}

describe("blueprint_sync — a provision sees what the blueprint holds NOW (issue #11)", () => {
  test("first bring-up clones the blueprint", () => {
    const w = world();
    const r = w.sync();
    expect(r.stdout).toContain("SYNC_DONE");
    expect(w.has("first-skill")).toBe(true);
  });

  test("a skill added to the blueprint after the clone appears on the next bring-up", () => {
    const w = world();
    w.sync();
    w.addSkill("junior-skill");
    expect(w.has("junior-skill")).toBe(false);
    const r = w.sync();
    expect(r.stdout).toContain("SYNC_DONE");
    expect(w.has("junior-skill")).toBe(true);
  });

  test("BLUEPRINT_REF pins the checkout to that ref, on the first clone and on a refresh", () => {
    const w = world();
    w.addSkill("pinned-only", "pinned");
    w.sync({ BLUEPRINT_REF: "pinned" });
    expect(w.has("pinned-only")).toBe(true);
    w.addSkill("pinned-later", "pinned");
    w.sync({ BLUEPRINT_REF: "pinned" });
    expect(w.has("pinned-later")).toBe(true);
    // main never got either skill: the checkout followed the ref, not HEAD.
    w.sync({ BLUEPRINT_REF: "main" });
    expect(w.has("pinned-only")).toBe(false);
  });

  test("a failed refresh keeps the existing checkout, says so, and never aborts bring-up", () => {
    const w = world();
    w.sync();
    rmSync(w.bare, { recursive: true, force: true });
    const r = w.sync();
    expect(r.stdout).toContain("SYNC_DONE");
    expect(w.has("first-skill")).toBe(true);
    expect(r.stderr).toContain("blueprint refresh failed");
  });

  test("a failed first clone is tolerated, with the existing message", () => {
    const w = world();
    rmSync(w.bare, { recursive: true, force: true });
    const r = w.sync();
    expect(r.stdout).toContain("SYNC_DONE");
    expect(r.stderr).toContain("blueprint clone failed, skills will be missing");
    expect(existsSync(join(w.checkout, ".git"))).toBe(false);
  });

  test("no BLUEPRINT_REPO: nothing is cloned", () => {
    const w = world();
    const r = w.sync({ BLUEPRINT_REPO: "" });
    expect(r.stdout).toContain("SYNC_DONE");
    expect(existsSync(w.checkout)).toBe(false);
  });
});
