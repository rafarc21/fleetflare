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

beforeAll(async () => {
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
  // #1398 side-PR: the gate container's CPU contention makes a COLD
  // `bun container/studio-fleet` child miss the 5 s default on its first 1-2
  // spawns (later tests run warm and pass). Warm it once here so the first
  // real test is not the one paying the JIT/startup cost. --help exits 0 with
  // no server, so this is a cheap warm, bounded at 30 s.
  // Same sh-wrapper trick as run(): EOF on the child's pipes is the exit
  // signal, never p.exited (which can hang on a dead child under the gate's
  // no-init PID1).
  const warm = Bun.spawn(["sh", "-c", 'bun "$0" "$@"; echo "__EXIT=$?" >&2', BIN, "--help"], {
    stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH! },
  });
  await Promise.race([
    Promise.all([new Response(warm.stdout).text(), new Response(warm.stderr).text()]).then(() => undefined),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        try { warm.kill(); } catch { /* already gone */ }
        reject(new Error("studio-fleet --help warm timed out after 30 s"));
      }, 30_000);
    }),
  ]);
}, { timeout: 35_000 });
afterAll(() => server.stop(true));

async function run(args: string[], stdin = "", extraEnv: Record<string, string> = {}) {
  seen = [];
  // #1398 side-PR: run the child under sh, which echoes its real exit code to
  // stderr after it returns. EOF on both pipes means the shell has closed its
  // fds — i.e. the child has exited — even when bun never delivers the exit
  // event (gate PID1 has no init, so p.exited can hang forever on a dead child).
  const p = Bun.spawn(["sh", "-c", 'bun "$0" "$@"; echo "__EXIT=$?" >&2', BIN, ...args], {
    stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH!, FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`, FLEET_SPAWN_TOKEN: TOKEN,
      ...extraEnv,
    },
  });
  const [out, errRaw] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const m = /__EXIT=(\d+)\s*$/.exec(errRaw);
  // No marker = sh never reached the echo (its own failure); treat as failure.
  const code = m ? Number(m[1]) : 1;
  const err = errRaw.replace(/__EXIT=\d+\s*$/, "").trimEnd();
  return { out, err, code };
}

describe("studio-fleet spawn — instance targeting", () => {
  test("bare `spawn <role>` sends exactly {role}, as every old caller did", async () => {
    const r = await run(["spawn", "web-studio"]);
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ method: "POST", path: "/fleet/spawn", token: TOKEN, body: { role: "web-studio" } }]);
  }, { timeout: 15_000 });

  test("`spawn <role>--<n>` splits into {role, instance}", async () => {
    const r = await run(["spawn", "web-studio--5"]);
    expect(r.code).toBe(0);
    expect(seen[0].body).toEqual({ role: "web-studio", instance: 5 });
  }, { timeout: 15_000 });

  test("`spawn <role> --instance <n>` and `--instance next`", async () => {
    await run(["spawn", "web-studio", "--instance", "3"]);
    expect(seen[0].body).toEqual({ role: "web-studio", instance: 3 });
    await run(["spawn", "web-studio", "--instance", "next"]);
    expect(seen[0].body).toEqual({ role: "web-studio", instance: "next" });
  }, { timeout: 15_000 });

  test("a compound id naming a repo is sent verbatim — the Worker refuses it, the CLI never rewrites it", async () => {
    await run(["spawn", "otherrepo--web-studio"]);
    expect(seen[0].body).toEqual({ role: "otherrepo--web-studio" });
  }, { timeout: 15_000 });

  test("two instances at once is a usage error, no request", async () => {
    const r = await run(["spawn", "web-studio--5", "--instance", "3"]);
    expect(r.code).toBe(1);
    expect(seen).toEqual([]);
  }, { timeout: 15_000 });
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
