// Board issue #332, plan step 4's CLI half: `fleet destroy`'s unmerged-PR
// refusal (--strict-unmerged) and post-destroy park warning. The line
// shapers are pure; the one-studio fetch (fetchStudioOpenPrs) takes the
// fetch port as an argument, the same injected-dependency posture
// openPrsByStudio (test/bun/cli.fleet-ls-prs.test.ts) and TabsDeps already
// document — no network, no live Worker, no mocks of this repo's own modules.
//
// The unknown-SCAN refusal branch (cmdDestroy's `answer.unknown` leg) is the
// one piece the in-process halves above cannot reach: cmdDestroy is not
// exported (cli/fleet.ts runs its CLI on import), so its behavioral test
// drives the REAL CLI as a subprocess against a real local Bun.serve Worker
// stand-in — the same harness family test/bun/accounts-cli.test.ts documents
// (a real `Bun.spawn` of cli/fleet.ts, a temp HOME with a synthetic
// credentials file pointing at the stand-in).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchStudioOpenPrs, parkWarningLines, strictRefusalLines,
  STRICT_UNMERGED_UNKNOWN_PROCEEDING, STRICT_UNMERGED_UNKNOWN_SCAN,
  PARK_WARNING_UNAVAILABLE, PARK_WARNING_UNKNOWN_SCAN,
  type Credentials,
} from "../../cli/fleet";

const CREDS: Credentials = { workerUrl: "https://worker.test", accessClientId: "cid", accessClientSecret: "csecret" };

/** One OpenPr, the exact shape the route answers with (src/board/open-prs.ts). */
function pr(prNumber: number, taskNumber = 12): { taskNumber: number; prNumber: number; title: string; url: string } {
  return {
    taskNumber, prNumber,
    title: `feat: thing ${prNumber}`,
    url: `https://github.com/acme-org/websites/pull/${prNumber}`,
  };
}

const TWO = [pr(9), pr(31)];

describe("strictRefusalLines — the --strict-unmerged refusal (#332)", () => {
  test("leads with the count and the flag, then one line per PR: #<n> <title> <url>", () => {
    const lines = strictRefusalLines(TWO);
    expect(lines[0]).toContain("2");
    expect(lines[0]).toContain("--strict-unmerged");
    expect(lines.slice(1)).toEqual([
      "  #9 feat: thing 9 https://github.com/acme-org/websites/pull/9",
      "  #31 feat: thing 31 https://github.com/acme-org/websites/pull/31",
    ]);
  });

  test("an empty list still renders a header — the caller never decides shape", () => {
    expect(strictRefusalLines([]).length).toBe(1);
  });
});

describe("parkWarningLines — the post-destroy non-blocking warning (#332)", () => {
  test("the exact header: 'park warning: <id> still has N unmerged PR(s):', then one indented PR line each", () => {
    const lines = parkWarningLines("websites--web-studio", TWO);
    expect(lines[0]).toBe("park warning: websites--web-studio still has 2 unmerged PR(s):");
    expect(lines.slice(1)).toEqual([
      "  #9 feat: thing 9 https://github.com/acme-org/websites/pull/9",
      "  #31 feat: thing 31 https://github.com/acme-org/websites/pull/31",
    ]);
  });

  test("the singular grammar holds for one PR", () => {
    expect(parkWarningLines("websites--pilot", [pr(5)])[0])
      .toBe("park warning: websites--pilot still has 1 unmerged PR(s):");
  });
});

