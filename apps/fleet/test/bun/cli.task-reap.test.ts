// apps/fleet/test/bun/cli.task-reap.test.ts
// Sweep 11 finding S11-F5 (issue #493, refs #467): cmdTaskReap's two print
// loops. reapTerminalAll the helper is already covered (test/cli.reap-
// terminal.test.ts) — this covers the command's own printing, end to end: a
// real `Bun.spawn` of cli/fleet.ts against a real local Bun.serve standing
// in for the Worker's POST /studio/board/tasks/reap (accounts-cli.test.ts's
// pattern), a temp HOME holding the credentials, and the spawn's cwd on that
// same temp HOME so detectRepo finds no git origin — the POST body carries
// no `repo` key (the Worker's own default stays the single source of that
// fallback) and reportRepo prints its fallback line on stderr.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentials } from "./helpers/credentials";

const FLEET = join(import.meta.dir, "../../cli/fleet.ts");

/** What the CLI POSTs to /tasks/reap. `repo` and `terminal` ride only when
 *  the branch that sends them is the one taken — see each test's asserts. */
interface ReapCall { apply: boolean; terminal?: boolean; repo?: string }

const tempDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A stand-in for the Worker's POST /studio/board/tasks/reap: records every
 *  request body and answers the one canned response this run needs. */
function startReapWorker(answer: unknown) {
  const calls: ReapCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/studio/board/tasks/reap" && req.method === "POST") {
        calls.push((await req.json()) as ReapCall);
        return Response.json(answer);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, calls };
}

/** Spawns the real CLI with HOME on the temp dir and cwd there too — no git
 *  repo, so the POST body carries no `repo` and the stderr fallback line
 *  (reportRepo's "using the fleet's default repo") prints. */
async function run(args: string[], home: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    env: { PATH: process.env.PATH!, HOME: home },
    cwd: home,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

describe("fleet task reap — print loops", () => {
  test("--terminal (dry-run): header, per-result lines, the N-left line, exactly one POST", async () => {
    const home = tmpDir("reap-home-");
    const page = {
      repo: "example-org/acme", apply: false, terminal: true, remaining: 3,
      results: [
        { number: 101, state: "completed", outcome: "closed", reason: "completed" },
        { number: 102, state: "failed", outcome: "error", reason: "not_planned", error: "500 from GitHub" },
      ],
    };
    const { server, calls } = startReapWorker(page);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["task", "reap", "--terminal"], home);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("fleet task reap --terminal (dry-run) — example-org/acme");
    expect(r.out).toContain("  #101 (completed): closed as completed");
    expect(r.out).toContain("  #102 (failed): error as not_planned — 500 from GitHub");
    expect(r.out).toContain("  3 left: a page closed nothing; re-run after checking the errors above");
    expect(r.out).not.toContain("(no open issue in a terminal state)");
    // A dry run asks once, whatever `remaining` claims is still open.
    expect(calls.length).toBe(1);
    expect(calls[0]!.apply).toBe(false);
    expect(calls[0]!.terminal).toBe(true);
    expect("repo" in calls[0]!).toBe(false);
    expect(r.err).toContain("using the fleet's default repo");
  });

  test("--terminal --dry-run with an empty page: the empty line, never the N-left line", async () => {
    const home = tmpDir("reap-home-");
    const page = { repo: "example-org/acme", apply: false, terminal: true, remaining: 0, results: [] };
    const { server } = startReapWorker(page);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["task", "reap", "--terminal", "--dry-run"], home);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("fleet task reap --terminal (dry-run) — example-org/acme");
    expect(r.out).toContain("  (no open issue in a terminal state)");
    expect(r.out).not.toContain("left:");
  });

  test("plain --apply: header with defaultBranch, skipped and PR lines exactly", async () => {
    const home = tmpDir("reap-home-");
    const answer = {
      repo: "example-org/acme", apply: true, defaultBranch: "main",
      results: [
        { taskNumber: 7, outcome: "skipped", reason: "input_required" },
        { taskNumber: 8, prNumber: 55, outcome: "would-close", sha: "abcdef1234567890" },
        { taskNumber: 9, prNumber: 56, outcome: "closed", sha: "0123abcd4567ef" },
      ],
    };
    const { server, calls } = startReapWorker(answer);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["task", "reap", "--apply"], home);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("fleet task reap (--apply) — example-org/acme @ main");
    expect(r.out).toContain("  #7: skipped — input_required");
    expect(r.out).toContain("  #8 (PR #55): would-close — abcdef12");
    expect(r.out).toContain("  #9 (PR #56): closed — 0123abcd");
    expect(r.out).not.toContain("(no open tasks)");
    expect(calls.length).toBe(1);
    expect(calls[0]!.apply).toBe(true);
    expect("terminal" in calls[0]!).toBe(false);
  });

  test("bare run with nothing to do: the (no open tasks) line, exit 0", async () => {
    const home = tmpDir("reap-home-");
    const answer = { repo: "example-org/acme", apply: false, defaultBranch: "main", results: [] };
    const { server, calls } = startReapWorker(answer);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["task", "reap"], home);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("fleet task reap (dry-run) — example-org/acme @ main");
    expect(r.out).toContain("  (no open tasks)");
    expect(calls.length).toBe(1);
    expect(calls[0]!.apply).toBe(false);
  });

  // Issue #546: cmdTaskReap's --terminal branch used to exit 0 no matter
  // what the page said -- a batch of failed closes printed as handled with
  // a green exit. An error row (closeTerminalTasks' failure word) must
  // leave exit 1. Dry pages never carry error rows, so the dry-run exit-0
  // pins above stay as they are.
  test("--terminal --apply with an error row: the failed line prints, and the exit is 1, not 0", async () => {
    const home = tmpDir("reap-home-");
    const page = {
      repo: "example-org/acme", apply: true, terminal: true, remaining: 0,
      results: [
        { number: 201, state: "failed", outcome: "error", reason: "not_planned", error: "502" },
      ],
    };
    const { server, calls } = startReapWorker(page);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["task", "reap", "--terminal", "--apply"], home);
    server.stop(true);

    expect(r.out).toContain("fleet task reap --terminal (--apply) — example-org/acme");
    expect(r.out).toContain("  #201 (failed): error as not_planned — 502");
    // remaining 0 means reapTerminalAll stops after this one page.
    expect(calls.length).toBe(1);
    expect(r.code).toBe(1);
  });

  // Issue #546: the non-terminal print loop's else-branch assumed every
  // non-skipped row carries a sha. A failed row has a reason and no sha,
  // so it must print the reason -- and per the plan's Worker-side policy
  // the non-terminal exit stays 0 (a failed close there is reported, not
  // escalated).
  test("plain --apply with a failed row: the failed line with the reason prints, exit stays 0", async () => {
    const home = tmpDir("reap-home-");
    const answer = {
      repo: "example-org/acme", apply: true, defaultBranch: "main",
      results: [
        { taskNumber: 12, prNumber: 9, outcome: "failed", reason: "close 500" },
      ],
    };
    const { server } = startReapWorker(answer);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["task", "reap", "--apply"], home);
    server.stop(true);

    expect(r.out).toContain("fleet task reap (--apply) — example-org/acme @ main");
    expect(r.out).toContain("  #12 (PR #9): failed — close 500");
    expect(r.code).toBe(0);
  });
});
