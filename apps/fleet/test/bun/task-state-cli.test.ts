// apps/fleet/test/bun/task-state-cli.test.ts
// Board task #492 (sweep 11 finding S11-F4, refs #467): `fleet task state
// <n> <to>`'s real-I/O halves, taskStateFetchCurrent and
// taskStateFetchTransition (cli/fleet.ts). The pure core runTaskStateTransition
// is covered by injected fetches (test/studio.task-state.test.ts); these tests
// drive the REAL cli/fleet.ts subprocess against a real local Bun.serve
// stand-in for the Worker — accounts-cli.test.ts's pattern — so every fetch
// half's own status handling and message text is proven end to end. The spawn
// runs with a bare temp dir as cwd AND HOME, so detectRepo finds no git repo,
// reportRepo prints its fallback line, and repoQuery stays empty (no ?repo=).
import { afterEach, describe, expect, test } from "bun:test";
import { writeCredentials } from "./helpers/credentials";
import { cleanupTempDirs, FLEET, tmpDir } from "./helpers/fleet-cli";

afterEach(cleanupTempDirs);

/** One stand-in Worker, answering the two routes cmdTaskState's halves call:
 *  GET /studio/board/tasks/12 (fetchCurrent) and POST
 *  /studio/board/tasks/12/state (fetchTransition). `get` answers the GET,
 *  `post` the POST — a test that must prove "the POST is never reached"
 *  hands post a 500 answer with an unmistakable body, never a 404, so an
 *  unexpected hit surfaces in the CLI's own error line rather than as a
 *  confusing not-found. `postCalls` captures every POST body for assertion. */
function startWorker(get: () => Response, post: (body: string) => Response) {
  const postCalls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/studio/board/tasks/12" && req.method === "GET") return get();
      if (url.pathname === "/studio/board/tasks/12/state" && req.method === "POST") {
        const body = await req.text();
        postCalls.push(body);
        return post(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, postCalls };
}

/** Spawns `fleet task state 12 completed` from a bare temp cwd+HOME. Only
 *  stdout is asserted precisely (one line); stderr carries reportRepo's
 *  fallback line before anything else, so stderr assertions use toContain. */
async function run(home: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, "task", "state", "12", "completed"],
    env: { PATH: process.env.PATH!, HOME: home },
    cwd: home,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

/** A BoardTask JSON as the real Worker sends it (src/board/types.ts's own
 *  shape — state is BoardTaskState | null, the drift-carrying null these tests
 *  exist to exercise). */
function taskJson(state: string | null, labels: string[]) {
  return {
    number: 12,
    url: "https://github.com/rafarc21/fleetflare/issues/12",
    title: "t",
    body: "",
    state,
    labels,
    assignee: "x",
    milestone: null,
    open: true,
    updatedAt: "2026-10-12T00:00:00Z",
  };
}

describe("fleet task state", () => {
  test("happy control: reads the current state, posts {from,to}, prints before -> after", async () => {
    const home = tmpDir("task-state-home-");
    const { server, postCalls } = startWorker(
      () => Response.json({ task: taskJson("working", ["working"]) }),
      () => Response.json(taskJson("completed", ["completed"])),
    );
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(home);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("task #12: working -> completed");
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse(postCalls[0]!)).toEqual({ from: "working", to: "completed" });
  });

  // fetchCurrent's 409: a task with no single board state label has no `from`
  // this CLI can read. The message must name the actual labels and end with
  // the --from-none repair hint (the operator's only repair instruction for
  // an interrupted transition), and the transition POST is never reached.
  test("no single state label: 409 names the labels, carries the --from-none hint, never POSTs", async () => {
    const home = tmpDir("task-state-home-");
    const { server, postCalls } = startWorker(
      () => Response.json({ task: taskJson(null, ["urgent", "bug"]) }),
      () => new Response("unexpected POST: getCurrentState failed first", { status: 500 }),
    );
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(home);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet task state: ");
    expect(r.err).toContain("task #12 carries no single board state label (labels: urgent, bug)");
    expect(r.err).toContain('there is no "from" this CLI can read to transition it safely');
    expect(r.err).toContain("If it has NO state label at all (an interrupted transition), repair it: ");
    // The hint ends with the literal <to>, never the actual requested state —
    // an operator copies it and substitutes their own target.
    expect(r.err).toContain("fleet task state 12 <to> --from-none");
    expect(postCalls).toHaveLength(0);
  });

  // fetchCurrent's !res.ok slice: the first 500 chars of the body surface
  // verbatim after the prefix — the operator sees the Worker's own failure
  // words, never a bare status number.
  test("a failing task-show GET surfaces the body verbatim on stderr, exit 1", async () => {
    const home = tmpDir("task-state-home-");
    const { server } = startWorker(
      () => new Response("board upstream failed: installation revoked", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
      () => new Response("unexpected POST: the read failed first", { status: 500 }),
    );
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(home);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet task state: board upstream failed: installation revoked");
  });

  // fetchTransition's own null-state slice: the POST answered 200 but the
  // task carries no single state label back — the CLI must say the Worker
  // wrote the transition, not silently invent a `to` to print.
  test("a 200 transition answer with no single state label back: 500 message, exit 1", async () => {
    const home = tmpDir("task-state-home-");
    const { server } = startWorker(
      () => Response.json({ task: taskJson("working", ["working"]) }),
      () => Response.json(taskJson(null, ["submitted", "working"])),
    );
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(home);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet task state: task #12: the Worker wrote the transition but returned no single state label back");
  });

  // fetchTransition's !res.ok slice: the route's stale-from 409 (the board
  // moved between the read and the write) must reach the operator
  // byte-identical through the real fetch — the same verbatim contract the
  // pure-core test pins with an injected message, here proven end to end.
  test("a 409 transition answer carries the route's stale-from message verbatim, exit 1", async () => {
    const home = tmpDir("task-state-home-");
    const staleFrom =
      'task #12 is "completed", caller expected "working" — the Worker is the single writer of task state ' +
      "and refuses a transition it did not initiate";
    const { server } = startWorker(
      () => Response.json({ task: taskJson("working", ["working"]) }),
      () => new Response(staleFrom, { status: 409, headers: { "Content-Type": "text/plain" } }),
    );
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(home);
    server.stop(true);

    expect(r.code).toBe(1);
    expect(r.err).toContain(`fleet task state: ${staleFrom}`);
  });
});
