// apps/fleet/test/bun/memory-cmd.test.ts
// Issue #490 (sweep 11, finding S11-F2): the cmd halves of P5 §9's memory
// pass -- cmdMemoryLs (cli/fleet.ts:2568) and cmdMemoryCompact
// (cli/fleet.ts:2606) -- had no behavioral test. The helpers are covered by
// test/cli.memory-format.test.ts and the Worker routes by
// test/memory.routes.test.ts, but nothing exercised the CLI end to end.
// Same pattern as test/bun/accounts-cli.test.ts: a real `Bun.spawn` of
// cli/fleet.ts, a temp HOME holding a synthetic credentials file (mode
// 600), and a local Bun.serve standing in for the Worker (GET
// /studio/memory, POST /studio/memory/compact). The child runs in a temp
// cwd with NO .git, so detectRepo() falls back and reportRepo prints its
// fallback stderr line -- which also pins the no-query GET URL shape.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLEET = join(import.meta.dir, "../../cli/fleet.ts");

const tempDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function writeCredentials(home: string, workerUrl: string) {
  mkdirSync(join(home, ".fleet"));
  const path = join(home, ".fleet", "credentials");
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "id", accessClientSecret: "secret" }));
  chmodSync(path, 0o600);
}

// The two MemoryFileRow fixtures test/cli.memory-format.test.ts already
// uses -- reused here, never new inline data.
const ROWS = [
  { target: "websites--pilot/a.md", citations: 3, ageMs: 9 * 24 * 3600 * 1000, indexed: true, verdict: "promote" },
  { target: "websites--web-studio/bb.md", citations: 0, ageMs: null, indexed: false, verdict: "hold" },
];

// src/memory/routes.ts's survey response shape, with the counts the header
// line prints: 2 index line(s), 2 file(s), 1 unindexed.
const SURVEY = {
  repo: "acme-org/websites", ref: "main", boardRepo: "acme-org/websites",
  index: [{ title: "a.md -- bump rollout_step_percentage" }, { title: "bb.md -- ipv6-bind" }],
  files: ROWS,
  unindexed: ["cc.md"],
  candidates: [],
  truncated: false,
};

// src/memory/routes.ts's compact response shape (pr/branch/summary).
const COMPACT = {
  repo: "acme-org/websites", branch: "fleet/memory-compaction-2026-10-12", commit: "sha",
  pr: 91, url: "https://github.com/acme-org/websites/pull/91",
  summary: { merged: 3, demoted: 2, promoted: 1, archived: 4, indexLines: 12 },
  truncated: false,
};

/** Bun.serve standing in for the Worker. Records every request (method,
 *  full path incl. search, POST body text) so tests can assert URL shapes
 *  and that the invalid-stdin refusal never POSTs at all. */
function startMemoryWorker() {
  const requests: { method: string; path: string; body?: string }[] = [];
  const state = { survey: SURVEY, compact: COMPACT, surveyStatus: 200 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/studio/memory" && req.method === "GET") {
        requests.push({ method: "GET", path: url.pathname + url.search });
        if (state.surveyStatus !== 200) return new Response("boom", { status: state.surveyStatus });
        return Response.json(state.survey);
      }
      if (url.pathname === "/studio/memory/compact" && req.method === "POST") {
        requests.push({ method: "POST", path: url.pathname, body: await req.text() });
        return Response.json(state.compact);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requests, state };
}

/** Spawns the real CLI. `stdinBytes === undefined` means stdin closed
 *  immediately; any other value (including "") is piped in and closed, so
 *  cmdMemoryCompact's read-to-EOF sees exactly those bytes. */
