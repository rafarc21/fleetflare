// Board issue #105 (pre-gate), end to end: the REAL container/studio-fleet
// binary, spawned as a subprocess (same technique test/bun/attach-liveness.
// test.ts already uses for cli/fleet.ts) against a local fake Worker, proving
// the full "task report" wire contract — not just the pure functions
// test/bun/studio-fleet-pregate.test.ts already covers directly.
//
// STUDIO_ID's repo-root derivation is hardcoded to `/workspace/<repo>` (see
// resolveRepoRoot's own doc comment — the SAME derivation
// container/studio-bringup.sh's claude-launch step uses), so these tests
// write a real, uniquely-named fleet.json under the real /workspace rather
// than a tmpdir, and remove it again in afterEach — the one thing this
// feature's own repo-root resolution cannot be redirected away from.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../container/studio-fleet");
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fleetRepoDir(studioId: string): string {
  return `/workspace/${studioId.split("--")[0]}`;
}

function withFleetJson(studioId: string, fleetJson: Record<string, unknown> | null): void {
  const dir = fleetRepoDir(studioId);
  mkdirSync(dir, { recursive: true });
  if (fleetJson !== null) writeFileSync(join(dir, "fleet.json"), JSON.stringify(fleetJson));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
}

/** A fake Worker recording every /fleet/tasks/<n>/envelope POST it receives. */
function fakeWorker(): { url: string; posts: { body: string }[]; close: () => void } {
  const posts: { body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      posts.push({ body: await req.text() });
      return new Response(JSON.stringify({ url: "https://github.com/o/r/issues/1#comment" }), { status: 200 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, posts, close: () => server.stop(true) };
}

function runReport(
  studioId: string, workerUrl: string, taskNumber: number, envelope: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, "task", "report", String(taskNumber)], {
    env: { ...process.env, STUDIO_ID: studioId, FLEET_WORKER_URL: workerUrl, FLEET_SPAWN_TOKEN: "test-token" },
    stdin: Buffer.from(JSON.stringify(envelope)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
}

describe("studio-fleet task report — pre-gate wiring (board issue #105)", () => {
  test("no fleet.json at all -> posts unchanged, no pre_gate field, exit 0", async () => {
    const studioId = "pregate-none--web-studio";
    withFleetJson(studioId, null);
    const worker = fakeWorker();
    const r = await runReport(studioId, worker.url, 1, { intent: "result", status: "ok" });
    expect(r.exitCode).toBe(0);
    expect(worker.posts).toHaveLength(1);
    expect(JSON.parse(worker.posts[0].body)).toEqual({ intent: "result", status: "ok" });
  });

  test("fleet.json with no preflight field -> same complete no-op", async () => {
    const studioId = "pregate-empty--web-studio";
    withFleetJson(studioId, { blueprint: { repo: "o/r", ref: "main" }, roles: [], instance_type: "standard-2" });
    const worker = fakeWorker();
    const r = await runReport(studioId, worker.url, 1, { intent: "result", status: "ok" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(worker.posts[0].body).pre_gate).toBeUndefined();
  });

  test("a green pre-gate posts, with pre_gate attached", async () => {
    const studioId = "pregate-green--web-studio";
    withFleetJson(studioId, { preflight: "echo all-good; exit 0" });
    const worker = fakeWorker();
    const r = await runReport(studioId, worker.url, 1, { intent: "result", status: "ok" });
    expect(r.exitCode).toBe(0);
    const posted = JSON.parse(worker.posts[0].body);
    expect(posted.pre_gate).toEqual({ cmd: "echo all-good; exit 0", exit: 0, output: "all-good\n" });
  });

  test("a RED pre-gate + result/ok -> REFUSED, nothing posted, exit 1, stderr names the failure", async () => {
    const studioId = "pregate-red-ok--web-studio";
    withFleetJson(studioId, { preflight: "echo broken >&2; exit 1" });
    const worker = fakeWorker();
    const r = await runReport(studioId, worker.url, 1, { intent: "result", status: "ok" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("pre-gate failed");
    expect(r.stderr).toContain("broken");
    expect(worker.posts).toHaveLength(0);
  });

  test("a RED pre-gate + result/blocked -> still posts, pre_gate attached, exit 0 (not refused)", async () => {
    const studioId = "pregate-red-blocked--web-studio";
    withFleetJson(studioId, { preflight: "exit 1" });
    const worker = fakeWorker();
    const r = await runReport(studioId, worker.url, 1, { intent: "result", status: "blocked" });
    expect(r.exitCode).toBe(0);
    expect(worker.posts).toHaveLength(1);
    expect(JSON.parse(worker.posts[0].body).pre_gate.exit).toBe(1);
  });

  test("a RED pre-gate + a \"request\" intent -> still posts, never refused regardless of status", async () => {
    const studioId = "pregate-red-request--web-studio";
    withFleetJson(studioId, { preflight: "exit 1" });
    const worker = fakeWorker();
    const r = await runReport(studioId, worker.url, 1, { intent: "request", status: "ok" });
    expect(r.exitCode).toBe(0);
    expect(worker.posts).toHaveLength(1);
    expect(JSON.parse(worker.posts[0].body).pre_gate.exit).toBe(1);
  });
});
