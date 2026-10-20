// apps/fleet/test/bun/cli.spawn-no-remote.test.ts
// Issue #1229: `fleet spawn` / `fleet provision` refuse a cwd with no git
// remote instead of falling back to the fleet's default repo (measured
// 2026-10-19: a scratchpad `fleet spawn pilot` spawned 3 idling, billing
// pilots on the default repo). Only the CREATING verbs refuse; provision's
// address-by-id path (a studio id not derived from the cwd) stays bodyless.
//
// bun:test lane, not vitest: cli/fleet.ts is Bun-only (Bun.spawn, Bun.file,
// process.exit) and is never imported from the vitest suite. Same harness as
// cli.task-verify.test.ts: a real `Bun.spawn` of cli/fleet.ts against a local
// `Bun.serve` Worker stand-in, a temp HOME whose `~/.fleet/credentials` names
// the stand-in, and a temp cwd with NO `.git` in it — detectRepo then yields
// `{slug: null}`, so the refusal paths are hermetic (never this checkout's own
// remote). The stand-in records every request and answers 404 for anything it
// was not supposed to serve, so "zero Worker calls on refusal" is an assertion
// about observed traffic, not about the absence of output.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeCredentials } from "./helpers/credentials";
import { cleanupTempDirs, FLEET, tmpDir } from "./helpers/fleet-cli";

const FF = join(import.meta.dir, "../../cli/ff.ts");

afterEach(cleanupTempDirs);

/** Spawns `fleet <args>` with the given HOME (credentials) and a cwd that
 *  holds no `.git` — detectRepo's `git remote get-url origin` fails there, so
 *  the no-repo refusal is hermetic, never reading this checkout's own remote.
 *  Mirrors helpers/fleet-cli.ts's runFleet, but that helper hardcodes the
 *  spawn cwd; the refusal this suite pins depends on the cwd naming no repo. */
async function runFleetIn(args: string[], home: string, cwd: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    cwd,
    env: { PATH: process.env.PATH!, HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

/** Spawns `ff <args>` with the given HOME and a no-.git cwd — same refusal
 *  hermeticity as runFleetIn, but for cli/ff.ts. Drops inherited ORCA_* the
 *  way ff-no-tty.test.ts does, so the process never shells a real `orca`. */
async function runFfIn(args: string[], home: string, cwd: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FF, ...args],
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_"))),
      PATH: process.env.PATH!, HOME: home, TERM_PROGRAM: "not-orca",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

interface SeenRequest { method: string; path: string; body: unknown }

/** The spawn row the stand-in answers /studio/spawn with. The three fields
 *  parseStudioStatus demands (id/state/error) plus repoSlug, so the spawn
 *  print path has a real row to render. */
const SPAWNED = {
  id: "faux--pilot", state: "running", error: null, repoSlug: "acme/faux",
  tailscaleHost: null, lastRefresh: null,
};

/**
 * The stand-in Worker. Answers:
 *   POST /studio/spawn                    -> SPAWNED
 *   POST /studio/faux--pilot/provision    -> SPAWNED (provision print path)
 *   GET  /studio/board/tasks?...          -> [] (listStudioTasks on success)
 * Anything else — including GET /studio/ itself, which spawn/provision never
 * call on their own — is 404. Every request is recorded.
 */
function startStandIn() {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const record = async (): Promise<unknown> => {
        const body = await req.json().catch(() => null);
        seen.push({ method: req.method, path: url.pathname, body });
        return body;
      };
      if (url.pathname === "/studio/spawn") {
        await record();
        return Response.json(SPAWNED);
      }
      if (url.pathname === "/studio/faux--pilot/provision") {
        await record();
        return Response.json(SPAWNED);
      }
      if (url.pathname === "/studio/" && req.method === "GET") {
        seen.push({ method: req.method, path: url.pathname, body: null });
        return Response.json([]);
      }
      if (url.pathname === "/studio/board/tasks") {
        seen.push({ method: req.method, path: url.pathname, body: null });
        return Response.json([]);
      }
      seen.push({ method: req.method, path: url.pathname, body: null });
      return new Response("not found", { status: 404 });
    },
  });
  return { server, seen };
}

