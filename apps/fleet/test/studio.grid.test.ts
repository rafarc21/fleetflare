import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { recordStudio, listStudios } from "../src/studio/registry";
import { scrubPreview, renderGridPage, computeFleetTotals, type GridCard } from "../src/studio/grid";
import { getTranscriptTailWithStorage, type TranscriptStorage } from "../src/studio/transcript";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import type { Env } from "../src/env";
// Text-module import of the checked-in build artifact — same mechanism
// src/studio/grid.ts itself uses (see html.d.ts). Read directly here so the
// "no external requests / no stray source-map comment / placeholder intact"
// checks below prove something about the ACTUAL shipped bytes, not a
// re-derivation of them.
import gridHtmlArtifact from "../page/grid.html";

const STUDIO_ID = "websites--pilot";
const OTHER_ID = "websites--scratch";

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: "2026-08-16T00:00:00.000Z",
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

// Issue #181: window5hStart is `now`, not a frozen 2026-08-16 literal.
// registry.ts's listStudios now reads an ELAPSED 5h bucket as 0, so a
// hardcoded past date would make every assertion below about
// window5hOutput reaching the page assert the expiry instead of the render
// it exists to cover. The expiry itself has its own file
// (test/studio.burn-window-expiry.test.ts).
function burn(overrides: Partial<Burn> = {}): Burn {
  return {
    turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    window5hStart: new Date().toISOString(), window5hOutput: 0,
    ...overrides,
  };
}

// A live StudioDO cannot be constructed under vitest-pool-workers (see
// test/studio.routes.test.ts's own fakeStudioNamespace header for the full
// reason). This fake is deliberately narrower than that one: the grid path
// (routes.ts's renderStudioGrid) only ever calls getTranscriptTail() on a
// stub — it never calls getStatus/provision/restartStudio for the render
// itself — so only that one member is implemented here.
//
// `tails` keys by studio id; a value that is an `Error` makes THAT studio's
// own tail read throw, for the "one broken studio must not break the whole
// grid" coverage below. A missing key defaults to "" (no ship tick yet),
// matching getTranscriptTailWithStorage's own real default.
function fakeStudioNamespace(tails: Record<string, string | Error> = {}): Env["STUDIO"] {
  const get = ((id: unknown) => {
    const studioId = id as string;
    return {
      getTranscriptTail: async () => {
        const v = tails[studioId];
        if (v instanceof Error) throw v;
        return v ?? "";
      },
    };
  }) as unknown as Env["STUDIO"]["get"];
  return {
    idFromName: ((name: string) => name) as unknown as Env["STUDIO"]["idFromName"],
    get,
  } as unknown as Env["STUDIO"];
}

function envWithFakeStudio(tails: Record<string, string | Error> = {}): Env {
  return { ...env, STUDIO: fakeStudioNamespace(tails) } as unknown as Env;
}

