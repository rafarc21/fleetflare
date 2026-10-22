// `fleet task new --studio <local-studio>` — fleet task #1259 item 2, the
// assign-wake swap for a LOCAL studio. The Worker answers an assignment whose
// `wake` is the local refusal (`{local:true}`); cli/fleet.ts's reportAssignWake
// must run that through resolveLocalWake -> sendLocalWake rather than printing
// the Worker's own wording untouched. sendLocalWake itself refuses ("not an
// Orca session") when this process is not under Orca, which is the hermetic
// proof that the swap fired: the Worker's local wording does NOT contain that
// phrase.
//
// bun:test lane: a real Bun.spawn of cli/fleet.ts against a Bun.serve
// stand-in for POST /studio/board/tasks, a temp HOME whose credentials name
// the stand-in, and a cwd with no `.git`, so detectRepo yields `slug: null`
// and the request carries no repo query.
import { afterEach, describe, expect, test } from "bun:test";
import { writeCredentials } from "./helpers/credentials";
import { cleanupTempDirs, FLEET, tmpDir } from "./helpers/fleet-cli";

afterEach(cleanupTempDirs);

describe("fleet task new --studio <local> — the local wake swap (item 2)", () => {
  test("prints sendLocalWake's own refusal, not the Worker's local wording, proving the swap ran", async () => {
    const home = tmpDir("task-new-local-home-");
    const cwd = tmpDir("task-new-local-cwd-"); // no .git here, deliberately

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/studio/board/tasks" && req.method === "POST") {
          return Response.json({
            number: 501,
            url: "https://github.com/acme/faux/issues/501",
            title: "do the thing",
            body: "the brief",
            state: "submitted",
            labels: ["studio:websites--web-studio"],
            assignee: "websites--web-studio",
            milestone: null,
            open: true,
            updatedAt: "2026-10-21T00:00:00.000Z",
            wake: {
              woke: false,
              reason: "websites--web-studio is a local studio — it has no container to wake. The lead is woken by Orca terminal send instead.",
              local: true,
              digest: "WAKE TASK ASSIGNED #501 \"do the thing\" | read it: fleet task show 501",
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const proc = Bun.spawn({
      cmd: [process.execPath, FLEET, "task", "new",
        "--title", "t", "--objective", "o", "--output", "f", "--boundaries", "b",
        "--backlog", "--studio", "websites--web-studio"],
      cwd,
      // TERM_PROGRAM deliberately unset: orcaPresent is false, so sendLocalWake
      // reports its own refusal — the marker that the swap ran at all.
      env: { PATH: process.env.PATH!, HOME: home },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    server.stop(true);

    expect(code).toBe(0);
    // The CLI-side sendLocalWake ran and printed its own refusal wording — this
    // proves the swap happened, not the Worker's local wording passing through.
    expect(out).toContain("not an Orca session");
    // The Worker's exact local refusal wording is NOT present verbatim.
    expect(out).not.toContain("woken by Orca terminal send instead");
    expect(err).not.toContain("Error:");
  }, 40_000);
});