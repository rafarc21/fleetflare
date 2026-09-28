import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCloneCmd } from "../../src/memory/store";

// Issue #341: memoryCloneCmd EXECUTED against real git -- a local bare repo
// stands in for github.com via the `base` seam; the clone lands in a temp dir
// via the `dir` seam. Same builder the Worker execs at provision.
let root: string;
function sh(cmd: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...env } });
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-memclone-"));
  sh(`git init -q --bare -b main o/fleet-memory.git && git init -q -b main seed`);
  mkdirSync(join(root, "seed/fleet/memory"), { recursive: true });
  writeFileSync(join(root, "seed/fleet/memory/INDEX.md"), "# Fleet memory index\n- [a](s/a.md) — fact a\n");
  sh(`cd seed && git add -A && git commit -qm seed && git push -q ../o/fleet-memory.git main`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("#341 memoryCloneCmd, real git", () => {
  test("clones the store with its fleet/memory layout", () => {
    const dir = join(root, "opt-memory");
    const r = sh(memoryCloneCmd("o/fleet-memory", { base: `file://${root}/`, dir }));
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "fleet/memory/INDEX.md"), "utf8")).toContain("fact a");
  });

  test("a re-run replaces the copy with the store's current tip", () => {
    const dir = join(root, "opt-memory");
    sh(memoryCloneCmd("o/fleet-memory", { base: `file://${root}/`, dir }));
    writeFileSync(join(root, "seed/fleet/memory/INDEX.md"), "# Fleet memory index\n- [b](s/b.md) — fact b\n");
    sh(`cd seed && git commit -qam next && git push -q ../o/fleet-memory.git main`);
    expect(sh(memoryCloneCmd("o/fleet-memory", { base: `file://${root}/`, dir })).code).toBe(0);
    expect(readFileSync(join(dir, "fleet/memory/INDEX.md"), "utf8")).toContain("fact b");
  });

  // #346 review item 1: the token must never appear in any process's argv
  // (visible in `ps` to everything in the container). A shim `git` first on
  // PATH records its argv and hands off to the real one.
  test("the token never reaches git's argv", () => {
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    const real = Bun.which("git")!;
    writeFileSync(join(shimDir, "git"), `#!/bin/bash\nprintf '%s\\n' "$@" >> ${join(root, "argv.log")}\nexec ${real} "$@"\n`);
    Bun.spawnSync({ cmd: ["chmod", "+x", join(shimDir, "git")] });
    const dir = join(root, "opt-memory");
    const r = sh(memoryCloneCmd("o/fleet-memory", { base: `file://${root}/`, dir }), {
      PATH: `${shimDir}:${process.env.PATH}`, FLEET_MEMORY_TOKEN: "sekrit-token-value-123",
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "fleet/memory/INDEX.md"))).toBe(true);
    const argv = readFileSync(join(root, "argv.log"), "utf8");
    expect(argv).toContain("clone");
    expect(argv).not.toContain("sekrit-token-value-123");
    expect(argv).not.toContain(Buffer.from("x-access-token:sekrit-token-value-123").toString("base64"));
  });

  test("a failed clone says so on stderr, exits 0, and keeps the previous copy", () => {
    const dir = join(root, "opt-memory");
    sh(memoryCloneCmd("o/fleet-memory", { base: `file://${root}/`, dir }));
    const r = sh(memoryCloneCmd("o/no-such-repo", { base: `file://${root}/`, dir }));
    expect(r.code).toBe(0);
    expect(r.err).toContain("memory clone skipped");
    expect(existsSync(join(dir, "fleet/memory/INDEX.md"))).toBe(true);
  });
});
