import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createIssue, getIssue, listIssues, addLabels, removeLabel,
  createComment, listComments, listMilestones, BOARD_PAGE_SIZE, BOARD_MAX_PAGES,
  listIssueTexts, TASK_TEXTS_MAX_PAGES,
} from "../src/board/api";

// Same fetch-mocking shape as test/github.api.test.ts — these are the same
// kind of function (token in, one authenticated GitHub call out), so they are
// proven the same way.

interface Call { url: string; method?: string; headers: Record<string, string>; body: any }
let calls: Call[] = [];
let realFetch: typeof globalThis.fetch;
let respond: () => Response;

function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 12, title: "Build the task board", body: "## Objective\n", html_url: "https://github.com/o/r/issues/12",
    state: "open", labels: [{ name: "submitted" }], milestone: { title: "Sprint 1" },
    updated_at: "2026-08-25T10:00:00Z", ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  respond = () => Response.json(issue());
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return respond();
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe("createIssue", () => {
  it("POSTs title, body, labels and milestone number, authenticated, and maps the result", async () => {
    const task = await createIssue("tok", "o/r", {
      title: "Build the task board", body: "## Objective\n...", labels: ["submitted"], milestone: 3,
    });

    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    // Issue #331: a neutral product name, not the App's own bot slug — see
    // src/board/api.ts's USER_AGENT doc comment.
    expect(calls[0].headers["user-agent"]).toBe("fleetflare");
    expect(calls[0].body).toEqual({
      title: "Build the task board", body: "## Objective\n...", labels: ["submitted"], milestone: 3,
    });
    expect(task).toEqual({
      number: 12, url: "https://github.com/o/r/issues/12", title: "Build the task board",
      body: "## Objective\n", state: "submitted", labels: ["submitted"], assignee: null,
      milestone: "Sprint 1", open: true, updatedAt: "2026-08-25T10:00:00Z",
    });
  });

  it("omits milestone entirely when the task is on no sprint", async () => {
    await createIssue("tok", "o/r", { title: "t", body: "b", labels: ["submitted"] });
    expect(calls[0].body).not.toHaveProperty("milestone");
  });

  it("passes GitHub's own words through on failure, without the token", async () => {
    respond = () => new Response('{"message":"Validation Failed"}', { status: 422 });
    await expect(createIssue("tok", "o/r", { title: "t", body: "b", labels: [] }))
      .rejects.toThrow(/Validation Failed/);
    await expect(createIssue("tok", "o/r", { title: "t", body: "b", labels: [] }))
      .rejects.not.toThrow(/tok/);
  });
});

describe("getIssue", () => {
  it("GETs one issue and maps it", async () => {
    const task = await getIssue("tok", "o/r", 12);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/12");
    expect(task.number).toBe(12);
    expect(task.state).toBe("submitted");
  });

  it("reports no state for an issue carrying none, and none for an ambiguous one", async () => {
    respond = () => Response.json(issue({ labels: [{ name: "bug" }] }));
    expect((await getIssue("tok", "o/r", 12)).state).toBeNull();

    respond = () => Response.json(issue({ labels: [{ name: "working" }, { name: "completed" }] }));
    const drifted = await getIssue("tok", "o/r", 12);
    expect(drifted.state).toBeNull();
    expect(drifted.labels).toEqual(["working", "completed"]);
  });

  it("reads a closed issue and a milestone-less one without inventing values", async () => {
    respond = () => Response.json(issue({ state: "closed", milestone: null }));
    const task = await getIssue("tok", "o/r", 12);
    expect(task.open).toBe(false);
    expect(task.milestone).toBeNull();
  });

  it("accepts GitHub's string-label form as well as its object form", async () => {
    respond = () => Response.json(issue({ labels: ["working"] }));
    expect((await getIssue("tok", "o/r", 12)).state).toBe("working");
  });
});

