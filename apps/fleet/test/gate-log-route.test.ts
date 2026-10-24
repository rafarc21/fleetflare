// #1277: /studio/gate/log — reads one leg's final R2 output. The route needs a
// GitHub token (repoTokenMinter token path) and a mocked getPullRequest for the
// canonical repo name; the R2 result goes straight into the real STUDIO_ARCHIVE
// binding under the leg's key.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleGateRoute } from "../src/gate/routes";
import type { Env } from "../src/env";

const REPO = "acme/example";
const PR = 9;
const RUN = "gate-run-log";
const CANONICAL = "acme/example";

function logEnv(): Env {
  return {
    ...env,
    FLEET_GATE_RUNNER: "on",
    GATE_RUNNER_REPOS: REPO,
    GITHUB_TOKEN: "github_pat_TESTONLY_not_real",
    GITHUB_REPO_AUTH: "", // token path for acme
  } as unknown as Env;
}

let realFetch: typeof globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  // Clean any R2 keys this test wrote.
  const listed = await env.STUDIO_ARCHIVE.list({ prefix: `gate/${CANONICAL}/runs/${PR}/${RUN}/` });
  for (const o of listed.objects) await env.STUDIO_ARCHIVE.delete(o.key);
});

describe("GET /studio/gate/log (#1277)", () => {
  it("reads the final-try leg output and extracts failing lines", async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/pulls/")) {
        return new Response(JSON.stringify({
          number: PR, merged: false, merge_commit_sha: null, state: "open",
          base: { ref: "main", repo: { full_name: CANONICAL, private: false } },
          head: { ref: "feature", sha: "a".repeat(40) },
          title: "t", body: "",
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof globalThis.fetch;

    // First attempt failed, retry passed later try — the route must read the
    // FINAL try, never the stale first.
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.json`,
      JSON.stringify({ state: "failure", stdout: "FAIL stale\n", summary: "Tests 1 failed" }),
    );
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6-try2.json`,
      JSON.stringify({
        state: "failure", stdout: "FAIL final > should equal\nAssertionError: expected 1 to equal 2\n",
        summary: "Tests  1 failed | 1393 passed (1394)",
      }),
    );

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=vitest-6&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toContain("-try2.json");
    expect(body.state).toBe("failure");
    expect(body.summary).toContain("1 failed");
    expect(body.failing).toContain("FAIL final > should equal");
    expect(body.failing).toContain("AssertionError: expected 1 to equal 2");
  });

  it("404 (JSON) when the leg has no result", async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/pulls/")) {
        return new Response(JSON.stringify({
          number: PR, merged: false, state: "open",
          base: { ref: "main", repo: { full_name: CANONICAL, private: false } },
          head: { ref: "feature" }, title: "t", body: "",
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=merge-tree&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain("no result");
  });
});

describe("GET /studio/gate/summary (#1277 item 2)", () => {
  it("renders the run's per-leg verdict, red legs linking to their log", async () => {
    const e = logEnv();
    (e as unknown as { GATE_WORKFLOW: unknown }).GATE_WORKFLOW = {
      get: async () => ({
        status: async () => ({
          status: "complete",
          output: {
            state: "failure", description: "1/2 green; red: vitest-1 (run gate-summary)",
            legs: [
              { leg: "merge-tree", state: "success", ms: 900 },
              { leg: "vitest-1", state: "failure", ms: 83_000, summary: "Tests  1 failed" },
            ],
          },
        }),
      }),
    };
    const req = new Request(`https://worker/studio/gate/summary?repo=${REPO}&pr=${PR}&run=gate-summary`);
    const res = await handleGateRoute(req, e);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("gate acme/example#9");
    expect(html).toContain("FAIL vitest-1");
    expect(html).toContain("/studio/gate/log?repo=acme%2Fexample&pr=9&leg=vitest-1&run=gate-summary");
  });
});