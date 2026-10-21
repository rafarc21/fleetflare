// apps/fleet/test/bun/cli.task-message.test.ts
// Board issue #1077, item 2: `fleet task message <n> "<text>"` in the LOCAL
// CLI. cli/fleet.ts's cmdTaskMessage POSTs {text} to the Worker's message
// route (src/board/task-message.ts's sendTaskMessage: one board comment, then
// one wake of the task's lead) and prints what happened. A refused wake is
// printed, never silent, and a Worker refusal exits 1.
//
// Same sweep-11 pattern as cli.task-verify.test.ts: a real `Bun.spawn` of
// cli/fleet.ts against a local `Bun.serve` Worker stand-in, a temp HOME whose
// credentials name the stand-in, and a cwd with no `.git`, so the request
// carries no repo query and the test never depends on this checkout's remote.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { writeCredentials } from "./helpers/credentials";
import { cleanupTempDirs, FLEET, tmpDir } from "./helpers/fleet-cli";

afterEach(cleanupTempDirs);

interface SeenRequest { method: string; path: string; body: unknown }

/** The stand-in Worker: answers POST /studio/board/tasks/12/message with
 *  whatever `respond` returns, and records every request it saw. */
function startMessageStandIn(respond: () => Response) {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/studio/board/tasks/12/message") {
        const body = await req.json().catch(() => null);
        seen.push({ method: req.method, path: url.pathname, body });
        return respond();
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, seen };
}

/** Spawns `fleet task message 12 <words…>` under the given HOME, cwd with no
 *  git repo. The words are passed as separate argv entries, as a shell would
 *  split an unquoted message. */
async function runMessage(home: string, cwd: string, words: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, "task", "message", "12", ...words],
    cwd,
    env: { PATH: process.env.PATH!, HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

const COMMENT = { id: 7, url: "https://github.com/o/r/issues/12#issuecomment-7" };

describe("fleet task message (board issue #1077)", () => {
  test("POSTs the joined text to the message route and prints the woken lead; exits 0", async () => {
    const home = tmpDir("task-message-home-");
    const cwd = tmpDir("task-message-cwd-");
    const { server, seen } = startMessageStandIn(() => Response.json({
      comment: COMMENT,
      wake: { woke: true, digest: "WAKE TASK MESSAGE #12 \"Some task\" | please rebase first | read: fleet task show 12" },
    }));
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runMessage(home, cwd, ["please", "rebase", "first"]);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]!.method).toBe("POST");
    // The unquoted words arrive as ONE text, the same join the container verb does.
    expect(seen[0]!.body).toEqual({ text: "please rebase first" });
    expect(r.out).toContain("task #12 message posted");
    expect(r.out).toContain(COMMENT.url);
    expect(r.out).toContain("woke the studio");
  });

  test("a refused wake (stopped lead) is printed as NO WAKE, and the command still exits 0 — the comment landed", async () => {
    const home = tmpDir("task-message-home-");
    const cwd = tmpDir("task-message-cwd-");
    const { server } = startMessageStandIn(() => Response.json({
      comment: COMMENT,
      wake: { woke: false, reason: "websites--web-studio is stopped — no wake was sent" },
    }));
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runMessage(home, cwd, ["ping"]);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("NO WAKE — websites--web-studio is stopped");
  });

  test("a Worker refusal (closed or terminal task, 409) prints the Worker's reason and exits 1", async () => {
    const home = tmpDir("task-message-home-");
    const cwd = tmpDir("task-message-cwd-");
    const { server } = startMessageStandIn(() =>
      new Response("task #12 is completed — finished work takes no message", { status: 409 }));
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runMessage(home, cwd, ["hello"]);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet task message: 409");
    expect(r.err).toContain("finished work takes no message");
  });
});

