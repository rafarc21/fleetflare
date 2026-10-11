// Board issue #332, plan step 3: `fleet ls`'s PRS column — how many unmerged,
// still-open PRs each studio's assigned tasks' newest result envelopes name,
// read from the board's batched GET /studio/board/open-prs route (steps 1-2).
// Model: test/bun/fleet-ls-wip.test.ts (the WIP column's own suite) for the
// pure formatTable half, and test/bun/fleet-ls-footer.test.ts (a real cmdLs
// run against a local Bun.serve Worker stand-in) for the wiring half.
//
// The fetch half is provable WITHOUT a network because openPrsByStudio takes
// the fetch port as an argument — the same injected-dependency posture
// TabsDeps documents (cli/fleet.ts) for exactly this class of
// untestable-outside-a-real-network problem.
import { describe, expect, test } from "bun:test";
import { afterAll, beforeAll } from "bun:test";
import { cmdLs, formatTable, openPrsByStudio, type Credentials } from "../../cli/fleet";
import type { OrcaDeps } from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const CREDS: Credentials = { workerUrl: "https://worker.test", accessClientId: "cid", accessClientSecret: "csecret" };

function row(overrides: Partial<StudioStatus> = {}, id = "websites--web-studio"): StudioStatus {
  return {
    id, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null, ...overrides,
  };
}

/** One OpenPr, the exact shape the route answers with (src/board/open-prs.ts). */
function pr(prNumber: number, taskNumber = 12): { taskNumber: number; prNumber: number; title: string; url: string } {
  return {
    taskNumber, prNumber,
    title: `feat: thing ${prNumber}`,
    url: `https://github.com/acme-org/websites/pull/${prNumber}`,
  };
}

/** The PRS cell of one rendered table line, by header position. */
function prsCell(header: string, line: string): string {
  return line.split(/\s{2,}/)[header.split(/\s{2,}/).indexOf("PRS")];
}

/** formatTable's header and row lines, split apart. */
function tableLines(out: string): string[] {
  return out.split("\n");
}

describe("fleet ls table — PRS column (#332)", () => {
  test("has a PRS column between WIP and READY", () => {
    const [header] = tableLines(formatTable([row()], NOW));
    const cols = header.split(/\s{2,}/);
    expect(cols).toContain("PRS");
    expect(cols.indexOf("PRS")).toBe(cols.indexOf("WIP") + 1);
    expect(cols.indexOf("READY")).toBe(cols.indexOf("PRS") + 1);
  });

  test("no map at all (single-studio views, or a fetch that never ran): the cell reads '-'", () => {
    const [header, line] = tableLines(formatTable([row()], NOW));
    expect(prsCell(header, line)).toBe("-");
  });

  test("a counted entry renders its count; a zero entry renders '0', never '-'", () => {
    const map = new Map([
      ["websites--web-studio", 2],
      ["websites--pilot", 0],
      ["beta--pilot", 1],
    ]);
    const [header, ...lines] = tableLines(formatTable([
      row({ id: "websites--web-studio" }),
      row({ id: "websites--pilot", repoSlug: "acme-org/websites" }),
      row({ id: "beta--pilot", repoSlug: "acme-org/beta" }),
    ], NOW, null, map));
    expect(prsCell(header, lines[0])).toBe("2");
    expect(prsCell(header, lines[1])).toBe("0");
    expect(prsCell(header, lines[2])).toBe("1");
  });

  test("a studio the map does not cover reads '-' — 'could not look' never reads as 0", () => {
    const [header, line] = tableLines(formatTable([row({ id: "beta--pilot" })], NOW, null, new Map([["websites--web-studio", 3]])));
    expect(prsCell(header, line)).toBe("-");
  });

  test("a table that passes ONLY orca rows (the old call shape) still renders, PRS reads '-'", () => {
    const [header, line] = tableLines(formatTable([row()], NOW, new Map([["websites--web-studio", "open"]])));
    expect(header).toContain("PRS");
    expect(prsCell(header, line)).toBe("-");
  });
});

