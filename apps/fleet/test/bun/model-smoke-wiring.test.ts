// apps/fleet/test/bun/model-smoke-wiring.test.ts — issue #1476 round 3
// (maestro LIVE review bounce): coverage for scripts/model-smoke.ts's own
// catalog-field parsing, its wiring to planSmokeCatalogCheck (fetch catalog
// -> decide -> refuse before any inference call), and the AI Gateway
// cache-skip header every live call it makes must send. None of this needs
// real Cloudflare credentials or network — parseCatalogEntry/
// planSmokeCatalogCheck/smokeCall are pure (or fetch-injectable) functions
// exported from the script itself (gated behind `import.meta.main`, so
// importing them here never runs `main()`'s live side effects); the wiring
// test below stubs the `wrangler` binary the same way
// helpers/deploy-rescue-harness.ts stubs it for deploy-target.ts.
import { describe, expect, test, afterEach } from "bun:test";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_GATEWAY_SKIP_CACHE_HEADER, parseCatalogEntry, planSmokeCatalogCheck, smokeCall,
} from "../../scripts/model-smoke";
import { POOL } from "../../src/llm/models";

const NOW = new Date("2026-11-26T00:00:00.000Z").getTime();

describe("parseCatalogEntry (#1476 round 3, R1)", () => {
  test("a real-shape catalog entry — `.id` a UUID, `.name` the model id string — resolves by `.name`", () => {
    const glm = parseCatalogEntry({ id: "11111111-2222-3333-4444-555555555555", name: "@cf/zai-org/glm-5.3" });
    expect(glm.id).toBe("@cf/zai-org/glm-5.3");
    // Feeding this through the same check model-smoke.ts itself runs: a
    // present, real-shape entry resolves "ok", never "retired".
    expect(planSmokeCatalogCheck([glm], "@cf/zai-org/glm-5.3", NOW).status).toBe("ok");
  });

  test("a genuinely retired id — absent `.name` match — still resolves retired", () => {
    const entries = [{ id: "11111111-2222-3333-4444-555555555555", name: "@cf/zai-org/glm-5.3" }].map(parseCatalogEntry);
    expect(planSmokeCatalogCheck(entries, "@cf/moonshotai/kimi-k2.7-code", NOW).status).toBe("retired");
  });

  test("a catalog entry with no `.name` at all falls back to `.id`", () => {
    expect(parseCatalogEntry({ id: "@cf/some/legacy-shape" }).id).toBe("@cf/some/legacy-shape");
  });
});

describe("parseCatalogEntry planned_deprecation_date (#1476 round 3, L1)", () => {
  test("top-level field, when present, wins", () => {
    const e = parseCatalogEntry({ name: "@cf/x/y", planned_deprecation_date: "2027-01-01T00:00:00.000Z" });
    expect(e.planned_deprecation_date).toBe("2027-01-01T00:00:00.000Z");
  });

  test("no top-level field: scans properties[] for property_id === planned_deprecation_date", () => {
    const e = parseCatalogEntry({
      name: "@cf/x/y",
      properties: [{ property_id: "context_window", value: "128000" }, { property_id: "planned_deprecation_date", value: "2027-03-01T00:00:00.000Z" }],
    });
    expect(e.planned_deprecation_date).toBe("2027-03-01T00:00:00.000Z");
  });

  test("no top-level field, no matching properties[] entry: undefined (ok, no date at all)", () => {
    const e = parseCatalogEntry({ name: "@cf/x/y", properties: [{ property_id: "context_window", value: "128000" }] });
    expect(e.planned_deprecation_date).toBeUndefined();
  });
});

describe("planSmokeCatalogCheck (#1476 round 2/3, R2)", () => {
  test("absent from the catalog: proceed=false, refusal message names the id", () => {
    const d = planSmokeCatalogCheck([], "@cf/zai-org/glm-5.3", NOW);
    expect(d.status).toBe("retired");
    expect(d.proceed).toBe(false);
    expect(d.message).toContain("@cf/zai-org/glm-5.3 is retired");
  });

  test("present, no date: proceed=true, no message", () => {
    const d = planSmokeCatalogCheck([{ id: "@cf/zai-org/glm-5.3" }], "@cf/zai-org/glm-5.3", NOW);
    expect(d.status).toBe("ok");
    expect(d.proceed).toBe(true);
    expect(d.message).toBeNull();
  });

  test("present, within the warn window: proceed=true, warning message", () => {
    const soon = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString();
    const d = planSmokeCatalogCheck([{ id: "@cf/zai-org/glm-5.3", planned_deprecation_date: soon }], "@cf/zai-org/glm-5.3", NOW);
    expect(d.status).toBe("warn");
    expect(d.proceed).toBe(true);
    expect(d.message).toContain("within the warning window");
  });
});

describe("smokeCall (#1476 round 3, R3): AI Gateway cache-skip header", () => {
  test("every call sets cf-aig-skip-cache: true — the same call() wraps this for tool-call, multi-turn, and stream steps alike", async () => {
    const seen: RequestInit[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    }) as typeof fetch;
    await smokeCall("https://example.invalid/x", "tok", POOL[0], { messages: [], max_tokens: 10 }, fakeFetch);
    await smokeCall("https://example.invalid/x", "tok", POOL[0], { messages: [], max_tokens: 10, stream: true }, fakeFetch);
    expect(seen).toHaveLength(2);
    for (const init of seen) {
      expect((init.headers as Record<string, string>)[AI_GATEWAY_SKIP_CACHE_HEADER]).toBe("true");
    }
  });

  test("a non-ok response still throws (unchanged behavior) even with the new header set", async () => {
    const fakeFetch = (async (_url: string, _init: RequestInit) => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(smokeCall("https://example.invalid/x", "tok", POOL[0], {}, fakeFetch)).rejects.toThrow(/HTTP 500/);
  });
});

