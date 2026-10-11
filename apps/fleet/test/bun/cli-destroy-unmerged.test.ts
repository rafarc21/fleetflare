// Board issue #332, plan step 4's CLI half: `fleet destroy`'s unmerged-PR
// refusal (--strict-unmerged) and post-destroy park warning. The line
// shapers are pure; the one-studio fetch (fetchStudioOpenPrs) takes the
// fetch port as an argument, the same injected-dependency posture
// openPrsByStudio (test/bun/cli.fleet-ls-prs.test.ts) and TabsDeps already
// document — no network, no live Worker, no mocks of this repo's own modules.
import { describe, expect, test } from "bun:test";
import {
  fetchStudioOpenPrs, parkWarningLines, strictRefusalLines,
  STRICT_UNMERGED_UNKNOWN_PROCEEDING, PARK_WARNING_UNAVAILABLE,
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
    expect(PARK_WARNING_UNAVAILABLE).toBe("park warning: could not check unmerged PRs (route unavailable)");
  });
});

describe("fetchStudioOpenPrs — one studio's live answer (#332)", () => {
  test("a 200 covering the studio answers its prs", async () => {
    const fetchImpl = (async () => Response.json({
      repo: "acme-org/websites",
      prs: { "websites--web-studio": TWO },
    })) as typeof fetch;
    const out = await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl);
    expect(out).toEqual({ ok: true, prs: TWO });
  });

  test("repoParam null asks the route's default repo — no ?repo= at all", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json({ repo: "acme-org/fleet", prs: { "websites--legacy-studio": [] } });
    }) as typeof fetch;
    const out = await fetchStudioOpenPrs(CREDS, null, "websites--legacy-studio", fetchImpl);
    expect(seen).toEqual(["https://worker.test/studio/board/open-prs"]);
    expect(out).toEqual({ ok: true, prs: [] });
  });

  test("a 404 (an old Worker, or a repo the route refuses) is {ok:false} — never a thrown error", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl)).toEqual({ ok: false });
  });

  test("a 200 whose map does not cover this studio is {ok:false} — absence is unknown, never zero", async () => {
    const fetchImpl = (async () => Response.json({ repo: "acme-org/beta", prs: {} })) as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl)).toEqual({ ok: false });
  });

  test("a fetch that throws (a transport blip) is {ok:false}, never a rejection", async () => {
    const fetchImpl = (async () => { throw new Error("connection reset"); }) as typeof fetch;
    expect(await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl)).toEqual({ ok: false });
  });

  test("carries the Access service-token headers and an explicit JSON Accept", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return Response.json({ repo: "acme-org/websites", prs: { "websites--web-studio": [] } });
    }) as typeof fetch;
    await fetchStudioOpenPrs(CREDS, "acme-org/websites", "websites--web-studio", fetchImpl);
    expect(headers["CF-Access-Client-Id"]).toBe("cid");
    expect(headers["CF-Access-Client-Secret"]).toBe("csecret");
    expect(headers["Accept"]).toBe("application/json");
  });
});