describe("openPrsByStudio — the map behind the column (#332)", () => {
  /** Records every request the helper makes, answers from a per-repo map. */
  function recorder(
    answers: Record<string, Record<string, ReturnType<typeof pr>[]>>,
    failures: string[] = [],
  ): { fetchImpl: typeof fetch; seen: { url: string; headers: Record<string, string> }[] } {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const repo = new URL(url).searchParams.get("repo");
      const key = repo ?? "(default)";
      if (failures.includes(key)) return new Response("route unavailable", { status: 404 });
      return Response.json({ repo: repo ?? "acme-org/fleet", prs: answers[key] ?? {} });
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  test("one fetch per distinct repo, merged into one studio-id -> count map", async () => {
    const { fetchImpl, seen } = recorder({
      "acme-org/websites": { "websites--web-studio": [pr(9), pr(10)], "websites--pilot": [] },
      "acme-org/beta": { "beta--pilot": [pr(31)] },
    });
    const map = await openPrsByStudio(CREDS, [
      row({ id: "websites--web-studio", repoSlug: "acme-org/websites" }),
      row({ id: "websites--pilot", repoSlug: "acme-org/websites" }),
      row({ id: "beta--pilot", repoSlug: "acme-org/beta" }),
    ], fetchImpl);

    expect(map.get("websites--web-studio")).toBe(2);
    expect(map.get("websites--pilot")).toBe(0);
    expect(map.get("beta--pilot")).toBe(1);
    // Two repos, two studios sharing one of them: exactly two fetches — the
    // route answers every studio of a repo at once, never per studio.
    expect(seen.map((s) => s.url).sort()).toEqual([
      "https://worker.test/studio/board/open-prs?repo=acme-org%2Fbeta",
      "https://worker.test/studio/board/open-prs?repo=acme-org%2Fwebsites",
    ]);
  });

  test("a null repoSlug (pre-P4a studio, cloned from the fleet default) fetches with NO repo param", async () => {
    const { fetchImpl, seen } = recorder({ "(default)": { "websites--legacy": [] } });
    const map = await openPrsByStudio(CREDS, [row({ id: "websites--legacy", repoSlug: null })], fetchImpl);
    expect(seen.map((s) => s.url)).toEqual(["https://worker.test/studio/board/open-prs"]);
    expect(map.get("websites--legacy")).toBe(0);
  });

  test("null and non-null repoSlug rows never share a fetch — mixed pre/post-P4a fleets read their own repos", async () => {
    const { fetchImpl, seen } = recorder({
      "acme-org/websites": { "websites--web-studio": [pr(9)] },
      "(default)": { "websites--legacy": [] },
    });
    const map = await openPrsByStudio(CREDS, [
      row({ id: "websites--web-studio", repoSlug: "acme-org/websites" }),
      row({ id: "websites--legacy", repoSlug: null }),
    ], fetchImpl);
    expect(map.get("websites--web-studio")).toBe(1);
    expect(map.get("websites--legacy")).toBe(0);
    expect(seen.length).toBe(2);
  });

  test("a route that 404s (an old Worker) contributes NO data for that repo — never a failed ls", async () => {
    const { fetchImpl } = recorder(
      { "acme-org/websites": { "websites--web-studio": [pr(9)] }, "(default)": {} },
      ["acme-org/websites"],
    );
    const map = await openPrsByStudio(CREDS, [
      row({ id: "websites--web-studio", repoSlug: "acme-org/websites" }),
      row({ id: "fleet--maestro", repoSlug: null }),
    ], fetchImpl);
    // The failed repo's studio is ABSENT from the map (cell '-'), the other
    // repo's answer survives intact.
    expect(map.has("websites--web-studio")).toBe(false);
    expect(map.get("fleet--maestro")).toBe(0);
  });

  test("a fetch that throws (a transport blip) is the same as unavailable: absent, others intact", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("websites")) throw new Error("connection reset");
      return Response.json({ repo: "acme-org/beta", prs: { "beta--pilot": [pr(3)] } });
    }) as typeof fetch;
    const map = await openPrsByStudio(CREDS, [
      row({ id: "websites--web-studio", repoSlug: "acme-org/websites" }),
      row({ id: "beta--pilot", repoSlug: "acme-org/beta" }),
    ], fetchImpl);
    expect(map.has("websites--web-studio")).toBe(false);
    expect(map.get("beta--pilot")).toBe(1);
    expect(seen.length).toBe(2);
  });

  test("a 200 whose map does not cover a studio is absence, never a silent 0", async () => {
    const fetchImpl = (async () => Response.json({ repo: "acme-org/websites", prs: {} })) as typeof fetch;
    const map = await openPrsByStudio(CREDS, [row({ id: "websites--web-studio", repoSlug: "acme-org/websites" })], fetchImpl);
    expect(map.has("websites--web-studio")).toBe(false);
  });

  test("every request carries the Access service-token headers and an explicit JSON Accept", async () => {
    const { fetchImpl, seen } = recorder({ "acme-org/websites": {} });
    await openPrsByStudio(CREDS, [row({ repoSlug: "acme-org/websites" })], fetchImpl);
    const headers = seen[0].headers;
    expect(headers["CF-Access-Client-Id"]).toBe("cid");
    expect(headers["CF-Access-Client-Secret"]).toBe("csecret");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("an empty listing fetches nothing", async () => {
    const { fetchImpl, seen } = recorder({});
    const map = await openPrsByStudio(CREDS, [], fetchImpl);
    expect(seen.length).toBe(0);
    expect(map.size).toBe(0);
  });
});

