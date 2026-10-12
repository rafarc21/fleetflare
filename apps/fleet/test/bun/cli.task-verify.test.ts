// apps/fleet/test/bun/cli.task-verify.test.ts
// Issue #491 (sweep 11 finding S11-F3, refs #467): `fleet task verify <n>`.
// cli/fleet.ts's cmdTaskVerify (:1797, dispatch :3029) POSTs to the Worker's
// verify route and prints back what it found — the per-result icon lines
// (✅ attempted-ok / ❌ attempted-failed / ➖ other, the `icon` helper
// :1806-1807), the envelope header naming `envelopeMsgId` (:1808), the
// trailing `comment: <url>` line (:1810), and `boardRequest`'s
// exit-1-on-non-2xx posture (:1596-1605). It also pins the exit code
// (#545, refs #539): the print loop still prints every result in full, but
// the command exits 1 when any verdict is `attempted-failed` and exits 0
// when none is — attempted-ok and not-mechanically-checkable both stay 0.
// The Worker's OWN verify logic (reading the newest §6 envelope, mechanically
// re-checking it, posting the classifying comment) already lives in
// test/board.verify.test.ts — this file is only the CLI half.
//
// Sweep-11 pattern (a), same shape as accounts-cli.test.ts: a real
// `Bun.spawn` of cli/fleet.ts against a local `Bun.serve` Worker stand-in
// answering POST /studio/board/tasks/77/verify, a temp HOME whose
// `~/.fleet/credentials` names the stand-in. The spawn's cwd is a SECOND
// temp dir with no `.git` in it — detectRepo then yields `{slug: null}`, so
// the POST body is exactly `{}` and the fallback reportRepo line names the
// real git error — hermetic, no dependence on this checkout's own remote.
// The stand-in does not validate accessHeaders' auth headers; asserting on
// them is out of scope here.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredentials } from "./helpers/credentials";

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

interface SeenRequest { method: string; path: string; body: unknown }

/** The stand-in Worker. Answers POST /studio/board/tasks/77/verify with
 *  `answer` when given, else 500 with `boom` as the text body — both halves
 *  of the route this command consumes (the ok print loop and boardRequest's
 *  non-2xx posture) from one server. Records every request it saw. */
function startVerifyStandIn(answer?: unknown, boom = "worker boom") {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/studio/board/tasks/77/verify") {
        const body = await req.json().catch(() => null);
        seen.push({ method: req.method, path: url.pathname, body });
        if (answer === undefined) return new Response(boom, { status: 500 });
        return Response.json(answer);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, seen };
}

/** Spawns `fleet task verify 77` under the given HOME (credentials file) and
 *  a cwd with no `.git` — detectRepo's `git remote get-url origin` fails
 *  there, so the POST body is `{}` and reportRepo's fallback line names the
 *  actual git error, never this checkout's own remote URL. */
async function runVerify(home: string, cwd: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, "task", "verify", "77"],
    cwd,
    env: { PATH: process.env.PATH!, HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

describe("fleet task verify", () => {
  // The two-result answer the sweep doc's own design names: one
  // attempted-ok, one attempted-failed, plus comment url and envelopeMsgId —
  // both icon branches and both printed lines in one run.
  const ANSWER = {
    comment: { url: "https://github.com/o/r/issues/77#issuecomment-1" },
    envelopeMsgId: "msg-41",
    results: [
      { label: "open the PR", verdict: "attempted-ok", detail: "PR #78 open" },
      { label: "run the suite", verdict: "attempted-failed", detail: "2 fail" },
    ],
  };

  test("prints the envelope header, both icon lines, and the comment url; POSTs an empty-body request and exits 1 — one verdict is attempted-failed", async () => {
    const home = tmpDir("task-verify-home-");
    const cwd = tmpDir("task-verify-cwd-"); // no .git here, deliberately
    const { server, seen } = startVerifyStandIn(ANSWER);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runVerify(home, cwd);
    server.stop(true);

    // The loop prints everything in full, but the verdict halves: any
    // attempted-failed result makes the command exit 1 — the ❌ above is a
    // failure, so $? must say so.
    expect(r.code).toBe(1);
    expect(seen.length).toBe(1);
    // The request half: one POST to the verify route, and — because the cwd
    // holds no git repo for detectRepo to read — a body with NO repo field,
    // exactly the `detected.slug ? {repo} : {}` shape cmdTaskVerify posts.
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.path).toBe("/studio/board/tasks/77/verify");
    expect(seen[0]!.body).toEqual({});
    // reportRepo's fallback line — the non-git cwd's own reason, so the
    // operator can see the Worker used the fleet default.
    expect(r.err).toContain("fleet task verify: ");
    expect(r.err).toContain("using the fleet's default repo");
    // The print loop, verbatim: the envelope header naming envelopeMsgId,
    // one icon line per result with its verdict, label and detail (the two
    // leading spaces are the loop's own indentation), then the comment url.
    expect(r.out).toContain("fleet task verify #77 — checking result envelope msg-41:");
    expect(r.out).toContain("  ✅ attempted-ok — open the PR: PR #78 open");
    expect(r.out).toContain("  ❌ attempted-failed — run the suite: 2 fail");
    expect(r.out).toContain("comment: https://github.com/o/r/issues/77#issuecomment-1");
  });

  test("a 500 from the verify route exits 1 with the status and body on stderr", async () => {
    const home = tmpDir("task-verify-home-");
    const cwd = tmpDir("task-verify-cwd-");
    const { server, seen } = startVerifyStandIn(undefined, "worker boom");
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runVerify(home, cwd);
    server.stop(true);

    // boardRequest's own posture (:1596-1605): any non-ok response prints
    // `<cmd>: <status> <body up to 500 chars>` on stderr and exits 1 — no
    // result lines ever print.
    expect(r.code).toBe(1);
    expect(seen.length).toBe(1);
    expect(r.err).toContain("fleet task verify: 500 worker boom");
    expect(r.out).not.toContain("checking result envelope");
    expect(r.out).not.toContain("comment:");
  });

  test("all-attempted-ok results exit 0", async () => {
    const home = tmpDir("task-verify-home-");
    const cwd = tmpDir("task-verify-cwd-");
    const { server } = startVerifyStandIn({
      comment: { url: "https://github.com/o/r/issues/77#issuecomment-2" },
      envelopeMsgId: "msg-42",
      results: [
        { label: "open the PR", verdict: "attempted-ok", detail: "PR #79 open" },
      ],
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runVerify(home, cwd);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("  ✅ attempted-ok — open the PR: PR #79 open");
    expect(r.out).toContain("comment: https://github.com/o/r/issues/77#issuecomment-2");
  });

  test("a not-mechanically-checkable verdict exits 0", async () => {
    const home = tmpDir("task-verify-home-");
    const cwd = tmpDir("task-verify-cwd-");
    const { server } = startVerifyStandIn({
      comment: { url: "https://github.com/o/r/issues/77#issuecomment-3" },
      envelopeMsgId: "msg-43",
      results: [
        { label: "review the docs", verdict: "not-mechanically-checkable", detail: "needs eyes" },
      ],
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await runVerify(home, cwd);
    server.stop(true);

    // An unmechanizable step is not a failure — ➖ prints, $? stays 0.
    expect(r.code).toBe(0);
    expect(r.out).toContain("  ➖ not-mechanically-checkable — review the docs: needs eyes");
  });
});