describe("listIssues", () => {
  it("asks for both open and closed, one bounded page, and filters pull requests out", async () => {
    respond = () => Response.json([issue(), issue({ number: 13, pull_request: { url: "x" } })]);
    const tasks = await listIssues("tok", "o/r", {});

    expect(calls[0].url).toContain("https://api.github.com/repos/o/r/issues?");
    expect(calls[0].url).toContain("state=all");
    expect(calls[0].url).toContain(`per_page=${BOARD_PAGE_SIZE}`);
    expect(tasks.map((t) => t.number)).toEqual([12]);
  });

  it("filters by milestone number and by label when asked", async () => {
    respond = () => Response.json([]);
    await listIssues("tok", "o/r", { milestone: 3, labels: ["working"] });
    expect(calls[0].url).toContain("milestone=3");
    expect(calls[0].url).toContain("labels=working");
  });

  // Issue #148: a repo whose issues+PRs pass 100 hid everything older than
  // page 1. These pin pagination across the `Link` response header.
  //
  // Issue #168: GitHub's real `Link` header shape depends on a page's
  // POSITION, not just "is there a next page" — confirmed live against
  // `repos/.../issues?state=all&per_page=50&page=N`. Page 1 carries `next`
  // only; a middle page carries `next` AND `prev`; the last page carries
  // `prev` only — GitHub never sends `rel="last"` on this endpoint. Fixtures
  // below mirror that per-position shape rather than a generic stand-in, so a
  // mutant that follows the wrong relation (or the wrong header entry) is
  // exercised the way a real multi-page repo would exercise it.
  const linkFirst = (nextUrl: string) => ({ headers: { link: `<${nextUrl}>; rel="next"` } });
  const linkMiddle = (nextUrl: string, prevUrl: string) => (
    { headers: { link: `<${nextUrl}>; rel="next", <${prevUrl}>; rel="prev"` } }
  );
  const linkLast = (prevUrl: string) => ({ headers: { link: `<${prevUrl}>; rel="prev"` } });

  it("follows the Link header across pages, concatenating in GitHub's own (newest-first) order", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issue({ number: 300 - i }));
    const page2 = Array.from({ length: 100 }, (_, i) => issue({ number: 200 - i }));
    const page3 = Array.from({ length: 50 }, (_, i) => issue({ number: 100 - i }));
    const url1 = "https://api.github.com/repos/o/r/issues?page=1";
    const url2 = "https://api.github.com/repos/o/r/issues?page=2";
    const url3 = "https://api.github.com/repos/o/r/issues?page=3";
    const pages = [
      Response.json(page1, linkFirst(url2)),
      Response.json(page2, linkMiddle(url3, url1)),
      Response.json(page3, linkLast(url2)),
    ];
    respond = () => pages[calls.length - 1];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const tasks = await listIssues("tok", "o/r", {});

    expect(calls).toHaveLength(3);
    expect(tasks).toHaveLength(250);
    expect(tasks.map((t) => t.number)).toEqual([
      ...page1.map((i) => i.number), ...page2.map((i) => i.number), ...page3.map((i) => i.number),
    ]);
    // A complete, untruncated read must never log — only the bound-reached
    // path (below) does. Distinct from that test's toHaveBeenCalledTimes(1).
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("filters pull requests out of every page, not just the first", async () => {
    const url1 = "https://api.github.com/repos/o/r/issues?page=1";
    const url2 = "https://api.github.com/repos/o/r/issues?page=2";
    const pages = [
      Response.json([issue({ number: 1 })], linkFirst(url2)),
      Response.json([issue({ number: 2 }), issue({ number: 3, pull_request: { url: "x" } })], linkLast(url1)),
    ];
    respond = () => pages[calls.length - 1];

    const tasks = await listIssues("tok", "o/r", {});
    expect(tasks.map((t) => t.number)).toEqual([1, 2]);
  });

  it("preserves newest-first order across a page boundary — board.ts's findByKey .at(-1) relies on it", async () => {
    const marker = "<!-- fleet-task-key: k-abc123 -->";
    const url1 = "https://api.github.com/repos/o/r/issues?page=1";
    const url2 = "https://api.github.com/repos/o/r/issues?page=2";
    const pages = [
      Response.json([issue({ number: 50, body: `newer duplicate\n${marker}` })], linkFirst(url2)),
      Response.json([issue({ number: 10, body: `oldest, the real one\n${marker}` })], linkLast(url1)),
    ];
    respond = () => pages[calls.length - 1];

    const tasks = await listIssues("tok", "o/r", {});
    const matches = tasks.filter((t) => t.body.includes(marker));
    // #10 was fetched on the later page (older issues), and must still land
    // LAST in the concatenated array for `.at(-1)` to resolve to it.
    expect(matches.at(-1)?.number).toBe(10);
  });

  it("stops at the page bound, returns what it fetched, and reports the truncation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Every page claims another page exists (a page deep in an endless
    // sequence realistically carries both `next` and `prev`), so only the
    // bound stops the loop.
    respond = () => Response.json(
      [issue({ number: 1 })],
      linkMiddle("https://api.github.com/repos/o/r/issues?page=999", "https://api.github.com/repos/o/r/issues?page=997"),
    );

    const tasks = await listIssues("tok", "o/r", {});

    expect(calls).toHaveLength(BOARD_MAX_PAGES);
    expect(tasks).toHaveLength(BOARD_MAX_PAGES);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(message).toContain("o/r");
    expect(message).toMatch(/truncat/i);

    errorSpy.mockRestore();
  });

  it("refuses to follow a next-page URL off the GitHub API host, and logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = () => Response.json(
      [issue({ number: 1 })],
      linkFirst("https://evil.example.com/repos/o/r/issues?page=2"),
    );

    const tasks = await listIssues("tok", "o/r", {});

    // Only the first, legitimate call happened — the token was never sent
    // toward the foreign host.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes("evil.example.com"))).toBe(true);
    expect(tasks.map((t) => t.number)).toEqual([1]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(message).toContain("o/r");
    expect(message).toContain("evil.example.com");

    errorSpy.mockRestore();
  });

  // Issue #168 fix round: the off-host guard above must compare ORIGINS
  // (scheme+host+port), not string prefixes. A prefix check lets each of
  // these look-alikes through — they all start with the right characters,
  // but none of them IS `https://api.github.com` — and the bearer token
  // must never reach any of them.
  it.each([
    ["a subdomain of a foreign host", "https://api.github.com.evil.example/repos/o/r/issues?page=2", "api.github.com.evil.example"],
    ["a foreign host glued on with no separator", "https://api.github.comevil.example/repos/o/r/issues?page=2", "api.github.comevil.example"],
    ["the right host on the wrong port", "https://api.github.com:8443/repos/o/r/issues?page=2", "api.github.com:8443"],
    // An unparseable `next` (not a URL at all) must fail closed the same as a
    // look-alike host: `new URL(next)` throws, the catch sets sameOrigin =
    // false, and — since `host` was seeded from the raw string before the
    // parse attempt — the log carries that raw string verbatim, not a `.host`
    // (which would itself throw here). No existing case before this one fed
    // listIssues a next URL that fails to parse at all.
    ["an unparseable URL", "not a url", "not a url"],
  ])("refuses to follow a look-alike next-page URL (%s), and logs it", async (_label, lookAlike, expectedHost) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = () => Response.json([issue({ number: 1 })], linkFirst(lookAlike));

    const tasks = await listIssues("tok", "o/r", {});

    // Only the first, legitimate call happened — the token was never sent
    // toward the look-alike host, and no throw escaped listIssues.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes("evil"))).toBe(true);
    expect(tasks.map((t) => t.number)).toEqual([1]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(message).toContain("o/r");
    expect(message).toContain(expectedHost);

    errorSpy.mockRestore();
  });
});