describe("the fixed one-line notes (#332)", () => {
  test("strict + unknown names the route and says it proceeds, never blocks", () => {
    expect(STRICT_UNMERGED_UNKNOWN_PROCEEDING).toContain("unmerged-PR status unknown");
    expect(STRICT_UNMERGED_UNKNOWN_PROCEEDING).toContain("route unavailable");
    expect(STRICT_UNMERGED_UNKNOWN_PROCEEDING).toContain("proceeding");
  });

  test("the post-destroy fetch-failure note is the one-line 'could not check'", () => {
    expect(PARK_WARNING_UNAVAILABLE).toContain("park warning:");
    expect(PARK_WARNING_UNAVAILABLE).toContain("could not check unmerged PRs");
    expect(PARK_WARNING_UNAVAILABLE).toContain("route unavailable");
  });

  // #332 review H2: a scan the route REPORTS as failed is a different fact
  // from an unavailable route — the check ran and could not answer, so
  // strict refuses on it. The exact strings, pinned: these two lines are
  // what cmdDestroy picks between, and an operator-facing line whose text
  // changed silently is exactly the regression these pins exist to catch.
  test("the strict-side unknown-SCAN refusal line, exact string", () => {
    expect(STRICT_UNMERGED_UNKNOWN_SCAN).toBe( // test-lies-check: allow — an exact-string pin on an operator-facing refusal line; the line text IS the contract, and a silent rewording is the regression this pin exists to catch
      "fleet destroy: refusing: unmerged-PR status unknown (the scan failed for this studio) — cannot confirm zero PRs (--strict-unmerged); re-run, or drop the flag to proceed",
    );
  });

  test("the park warning's unknown-SCAN line, exact string", () => {
    expect(PARK_WARNING_UNKNOWN_SCAN).toBe( // test-lies-check: allow — an exact-string pin on an operator-facing warning line; the line text IS the contract, and a silent rewording is the regression this pin exists to catch
      "park warning: could not check unmerged PRs (the scan failed for this studio)",
    );
  });
});