async function run(args: string[], home: string, cwd: string, stdinBytes?: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    env: { ...process.env, HOME: home },
    cwd,
    stdin: stdinBytes === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdinBytes !== undefined) {
    // `!`: stdin is "pipe" exactly when stdinBytes !== undefined (the
    // ternary above), so the sink always exists inside this guard — but the
    // ternary types Bun's In generic as "pipe" | "ignore", leaving stdin
    // FileSink | undefined to tsc's eyes.
    proc.stdin!.write(stdinBytes);
    proc.stdin!.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

// One temp cwd per test, never git-init-ed: detectRepo's `git remote
// get-url origin` fails there, which is the fallback path reportRepo
// prints and the no-?repo= GET this suite pins.
async function setup() {
  const home = tmpDir("memory-home-");
  const cwd = tmpDir("memory-cwd-");
  const worker = startMemoryWorker();
  writeCredentials(home, `http://127.0.0.1:${worker.server.port}`);
  return { home, cwd, worker };
}

describe("fleet memory ls", () => {
  test("prints header counts, legend and table; GET hits /studio/memory with no ?repo= query", async () => {
    const { home, cwd, worker } = await setup();
    try {
      const r = await run(["memory", "ls"], home, cwd);

      expect(r.code).toBe(0);
      expect(r.out).toContain("memory: acme-org/websites@main — 2 index line(s), 2 file(s), 1 unindexed");
      expect(r.out).toContain("VERDICT: promote = cited by 3+ tasks");
      expect(r.out).toContain("websites--pilot/a.md");
      expect(r.out).toContain("promote");
      expect(r.out).not.toContain("WARNING: citation survey truncated");
      // reportRepo's fallback stderr line -- git's own message text varies
      // by version, so pin only the shape around it.
      expect(r.err).toMatch(/fleet memory ls: .* — using the fleet's default repo/);
      expect(worker.requests).toEqual([{ method: "GET", path: "/studio/memory" }]);
    } finally {
      worker.server.stop(true);
    }
  });

  test("truncated survey prints the issue #187 WARNING, exact line (issue #490: the truncated half)", async () => {
    const { home, cwd, worker } = await setup();
    try {
      worker.state.survey = { ...SURVEY, truncated: true };
      const r = await run(["memory", "ls"], home, cwd);

      expect(r.code).toBe(0);
      expect(r.out).toContain("WARNING: citation survey truncated -- some issues were not scanned, see Worker logs");
    } finally {
      worker.server.stop(true);
    }
  });

  test("a non-ok survey exits 1 with the status line on stderr, no table on stdout", async () => {
    const { home, cwd, worker } = await setup();
    try {
      worker.state.surveyStatus = 500;
      const r = await run(["memory", "ls"], home, cwd);

      expect(r.code).toBe(1);
      expect(r.err).toContain("fleet memory ls: 500 boom");
      expect(r.out).not.toContain("VERDICT:");
      expect(r.out).not.toContain("memory: acme-org/websites@main");
    } finally {
      worker.server.stop(true);
    }
  });
});

describe("fleet memory compact", () => {
  test("empty stdin is the bootstrap run: POST body {}, PR/branch/summary lines (issue #490: the summary half)", async () => {
    const { home, cwd, worker } = await setup();
    try {
      const r = await run(["memory", "compact"], home, cwd, "");

      expect(r.code).toBe(0);
      expect(r.out).toContain("PR #91  https://github.com/acme-org/websites/pull/91");
      expect(r.out).toContain("branch fleet/memory-compaction-2026-10-12");
      expect(r.out).toContain(
        "merged 3, demoted 2, promoted 1; 4 file(s) MOVED to fleet/memory/archive/ (none deleted); index now 12 line(s)",
      );
      const posts = worker.requests.filter((req) => req.method === "POST");
      expect(posts.length).toBe(1);
      expect(posts[0].body).toBe("{}");
    } finally {
      worker.server.stop(true);
    }
  });

  test("a truncated compact answer prints the same WARNING line as ls (issue #187)", async () => {
    const { home, cwd, worker } = await setup();
    try {
      worker.state.compact = { ...COMPACT, truncated: true };
      const r = await run(["memory", "compact"], home, cwd, "");

      expect(r.code).toBe(0);
      expect(r.out).toContain("WARNING: citation survey truncated -- some issues were not scanned, see Worker logs");
    } finally {
      worker.server.stop(true);
    }
  });

  test("invalid stdin JSON: exit 1, the exact refusal on stderr, and ZERO POSTs reach the Worker", async () => {
    const { home, cwd, worker } = await setup();
    try {
      const r = await run(["memory", "compact"], home, cwd, "not json at all");

      expect(r.code).toBe(1);
      expect(r.err).toContain("fleet memory compact: stdin is not valid JSON (send {} or nothing for a bootstrap run)");
      expect(worker.requests.length).toBe(0);
    } finally {
      worker.server.stop(true);
    }
  });

  test("valid-JSON stdin is passed through to the Worker as the exact body text", async () => {
    const { home, cwd, worker } = await setup();
    try {
      const r = await run(["memory", "compact"], home, cwd, '{"proposal":{"merge":["x"]}}');

      expect(r.code).toBe(0);
      const posts = worker.requests.filter((req) => req.method === "POST");
      expect(posts.length).toBe(1);
      expect(posts[0].body).toBe('{"proposal":{"merge":["x"]}}');
    } finally {
      worker.server.stop(true);
    }
  });
});
