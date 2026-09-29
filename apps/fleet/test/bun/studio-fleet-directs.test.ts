import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

// Issue #59: the in-container `fleet` (container/studio-fleet) gains
// instance-targeted spawn, resume, task new and task assign. Real binary, real
// HTTP: every test runs the script under bun against a local server and
// asserts the exact request it sent. The Worker decides what is allowed —
// these tests pin only what the CLI ASKS for.

const BIN = join(import.meta.dir, "../../container/studio-fleet");
const TOKEN = `fsp_${"a".repeat(64)}`;
let seen: Array<{ method: string; path: string; token: string | null; body: unknown }> = [];
let server: ReturnType<typeof Bun.serve>;
let hangMs = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      seen.push({
        method: req.method, path: new URL(req.url).pathname,
        token: req.headers.get("X-Fleet-Spawn-Token"), body: text === "" ? null : JSON.parse(text),
      });
      if (hangMs > 0) await Bun.sleep(hangMs);
      return Response.json({ id: "websites--web-studio--5", state: "running", number: 71, url: "https://example.test/71" });
    },
  });
});
afterAll(() => server.stop(true));

async function run(args: string[], stdin = "", extraEnv: Record<string, string> = {}) {
  seen = [];
  const p = Bun.spawn(["bun", BIN, ...args], {
    stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH!, FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`, FLEET_SPAWN_TOKEN: TOKEN,
      ...extraEnv,
    },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("studio-fleet spawn — instance targeting", () => {
  test("bare `spawn <role>` sends exactly {role}, as every old caller did", async () => {
    const r = await run(["spawn", "web-studio"]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: "/fleet/spawn", token: TOKEN, body: { role: "web-studio" } }]);
  });

  test("`spawn <role>--<n>` splits into {role, instance}", async () => {
    const r = await run(["spawn", "web-studio--5"]);
    expect(r.code).toBe(0);
    expect(seen[0].body).toEqual({ role: "web-studio", instance: 5 });
  });

  test("`spawn <role> --instance <n>` and `--instance next`", async () => {
    await run(["spawn", "web-studio", "--instance", "3"]);
    expect(seen[0].body).toEqual({ role: "web-studio", instance: 3 });
    await run(["spawn", "web-studio", "--instance", "next"]);
    expect(seen[0].body).toEqual({ role: "web-studio", instance: "next" });
  });

  test("a compound id naming a repo is sent verbatim — the Worker refuses it, the CLI never rewrites it", async () => {
    await run(["spawn", "otherrepo--web-studio"]);
    expect(seen[0].body).toEqual({ role: "otherrepo--web-studio" });
  });

  test("two instances at once is a usage error, no request", async () => {
    const r = await run(["spawn", "web-studio--5", "--instance", "3"]);
    expect(r.code).toBe(1);
    expect(seen).toEqual([]);
  });
});

describe("studio-fleet resume", () => {
  test("`resume <role>--<n>` asks /fleet/spawn with resume: true", async () => {
    const r = await run(["resume", "web-studio--5"]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{
      method: "POST", path: "/fleet/spawn", token: TOKEN, body: { role: "web-studio", instance: 5, resume: true },
    }]);
    expect(r.out).toContain("websites--web-studio--5");
  });

  test("`resume <role>` alone means instance 1", async () => {
    await run(["resume", "web-studio"]);
    expect(seen[0].body).toEqual({ role: "web-studio", resume: true });
  });

  // Review round 1 (M1): a resume runs a whole bring-up and can outlast any
  // socket. The CLI gives up after a deadline, sends exactly ONE request, and
  // tells the lead not to retry — a retry is what used to start a second
  // bring-up (the Worker now refuses it 409 too).
  test("a resume that outlasts its deadline sends ONE request, exits 1, says do not retry", async () => {
    hangMs = 1500;
    try {
      const r = await run(["resume", "web-studio--5"], "", { FLEET_RESUME_TIMEOUT_MS: "200" });
      expect(r.code).toBe(1);
      expect(seen).toHaveLength(1);
      expect(r.err).toContain("do not retry");
    } finally {
      hangMs = 0;
    }
  });

  test("`resume <role> --instance next` is a usage error — resume names the studio it wakes", async () => {
    const r = await run(["resume", "web-studio", "--instance", "next"]);
    expect(r.code).toBe(1);
    expect(seen).toEqual([]);
  });
});

describe("studio-fleet task new / task assign", () => {
  const brief = { title: "T", objective: "O", outputFormat: "F", boundaries: "B" };

  test("`task new --studio <id>` posts the stdin brief with that assignee", async () => {
    const r = await run(["task", "new", "--studio", "websites--web-studio--5"], JSON.stringify(brief));
    expect(r.code).toBe(0);
    expect(seen).toEqual([{
      method: "POST", path: "/fleet/tasks", token: TOKEN, body: { ...brief, assignee: "websites--web-studio--5" },
    }]);
  });

  test("`task new` with the assignee inside the brief posts it as is", async () => {
    await run(["task", "new"], JSON.stringify({ ...brief, assignee: "websites--web-studio" }));
    expect(seen[0].body).toEqual({ ...brief, assignee: "websites--web-studio" });
  });

  test("`task new` with empty stdin is refused, no request", async () => {
    const r = await run(["task", "new", "--studio", "websites--web-studio"]);
    expect(r.code).toBe(1);
    expect(seen).toEqual([]);
  });

  test("`task assign <n> <studio>` posts {assignee}; --why rides along", async () => {
    await run(["task", "assign", "71", "websites--web-studio--5"]);
    expect(seen).toEqual([{
      method: "POST", path: "/fleet/tasks/71/assign", token: TOKEN, body: { assignee: "websites--web-studio--5" },
    }]);
    await run(["task", "assign", "71", "websites--web-studio--5", "--why", "lead died"]);
    expect(seen[0].body).toEqual({ assignee: "websites--web-studio--5", why: "lead died" });
  });

  test("`task assign` without a studio is a usage error, no request", async () => {
    const r = await run(["task", "assign", "71"]);
    expect(r.code).toBe(1);
    expect(seen).toEqual([]);
  });
});
