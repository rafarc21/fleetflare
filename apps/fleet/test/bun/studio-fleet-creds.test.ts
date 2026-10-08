import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

// Issue #279: `fleet creds get <name>` in the studio container. Real binary,
// real HTTP against a local fake Worker. The value goes to STDOUT only, alone,
// so `$(fleet creds get viewer)` works; it never reaches stderr, and an error
// path prints only the Worker's own body (which never carries a value).

const BIN = join(import.meta.dir, "../../container/studio-fleet");
const TOKEN = `fsp_${"b".repeat(64)}`;
const VALUE = "fake-cli-secret-91ab";
let seen: Array<{ method: string; path: string; token: string | null }> = [];
let reply: () => Response = () => Response.json({ name: "viewer", value: VALUE });
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ method: req.method, path: new URL(req.url).pathname, token: req.headers.get("X-Fleet-Spawn-Token") });
      return reply();
    },
  });
});
afterAll(() => server.stop(true));

async function run(args: string[]) {
  seen = [];
  const p = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`, FLEET_SPAWN_TOKEN: TOKEN },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("studio-fleet creds get", () => {
  test("GETs /fleet/creds/<name> with the spawn token and prints only the value", async () => {
    reply = () => Response.json({ name: "viewer", value: VALUE });
    const r = await run(["creds", "get", "viewer"]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "GET", path: "/fleet/creds/viewer", token: TOKEN }]);
    expect(r.out).toBe(`${VALUE}\n`);
    expect(r.err).not.toContain(VALUE);
  });

  test("a Worker refusal exits 1 with the Worker's body on stderr, nothing on stdout", async () => {
    reply = () => new Response("test creds not configured", { status: 503 });
    const r = await run(["creds", "get", "viewer"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("(503): test creds not configured");
  });

  test("a 200 without a string value fails instead of printing raw JSON", async () => {
    reply = () => Response.json({ name: "viewer" });
    const r = await run(["creds", "get", "viewer"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });

  // Review round 1, fix 4: a non-JSON 200 is never echoed to stdout.
  test("a non-JSON 200 goes to stderr as an error, exit 1, nothing on stdout", async () => {
    reply = () => new Response("not json at all", { status: 200 });
    const r = await run(["creds", "get", "viewer"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("not JSON");
    expect(r.err).not.toContain("not json at all");
  });

  test("usage errors never call the Worker", async () => {
    for (const args of [["creds"], ["creds", "get"], ["creds", "ls"], ["creds", "get", "a/b"], ["creds", "get", "x", "y"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(seen).toEqual([]);
    }
  });

  test("--help documents the verb and the never-paste rule", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("fleet creds get <name>");
    expect(r.out).toMatch(/never paste/i);
  });
});
