// #1237 nit 3: ff in a no-repo cwd resolves by the one existing studio (attach)
// rather than refusing, and its stderr must say so — the pre-fix line claimed
// "refusing to use the default repo" while still attaching.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FF = join(import.meta.dir, "../../cli/ff.ts");
const STUDIO_ID = "faux--release-studio";
let server: ReturnType<typeof Bun.serve>;
let home: string;
let cwd: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/studio/") {
        return Response.json([
          { id: STUDIO_ID, state: "running", error: null, repoSlug: "acme/faux", tailscaleHost: null, lastRefresh: null },
        ]);
      }
      if (path === `/studio/${STUDIO_ID}/provisioned`) return Response.json({ kind: "provisioned" });
      return new Response("not found", { status: 404 });
    },
  });
  home = mkdtempSync(join(tmpdir(), "ff-norepo-home-"));
  mkdirSync(join(home, ".fleet"));
  const creds = join(home, ".fleet", "credentials");
  writeFileSync(creds, JSON.stringify({ workerUrl: `http://127.0.0.1:${server.port}`, accessClientId: "id", accessClientSecret: "s" }));
  chmodSync(creds, 0o600);
  cwd = mkdtempSync(join(tmpdir(), "ff-norepo-cwd-")); // no .git here
});

afterAll(() => {
  server?.stop(true);
  for (const d of [home, cwd]) if (d) rmSync(d, { recursive: true, force: true });
});

test("ff in a no-repo cwd attaches to the one existing studio and never claims it refused", async () => {
  const proc = Bun.spawn({
    cmd: [process.execPath, FF, "release-studio"],
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_"))),
      HOME: home, TERM_PROGRAM: "not-orca",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(killer);
  expect(code).toBe(0);
  expect(err).toContain("no git remote; resolving by the one existing release-studio studio");
  expect(err).not.toContain("refusing to use the default repo");
  expect(out).not.toContain("refusing");
}, 40_000);