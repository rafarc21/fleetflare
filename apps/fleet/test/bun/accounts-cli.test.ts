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
import { CSWAP_LIST_FIXTURE, OVER_FIVE_HOUR, UNDER_THRESHOLD } from "../fixtures/cswap-list";

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

interface SyncCall { decisions: { name: string; action: string; until?: string | null; seenAt?: string }[] }

function startWorker(accountsRows: { name: string; label: string | null; dead: boolean; until: string | null; seenAt: string | null }[]) {
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
        return Response.json({ applied: body.decisions.map((d) => d.name), rejected: [] });
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
    expect(r.out).toContain(OVER_FIVE_HOUR.usage.fiveHour.resetsAt!); // WOULD: limit until this
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
    const rows = JSON.parse(r.out) as { name: string; decision: { action: string } }[];
    expect(rows).toHaveLength(3);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN"]!.decision.action).toBe("limit");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_2"]!.decision.action).toBe("clear");
    expect(byName["CLAUDE_CODE_OAUTH_TOKEN_3"]!.decision.action).toBe("unmanaged");
    expect(syncCalls.length).toBe(0);
  });

  test("missing cswap binary: every slot reads unmanaged, table still prints, no crash", async () => {
    const home = tmpDir("accounts-home-");
    const { server, syncCalls } = startWorker(ACCOUNT_SLOTS);
    writeCredentials(home, `http://127.0.0.1:${server.port}`);

    // No fake cswap on PATH at all — this container has none installed
    // either, so the ordinary PATH already proves the real "not installed"
    // case, not just a synthetic one.
    const r = await run(["accounts", "--json"], home);
    server.stop(true);

    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as { name: string; decision: { action: string; reason?: string } }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.decision.action).toBe("unmanaged");
      expect(row.decision.reason).toBe("cswap-missing");
    }
    expect(syncCalls.length).toBe(0);
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
    expect(limit.until).toBe(OVER_FIVE_HOUR.usage.fiveHour.resetsAt);
    const clear = decisions.find((d) => d.name === "CLAUDE_CODE_OAUTH_TOKEN_2")!;
    expect(clear.action).toBe("clear");

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
          return Response.json({ applied: [], rejected: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", reason: "unknown account name" }] });
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
});
