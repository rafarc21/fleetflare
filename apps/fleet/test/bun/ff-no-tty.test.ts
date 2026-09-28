// `ff` with no tty must TERMINATE — issue #43, part 1, run for real.
//
// MEASURED 2026-09-23 on acme-os:
//   pid 34488  ff web-studio 2565          TTY=??      <- still alive 2h later
//   pid 38370  fleet attach ...web-studio  TTY=ttys008 <- the real client
// The tty-less `ff` held a tmux client at 80 columns; with the bring-up's
// `window-size latest`, that one stray client pinned the pane for everyone,
// and killing the process did NOT give the size back.
//
// A unit test on the decision function cannot catch a hang: only a real
// process can. So this spawns the REAL cli/ff.ts against a stub Worker, with
// no terminal on either end, and asserts it exits — plus that it never opened
// the terminal WS at all, because an attach that is refused must not leave a
// client behind on its way out.
//
// bun:test lane, not workerd: cli/ff.ts is Bun-only (Bun.spawn, process.exit,
// WebSocket) and is never imported from the vitest suite. Same precedent as
// test/bun/orca-workspace.test.ts's spawned-process test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUDIO_ID = "faux--release-studio";
const FF = join(import.meta.dir, "../../cli/ff.ts");

/** Every path the stub Worker was asked for, so "never opened the WS" is an
 *  assertion about observed traffic rather than about the absence of output. */
const seen: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let home: string;
let repo: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === "/studio/") {
        return Response.json([
          {
            id: STUDIO_ID, state: "running", error: null, repoSlug: "acme/faux",
            tailscaleHost: null, lastRefresh: null,
          },
        ]);
      }
      if (path === `/studio/${STUDIO_ID}/provisioned`) {
        return Response.json({ kind: "provisioned" });
      }
      // Anything else — including the terminal WS — is a route this run was
      // never supposed to reach.
      return new Response("not found", { status: 404 });
    },
  });

  home = mkdtempSync(join(tmpdir(), "fleet-ff-home-"));
  mkdirSync(join(home, ".fleet"));
  const credentials = join(home, ".fleet", "credentials");
  writeFileSync(credentials, JSON.stringify({
    workerUrl: `http://127.0.0.1:${server.port}`,
    accessClientId: "stub-id",
    accessClientSecret: "stub-secret",
  }));
  // cli/fleet.ts warns on stdout when the file is group/other readable; the
  // assertions below read stderr, so keep the run's output honest.
  chmodSync(credentials, 0o600);

  // `ff` derives the studio id from `git remote origin` in the CWD.
  repo = mkdtempSync(join(tmpdir(), "fleet-ff-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/faux.git"], { cwd: repo });
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * The real command, with NO terminal on either end: stdin ignored and stdout
 * piped is exactly what a background shell (`TTY=??`) gives it.
 *
 * The kill timer is the whole point of the run. A hang comes back as a kill
 * SIGNAL, which is what "it never exits" looks like from the outside; 20s is
 * far past every network hop this run makes against a loopback stub, and
 * comfortably inside the per-test budget below.
 *
 * ASYNC spawn, deliberately: the stub Worker above runs on THIS process's
 * event loop, and Bun.spawnSync blocks it — the child's very first fetch then
 * hangs against a server that cannot accept, which looks exactly like the bug
 * under test and would make this suite pass for the wrong reason.
 */
async function runFf(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FF, ...args],
    cwd: repo,
    // #135 review: drop inherited ORCA_* — ORCA_WORKTREE_ID alone makes
    // orcaPresent true and the child shells a real `orca worktree list`.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_"))),
      HOME: home, TERM_PROGRAM: "not-orca",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { code, signal: proc.signalCode, stdout, stderr };
}

/** bun:test's own default per-test budget is 5s — shorter than the hang this
 *  file exists to catch, so a real hang would be reported as a test-runner
 *  timeout instead of as the process never exiting. */
const TEST_TIMEOUT_MS = 40_000;

describe("ff without a tty", () => {
  let run: Awaited<ReturnType<typeof runFf>>;
  let paths: string[];

  beforeAll(async () => {
    seen.length = 0;
    run = await runFf(["release-studio"]);
    paths = [...seen];
  }, TEST_TIMEOUT_MS);

  test("terminates instead of sitting attached forever", () => {
    // A hang shows up here as a kill signal from the spawn timeout, which is
    // precisely the bug: two hours attached, TTY=??.
    expect(run.signal).toBeNull();
    // The handoff succeeded — the studio is up and the caller was told how to
    // reach it. A background agent calling `ff <role> <n>` is normal, so this
    // is not a failure exit.
    expect(run.code).toBe(0);
  });

  test("says what it did and what to type, on stderr", () => {
    expect(run.stderr).toContain(STUDIO_ID);
    expect(run.stderr).toContain("not attaching");
    expect(run.stderr).toContain(`fleet attach ${STUDIO_ID}`);
  });

  test("never opens the terminal WS, so it can leave no client behind", () => {
    expect(paths).toContain("/studio/");
    expect(paths.filter((p) => p.includes("/ws/"))).toEqual([]);
  });
});
