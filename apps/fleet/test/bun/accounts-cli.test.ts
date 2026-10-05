// apps/fleet/test/bun/accounts-cli.test.ts
// Issue #232, step 3: `fleet accounts` / `fleet accounts sync`. Mirrors
// junior-stats-cli.test.ts's real-subprocess-against-a-real-HOME pattern: a
// real `Bun.spawn` of cli/fleet.ts, a real local Bun.serve standing in for
// the Worker (GET /studio/accounts, POST /studio/accounts/sync), a temp HOME
// with a synthetic credentials file, and — for the "cswap available" tests —
// a fake `cswap` executable on PATH that prints the SAME fixture
// test/fixtures/cswap-list.ts's claude-swap.test.ts already uses, never new
// inline data.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSWAP_LIST_FIXTURE, OVER_FIVE_HOUR, UNDER_THRESHOLD, RELOGIN_REQUIRED, STALE_OK } from "../fixtures/cswap-list";

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

function writeCredentials(home: string, workerUrl: string) {
  mkdirSync(join(home, ".fleet"), { recursive: true });
  const path = join(home, ".fleet", "credentials");
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "id", accessClientSecret: "secret" }));
  chmodSync(path, 0o600);
}

/** A fake `cswap` on PATH: `cswap list --json` prints `accounts` verbatim,
 *  anything else exits 1. Reuses the real fixture's own values — never new
 *  inline data (see this file's own header). */