function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("GET /studio/ — content negotiation (Task 5, P2 plane 3)", () => {
  it("401 without an Access header even when Accept asks for html (auth runs before negotiation)", async () => {
    const testEnv = envWithFakeStudio();
    const res = await handleStudio(
      new Request("https://x/studio/", { headers: { Accept: "text/html" } }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("no Accept header at all still returns JSON, unchanged (back-compat default)", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(env, status());

    const res = await handleStudio(authorizedReq("/studio/"), testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toHaveLength(1);
  });

  it("Accept: application/json (CLI, explicit) returns exactly what listStudios returns — shape unchanged", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(env, status());
    await recordStudio(env, status({ id: OTHER_ID, state: "stopped", lastRefresh: null }));

    const res = await handleStudio(
      authorizedReq("/studio/", { headers: { Accept: "application/json" } }),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as StudioStatus[];
    expect(body).toHaveLength(2);
    expect(body).toEqual(await listStudios(env));
  });

  it("Accept: text/html (browser) serves the grid page, not JSON", async () => {
    authorized();
    const testEnv = envWithFakeStudio({ [STUDIO_ID]: "hello from the pane\n" });
    await recordStudio(env, status());

    const res = await handleStudio(
      authorizedReq("/studio/", { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await res.text();
    expect(body).toContain(STUDIO_ID);
    expect(body).toContain("hello from the pane");
    // The build artifact's placeholder is gone, replaced with real data —
    // same assertion shape as the terminal page's own test.
    expect(body).not.toContain("__FLEET_STUDIO_DATA__");
  });

  it("preview is scrubbed server-side: a raw tail carrying GitHub/Anthropic tokens never reaches the served HTML", async () => {
    authorized();
    const rawTail =
      "assistant: here is your token ghs_secretsecretvalue and also sk-ant-api03-deadbeefdeadbeef123";
    const testEnv = envWithFakeStudio({ [STUDIO_ID]: rawTail });
    await recordStudio(env, status());

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    const body = await res.text();
    expect(body).not.toContain("ghs_");
    expect(body).not.toContain("sk-ant-");
    expect(body).not.toContain("secretsecretvalue");
    expect(body).not.toContain("deadbeefdeadbeef123");
  });

  it("burn numbers (turns / output tokens / 5h-window output) are present in the served HTML", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(
      env,
      status({ burn: burn({ turns: 7, inputTokens: 111, outputTokens: 4231, window5hOutput: 908 }) }),
    );

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    const body = await res.text();
    expect(body).toContain('"turns":7');
    expect(body).toContain('"outputTokens":4231');
    expect(body).toContain('"window5hOutput":908');
  });

  // Fleet Spawn P3, Task 5 (R-P3-4): grid header totals render.
  it("grid header totals aggregate burn NUMBERS across every studio in the served HTML", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(env, status({ id: STUDIO_ID, burn: burn({ turns: 7, outputTokens: 4231, window5hOutput: 908 }) }));
    await recordStudio(env, status({ id: OTHER_ID, burn: burn({ turns: 3, outputTokens: 100, window5hOutput: 50 }) }));

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    const body = await res.text();
    // 7+3=10 turns, 4231+100=4331 output tokens, 908+50=958 5h output.
    expect(body).toContain('"turns":10');
    expect(body).toContain('"outputTokens":4331');
    expect(body).toContain('"window5hOutput":958');
    expect(body).not.toContain("__FLEET_TOTALS__"); // placeholder fully replaced
  });

  it("grid header totals: a studio with no burn yet (null) contributes zero, not a crash", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(env, status({ id: STUDIO_ID, burn: null }));
    await recordStudio(env, status({ id: OTHER_ID, burn: burn({ turns: 5, outputTokens: 20, window5hOutput: 20 }) }));

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"turns":5');
    expect(body).toContain('"outputTokens":20');
  });

  it("tailscaleHost appears verbatim in the payload when present", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(env, status({ tailscaleHost: "studio-pilot.tailnet-1234.ts.net" }));

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    const body = await res.text();
    expect(body).toContain("studio-pilot.tailnet-1234.ts.net");
  });

  it("the served page carries the terminal-link mechanism and this studio's id to build it from", async () => {
    // The link itself ("/studio/<id>/terminal") is built client-side from
    // the embedded card data (grid.template.html's `card()`), so a raw
    // (unexecuted) HTML string can't observe the concatenated href the way
    // a browser would — this asserts the two ingredients that make it
    // correct instead: the id is really in the injected data, and the
    // page's own script really does build a "/terminal" link labelled for
    // opening it.
    authorized();
    const testEnv = envWithFakeStudio();
    await recordStudio(env, status());

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    const body = await res.text();
    expect(body).toContain(`"id":"${STUDIO_ID}"`);
    expect(body).toContain("open terminal");
    expect(body).toContain('"/terminal"');
  });

  it("one studio's transcript-tail read failing does not break the whole grid (per-row isolation)", async () => {
    authorized();
    const testEnv = envWithFakeStudio({
      [STUDIO_ID]: new Error("DO unreachable"),
      [OTHER_ID]: "fine\n",
    });
    await recordStudio(env, status());
    await recordStudio(env, status({ id: OTHER_ID }));

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(STUDIO_ID);
    expect(body).toContain(OTHER_ID);
    expect(body).toContain("fine");
  });

  it("no studios provisioned: 200 with an empty card list, not an error", async () => {
    authorized();
    const testEnv = envWithFakeStudio();
    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "text/html" } }), testEnv);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("[]"); // the injected STUDIO_DATA array
  });
});