describe("labels", () => {
  it("POSTs added labels and DELETEs a removed one by name", async () => {
    respond = () => Response.json([{ name: "working" }]);
    await addLabels("tok", "o/r", 12, ["working"]);
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/12/labels");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ labels: ["working"] });

    await removeLabel("tok", "o/r", 12, "submitted");
    expect(calls[1].url).toBe("https://api.github.com/repos/o/r/issues/12/labels/submitted");
    expect(calls[1].method).toBe("DELETE");
  });

  it("url-encodes a label name rather than pasting it into the path", async () => {
    respond = () => Response.json([]);
    await removeLabel("tok", "o/r", 12, "input required");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/12/labels/input%20required");
  });
});

describe("comments", () => {
  it("POSTs a comment body and returns the comment's own url", async () => {
    respond = () => Response.json({ id: 99, html_url: "https://github.com/o/r/issues/12#issuecomment-99" });
    const res = await createComment("tok", "o/r", 12, "**result** ...");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/issues/12/comments");
    expect(calls[0].body).toEqual({ body: "**result** ..." });
    expect(res.url).toBe("https://github.com/o/r/issues/12#issuecomment-99");
  });

  it("lists comments with their author and body, one bounded page", async () => {
    respond = () => Response.json([
      { id: 1, html_url: "u1", body: "b1", created_at: "2026-08-25T10:00:00Z", user: { login: "example-bot[bot]" } },
    ]);
    const list = await listComments("tok", "o/r", 12);
    expect(calls[0].url).toContain(`per_page=${BOARD_PAGE_SIZE}`);
    expect(list).toEqual([
      { id: 1, url: "u1", body: "b1", createdAt: "2026-08-25T10:00:00Z", author: "example-bot[bot]" },
    ]);
  });
});

