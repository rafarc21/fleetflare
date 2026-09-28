// Task 8: `fleet junior enable|disable|status` — local opt-in. Purely a
// symlink from ~/.claude/skills/junior to this checkout's skills/junior/,
// plus a config file storing an account id. Never touches the Worker or any
// studio.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
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
  test("status reports enabled, account and auth path", () => {
    const { p } = fixture();
    juniorEnable(p, "acct9");
    const lines = juniorStatus(p, {}).lines.join("\n");
    expect(lines).toContain("enabled: yes");
    expect(lines).toContain("account: acct9");
    expect(lines).toContain("auth: wrangler");
    expect(juniorStatus(p, { CLOUDFLARE_API_TOKEN: "x" }).lines.join("\n")).toContain("auth: api-token");
  });
});