describe("scrubPreview (src/studio/grid.ts)", () => {
  it("keeps only the last 15 lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = scrubPreview(lines.join("\n"));
    expect(result.split("\n")).toHaveLength(15);
    expect(result).not.toContain("line 0\n");
    expect(result).toContain("line 19");
  });

  it("redacts secrets within the kept window", () => {
    expect(scrubPreview("token ghs_abcdefghijklmno present")).not.toContain("ghs_");
  });

  it("leaves input with 15 or fewer lines unchanged apart from redaction", () => {
    expect(scrubPreview("a\nb\nc")).toBe("a\nb\nc");
  });

  it("empty input produces an empty preview", () => {
    expect(scrubPreview("")).toBe("");
  });
});

describe("renderGridPage (src/studio/grid.ts)", () => {
  function card(overrides: Partial<GridCard> = {}): GridCard {
    return {
      id: STUDIO_ID, state: "running", lastRefresh: null, tailscaleHost: null, burn: null, preview: "",
      ...overrides,
    };
  }

  it("embeds card data as JSON with '<' escaped, so preview text cannot break out of the <script> tag", () => {
    const html = renderGridPage([card({ preview: "</script><script>alert(1)</script>" })]);
    expect(html).not.toContain("</script><script>alert(1)</script>");
    // Only "<" needs escaping (it's the character that begins a tag to an
    // HTML/script parser) — ">" is left as plain text, so the escaped form
    // is "\u003c/script>", not "\u003c/script\u003e".
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain("\\u003cscript>alert(1)\\u003c/script>");
  });

  it("replaces the placeholder token entirely — nothing left over in the output", () => {
    const html = renderGridPage([card()]);
    expect(html).not.toContain("__FLEET_STUDIO_DATA__");
    expect(html).toContain(`"id":"${STUDIO_ID}"`);
  });

  it("a preview containing $', $&, $$ is inserted literally — String.replace's dollar-pattern syntax must not fire on studio-influenced text", () => {
    // Ordinary terminal content (sed/shell/Make output) can carry any of
    // these. If renderGridPage ever passes safeJsonForScript's return value
    // as a STRING replacement again (instead of a replacement function),
    // the engine reads $&/$`/$'/$$ as replace-pattern syntax: $' in
    // particular splices in "everything in gridHtml after the matched
    // token" — i.e. the page's own tail (rest of the script, </script>,
    // </html>) — into the middle of the STUDIO_DATA array literal.
    const dangerousPreview = "before $' middle $& more $$ end";
    const baseline = renderGridPage([card()]);
    const html = renderGridPage([card({ preview: dangerousPreview })]);

    // (c) no extra </script> spliced in: same count as an unrelated
    // same-shape render, so only the page's own single real closing tag
    // (plus the one literal "</script>" already sitting in grid.html's
    // top-of-file comment — see that file's own header) are present,
    // exactly as before this card existed.
    const scriptCloseCount = (s: string) => (s.match(/<\/script>/g) ?? []).length;
    expect(scriptCloseCount(html)).toBe(scriptCloseCount(baseline));

    // (a) + (b): the injected STUDIO_DATA array is still valid JSON, and
    // round-trips the preview text byte-for-byte. A $-pattern splice would
    // either break JSON.parse outright or mix spliced-in page tail content
    // into the preview instead of leaving it untouched.
    const line = html.split("\n").find((l) => l.trim().startsWith("var STUDIO_DATA = "));
    expect(line).toBeDefined();
    const jsonText = line!.trim().replace(/^var STUDIO_DATA = /, "").replace(/;$/, "");
    const parsed = JSON.parse(jsonText) as GridCard[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].preview).toBe(dangerousPreview);
  });
});

