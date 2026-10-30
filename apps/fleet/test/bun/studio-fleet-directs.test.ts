import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// The gate container runs bun-test under PID1 with no init, so a child's
// exit event is never reaped: `p.exited` can hang forever on a dead child,
// and pipe EOF is unreliable — the write end can leak into an unrelated
// live process (a grandchild), so the reader never sees EOF. Exit is
// signalled by a FILE the wrapper writes last, polled until it appears:
// the file is a plain readdir/stat on a private tmpdir, no pipe fds at all.
function markerDir(): string {
  return mkdtempSync(join(tmpdir(), "studio-fleet-directs-"));
}

async function readMarker(dir: string, file: string): Promise<string> {
  const path = join(dir, file);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.trim() !== "") return text;
    }
    if (Date.now() > deadline) throw new Error(`marker ${file} never appeared within 20 s`);
    await Bun.sleep(20);
  }
}

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
  // Exit signalled by a marker file, never p.exited or pipe EOF (both can
  // hang under the gate's no-init PID1).
  const warmDir = markerDir();
  const warmCode = join(warmDir, "code");
  Bun.spawn(["sh", "-c", 'bun "$0" "$@" >"$O" 2>"$E"; echo "$?" >"$C"', BIN, "--help"], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
    env: { PATH: process.env.PATH!, O: `${warmDir}/out`, E: `${warmDir}/err`, C: warmCode },
  });
  const warmExit = Number((await readMarker(warmDir, "code")).trim());
  if (warmExit !== 0) {
    throw new Error(`studio-fleet --help warm exited ${warmExit}`);
  }
  rmSync(warmDir, { recursive: true, force: true });
}, { timeout: 35_000 });
afterAll(() => server.stop(true));

async function run(args: string[], stdin = "", extraEnv: Record<string, string> = {}) {
  seen = [];
  // Exit signalled by a marker file written last by the sh wrapper, polled
  // until it appears — never p.exited and never pipe EOF, both of which can
  // hang under the gate's no-init PID1 (pipe EOF is the rarer flake: the
  // child's write end can leak into an unrelated live process, so the reader
  // never sees it). stdout/stderr go to files in a private tmpdir; the child
  // never inherits a pipe that anything else could hold open.
  const dir = markerDir();
  const codePath = join(dir, "code");
  try {
    Bun.spawn(["sh", "-c", 'bun "$0" "$@" >"$O" 2>"$E"; echo "$?" >"$C"', BIN, ...args], {
      stdin: new Blob([stdin]), stdout: "ignore", stderr: "ignore",
      env: {
        PATH: process.env.PATH!, FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`, FLEET_SPAWN_TOKEN: TOKEN,
        O: `${dir}/out`, E: `${dir}/err`, C: codePath,
        ...extraEnv,
      },
    });
    const code = Number((await readMarker(dir, "code")).trim());
    const out = existsSync(join(dir, "out")) ? readFileSync(join(dir, "out"), "utf8") : "";
    const err = existsSync(join(dir, "err")) ? readFileSync(join(dir, "err"), "utf8").trimEnd() : "";
    return { out, err, code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
