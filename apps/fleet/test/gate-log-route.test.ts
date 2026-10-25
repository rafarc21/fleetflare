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

  it("accepts a union '@head' leg (cargo-test@head)", async () => {
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

    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-cargo-test@head.json`,
      JSON.stringify({ state: "failure", stdout: "FAIL cargo test failed\n", summary: "Tests 1 failed" }),
    );

    // `leg=cargo-test%40head` — the URL-encoded form the CLI sends.
    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=cargo-test%40head&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toContain("shard-cargo-test@head.json");
    expect(body.state).toBe("failure");
  });

  it("accepts a sharded union head leg (vitest@head-6)", async () => {
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

    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest@head-6.json`,
      JSON.stringify({ state: "failure", stdout: "FAIL shard 6 failed\n", summary: "Tests 1 failed" }),
    );

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=vitest%40head-6&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toContain("shard-vitest@head-6.json");
    expect(body.state).toBe("failure");
  });

  it("rejects a leg with an '@' that is not '@head'", async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof globalThis.fetch;

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=cargo-test@main&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("leg required");
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
describe("GET /studio/gate/log --all (#1318)", () => {
  it("lists every attempt of a flaky leg, oldest first, each with status and first failing test", async () => {
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

    // First try failed, retry passed later try — the route must list BOTH.
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.json`,
      JSON.stringify({ state: "failure", stdout: "FAIL src/a.test.ts > a > should trim\n", summary: "Tests 1 failed" }),
    );
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.retry.json`,
      JSON.stringify({ state: "success", summary: "1393 passed" }),
    );

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=vitest-6&run=${RUN}&all=1`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts: unknown[]; final?: unknown };
    expect(body.attempts).toHaveLength(2);
    const first = body.attempts[0] as { key: string; state: string; failingTest: string | null };
    expect(first.key).toContain("shard-vitest-6.json");
    expect(first.state).toBe("failure");
    expect(first.failingTest).toBe("should trim");
    const retry = body.attempts[1] as { key: string; state: string };
    expect(retry.key).toContain("shard-vitest-6.retry.json");
    expect(retry.state).toBe("success");
  });

  it("--all on a leg with no result 404s the same as the single-key path", async () => {
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

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=merge-tree&run=${RUN}&all=1`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toContain("no result");
  });
});