function writeFakeCswap(accounts: unknown[]): string {
  const dir = tmpDir("fake-cswap-");
  const path = join(dir, "cswap");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "list" ] && [ "$2" = "--json" ]; then\n  cat <<'CSWAP_JSON'\n${JSON.stringify(accounts)}\nCSWAP_JSON\nelse\n  exit 1\nfi\n`,
  );
  chmodSync(path, 0o755);
  return dir;
}

interface SyncCall { usageFetchedAt: string; decisions: { name: string; action: string; until?: string | null; seenAt?: string }[] }

/** `syncResponse` overrides the worker's own `{applied, rejected, skipped}`
 *  answer (default: every posted decision applied, nothing rejected/skipped)
 *  — used by the "skipped" coverage below, which needs the fake Worker to
 *  answer with a `skipped` entry rather than echoing every name as applied. */
function startWorker(
  accountsRows: { name: string; label: string | null; dead: boolean; until: string | null; seenAt: string | null }[],
  syncResponse?: (body: SyncCall) => { applied: string[]; rejected: { name: string; reason: string }[]; skipped: { name: string; reason: string }[] },
) {
  const syncCalls: SyncCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/studio/accounts" && req.method === "GET") {
        return Response.json(accountsRows);
      }
      if (url.pathname === "/studio/accounts/sync" && req.method === "POST") {
        const body = (await req.json()) as SyncCall;
        syncCalls.push(body);
        if (syncResponse) return Response.json(syncResponse(body));
        return Response.json({ applied: body.decisions.map((d) => d.name), rejected: [], skipped: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, syncCalls };
}

async function run(args: string[], home: string, extraPath?: string) {
  const PATH = extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH!;
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    env: { PATH, HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { out, err, code };
}

/** Reads `stream` incrementally until `predicate` matches the text seen so
 *  far, or `timeoutMs` elapses (whichever first). Used ONLY for the
 *  long-running `--watch` test below, which must observe a stderr line
 *  WITHOUT waiting for the process to exit (it never does on its own) —
 *  the whole loop races against a single timeout rather than racing each
 *  individual `reader.read()`, so an abandoned pending read on timeout is
 *  left for the test's own `proc.kill()` to clean up, never a stuck lock. */
function readUntil(stream: ReadableStream<Uint8Array>, predicate: (text: string) => boolean, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const loop = (async () => {
    while (!predicate(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`readUntil: stream ended before match; saw: ${JSON.stringify(text)}`);
      text += decoder.decode(value, { stream: true });
    }
    return text;
  })();
  const timeout = new Promise<string>((_, reject) => {
    setTimeout(() => reject(new Error(`readUntil: timed out waiting for match; saw: ${JSON.stringify(text)}`)), timeoutMs);
  });
  return Promise.race([loop, timeout]);
}

// Fleet slots joined to CSWAP_LIST_FIXTURE by label===email: primary ->
// OVER_FIVE_HOUR (limit), spare -> UNDER_THRESHOLD (clear), a third with no
// label -> unmanaged (no-label). Exercises all three decision kinds in one
// snapshot, same as claude-swap.test.ts's own join tests.
const ACCOUNT_SLOTS = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", dead: false, until: null, seenAt: null },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: "spare@example.com", dead: false, until: null, seenAt: null },
  { name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: null, dead: false, until: null, seenAt: null },
];

describe("fleet accounts", () => {
  test("bare: prints a table, never calls the sync route", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap(CSWAP_LIST_FIXTURE);
    const { server, syncCalls } = startWorker(ACCOUNT_SLOTS);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts"], home, cswapDir);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.out).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(r.out).toContain("primary@example.com");
    expect(r.out).toContain("97%");
    expect(r.out).toContain("free"); // ROW STATE: D1 currently holds nothing
    expect(r.out).toContain(OVER_FIVE_HOUR.usage!.fiveHour.resetsAt!); // WOULD: limit until this
    expect(r.out).toContain("label"); // MATCH column: matched by label===email
    expect(syncCalls.length).toBe(0);
  });

  test("--json prints parseable JSON matching the table's own data", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap(CSWAP_LIST_FIXTURE);
    const { server, syncCalls } = startWorker(ACCOUNT_SLOTS);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts", "--json"], home, cswapDir);
    server.stop(true);

    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { name: string; matchSource: string; decision: { action: string } }[];
    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN"]!.decision.action).toBe("limit");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN"]!.matchSource).toBe("label");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_2"]!.decision.action).toBe("clear");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_3"]!.decision.action).toBe("unmanaged");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_3"]!.matchSource).toBe("unmapped");
    expect(syncCalls.length).toBe(0);
  });

  // Issue #232 code review finding, this dispatch's own item 1: cswap's own
  // failure-status (RELOGIN_REQUIRED) and stale-but-otherwise-ok (STALE_OK)
  // accounts both gate to "no-data" — never "unmanaged" — distinctly from a
  // slot with genuinely no label/reset-time match at all. Labels two slots
  // straight onto those two fixtures (label===email, so the join is a clean
  // "label" match either way) and leaves a third slot with no label and no
  // `until` to exercise the genuinely-unmapped case side by side.
  test("a failed-status and a stale-but-ok cswap reading both read no-data, distinctly from unmanaged", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap([RELOGIN_REQUIRED, STALE_OK]);
    const slots = [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", label: RELOGIN_REQUIRED.email, dead: false, until: null, seenAt: null },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_2", label: STALE_OK.email, dead: false, until: null, seenAt: null },
      { name: "CLAUDE_CODE_OAUTH_TOKEN_3", label: null, dead: false, until: null, seenAt: null },
    ];
    const { server, syncCalls } = startWorker(slots);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts", "--json"], home, cswapDir);

    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { name: string; matchSource: string; decision: { action: string; reason?: string } }[];
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN"]!.matchSource).toBe("label");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN"]!.decision.action).toBe("no-data");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN"]!.decision.reason).toContain("relogin_required");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_2"]!.matchSource).toBe("label");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_2"]!.decision.action).toBe("no-data");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_2"]!.decision.reason).toContain("900s old");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_3"]!.matchSource).toBe("unmapped");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_3"]!.decision.action).toBe("unmanaged");
    expect(syncCalls.length).toBe(0);

    // Plain-text table: the two no-data rows read "no data (...)" in WOULD,
    // the genuinely-unmapped row reads a bare "-" — never the same text.
    const r2 = await run(["accounts"], home, cswapDir);
    server.stop(true);
    expect(r2.out).toContain("no data (usageStatus: relogin_required)");
    expect(r2.out).toContain("no data (usage data is 900s old");
    const lines = r2.out.split("\n");
    const unmappedLine = lines.find((l) => l.startsWith("CLAUDE_CODE_OAUTH_TOKEN_3"))!;
    expect(unmappedLine.trim().endsWith("-")).toBe(true);
  });

  test("missing cswap binary: every slot reads unmanaged (matchSource cswap-missing), table still prints, no crash", async () => {
    const home = tmpDir("accounts-home-");
    const { server, syncCalls } = startWorker(ACCOUNT_SLOTS);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    // No fake cswap on PATH at all — this container has none installed
    // either, so the ordinary PATH already proves the real "not installed"
    // case, not just a synthetic one.
    const r = await run(["accounts", "--json"], home);
    server.stop(true);

    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { name: string; matchSource: string; decision: { action: string } }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.decision.action).toBe("unmanaged");
      // "cswap-missing" is the JOIN's own matchSource now, not a decision
      // reason — decideAccountSync's "unmanaged" carries no `reason` field
      // at all (claude-swap.ts's SyncDecision union).
      expect(row.matchSource).toBe("cswap-missing");
    }
    expect(syncCalls.length).toBe(0);
  });

  // This dispatch's item 4: a slot resolved by reset-time INFERENCE (no
  // label match at all) must still show up correctly — `matchSource:
  // "inferred"`, not "label" — in both the JSON snapshot and the table's own
  // MATCH column. One fake cswap account, one slot with no label whose own
  // `until` sits within the +/-5min reset-match window of that account's
  // fiveHour reset.
  test("a reset-time-inferred match reads matchSource 'inferred' in JSON and the table's MATCH column", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap([OVER_FIVE_HOUR]);
    const inferredUntil = new Date(Date.parse(OVER_FIVE_HOUR.usage!.fiveHour.resetsAt!) + 60_000).toISOString();
    const slots = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, until: inferredUntil, seenAt: null }];
    const { server, syncCalls } = startWorker(slots);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts", "--json"], home, cswapDir);

    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { name: string; matchSource: string; matchedEmail: string | null }[];
    expect(rows[0]!.matchSource).toBe("inferred");
    expect(rows[0]!.matchedEmail).toBe(OVER_FIVE_HOUR.email);

    const r2 = await run(["accounts"], home, cswapDir);
    server.stop(true);
    const [header, body] = r2.out.split("\n");
    expect(header.split(/\s{2,}/)).toContain("MATCH");
    expect(body).toContain("inferred");
    expect(syncCalls.length).toBe(0);
  });

  // This dispatch's item 3: --write-labels prints one CLAUDE_ACCOUNT_<n>_LABEL
  // suggestion per inferred slot, in the plain-text path as extra lines after
  // the table, and — combined with --json — folded into the SAME JSON object
  // rather than a separate stdout line that would corrupt it as JSON.
  describe("fleet accounts --write-labels", () => {
    test("plain text: prints a CLAUDE_ACCOUNT_<n>_LABEL suggestion after the table for an inferred match", async () => {
      const home = tmpDir("accounts-home-");
      const cswapDir = writeFakeCswap([OVER_FIVE_HOUR]);
      const inferredUntil = OVER_FIVE_HOUR.usage!.fiveHour.resetsAt!;
      const slots = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, until: inferredUntil, seenAt: null }];
      const { server } = startWorker(slots);
      writeCredentials(home, `http://127.0.0.1:${server.port}`);

      const r = await run(["accounts", "--write-labels"], home, cswapDir);
      server.stop(true);

      expect(r.code).toBe(0);
      expect(r.out).toContain(`CLAUDE_ACCOUNT_1_LABEL=${OVER_FIVE_HOUR.email}`);
    });

    test("--json folds label suggestions into the JSON object, never a separate corrupting stdout line", async () => {
      const home = tmpDir("accounts-home-");
      const cswapDir = writeFakeCswap([OVER_FIVE_HOUR]);
      const inferredUntil = OVER_FIVE_HOUR.usage!.fiveHour.resetsAt!;
      const slots = [{ name: "CLAUDE_CODE_OAUTH_TOKEN", label: null, dead: false, until: inferredUntil, seenAt: null }];
      const { server } = startWorker(slots);
      writeCredentials(home, `http://127.0.0.1:${server.port}`);

      const r = await run(["accounts", "--write-labels", "--json"], home, cswapDir);
      server.stop(true);

      expect(r.code).toBe(0);
      // Parsing the WHOLE stdout as one JSON value is itself the "never a
      // separate corrupting stdout line" assertion — a bare suggestion line
      // mixed into stdout would break this parse outright.
      const parsed = JSON.parse(r.out) as { accounts: { name: string }[]; labelSuggestions: string[] };
      expect(parsed.accounts).toHaveLength(1);
      expect(parsed.labelSuggestions).toEqual([`CLAUDE_ACCOUNT_1_LABEL=${OVER_FIVE_HOUR.email}`]);
    });

    test("no inferred matches: plain text prints no suggestion line, --json prints an empty array", async () => {
      const home = tmpDir("accounts-home-");
      const cswapDir = writeFakeCswap(CSWAP_LIST_FIXTURE);
      const { server } = startWorker(ACCOUNT_SLOTS); // label matches only — no inferred rows
      writeCredentials(home, `http://127.0.0.1:${server.port}`);

      const r = await run(["accounts", "--write-labels"], home, cswapDir);
      expect(r.out).not.toContain("CLAUDE_ACCOUNT_");

      const r2 = await run(["accounts", "--write-labels", "--json"], home, cswapDir);
      server.stop(true);
      const parsed = JSON.parse(r2.out) as { labelSuggestions: string[] };
      expect(parsed.labelSuggestions).toEqual([]);
    });
  });
});