describe("cmdLs — the wiring (#332)", () => {
  const STUDIO: StudioStatus = row({ id: "websites--web-studio", repoSlug: "acme-org/websites" });
  let openPrsAnswer: Response;
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/studio/") return Response.json([STUDIO]);
        if (u.pathname === "/studio/board/open-prs") return openPrsAnswer;
        // /studio/accounts and everything else: a route this stand-in does
        // not serve 404s — best-effort callers must sail past that.
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  /** Outside Orca (footer test's own fixture): no Orca call is attempted. */
  const NOT_UNDER_ORCA: OrcaDeps = {
    env: { TERM_PROGRAM: "Apple_Terminal" },
    hasBinary: () => "orca",
    registry: { get: () => undefined, set: async () => {} },
    log: () => {},
    run: async () => { throw new Error("no orca call expected"); },
    lock: (_id, fn) => fn(),
  };

  async function lsTable(): Promise<string[]> {
    const out: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
    try {
      await cmdLs({ workerUrl: server.url.toString(), accessClientId: "", accessClientSecret: "" }, false, NOT_UNDER_ORCA);
    } finally {
      console.log = realLog;
    }
    return out;
  }

  test("renders the route's count in the PRS cell", async () => {
    openPrsAnswer = Response.json({
      repo: "acme-org/websites",
      prs: { "websites--web-studio": [pr(9), pr(10)] },
    });
    const out = await lsTable();
    const header = out.find((l) => l.split(/\s{2,}/).includes("PRS"));
    const table = out.find((l) => l.includes("websites--web-studio"));
    expect(header).toBeDefined();
    expect(table).toBeDefined();
    expect(prsCell(header!, table!)).toBe("2");
  });

  test("a route that 404s keeps ls instant: the cell reads '-', the command still prints the table", async () => {
    openPrsAnswer = new Response("not found", { status: 404 });
    const out = await lsTable();
    const header = out.find((l) => l.split(/\s{2,}/).includes("PRS"));
    const table = out.find((l) => l.includes("websites--web-studio"));
    expect(header).toBeDefined();
    expect(table).toBeDefined();
    expect(prsCell(header!, table!)).toBe("-");
  });

  test("--json carries openPrs per row when the route answered", async () => {
    openPrsAnswer = Response.json({ repo: "acme-org/websites", prs: { "websites--web-studio": [pr(9)] } });
    const out: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
    try {
      await cmdLs({ workerUrl: server.url.toString(), accessClientId: "", accessClientSecret: "" }, false, NOT_UNDER_ORCA, true);
    } finally {
      console.log = realLog;
    }
    const parsed = JSON.parse(out.join("")) as Array<{ id: string; openPrs?: number }>;
    expect(parsed[0].id).toBe("websites--web-studio");
    expect(parsed[0].openPrs).toBe(1);
  });

  test("--json omits openPrs entirely when the route 404ed — 'no data' must not read as 0", async () => {
    openPrsAnswer = new Response("not found", { status: 404 });
    const out: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
    try {
      await cmdLs({ workerUrl: server.url.toString(), accessClientId: "", accessClientSecret: "" }, false, NOT_UNDER_ORCA, true);
    } finally {
      console.log = realLog;
    }
    const parsed = JSON.parse(out.join("")) as Array<{ id: string; openPrs?: number }>;
    expect(parsed[0].id).toBe("websites--web-studio");
    expect(Object.hasOwn(parsed[0], "openPrs")).toBe(false);
  });
});
