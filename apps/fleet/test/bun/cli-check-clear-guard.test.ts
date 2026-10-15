// Board issue #495 (sweep 11 finding S11-F7, refs #467): behavioral coverage
// for `fleet check <id>` and `fleet clear-session-guard <id>` — the two CLI
// verbs whose whole body is wiring: one authenticated POST to the Worker's
// /studio/:id/check or /studio/:id/clear-session-guard route, a
// parseStudioStatus decode of the answer, a one-row formatTable print on
// stdout, then (check only) the optional full-ERROR line and the READY
// caveat, or (clear-session-guard only) the one-shot/superseded warning on
// stderr. S11-F7's finding: none of that wiring had a behavioral test — the
// 500-line rendering (a plain body vs a JSON {error} reason), the "answered
// 200 but the body was not a studio row" refusal, the full-ERROR threshold,
// and the caveat's very presence were all unverifiable claims about
// cli/fleet.ts.
//
// Why the subprocess lane: neither cmdCheck nor cmdClearSessionGuard is
// exported (cli/fleet.ts keeps them module-private; only main()'s dispatch
// reaches them), so no in-process test lane can call this code at all. A
// real Bun.spawn of the REAL cli/fleet.ts against a local Bun.serve Worker
// stand-in, with a temp HOME whose ~/.fleet/credentials points at the
// stand-in, is the only lane that can observe the whole edge — the same
// harness family test/bun/cli-destroy-unmerged.test.ts documents for
// cmdDestroy (accounts-cli.test.ts's original harness shape). The stand-in
// records every request, so "the right route was asked" is an assertion on
// a real request, never an inference.
//
// READY_CAVEAT is not exported either, so its distinctive substrings
// ("ALIVE, not WORKING", "ACTIVITY (issue #221)") are asserted from the
// captured stdout — proving the caveat printed without pinning the whole
// string against an import, which keeps scripts/test-lies-check.ts clean
// (no source reads, no own-module mocks, no exact-string import pins).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFleet } from "./helpers/fleet-cli";

const ID = "websites--web-studio";

/** A minimal studio row, the same shape the destroy lane's stand-in answers
 *  with — parseStudioStatus (cli/studio-row.ts) is a pass-through type guard
 *  keyed on id/state/error, so those three plus repoSlug are all a test's
 *  answer needs. */
function row(error: string | null): { id: string; state: string; error: string | null; repoSlug: string } {
  return { id: ID, state: "running", error, repoSlug: "acme-org/websites" };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A temp HOME whose ~/.fleet/credentials names this Worker stand-in —
 *  accounts-cli.test.ts's writeCredentials shape, same 0600 the real one
 *  wants. */
function tmpHomeWithCredentials(workerUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), "check-guard-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, ".fleet"), { recursive: true });
  const path = join(home, ".fleet", "credentials");
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "cid", accessClientSecret: "csecret" }));
  chmodSync(path, 0o600);
  return home;
}

/** The Worker stand-in: every request is recorded as "<METHOD> <pathname>"
 *  (so "the right route was asked" is an assertion on a real request), then
 *  handed to this test's own script — a Response answers it, undefined means
 *  the stand-in 404s the way a real Worker's router would. */
function startCheckServer(handler: (req: Request, pathname: string) => Response | undefined) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      requests.push(`${req.method} ${u.pathname}`);
      return handler(req, u.pathname) ?? new Response("not found", { status: 404 });
    },
  });
  return { server, requests };
}