// Board issue #1106: the Worker reads the board repo from the BODY on every
// operator write, never from the query string. A folder with an `origin`
// remote must therefore name its repo in the body, or the message lands on the
// fleet's default repo.
describe("fleet task message — the repo travels in the body (issue #1106)", () => {
  test("a folder with an origin remote sends its repo in the body", async () => {
    const home = tmpDir("task-message-home-");
    const cwd = tmpDir("task-message-cwd-");
    const git = Bun.spawnSync(["git", "init", "-q"], { cwd });
    expect(git.exitCode).toBe(0);
    Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/acme-org/beta.git"], { cwd });

    const { server, seen } = startMessageStandIn(() => Response.json({
      comment: COMMENT,
      wake: { woke: true, digest: "WAKE TASK MESSAGE #12" },
    }));
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runMessage(home, cwd, ["hi"]);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(seen[0]!.body).toEqual({ text: "hi", repo: "acme-org/beta" });
  });
});

describe("fleet task message — local assignee wakes by Orca terminal send (item 2)", () => {
  test("a local-refusal wake is swapped for a real terminal send under Orca, printed as woke the studio", async () => {
    const home = tmpDir("task-message-local-home-");
    const cwd = tmpDir("task-message-local-cwd-");
    // A fake orca binary that answers the two LIST calls sendLocalWake's
    // foreground check makes (a healthy attach terminal whose preview carries
    // claude chrome) and `terminal send` with `{}`, and logs every argv so the
    // test can assert the send actually fired. TERM_PROGRAM=Orca makes
    // orcaPresent true, so the full CLI-side swap (resolveLocalWake ->
    // sendLocalWake) runs end to end.
    const fakeOrca = `${home}/orca`;
    const logFile = `${home}/orca-calls.log`;
    writeFileSync(fakeOrca, [
      "#!/bin/sh",
      `echo "$@" >> "${logFile}"`,
      "case \"$1:$2\" in",
      "  worktree:list)",
      "    echo '{\"ok\":true,\"result\":{\"worktrees\":[{\"id\":\"repo-websites::/w/studio-websites-web-studio\",\"displayName\":\"studio-websites--web-studio\",\"path\":\"/fake/orca/studio-websites-web-studio\"}]}}'",
      "    ;;",
      "  terminal:list)",
      "    echo '{\"ok\":true,\"result\":{\"terminals\":[{\"handle\":\"term_0\",\"title\":\"fleet\",\"connected\":true,\"worktreeId\":\"repo-websites::/w/studio-websites-web-studio\",\"preview\":\"❯ ready\"}]}}'",
      "    ;;",
      "  *)",
      "    echo '{}'",
      "    ;;",
      "esac",
    ].join("\n"));
    chmodSync(fakeOrca, 0o755);
    const { server } = startMessageStandIn(() => Response.json({
      comment: { id: 9, url: "https://github.com/o/r/issues/12#issuecomment-9" },
      assignee: "websites--web-studio",
      wake: {
        woke: false,
        reason: "websites--web-studio is a local studio — no container to wake. Wake its lead by Orca terminal send from the operator's machine.",
        local: true,
        digest: "WAKE TASK MESSAGE #12 \"Some task\" | ping | read: fleet task show 12",
      },
    }));
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const proc = Bun.spawn({
      cmd: [process.execPath, FLEET, "task", "message", "12", "ping"],
      cwd,
      env: { PATH: process.env.PATH!, HOME: home, ORCA_CLI_COMMAND: fakeOrca, TERM_PROGRAM: "Orca" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    server.stop(true);

    expect(code).toBe(0);
    expect(out).toContain("task #12 message posted");
    // The full swap ran and the fake terminal send succeeded — the wake is
    // reported as landed, never the Worker's local wording passed through.
    expect(out).toContain("woke the studio");
    expect(out).not.toContain("not an Orca session");
    // The fake orca really received a terminal send with the digest text.
    const calls = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    const send = calls.find((c) => c.startsWith("terminal send"));
    expect(send).toBeDefined();
    expect(send).toContain("--text");
    // Fix 1 (#1259 round 4): the text that actually reaches `terminal send`
    // is the fixed per-task-number template, never the Worker's own `digest`
    // field (`WAKE TASK MESSAGE #12 "Some task" | ping | ...` above) — that
    // field is never read on this path anymore.
    expect(send).toContain("Board task #12 has a new message. Run: fleet task show 12");
    expect(send).not.toContain("WAKE TASK MESSAGE");
    expect(err).not.toContain("Error:");
  });
});