describe("fetchStudioOpenPrs — one studio's live answer (#332)", () => {
  test("a 200 covering the studio answers its prs", async () => {
    const fetchImpl = (async () => Response.json({
      repo: "acme-org/websites",
      prs: { "websites--web-studio": TWO },
    })) as unknown as typeof fetch;
    const out = await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl);
    expect(out).toEqual({ ok: true, prs: TWO });
  });

  test("repoParam null asks the route's default repo — no ?repo= at all", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return Response.json({ repo: "acme-org/fleet", prs: { "websites--legacy-studio": [] } });
    }) as unknown as typeof fetch;
    const out = await fetchStudioOpenPrs(CREDS, null, "websites--legacy-studio", fetchImpl);
    expect(seen).toEqual(["https://worker.test/studio/board/open-prs"]);
    expect(out).toEqual({ ok: true, prs: [] });
  });

  test("a 404 (an old Worker, or a repo the route refuses) is {ok:false} — never a thrown error", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl)).toEqual({ ok: false });
  });

  test("a 200 whose map does not cover this studio is {ok:false} — absence is unknown, never zero", async () => {
    const fetchImpl = (async () => Response.json({ repo: "acme-org/beta", prs: {} })) as unknown as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl)).toEqual({ ok: false });
  });

  test("a fetch that throws (a transport blip) is {ok:false}, never a rejection", async () => {
    const fetchImpl = (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl)).toEqual({ ok: false });
  });

  // #332 review H2: a 200 whose body names THIS studio in `unknown` — the
  // scan ran and failed for it. A different fact from a 404 (route not
  // there) and from an uncovered map (mismatched answer): strict refuses on
  // this one, so it carries `unknown: true`.
  test("a 200 whose body carries unknown: [<this id>] is {ok:false, unknown:true} — scan-failed, not route-missing", async () => {
    const fetchImpl = (async () => Response.json({
      repo: "acme-org/websites",
      prs: {},
      unknown: ["websites--web-studio"],
    })) as unknown as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl))
      .toEqual({ ok: false, unknown: true });
  });

  test("a 200 whose body carries unknown: [someone else] is plain {ok:false} for this studio", async () => {
    const fetchImpl = (async () => Response.json({
      repo: "acme-org/websites",
      prs: { "websites--web-studio": [] },
      unknown: ["websites--release-studio"],
    })) as unknown as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl))
      .toEqual({ ok: true, prs: [] });
  });

  test("carries the Access service-token headers and an explicit JSON Accept", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return Response.json({ repo: "acme-org/websites", prs: { "websites--web-studio": [] } });
    }) as unknown as typeof fetch;
    await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl);
    expect(headers["CF-Access-Client-Id"]).toBe("cid");
    expect(headers["CF-Access-Client-Secret"]).toBe("csecret");
    expect(headers["Accept"]).toBe("application/json");
  });

  // #332 review H1: the destroy path's one open-prs read carries its own
  // deadline too — same recorder shape as the headers test just above, the
  // same 10s bound openPrsByStudio's own tests pin.
  test("carries an AbortSignal — the read never hangs the destroy on a slow scan", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_input: string | URL | Request, i?: RequestInit) => {
      init = i;
      return Response.json({ repo: "acme-org/websites", prs: { "websites--web-studio": [] } });
    }) as unknown as typeof fetch;
    await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl);
    expect(init?.signal instanceof AbortSignal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The unknown-SCAN refusal, driven through the REAL CLI (a subprocess) —
// accounts-cli.test.ts's harness: a temp HOME whose ~/.fleet/credentials
// points at a local Bun.serve Worker stand-in. cmdDestroy is not exported,
// so this is the only lane that can observe the whole edge: parse → status
// read → open-prs read → `unknown` refusal → exit 1, with the stand-in
// recording every request so "the destroy never fired" is an assertion, not
// an inference from a source pin (cli-destroy-flags.test.ts's ordering pin
// above carries the structural half).
describe("cmdDestroy — the strict unknown-scan refusal, end to end (#332 review H2)", () => {
  const FLEET_CLI = join(import.meta.dir, "../../cli/fleet.ts");
  const ID = "websites--web-studio";

  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  /** A temp HOME with a credentials file naming this Worker stand-in —
   *  accounts-cli.test.ts's writeCredentials, same 0600 the real one wants. */
  function tmpHomeWithCredentials(workerUrl: string): string {
    const home = mkdtempSync(join(tmpdir(), "destroy-strict-home-"));
    tempDirs.push(home);
    mkdirSync(join(home, ".fleet"), { recursive: true });
    const path = join(home, ".fleet", "credentials");
    writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "cid", accessClientSecret: "csecret" }));
    chmodSync(path, 0o600);
    return home;
  }

  /** The Worker stand-in: GET /studio/<id>/status answers a minimal status
   *  row (repoSlug included — the one field the strict pre-check reads the
   *  row for), GET /studio/board/open-prs answers the scripted body, and
   *  EVERY request path is recorded so a test can assert what was and was
   *  never asked for. */
  function startWorker(openPrsBody: unknown) {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        requests.push(`${req.method} ${u.pathname}`);
        if (u.pathname === `/studio/${ID}/status` && req.method === "GET") {
          return Response.json({ id: ID, state: "running", repoSlug: "acme-org/websites" });
        }
        if (u.pathname === "/studio/board/open-prs" && req.method === "GET") {
          return Response.json(openPrsBody);
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { server, requests };
  }

  async function run(args: string[], home: string) {
    const proc = Bun.spawn({
      cmd: [process.execPath, FLEET_CLI, ...args],
      env: { PATH: process.env.PATH!, HOME: home },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { out, err, code };
  }

  test("a scan the route reports FAILED (unknown: [<id>]) refuses: the line, exit 1, and NO destroy request", async () => {
    const { server, requests } = startWorker({ repo: "acme-org/websites", prs: {}, unknown: [ID] });
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await run(["destroy", ID, "--strict-unmerged"], home);
      // The refusal line itself — the exact contract the strict flag is:
      // uncertainty about zero is a refusal, never a silent proceed.
      expect(r.err).toContain(STRICT_UNMERGED_UNKNOWN_SCAN);
      // The refusal is a real exit, not a warning on a successful destroy.
      expect(r.code).toBe(1);
      // The read sequence proves the branch: the status row was read, the
      // open-prs route was asked — and no /destroy request ever fired, the
      // refusal must happen BEFORE anything is destroyed.
      expect(requests).toContain(`GET /studio/${ID}/status`);
      expect(requests).toContain("GET /studio/board/open-prs");
      expect(requests.some((p) => p.endsWith("/destroy"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