// Fleet Spawn P3, Task 5 (R-P3-4: "Grid header row aggregating
// turns/output/5h across studios... server-side sum in grid.ts").
describe("computeFleetTotals (src/studio/grid.ts)", () => {
  function cardWithBurn(overrides: Partial<Burn> = {}): Pick<GridCard, "burn"> {
    return { burn: { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, window5hStart: "", window5hOutput: 0, ...overrides } };
  }

  it("sums turns/outputTokens/window5hOutput across every card", () => {
    const totals = computeFleetTotals([
      cardWithBurn({ turns: 7, outputTokens: 4231, window5hOutput: 908 }),
      cardWithBurn({ turns: 3, outputTokens: 100, window5hOutput: 50 }),
    ]);
    expect(totals).toEqual({ turns: 10, outputTokens: 4331, window5hOutput: 958 });
  });

  it("a null-burn studio (never synced yet) contributes zero, not NaN/crash", () => {
    const totals = computeFleetTotals([
      { burn: null },
      cardWithBurn({ turns: 5, outputTokens: 20, window5hOutput: 20 }),
    ]);
    expect(totals).toEqual({ turns: 5, outputTokens: 20, window5hOutput: 20 });
  });

  it("all null-burn studios (no studio synced yet) yields all-zero totals, not NaN", () => {
    expect(computeFleetTotals([{ burn: null }, { burn: null }])).toEqual({ turns: 0, outputTokens: 0, window5hOutput: 0 });
  });

  it("empty card list yields all-zero totals", () => {
    expect(computeFleetTotals([])).toEqual({ turns: 0, outputTokens: 0, window5hOutput: 0 });
  });

  it("inputTokens/costUsd are ignored — only turns/outputTokens/window5hOutput are aggregated", () => {
    const totals = computeFleetTotals([cardWithBurn({ turns: 1, inputTokens: 99999, costUsd: 42, outputTokens: 2, window5hOutput: 3 })]);
    expect(totals).toEqual({ turns: 1, outputTokens: 2, window5hOutput: 3 });
  });
});

describe("renderGridPage — fleet totals injection (src/studio/grid.ts)", () => {
  function card(overrides: Partial<GridCard> = {}): GridCard {
    return {
      id: STUDIO_ID, state: "running", lastRefresh: null, tailscaleHost: null, burn: null, preview: "",
      ...overrides,
    };
  }

  it("embeds computeFleetTotals' own result under the totals placeholder, replacing it entirely", () => {
    const html = renderGridPage([
      card({ burn: { turns: 7, inputTokens: 0, outputTokens: 4231, costUsd: 0, window5hStart: "", window5hOutput: 908 } }),
    ]);
    expect(html).not.toContain("__FLEET_TOTALS__");
    const line = html.split("\n").find((l) => l.trim().startsWith("var FLEET_TOTALS = "));
    expect(line).toBeDefined();
    const jsonText = line!.trim().replace(/^var FLEET_TOTALS = /, "").replace(/;$/, "");
    expect(JSON.parse(jsonText)).toEqual({ turns: 7, outputTokens: 4231, window5hOutput: 908 });
  });

  it("empty card list still renders all-zero totals, valid JSON, no placeholder left over", () => {
    const html = renderGridPage([]);
    expect(html).not.toContain("__FLEET_TOTALS__");
    const line = html.split("\n").find((l) => l.trim().startsWith("var FLEET_TOTALS = "));
    const jsonText = line!.trim().replace(/^var FLEET_TOTALS = /, "").replace(/;$/, "");
    expect(JSON.parse(jsonText)).toEqual({ turns: 0, outputTokens: 0, window5hOutput: 0 });
  });

  it("the STUDIO_DATA card-list injection (scrubbed-pipeline) stays byte-identical alongside the new totals injection", () => {
    // Fleet Spawn P3, Task 5 controller carry: "scrubbed pipeline untouched"
    // — this re-runs the pre-existing $-pattern-safety assertion shape
    // (test/studio.grid.test.ts's own "preview containing $', $&, $$"
    // coverage above) with a NON-EMPTY totals payload also present, proving
    // the second substitution does not disturb the first.
    const dangerousPreview = "before $' middle $& more $$ end";
    const html = renderGridPage([card({ preview: dangerousPreview, burn: { turns: 1, inputTokens: 0, outputTokens: 2, costUsd: 0, window5hStart: "", window5hOutput: 3 } })]);
    const cardLine = html.split("\n").find((l) => l.trim().startsWith("var STUDIO_DATA = "));
    const parsed = JSON.parse(cardLine!.trim().replace(/^var STUDIO_DATA = /, "").replace(/;$/, "")) as GridCard[];
    expect(parsed[0].preview).toBe(dangerousPreview); // untouched by the totals substitution
  });

  // Fleet Spawn P3, Task 6 fold (Task 5 review minor): a preview whose text
  // IS the totals placeholder. Serialised into the card list it becomes
  // `"__FLEET_TOTALS__"` byte for byte — the exact string the totals
  // substitution looks for. While the two substitutions were CHAINED (cards
  // first, then totals over the result), `.replace`'s first-match rule hit
  // that card's preview instead of the real placeholder: the preview turned
  // into a totals object and the header placeholder survived into the served
  // page. A studio controls its own preview text, so this was steerable from
  // inside a container, not merely a coincidence.
  it("a preview that IS the totals placeholder stays a string, and the header totals still render", () => {
    const html = renderGridPage([
      card({
        preview: "__FLEET_TOTALS__",
        burn: { turns: 3, inputTokens: 0, outputTokens: 11, costUsd: 0, window5hStart: "", window5hOutput: 5 },
      }),
    ]);

    const cardLine = html.split("\n").find((l) => l.trim().startsWith("var STUDIO_DATA = "));
    const parsed = JSON.parse(cardLine!.trim().replace(/^var STUDIO_DATA = /, "").replace(/;$/, "")) as GridCard[];
    expect(parsed[0].preview).toBe("__FLEET_TOTALS__"); // still a string, not swallowed by the totals object

    const totalsLine = html.split("\n").find((l) => l.trim().startsWith("var FLEET_TOTALS = "));
    const totals = JSON.parse(totalsLine!.trim().replace(/^var FLEET_TOTALS = /, "").replace(/;$/, ""));
    expect(totals).toEqual({ turns: 3, outputTokens: 11, window5hOutput: 5 });
    // The header placeholder is genuinely consumed — the only `__FLEET_TOTALS__`
    // left anywhere in the page is the card's own preview string.
    expect(html.match(/__FLEET_TOTALS__/g)).toHaveLength(1);
  });
});