describe("fleet accounts sync", () => {
  test("posts the non-unmanaged decisions to the sync route", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap(CSWAP_LIST_FIXTURE);
    const { server, syncCalls } = startWorker(ACCOUNT_SLOTS);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts", "sync"], home, cswapDir);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(syncCalls.length).toBe(1);
    const decisions = syncCalls[0]!.decisions;
    // Unmanaged (CLAUDE_CODE_OAUTH_TOKEN_3, no-label) is never sent — the
    // route's own posture is "unmanaged writes nothing", so sending it would
    // be a pointless no-op round-trip.
    expect(decisions.map((d) => d.name).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2"]);
    const limit = decisions.find((d) => d.name === "CLAUDE_CODE_OAUTH_TOKEN")!;
    expect(limit.action).toBe("limit");
    expect(limit.until).toBe(OVER_FIVE_HOUR.usage!.fiveHour.resetsAt);
    const clear = decisions.find((d) => d.name === "CLAUDE_CODE_OAUTH_TOKEN_2")!;
    expect(clear.action).toBe("clear");
    // The ONE snapshot timestamp (buildAccountsSnapshot's own `fetchedAt`),
    // ISO-stringified, rides the POST's top-level `usageFetchedAt` — the
    // yardstick routes.ts's MAJOR 6 clear-skip check compares a row's own
    // `seenAt` against.
    expect(typeof syncCalls[0]!.usageFetchedAt).toBe("string");
    expect(Number.isFinite(Date.parse(syncCalls[0]!.usageFetchedAt))).toBe(true);

    expect(r.err).toContain("applied 2");
    expect(r.out).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("reports what the route rejected, still prints the table, exits 0", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap([OVER_FIVE_HOUR, UNDER_THRESHOLD]);
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/studio/accounts" && req.method === "GET") {
          return Response.json([
            { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "primary@example.com", dead: false, until: null, seenAt: null },
          ]);
        }
        if (url.pathname === "/studio/accounts/sync" && req.method === "POST") {
          return Response.json({ applied: [], rejected: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "unknown account name" }], skipped: [] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts", "sync"], home, cswapDir);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(r.err).toContain("rejected CLAUDE_CODE_OAUTH_TOKEN (unknown account name)");
    expect(r.out).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  // Issue #232 review MAJOR 6: a "clear" the route skipped (a fresher
  // sighting already recorded after this snapshot's own usageFetchedAt) is a
  // correct no-op, not an error — this dispatch's item 5 asks for it to be
  // reported distinctly from both applied and rejected.
  test("reports what the route skipped, distinctly from applied/rejected, still exits 0", async () => {
    const home = tmpDir("accounts-home-");
    const cswapDir = writeFakeCswap(CSWAP_LIST_FIXTURE);
    const { server, syncCalls } = startWorker(ACCOUNT_SLOTS, (body) => ({
      applied: [body.decisions.find((d) => d.name === "CLAUDE_CODE_OAUTH_TOKEN")!.name],
      rejected: [],
      skipped: [{ name: "CLAUDE_CODE_OAUTH_TOKEN_2", reason: "newer row exists" }],
    }));
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const r = await run(["accounts", "sync"], home, cswapDir);
    server.stop(true);

    expect(r.code).toBe(0);
    expect(syncCalls.length).toBe(1);
    expect(r.err).toContain("applied 1 (CLAUDE_CODE_OAUTH_TOKEN)");
    expect(r.err).toContain("skipped CLAUDE_CODE_OAUTH_TOKEN_2 (newer row exists)");
    expect(r.err).not.toContain("rejected");
    expect(r.out).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

// Issue #232 code review finding 3: `--watch` must tolerate a failed
// iteration (a non-2xx or a dropped connection) rather than exiting the
// whole long-running session, unlike the bare one-shot commands above
// (which correctly keep exiting loudly on the same failure — see the
// "bad status -> exit 1" coverage already in the two describe blocks
// above this one, left unchanged by this fix).
//
// WATCH_INTERVAL_MS is a real 60s, so this test only observes the FIRST
// iteration: a GET /studio/accounts that always 500s, which previously made
// `fetchAccountsApi` call `process.exit(1)` directly (even inside the
// watch loop). It never waits for — or asserts anything about — a second
// iteration, since that would need a real 60s sleep to elapse; "the process
// is still alive and printed the retry line shortly after the failing
// fetch" is already the fault-tolerance claim this finding is about.
describe("fleet accounts --watch", () => {
  test("a failing iteration prints a retry line and does not exit the process", async () => {
    const home = tmpDir("accounts-home-");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/studio/accounts" && req.method === "GET") {
          return new Response("boom", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    const proc = Bun.spawn({
      cmd: [process.execPath, FLEET, "accounts", "--watch"],
      env: { PATH: process.env.PATH!, HOME: home },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    try {
      const seen = await readUntil(
        proc.stderr as ReadableStream<Uint8Array>,
        (text) => text.includes("iteration failed"),
        10_000,
      );
      expect(seen).toContain("iteration failed, retrying");

      // The bug this finding describes was `process.exit(1)` running
      // synchronously right after printing the (old) error line — so give
      // the event loop a moment, then confirm the process has NOT exited
      // on its own (it is still sleeping out WATCH_INTERVAL_MS).
      const stillRunning = await Promise.race([
        proc.exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300)),
      ]);
      expect(stillRunning).toBe(true);
    } finally {
      proc.kill();
      server.stop(true);
    }
  });
});
