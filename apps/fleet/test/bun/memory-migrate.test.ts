import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #341: scripts/migrate-memory-store.sh, EXECUTED against real git. It
// never touches the network and never pushes: it builds the store repo in an
// output dir; the maestro pushes it (commands in the PR body).
const SCRIPT = join(import.meta.dir, "../../scripts/migrate-memory-store.sh");
let root: string;
function sh(cmd: string, cwd = root) {
  const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-memmig-"));
  const fleet = join(root, "fleet");
  sh(`git init -q -b main fleet`);
  mkdirSync(join(fleet, "fleet/memory/a--pilot"), { recursive: true });
  mkdirSync(join(fleet, "apps"), { recursive: true });
  writeFileSync(join(fleet, "apps/code.ts"), "export {}\n");
  writeFileSync(join(fleet, "fleet/memory/a--pilot/one.md"), "fact one\n");
  sh(`git add -A && git commit -qm "code + first learning"`, fleet);
  writeFileSync(join(fleet, "fleet/memory/INDEX.md"), "# Fleet memory index\n- [one](a--pilot/one.md) — fact one\n");
  sh(`git add -A && git commit -qm "fleet: harvest learning (a--pilot)"`, fleet);
  writeFileSync(join(fleet, "apps/code.ts"), "export const x = 1\n");
  sh(`git commit -qam "code only"`, fleet);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("#341 migrate-memory-store.sh", () => {
  test("builds a store with ONLY fleet/memory/, same layout, memory history preserved", () => {
    const out = join(root, "store");
    const r = sh(`bash ${SCRIPT} ${join(root, "fleet")} ${out}`);
    expect(r.code).toBe(0);
    expect(existsSync(join(out, "fleet/memory/INDEX.md"))).toBe(true);
    expect(existsSync(join(out, "fleet/memory/a--pilot/one.md"))).toBe(true);
    expect(existsSync(join(out, "apps"))).toBe(false);
    const files = sh(`git -C ${out} ls-files`).out.split("\n").sort();
    expect(files).toEqual(["fleet/memory/INDEX.md", "fleet/memory/a--pilot/one.md"]);
    // Both memory-touching commits survive; the code-only one does not.
    const log = sh(`git -C ${out} log --format=%s`).out;
    expect(log).toContain("fleet: harvest learning (a--pilot)");
    expect(log).toContain("code + first learning");
    expect(log).not.toContain("code only");
    expect(r.out).toContain("files=2");
  });

  test("refuses an existing output dir rather than mixing into it", () => {
    const out = join(root, "store");
    mkdirSync(out);
    const r = sh(`bash ${SCRIPT} ${join(root, "fleet")} ${out}`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("exists");
  });
});