describe("fleet spawn refuses a no-git-remote cwd (issue #1229)", () => {
  test("non-git cwd, bare `fleet spawn pilot`: exit 1, names the fix, ZERO Worker calls", async () => {
    const home = tmpDir("spawn-no-remote-home-");
    const cwd = tmpDir("spawn-no-remote-cwd-"); // no .git here, deliberately
    const { server, seen } = startStandIn();
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runFleetIn(["spawn", "pilot"], home, cwd);
    server.stop(true);

    expect(r.code).toBe(1);
    // The refusal names the escape hatch, not a fallback the command never took.
    expect(r.err).toContain("no git remote here");
    expect(r.err).toContain("pass --repo owner/name");
    // Refusal fires BEFORE any fetch — the stand-in saw nothing at all.
    expect(seen.length).toBe(0);
  });

  test("non-git cwd, `fleet spawn pilot --repo acme/faux`: spawns, one POST with the repo, names the studio", async () => {
    const home = tmpDir("spawn-no-remote-home-");
    const cwd = tmpDir("spawn-no-remote-cwd-");
    const { server, seen } = startStandIn();
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runFleetIn(["spawn", "pilot", "--repo", "acme/faux"], home, cwd);
    server.stop(true);

    expect(r.code).toBe(0);
    // Exactly one spawn POST, carrying the --repo value as the body's repo.
    // (The success path also fires the Orca sidebar row title fetch —
    // GET /studio/board/tasks — a pre-existing second request, out of scope.)
    const spawnPosts = seen.filter((s) => s.method === "POST" && s.path === "/studio/spawn");
    expect(spawnPosts.length).toBe(1);
    expect(spawnPosts[0]!.body).toEqual({ role: "pilot", repo: "acme/faux" });
    // The --repo line and the post-spawn line both land on stderr.
    expect(r.err).toContain("fleet spawn: target repo acme/faux (--repo)");
    expect(r.err).toContain("fleet spawn: repo acme/faux → faux--pilot");
  });

  test("non-git cwd, `fleet provision faux--pilot`: bodyless POST, no refusal (address-by-id)", async () => {
    const home = tmpDir("spawn-no-remote-home-");
    const cwd = tmpDir("spawn-no-remote-cwd-");
    const { server, seen } = startStandIn();
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runFleetIn(["provision", "faux--pilot"], home, cwd);
    server.stop(true);

    // Address-by-id: the id was not derived from the cwd, so the refusal never
    // fires and the POST body is exactly `{}` (the Worker resolves the repo).
    expect(r.code).toBe(0);
    const spawnLike = seen.filter((s) => s.method === "POST" && s.path === "/studio/faux--pilot/provision");
    expect(spawnLike.length).toBe(1);
    expect(spawnLike[0]!.body).toEqual({});
  });

  test("non-git cwd, `fleet spawn pilot --repo notaslug`: exit 1, names the bad --repo, ZERO Worker calls", async () => {
    const home = tmpDir("spawn-no-remote-home-");
    const cwd = tmpDir("spawn-no-remote-cwd-");
    const { server, seen } = startStandIn();
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runFleetIn(["spawn", "pilot", "--repo", "notaslug"], home, cwd);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain("bad --repo");
    expect(seen.length).toBe(0);
  });

  test("non-git cwd, `fleet provision faux--pilot --repo acme/faux`: sends that repo (segment matches the id)", async () => {
    const home = tmpDir("spawn-no-remote-home-");
    const cwd = tmpDir("spawn-no-remote-cwd-");
    const { server, seen } = startStandIn();
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runFleetIn(["provision", "faux--pilot", "--repo", "acme/faux"], home, cwd);
    server.stop(true);

    expect(r.code).toBe(0);
    const provisionPosts = seen.filter((s) => s.method === "POST" && s.path === "/studio/faux--pilot/provision");
    expect(provisionPosts.length).toBe(1);
    expect(provisionPosts[0]!.body).toEqual({ repo: "acme/faux" });
    expect(r.err).toContain("fleet provision: target repo acme/faux (--repo)");
  });

  test("non-git cwd, bare `ff release-studio`: exit 1, names the fix, never spawns", async () => {
    const home = tmpDir("spawn-no-remote-home-");
    const cwd = tmpDir("spawn-no-remote-cwd-");
    const { server, seen } = startStandIn();
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runFfIn(["release-studio"], home, cwd);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain("no git remote here");
    // ff lists studios before deciding; it must never reach the spawn route.
    expect(seen.some((s) => s.path === "/studio/spawn")).toBe(false);
  });
});