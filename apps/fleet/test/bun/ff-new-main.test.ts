// #294 r2: `main()`'s own wiring for `ff <role> --new "<task>"` -- the task is
// filed ONCE, AFTER the spawn, against the id the spawn returned. The real
// cli/ff.ts runs as a subprocess against a stub Worker (same harness as
// ff-no-tty.test.ts), so a task filed before the spawn -- e.g. the pre-spawn
// filing block no longer skipping `--new` -- shows up in the observed traffic.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FF = join(import.meta.dir, "../../cli/ff.ts");
const SPAWNED = "faux--pilot";

const traffic: { method: string; path: string; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;
let repo: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      traffic.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/studio/" && req.method === "GET") return Response.json([]);
      if (url.pathname === "/studio/spawn") {
        return Response.json({ id: SPAWNED, state: "running", error: null, repoSlug: "acme/faux", tailscaleHost: null, lastRefresh: null });
      }
      if (url.pathname === `/studio/${SPAWNED}/provisioned`) return Response.json({ kind: "provisioned" });
      if (url.pathname === "/studio/board/tasks" && req.method === "POST") {
        return Response.json({ number: 501, url: "https://github.com/acme/faux/issues/501", title: "t", state: "submitted" });
      }
      if (url.pathname === "/studio/board/tasks" && req.method === "GET") return Response.json([]);
      return new Response("not found", { status: 404 });
    },
  });
  home = mkdtempSync(join(tmpdir(), "fleet-ffnew-home-"));
  mkdirSync(join(home, ".fleet"));
  const credentials = join(home, ".fleet", "credentials");
  writeFileSync(credentials, JSON.stringify({ workerUrl: `http://127.0.0.1:${server.port}`, accessClientId: "id", accessClientSecret: "s" }));
  chmodSync(credentials, 0o600);
  repo = mkdtempSync(join(tmpdir(), "fleet-ffnew-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/faux.git"], { cwd: repo });
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ff <role> --new \"<task>\" — main() files the task once, after the spawn (#294 r2)", () => {
  test("one task POST, after the spawn, assigned to the spawned id", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, FF, "pilot", "--new", "do the thing"],
      cwd: repo,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_"))), HOME: home, TERM_PROGRAM: "not-orca" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(killer);

    const spawnAt = traffic.findIndex((t) => t.path === "/studio/spawn");
    const filed = traffic.map((t, i) => ({ ...t, i })).filter((t) => t.path === "/studio/board/tasks" && t.method === "POST");
    expect(spawnAt, stderr).toBeGreaterThanOrEqual(0);
    expect((traffic[spawnAt].body as { instance?: unknown }).instance).toBe("next");
    expect(filed).toHaveLength(1);
    expect(filed[0].i).toBeGreaterThan(spawnAt);
    expect((filed[0].body as { assignee?: string }).assignee).toBe(SPAWNED);
  }, 40_000);
});