// Wiring (#1476 round 2/3/4, R2/R6): the maestro's mutation run found two
// surviving mutants in the REMAINING top-level script glue -- deleting the
// retired-exit branch, and hardcoding the decision's status to "ok" -- with
// 191/191 of the then-existing suite still green. Round 4's LIVE review
// found the round-2/3 fix for this still incomplete: the "present id" test
// below used to send a REAL request to the live gateway on every CI run
// (network-dependent, and the fake token's 401 was the ONLY thing standing
// in for "proceeded past the catalog check" -- a live gateway outage or a
// change to its auth-failure shape would silently break the test's own
// signal), and neither test ever observed what the script's own requests
// actually carried (the `cf-aig-skip-cache` header was asserted only on
// direct `smokeCall` unit calls above, never on the 3 requests `main()`
// itself sends end to end).
//
// Fix: runs the REAL script as a subprocess (same technique
// test/bun/model-smoke.test.ts already uses), with a stub `wrangler`
// standing in for the live binary (same technique
// test/bun/helpers/deploy-rescue-harness.ts uses for deploy-target.ts's own
// `wranglerJson`) AND fixtures/model-smoke-fetch-spy.ts preloaded ahead of
// the script (`bun --preload <spy> <script> <key>`) to replace
// `globalThis.fetch` itself before model-smoke.ts's module body ever runs.
// The spy logs one JSON line per request -- `{url, skip, stream}` -- to a
// file named by FETCH_SPY_LOG and answers with canned OpenAI-shape
// responses; the real network is never reached by either test, online or
// offline, because `fetch` itself never resolves to the real implementation
// at any point in the child process's lifetime.
const SCRIPT = join(import.meta.dir, "../../scripts/model-smoke.ts");
const SRC = join(import.meta.dir, "../../src");
const SPY = join(import.meta.dir, "fixtures/model-smoke-fetch-spy.ts");

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function buildWiringHarness(catalogJson: string): { scriptPath: string; logPath: string } {
  root = mkdtempSync(join(tmpdir(), "model-smoke-wiring-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  copyFileSync(SCRIPT, join(root, "scripts", "model-smoke.ts"));
  symlinkSync(SRC, join(root, "src"));
  const wrangler = join(root, "node_modules", ".bin", "wrangler");
  writeFileSync(wrangler, [
    "#!/bin/sh",
    'case "$1 $2 $3" in',
    '  "ai models list")',
    `    cat <<'JSON'`,
    catalogJson,
    "JSON",
    "    exit 0 ;;",
    "esac",
    "exit 9",
    "",
  ].join("\n"));
  chmodSync(wrangler, 0o755);
  return { scriptPath: join(root, "scripts", "model-smoke.ts"), logPath: join(root, "fetch-spy.log") };
}

/** Missing log file (nothing ever fetched) reads as zero requests, rather
 *  than throwing on the absent-id path where the spy's own
 *  `appendFileSync` never runs at all. */
function readLoggedRequests(logPath: string): Array<{ url: string; skip: string | null; stream: boolean }> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function runWithSpy(scriptPath: string, logPath: string) {
  return Bun.spawnSync({
    cmd: ["bun", "--preload", SPY, scriptPath, "glm"],
    env: {
      PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: "acct-fake", CLOUDFLARE_API_TOKEN: "token-fake",
      FETCH_SPY_LOG: logPath,
    },
    stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
}

describe("model-smoke.ts wiring (#1476 round 2/4, R2/R6): catalog check refuses before any inference call", () => {
  test("catalog missing the target id: exits 1 with the catalog-refusal message, 0 inference requests ever sent", () => {
    // A catalog that has OTHER entries but not glm's id — same real shape
    // parseCatalogEntry reads (.name as the model id string).
    const { scriptPath, logPath } = buildWiringHarness(JSON.stringify([
      { id: "aaaa-bbbb", name: "@cf/some/other-model" },
    ]));
    const proc = runWithSpy(scriptPath, logPath);
    const stderr = proc.stderr.toString();
    expect(proc.exitCode, stderr).toBe(1);
    expect(stderr).toContain("SMOKE FAIL @cf/zai-org/glm-5.3 is retired");
    expect(stderr).toContain("refusing before spending an inference call");
    // The decisive check (catches M2b: deleting the `process.exit(1);
    // return;` right after the refusal message): with the real `fetch`
    // fully replaced by the spy, nothing distinguishes "refused, stopped"
    // from "refused, kept going" except whether a request was ever logged
    // at all — the mutant falls through to the live inference calls, which
    // the spy happily answers, so the log would carry 3 entries instead.
    expect(readLoggedRequests(logPath)).toHaveLength(0);
  });

  test("catalog carries the target id: proceeds, sends exactly 3 inference requests, every one cache-skipped, and PASSes", () => {
    const { scriptPath, logPath } = buildWiringHarness(JSON.stringify([
      { id: "aaaa-bbbb", name: "@cf/zai-org/glm-5.3" },
    ]));
    const proc = runWithSpy(scriptPath, logPath);
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    expect(proc.exitCode, stderr).toBe(0);
    expect(stdout).toContain("SMOKE PASS @cf/zai-org/glm-5.3");
    const requests = readLoggedRequests(logPath);
    // The decisive check (catches M4b: the stream call site sent as a raw
    // `fetch` bypassing `smokeCall`, so it never carries the header): all 3
    // of the script's own live-shaped calls (tool call, multi-turn, stream)
    // go through this one assertion, not just the two covered by the direct
    // `smokeCall` unit tests above.
    expect(requests).toHaveLength(3);
    for (const r of requests) expect(r.skip).toBe("true");
  });
});