describe("listMilestones", () => {
  it("asks for open and closed milestones and returns title/number pairs", async () => {
    respond = () => Response.json([{ number: 3, title: "Sprint 1" }, { number: 4, title: "Sprint 2" }]);
    const list = await listMilestones("tok", "o/r");
    expect(calls[0].url).toContain("state=all");
    expect(list).toEqual([{ number: 3, title: "Sprint 1" }, { number: 4, title: "Sprint 2" }]);
  });
});

// Issue #167: the memory-compaction survey used to make one REST
// `listComments` call PER issue across a repo's entire history (open AND
// closed — citations can come from a years-old closed task, see
// src/memory/compact.ts's countCitations doc comment). At ~1000 issues that
// alone approaches Cloudflare's 1000-subrequest-per-invocation cap (paid
// plan), which would hard-fail the whole compaction pass, not just this read.
// `listIssueTexts` replaces that N+1 REST loop with a handful of GraphQL
// calls, each returning many issues AND their comments in one HTTP response.
describe("listIssueTexts", () => {
  // Cursor-realistic fake: keyed by the actual `cursor` variable GitHub would
  // receive, not by how many calls have happened so far. Page 0 is requested
  // with `cursor: null`; page N is only served when the request carries
  // page (N-1)'s own `endCursor` — exactly how GitHub's opaque-cursor
  // pagination behaves for real. A fake keyed on `calls.length` instead would
  // serve the "right" page even to a caller that never advances its cursor,
  // which is precisely the bug (T6) this shape exists to catch.
  function cursorPages(total: number) {
    const totalPages = Math.ceil(total / BOARD_PAGE_SIZE);
    // endCursors[i] is the endCursor PAGE i's own response reports (null on
    // the last page); expectedCursor(i) is the cursor a caller must SEND to
    // receive page i.
    const endCursors: (string | null)[] = Array.from({ length: totalPages }, (_, i) =>
      i === totalPages - 1 ? null : `cursor-${i}`,
    );
    const expectedCursor = (pageIndex: number): string | null => (pageIndex === 0 ? null : endCursors[pageIndex - 1]);
    const pageIndexForCursor = new Map<string | null, number>();
    for (let i = 0; i < totalPages; i++) pageIndexForCursor.set(expectedCursor(i), i);

    function respondToCursor(cursor: string | null): Response {
      const pageIndex = pageIndexForCursor.get(cursor);
      if (pageIndex === undefined) {
        // A caller sending a cursor no real page would have produced — surface
        // it loudly rather than silently guessing a page, the same way a real
        // GitHub would reject an unrecognised cursor rather than serve page 1.
        throw new Error(`cursorPages fake received an unexpected cursor: ${JSON.stringify(cursor)}`);
      }
      const start = pageIndex * BOARD_PAGE_SIZE;
      const count = Math.min(BOARD_PAGE_SIZE, total - start);
      const nodes = Array.from({ length: count }, (_, i) => {
        const n = start + i + 1;
        return { number: n, title: `Task ${n}`, body: `Body ${n}`, comments: { totalCount: 1, nodes: [{ body: `C${n}` }] } };
      });
      const hasNextPage = pageIndex < totalPages - 1;
      return Response.json({
        data: {
          repository: {
            issues: { pageInfo: { hasNextPage, endCursor: endCursors[pageIndex] }, nodes },
          },
        },
      });
    }
    return { totalPages, expectedCursor, respondToCursor };
  }

  it("batches issues across GraphQL pages by CURSOR (not call count), comfortably under the subrequest cap, with no PR leakage", async () => {
    const TOTAL = 1200;
    const { totalPages, expectedCursor, respondToCursor } = cursorPages(TOTAL);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = () => respondToCursor(calls[calls.length - 1].body.variables.cursor);

    const { issues, truncated } = await listIssueTexts("tok", "o/r");

    // 1000 is Cloudflare's paid-plan per-invocation subrequest cap. 20 calls
    // is 2% of it — comfortably under, with the rest of the budget left for
    // everything else one memory-compaction pass does in the same Worker
    // invocation (listIssues' own pagination, the token mint, memory file
    // fetches). At the old one-REST-call-per-issue rate, 1200 issues would
    // have been 1200+ calls, well over the cap on its own.
    expect(calls.length).toBeLessThan(20);
    expect(calls.length).toBe(totalPages);
    // T6: the cursor sent on call i must be exactly page (i-1)'s own
    // endCursor — a mutant that never advances the cursor (always sends
    // `null`, or reuses the last one) would keep requesting page 0 forever
    // and this would fail long before the length/content assertions below.
    calls.forEach((call, i) => {
      expect(call.body.variables.cursor).toBe(expectedCursor(i));
    });
    expect(truncated).toBe(false);
    expect(issues).toHaveLength(TOTAL);
    expect(issues[0]).toEqual({ number: 1, title: "Task 1", body: "Body 1", comments: ["C1"] });
    expect(issues[TOTAL - 1]).toEqual({
      number: TOTAL, title: `Task ${TOTAL}`, body: `Body ${TOTAL}`, comments: [`C${TOTAL}`],
    });
    // GraphQL's `issues` connection never returns pull requests at all — pin
    // that assumption rather than re-deriving REST's own pull_request filter.
    expect(calls[0].body.query).not.toContain("pullRequests");
    // T12: page size pinned to the actual BOARD_PAGE_SIZE constant (not a
    // hardcoded literal that could drift from it) on BOTH connections —
    // `toContain("issues(")` alone would not catch a page size unpinned from
    // the constant.
    expect(calls[0].body.query).toContain(`issues(first: ${BOARD_PAGE_SIZE}`);
    expect(calls[0].body.query).toContain(`comments(last: ${BOARD_PAGE_SIZE}`);
    // Newest-first: a bound-hit truncation must drop the OLDEST issues, not
    // the newest (see the truncation test below and issue #187).
    expect(calls[0].body.query).toContain("orderBy: {field: CREATED_AT, direction: DESC}");
    // T5: a complete, untruncated read must never log — only the bound-reached
    // path (below) does.
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // Issue #204: GraphQL's `first: N` on a `comments` connection returns the
  // OLDEST N items (chronological ascending is the connection's own natural
  // order) — live-verified against microsoft/TypeScript#8 (193 comments):
  // `first` returned 2014-era comments, `last` returned 2024-era ones. So
  // `comments(first: ${BOARD_PAGE_SIZE})` had it backwards from the very
  // thing the doc comment above and the log below already claimed: a heavily
  // commented issue's NEWEST comments — exactly the ones most likely to cite
  // a CURRENT memory file — were the ones silently dropped, not the oldest.
  // `comments(last: N)` with no `before` cursor is Relay's supported way to
  // ask for the LAST N items overall, which is what this survey actually
  // wants. The big test above already pins the fixed string as part of its
  // T12 assertion; this one exists standalone so the pin survives even if
  // that larger test is ever trimmed, and so it can also assert the OLD,
  // backwards form is gone — a mutant reverting `last` back to `first` would
  // fail this even if it left BOARD_PAGE_SIZE itself untouched.
  it("requests the LAST 100 comments per issue over GraphQL, not the first — newest comments are what a citation survey must not drop", async () => {
    respond = () => Response.json({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    });

    await listIssueTexts("tok", "o/r");

    expect(calls[0].body.query).toContain(`comments(last: ${BOARD_PAGE_SIZE}`);
    expect(calls[0].body.query).not.toContain(`comments(first: ${BOARD_PAGE_SIZE}`);
  });

  it("stops at the page bound, returns what it fetched, and reports the truncation via the returned flag AND a log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Every page claims another page exists, so only the bound stops the loop.
    respond = () => Response.json({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "same" },
            nodes: [{ number: 1, title: "t", body: "b", comments: { nodes: [] } }],
          },
        },
      },
    });

    const { issues, truncated } = await listIssueTexts("tok", "o/r");

    expect(calls).toHaveLength(TASK_TEXTS_MAX_PAGES);
    expect(issues).toHaveLength(TASK_TEXTS_MAX_PAGES);
    expect(truncated).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(message).toContain("o/r");
    expect(message).toMatch(/truncat/i);

    errorSpy.mockRestore();
  });

  it("throws on a GraphQL errors[] response even when the transport itself is 200", async () => {
    respond = () => Response.json({ errors: [{ message: "Could not resolve to a Repository" }] });
    await expect(listIssueTexts("tok", "o/r")).rejects.toThrow(/Could not resolve/);
  });

  // T11: GitHub's GraphQL convention is that ANY non-empty `errors[]` is a
  // failure, regardless of whether `data` is ALSO present (a "partial
  // success" response). The test above only covers `errors[]` with no `data`
  // at all — a mutant that weakens the check to `if (!data && errors.length)`
  // would wrongly treat a response carrying BOTH as a success and would
  // survive that test, but not this one.
  it("throws on a GraphQL errors[] response even when data is ALSO present (a partial-success payload is still a failure)", async () => {
    respond = () => Response.json({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 1, title: "t", body: "b", comments: { nodes: [] } }] },
        },
      },
      errors: [{ message: "Something went wrong resolving a field" }],
    });
    await expect(listIssueTexts("tok", "o/r")).rejects.toThrow(/Something went wrong resolving a field/);
  });

  it("passes GitHub's own words through on a non-2xx transport failure", async () => {
    respond = () => new Response('{"message":"Bad credentials"}', { status: 401 });
    await expect(listIssueTexts("tok", "o/r")).rejects.toThrow(/Bad credentials/);
  });

  it("assembles number/title/body/comments in GitHub's own order — matches the old REST shape byte for byte", async () => {
    respond = () => Response.json({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              number: 12, title: "Build the task board", body: "## Objective\n",
              comments: { totalCount: 2, nodes: [{ body: "first" }, { body: "second" }] },
            }],
          },
        },
      },
    });

    const { issues } = await listIssueTexts("tok", "o/r");
    const [task] = issues;

    expect(task).toEqual({ number: 12, title: "Build the task board", body: "## Objective\n", comments: ["first", "second"] });
    // The exact join the old REST loop produced: title, body, then comment
    // bodies in the order GitHub returns them.
    expect([task.title, task.body, ...task.comments].join("\n")).toBe("Build the task board\n## Objective\n\nfirst\nsecond");
  });

  // Issue #187's optional item: the 100-comment-per-issue cap already silently
  // drops older comments beyond it (same cap `listComments` has), but nothing
  // said so. `totalCount` on the same connection is free — no extra
  // request — so a page that fetched fewer comments than the issue actually
  // has logs it, naming the issue and both counts.
  it("logs when an issue's comment count exceeds the one page fetched, naming the issue and both counts", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = () => Response.json({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              number: 42, title: "t", body: "b",
              comments: { totalCount: BOARD_PAGE_SIZE + 7, nodes: [{ body: "only the first page" }] },
            }],
          },
        },
      },
    });

    await listIssueTexts("tok", "o/r");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0];
    expect(message).toContain("42");
    expect(message).toContain(String(BOARD_PAGE_SIZE + 7));
    expect(message).toContain(String(BOARD_PAGE_SIZE));

    errorSpy.mockRestore();
  });

  it("does not log the over-page-comment warning for an issue at or under the cap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    respond = () => Response.json({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ number: 1, title: "t", body: "b", comments: { totalCount: BOARD_PAGE_SIZE, nodes: [{ body: "x" }] } }],
          },
        },
      },
    });

    await listIssueTexts("tok", "o/r");

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("toBoardTask — reopened (issue #10)", () => {
  it("true only for GitHub's state_reason \"reopened\"", async () => {
    respond = () => Response.json(issue({ state_reason: "reopened" }));
    expect((await getIssue("t", "o/r", 12)).reopened).toBe(true);
    for (const state_reason of [null, undefined, "completed", "not_planned"]) {
      respond = () => Response.json(issue({ state_reason }));
      expect((await getIssue("t", "o/r", 12)).reopened).toBe(false);
    }
  });
});

describe("toBoardTask — assignee (§5 assignment)", () => {
  it("reads exactly one studio: label as the owner", async () => {
    respond = () => Response.json(issue({ labels: [{ name: "submitted" }, { name: "studio:websites--web-studio" }] }));
    expect((await getIssue("t", "o/r", 12)).assignee).toBe("websites--web-studio");
  });

  it("null when nobody owns it and null when TWO writers claim it — same drift shape as state", async () => {
    respond = () => Response.json(issue({ labels: [{ name: "submitted" }] }));
    expect((await getIssue("t", "o/r", 12)).assignee).toBeNull();
    respond = () => Response.json(issue({
      labels: [{ name: "submitted" }, { name: "studio:a--b" }, { name: "studio:c--d" }],
    }));
    const drifted = await getIssue("t", "o/r", 12);
    expect(drifted.assignee).toBeNull();
    // The labels ride along so a caller can say WHAT it found.
    expect(drifted.labels).toContain("studio:a--b");
    expect(drifted.labels).toContain("studio:c--d");
  });
});
