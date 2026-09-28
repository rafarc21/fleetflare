import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProxyConfigCmd } from "../../src/write-proxy/container-config";

/**
 * Issue #7 -- the studio's git config in each write mode, asked of REAL git
 * (credentials.ts's header: reasoning about git's credential matching has
 * been wrong twice in this repo). HOME is a temp dir; nothing global touched.
 */

const WORKER = "https://fleet.example.workers.dev";
const TOKEN = `fsp_${"a".repeat(64)}`;
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function home() {
  const d = mkdtempSync(join(tmpdir(), "fleet-wp-"));
  dir = d;
  const env = { HOME: d, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", FLEET_SPAWN_TOKEN: TOKEN };
  const marker = join(d, "opt", "write-proxy");
  const sh = (cmd: string, stdin = "") => {
    const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], env, cwd: d, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { d, marker, sh, apply: (mode: "proxy" | "direct") => sh(writeProxyConfigCmd(mode, WORKER, { realGit: "git", marker })) };
}

describe("writeProxyConfigCmd", () => {
  test("proxy: one pushInsteadOf to the Worker, repeat-safe", () => {
    const h = home();
    expect(h.apply("proxy").code).toBe(0);
    expect(h.apply("proxy").code).toBe(0);
    const r = h.sh("git config --global --get-all url.https://fleet.example.workers.dev/fleet/git/github.com/.pushInsteadOf");
    expect(r.out).toBe("https://github.com/\n");
  });

  test("proxy: push url rewritten, fetch url untouched (asked of git)", () => {
    const h = home();
    h.apply("proxy");
    h.sh("git init -q r && git -C r remote add origin https://github.com/example-org/demo.git");
    expect(h.sh("git -C r remote get-url --push origin").out.trim())
      .toBe(`${WORKER}/fleet/git/github.com/example-org/demo.git`);
    expect(h.sh("git -C r remote get-url origin").out.trim()).toBe("https://github.com/example-org/demo.git");
  });

  test("proxy: git credential fill for the Worker answers the spawn token, read from env at run time", () => {
    const h = home();
    h.apply("proxy");
    expect(readFileSync(join(h.d, ".gitconfig"), "utf8")).not.toContain(TOKEN);
    const r = h.sh("git credential fill", `url=${WORKER}/fleet/git/github.com/example-org/demo.git\n\n`);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`password=${TOKEN}`);
  });

  test("proxy: github.com credentials are not answered by the Worker helper", () => {
    const h = home();
    h.apply("proxy");
    const r = h.sh("GIT_TERMINAL_PROMPT=0 git credential fill", "url=https://github.com/example-org/demo.git\n\n");
    expect(r.out).not.toContain(TOKEN);
  });

  test("proxy: marker written with the Worker url; direct: all of it removed", () => {
    const h = home();
    h.apply("proxy");
    expect(readFileSync(h.marker, "utf8").trim()).toBe(WORKER);
    expect(h.apply("direct").code).toBe(0);
    expect(existsSync(h.marker)).toBe(false);
    expect(h.sh("git config --global --get-regexp 'fleet/git'").out).toBe("");
    expect(h.apply("direct").code).toBe(0);
  });

  test("a trailing slash on the Worker url is normalized", () => {
    const h = home();
    expect(h.sh(writeProxyConfigCmd("proxy", `${WORKER}/`, { realGit: "git", marker: h.marker })).code).toBe(0);
    expect(h.sh("git config --global --get-regexp pushinsteadof").out).toContain(`${WORKER}/fleet/git/github.com/`);
  });
});
