// apps/fleet/test/bun/junior-stats-cli.test.ts
// Issue #218: `fleet junior stats` — merges the local usage-log (laptop/
// direct-transport calls, this machine only) with the Worker's aggregated
// /studio/junior/usage (studio/proxy-transport calls, across every studio).
// Mirrors junior-local-cli.test.ts's real-subprocess-against-a-real-HOME
// pattern; the Worker side here is a real local Bun.serve, never mocked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLEET = join(import.meta.dir, "../../cli/fleet.ts");

function writeCredentials(home: string, workerUrl: string) {
  mkdirSync(join(home, ".fleet"), { recursive: true });
  const path = join(home, ".fleet", "credentials");
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "id", accessClientSecret: "secret" }));
  chmodSync(path, 0o600);
}

function writeLocalUsage(home: string, lines: Record<string, unknown>[]) {
  const dir = join(home, ".local", "share", "fleet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "junior-usage.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "junior-stats-home-"));
}

async function run(args: string[], home: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    env: { PATH: process.env.PATH!, HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

describe("fleet junior stats", () => {
  test("no credentials file: fails the same documented way every other authenticated verb does", async () => {
    const home = tmpHome();
    const r = await run(["junior", "stats"], home);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no credentials file at");
    rmSync(home, { recursive: true, force: true });
  });

  test("bad --since value is a usage error, exit 1", async () => {
    const home = tmpHome();
    writeCredentials(home, "http://127.0.0.1:1");
    const r = await run(["junior", "stats", "--since", "not-a-duration"], home);
    expect(r.code).toBe(1);
    expect(r.err.length).toBeGreaterThan(0);
    rmSync(home, { recursive: true, force: true });
  });

  test("Worker unreachable: still prints local-only stats, warns, exits 0 (graceful degradation)", async () => {
    const home = tmpHome();
    // Nothing listens on this port.
    writeCredentials(home, "http://127.0.0.1:1");
    writeLocalUsage(home, [
      { ts: NOW, id: "laptop-a", mode: "edit", model: "glm", input_tokens: 10, output_tokens: 20, ok: true },
      { ts: NOW, id: "laptop-a", mode: "text", model: "glm", input_tokens: 5, output_tokens: 5, ok: true },
    ]);
    const r = await run(["junior", "stats"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("laptop-a");
    expect(r.out).toMatch(/laptop-a\s+2\s+15\s+25/);
    expect(r.out).toContain("TOTAL");
    expect(r.err.toLowerCase()).toContain("fleet-wide stats unavailable");
    rmSync(home, { recursive: true, force: true });
  });

  test("merges Worker rows with the local row, prints a TOTAL summing both", async () => {
    const home = tmpHome();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/studio/junior/usage") {
          return Response.json({
            rows: [{ studioId: "pilot--acme-x", calls: 3, inputTokens: 100, outputTokens: 50 }],
            totals: { calls: 3, inputTokens: 100, outputTokens: 50 },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);
    writeLocalUsage(home, [
      { ts: NOW, id: "laptop-b", mode: "edit", model: "glm", input_tokens: 7, output_tokens: 3, ok: true },
    ]);
    const r = await run(["junior", "stats"], home);
    server.stop(true);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pilot--acme-x");
    expect(r.out).toContain("laptop-b");
    // TOTAL = Worker (3 calls/100 in/50 out) + local (1 call/7 in/3 out)
    expect(r.out).toMatch(/TOTAL\s+4\s+107\s+53/);
    rmSync(home, { recursive: true, force: true });
  });

  test("--since filters out local rows older than the cutoff", async () => {
    const home = tmpHome();
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({ rows: [], totals: { calls: 0, inputTokens: 0, outputTokens: 0 } });
      },
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);
    writeLocalUsage(home, [
      { ts: NOW - 10 * DAY, id: "laptop-c", mode: "edit", model: "glm", input_tokens: 999, output_tokens: 999, ok: true },
      { ts: NOW, id: "laptop-c", mode: "edit", model: "glm", input_tokens: 1, output_tokens: 2, ok: true },
    ]);
    const r = await run(["junior", "stats", "--since", "1d"], home);
    server.stop(true);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/laptop-c\s+1\s+1\s+2/);
    expect(r.out).not.toContain("999");
    rmSync(home, { recursive: true, force: true });
  });
});