describe("cmdCheck — the wiring, end to end (#495)", () => {
  test("a 200 row answers exit 0: the one-row table, the READY caveat's distinctive substrings, no full-ERROR line, one POST /studio/:id/check", async () => {
    const { server, requests } = startCheckServer((_req, pathname) =>
      pathname === `/studio/${ID}/check` ? Response.json(row(null)) : undefined);
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["check", ID], home);
      expect(r.code).toBe(0);
      // The one-row table: the studio id and the header row's STATE column.
      expect(r.out).toContain(ID);
      expect(r.out).toContain("STATE");
      // READY_CAVEAT is not exported — its distinctive substrings stand in
      // for an exact-string import pin (plan step 4).
      expect(r.out).toContain("ALIVE, not WORKING");
      expect(r.out).toContain("ACTIVITY (issue #221)");
      // A null error already fits the ERROR cell whole — no full-ERROR line.
      expect(r.out).not.toContain("ERROR (full):");
      expect(requests).toContain(`POST /studio/${ID}/check`);
    } finally {
      server.stop(true);
    }
  });

  test("a row whose error exceeds the table cell cap also prints 'ERROR (full):' carrying every one of the 300 chars", async () => {
    const longError = "e".repeat(300);
    const { server, requests } = startCheckServer((_req, pathname) =>
      pathname === `/studio/${ID}/check` ? Response.json(row(longError)) : undefined);
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["check", ID], home);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`ERROR (full): ${longError}`);
      expect(requests).toContain(`POST /studio/${ID}/check`);
    } finally {
      server.stop(true);
    }
  });

  test("a 500 with a plain-text body prints 'fleet check: 500 <body>' and exits 1", async () => {
    const { server } = startCheckServer(() => new Response("worker exploded", { status: 500 }));
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["check", ID], home);
      expect(r.code).toBe(1);
      // toContain, not a whole-string pin: the contract is the prefix names
      // the verb and the status, then the body's own words, verbatim.
      expect(r.err).toContain("fleet check: 500");
      expect(r.err).toContain("fleet check: 500 worker exploded");
    } finally {
      server.stop(true);
    }
  });

  test("a 500 with a JSON {error} body prints the reason, never raw JSON, and exits 1", async () => {
    const { server } = startCheckServer(() =>
      Response.json({ error: "the container did not answer an 8s probe" }, { status: 500 }));
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["check", ID], home);
      expect(r.code).toBe(1);
      expect(r.err).toContain("fleet check: 500 the container did not answer an 8s probe");
      // Issue #217's rule, behavioral: the operator reads the reason, not
      // the JSON blob it arrived in.
      expect(r.err).not.toContain("{");
    } finally {
      server.stop(true);
    }
  });

  test("a 200 whose body is not a studio row refuses: exit 1 and the 'answered 200' line", async () => {
    const { server } = startCheckServer(() => Response.json({ ok: true }));
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["check", ID], home);
      expect(r.code).toBe(1);
      expect(r.err).toContain("fleet check: answered 200 but the body was not a studio row");
    } finally {
      server.stop(true);
    }
  });
});

describe("cmdClearSessionGuard — the wiring, end to end (#495)", () => {
  test("a 200 row answers exit 0: the table on stdout, the one-shot/superseded warning naming the id on stderr, one POST /studio/:id/clear-session-guard", async () => {
    const { server, requests } = startCheckServer((_req, pathname) =>
      pathname === `/studio/${ID}/clear-session-guard` ? Response.json(row(null)) : undefined);
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["clear-session-guard", ID], home);
      expect(r.code).toBe(0);
      expect(r.out).toContain(ID);
      expect(r.out).toContain("STATE");
      // The stderr warning says WHAT was armed (one-shot), WHAT happens to
      // the old latest (superseded/), and WHICH studio it names.
      expect(r.err).toContain("one-shot");
      expect(r.err).toContain("superseded");
      expect(r.err).toContain(ID);
      expect(requests).toContain(`POST /studio/${ID}/clear-session-guard`);
    } finally {
      server.stop(true);
    }
  });

  test("a 500 with body 'nope' prints 'fleet clear-session-guard: 500 nope' and exits 1", async () => {
    const { server } = startCheckServer(() => new Response("nope", { status: 500 }));
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["clear-session-guard", ID], home);
      expect(r.code).toBe(1);
      expect(r.err).toContain("fleet clear-session-guard: 500");
      expect(r.err).toContain("fleet clear-session-guard: 500 nope");
    } finally {
      server.stop(true);
    }
  });

  test("a 200 whose body is not a studio row refuses: exit 1 and the 'answered 200' line", async () => {
    const { server } = startCheckServer(() => Response.json({ ok: true }));
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await runFleet(["clear-session-guard", ID], home);
      expect(r.code).toBe(1);
      expect(r.err).toContain("fleet clear-session-guard: answered 200 but the body was not a studio row");
    } finally {
      server.stop(true);
    }
  });
});