describe("page/grid.html build artifact", () => {
  it("makes no external requests (no http:// or https:// URLs anywhere in the page)", () => {
    expect(gridHtmlArtifact).not.toMatch(/https?:\/\//);
  });

  it("carries no stray source-map comment", () => {
    expect(gridHtmlArtifact).not.toContain("sourceMappingURL");
  });

  it("still carries its data placeholder untouched (so renderGridPage's own substitution has something to find)", () => {
    expect(gridHtmlArtifact).toContain('"__FLEET_STUDIO_DATA__"');
  });

  it("still carries its totals placeholder untouched (Fleet Spawn P3, Task 5)", () => {
    expect(gridHtmlArtifact).toContain('"__FLEET_TOTALS__"');
  });

  it("its inline <script> content is syntactically valid JS", () => {
    const scripts = [...gridHtmlArtifact.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) {
      // Parses (and wraps, never executes) the extracted source — a
      // SyntaxError here means the checked-in artifact itself is broken,
      // not just the template it was built from.
      expect(() => new Function(code)).not.toThrow();
    }
  });
});

describe("getTranscriptTailWithStorage (src/studio/transcript.ts)", () => {
  // TranscriptStorage's `get` is an overloaded signature (one per key); a
  // plain single-purpose implementation is cast through, not naturally
  // assignable — same `as X["get"]` idiom test/studio.routes.test.ts's own
  // fakeStorage() uses for StudioStorage's identically-shaped overload.
  function fakeStorage(value: string | undefined): Pick<TranscriptStorage, "get"> {
    return { get: (async () => value) as TranscriptStorage["get"] };
  }

  it("returns '' (never undefined) when nothing has been stored yet", async () => {
    expect(await getTranscriptTailWithStorage(fakeStorage(undefined))).toBe("");
  });

  it("returns the stored value verbatim, unscrubbed (scrubbing is the caller's job)", async () => {
    const raw = "line one\nghs_rawsecretvalue\n";
    expect(await getTranscriptTailWithStorage(fakeStorage(raw))).toBe(raw);
  });
});
