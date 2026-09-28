// Task 8: `fleet junior enable|disable|status` — local opt-in. Purely a
// symlink from ~/.claude/skills/junior to this checkout's skills/junior/,
// plus a config file storing an account id. Never touches the Worker or any
// studio.
import { describe, expect, test } from "bun:test";
import {
  mkdtempSync, mkdirSync, existsSync, readlinkSync, readFileSync, writeFileSync, lstatSync,
  symlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { juniorPaths, juniorEnable, juniorDisable, juniorStatus } from "../../cli/junior";
import { juniorConfigPath } from "../../../../skills/junior/src/auth";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "junior-home-"));
  const repo = mkdtempSync(join(tmpdir(), "junior-repo-"));
  mkdirSync(join(repo, "skills/junior"), { recursive: true });
  return { home, repo, p: juniorPaths(home, repo) };
}

describe("fleet junior", () => {
  test("config path agrees with the wrapper's reader", () => {
    const { home, p } = fixture();
    expect(p.config).toBe(juniorConfigPath(home));
  });
  test("enable links the skill and stores the account", () => {
    const { p } = fixture();
    const r = juniorEnable(p, "acct1");
    expect(r.ok).toBe(true);
    expect(readlinkSync(p.skillLink)).toBe(p.skillSrc);
    expect(JSON.parse(readFileSync(p.config, "utf8"))).toEqual({ accountId: "acct1" });
  });
  test("enable twice is idempotent", () => {
    const { p } = fixture();
    juniorEnable(p, "a");
    expect(juniorEnable(p).ok).toBe(true);
    expect(JSON.parse(readFileSync(p.config, "utf8"))).toEqual({ accountId: "a" });
  });
  test("enable refuses to clobber a foreign skill dir", () => {
    const { p } = fixture();
    mkdirSync(p.skillLink, { recursive: true });
    const r = juniorEnable(p, "a");
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("already exists");
    expect(lstatSync(p.skillLink).isDirectory()).toBe(true);
  });
  test("enable/disable refuse a foreign SYMLINK (points at a different, still-existing target) — leave it alone", () => {
    const { p } = fixture();
    const otherTarget = mkdtempSync(join(tmpdir(), "junior-other-target-"));
    mkdirSync(join(p.skillLink, ".."), { recursive: true });
    symlinkSync(otherTarget, p.skillLink);
    const rEnable = juniorEnable(p, "a");
    expect(rEnable.ok).toBe(false);
    expect(rEnable.lines.join("\n")).toContain("already exists");
    expect(readlinkSync(p.skillLink)).toBe(otherTarget);
    const rDisable = juniorDisable(p);
    expect(rDisable.ok).toBe(false);
    expect(rDisable.lines.join("\n")).toContain("not this checkout's junior symlink");
    expect(readlinkSync(p.skillLink)).toBe(otherTarget);
  });
  test("a DANGLING symlink that was never ours is 'foreign', not 'absent' or 'ours'", () => {
    const { p } = fixture();
    // A path that was never created, so the symlink is dangling from the
    // start — readlinkSync still reports it (it never follows the link),
    // which is exactly what linkState's string comparison relies on.
    const neverExisted = join(tmpdir(), `junior-never-existed-${Date.now()}-${Math.random()}`);
    mkdirSync(join(p.skillLink, ".."), { recursive: true });
    symlinkSync(neverExisted, p.skillLink);
    const rEnable = juniorEnable(p, "a");
    expect(rEnable.ok).toBe(false);
    expect(rEnable.lines.join("\n")).toContain("already exists");
    const rDisable = juniorDisable(p);
    expect(rDisable.ok).toBe(false);
    expect(rDisable.lines.join("\n")).toContain("not this checkout's junior symlink");
    // untouched either way
    expect(lstatSync(p.skillLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(p.skillLink)).toBe(neverExisted);
  });
  test("enable without any account warns", () => {
    const { p } = fixture();
    expect(juniorEnable(p).lines.join("\n")).toContain("--account");
  });
  test("disable removes only our symlink, keeps config", () => {
    const { p } = fixture();
    juniorEnable(p, "a");
    expect(juniorDisable(p).ok).toBe(true);
    expect(existsSync(p.skillLink)).toBe(false);
    expect(existsSync(p.config)).toBe(true);
  });
  test("disable when not enabled is a no-op success", () => {
    const { p } = fixture();
    expect(juniorDisable(p).ok).toBe(true);
  });
  test("a DANGLING symlink that was OURS is still 'ours' — status/enable see it enabled, disable removes it cleanly", () => {
    const { p } = fixture();
    juniorEnable(p, "a");
    rmSync(p.skillSrc, { recursive: true, force: true }); // source gone, link now dangling
    expect(existsSync(p.skillLink)).toBe(false); // existsSync follows the (broken) link
    expect(lstatSync(p.skillLink).isSymbolicLink()).toBe(true); // but the link itself is still there
    // status: linkState never resolves the target, only compares the
    // recorded path string, so a dangling-but-ours link still reads "ours".
    expect(juniorStatus(p, {}).lines.join("\n")).toContain("enabled: yes");
    // enable again: idempotent, no attempt to re-symlink over an existing link
    expect(juniorEnable(p).ok).toBe(true);
    const rDisable = juniorDisable(p);
    expect(rDisable.ok).toBe(true);
    expect(rDisable.lines.join("\n")).toContain("junior disabled");
    let stillHasInode = true;
    try { lstatSync(p.skillLink); } catch { stillHasInode = false; }
    expect(stillHasInode).toBe(false);
  });
  test("status reports enabled, account and auth path", () => {
    const { p } = fixture();
    juniorEnable(p, "acct9");
    const lines = juniorStatus(p, {}).lines.join("\n");
    expect(lines).toContain("enabled: yes");
    expect(lines).toContain("account: acct9");
    expect(lines).toContain("auth: wrangler");
    expect(juniorStatus(p, { CLOUDFLARE_API_TOKEN: "x" }).lines.join("\n")).toContain("auth: api-token");
  });
  test("status with no account anywhere reports a clear auth line, not a specific unreachable auth path", () => {
    const { p } = fixture();
    // no CLOUDFLARE_ACCOUNT_ID, no stored config: resolveTransport would
    // throw AuthError (no account) before ever reaching wrangler, so
    // printing `auth: wrangler` here would be misleading.
    const lines = juniorStatus(p, {}).lines.join("\n");
    expect(lines).toContain("account: (none)");
    expect(lines).toContain("auth: (no account — see above)");
    expect(lines).not.toContain("auth: wrangler");
  });
});

describe("fleet junior — real CLI entry point", () => {
  // cmdJunior resolves repoRoot via `join(import.meta.dir, "../../..")`
  // relative to cli/junior.ts's own on-disk location — arithmetic that every
  // test above sidesteps entirely by calling juniorPaths/juniorEnable/etc.
  // directly with hand-built home/repo values. Spawning the real `fleet.ts`
  // entry point below exercises that arithmetic for real.
  //
  // Honesty note: fleet.ts's own header says a real `fleet` invocation goes
  // through a `bun link` symlink hop before reaching this file, and
  // `import.meta.dir` for a symlinked entry point resolves to the symlink's
  // *target* directory (not the symlink's own location) under Bun/Node — so
  // in practice that hop shouldn't change the answer. But reconstructing a
  // realistic `bun link` shim inside a disposable test sandbox is impractical
  // and would mostly be testing `bun link` itself, not this code. This test
  // instead spawns `cli/fleet.ts` directly (no symlink hop) and confirms the
  // depth-of-`..` math lands on the real `skills/junior` in this checkout.
  // The symlink-hop-specific case remains a documented, not fully tested,
  // assumption.
  const fleetTs = join(import.meta.dir, "../../cli/fleet.ts");
  const realRepoRoot = join(import.meta.dir, "../../../..");
  const realSkillSrc = join(realRepoRoot, "skills", "junior");

  async function runFleet(args: string[], home: string) {
    const proc = Bun.spawn(["bun", fleetTs, ...args], {
      cwd: realRepoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: home },
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  }

  test("`fleet junior status` on a clean HOME reports disabled, resolving against the real checkout", async () => {
    const home = mkdtempSync(join(tmpdir(), "junior-real-home-"));
    const r = await runFleet(["junior", "status"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("enabled: no");
  });

  test("`fleet junior enable` symlinks to this checkout's real skills/junior, not a test fixture", async () => {
    const home = mkdtempSync(join(tmpdir(), "junior-real-home-"));
    const r = await runFleet(["junior", "enable", "--account", "acct-real"], home);
    expect(r.code).toBe(0);
    const link = join(home, ".claude", "skills", "junior");
    expect(readlinkSync(link)).toBe(realSkillSrc);
  });
});
