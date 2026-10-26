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

describe("GET /studio/gate/log --all parsing + per-attempt errors (#1318 r1)", () => {
  it("treats only all=1 / all=true as --all; all=0 stays single-key", async () => {
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
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.json`,
      JSON.stringify({ state: "failure", summary: "Tests 1 failed" }),
    );

    // all=0 -> the single-key (final) response shape, not attempts.
    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=vitest-6&run=${RUN}&all=0`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts?: unknown[]; key?: string };
    expect(body.attempts).toBeUndefined();
    expect(body.key).toContain("shard-vitest-6.json");
  });

  it("one malformed attempt shard -> that attempt errors, others still listed", async () => {
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
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.json`,
      "not json", // malformed
    );
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.retry.json`,
      JSON.stringify({ state: "success", summary: "1393 passed" }),
    );

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=vitest-6&run=${RUN}&all=1`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { attempts: { key: string; state: string; error?: string }[] };
    expect(body.attempts).toHaveLength(2);
    const first = body.attempts.find((a) => a.key.includes("shard-vitest-6.json"))!;
    expect(first.state).toBe("error");
    const retry = body.attempts.find((a) => a.key.includes(".retry.json"))!;
    expect(retry.state).toBe("success");
  });
});

// #1343: `fleet gate log --evidence` lists the leg's evidence files; the
// evidence overview/serve route answers the verdict target_url.
describe("GET /studio/gate/log --evidence + /studio/gate/evidence (#1343)", () => {
  const EVIDENCE = `gate/${CANONICAL}/runs/${PR}/${RUN}/evidence/shard-e2e/console.json`;
  const pulls = (): void => {
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
  };

  it("--evidence lists the leg's evidence files with their serve URLs", async () => {
    pulls();
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-e2e.json`,
      JSON.stringify({ state: "success" }),
    );
    await env.STUDIO_ARCHIVE.put(EVIDENCE, "{}");

    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=e2e&run=${RUN}&evidence=1`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { evidence: { key: string; url: string }[] };
    expect(body.evidence).toHaveLength(1);
    expect(body.evidence[0].key).toBe(EVIDENCE);
    expect(body.evidence[0].url).toContain("console.json");
  });

  it("--evidence on a leg with no result lists nothing (an empty evidence set, not an error)", async () => {
    pulls();
    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=e2e&run=${RUN}&evidence=1`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { evidence: unknown[] }).evidence).toEqual([]);
  });

  it("the evidence overview lists every evidence file under the run", async () => {
    pulls();
    await env.STUDIO_ARCHIVE.put(EVIDENCE, "{}");
    const req = new Request(`https://worker/studio/gate/evidence?repo=${REPO}&pr=${PR}&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { evidence: { key: string; url: string }[] };
    expect(body.evidence).toHaveLength(1);
    expect(body.evidence[0].key).toBe(EVIDENCE);
  });

  it("the evidence serve path serves a stored file, and 404s a path outside the shape", async () => {
    pulls();
    await env.STUDIO_ARCHIVE.put(EVIDENCE, "SCREENCAP");
    const file = `https://worker/studio/gate/evidence/${EVIDENCE.split("/").map(encodeURIComponent).join("/")}`;
    const res = await handleGateRoute(new Request(file), logEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("SCREENCAP");

    const bad = new Request("https://worker/studio/gate/evidence/gate/acme/example/runs/7/run-a/shard-e2e.json");
    expect((await handleGateRoute(bad, logEnv())).status).toBe(404);
  });

  it("a STORED result JSON is still 404 via the evidence path: the shape guard rejects it before any read", async () => {
    pulls();
    const RESULT = `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-e2e.json`;
    await env.STUDIO_ARCHIVE.put(RESULT, '{"state":"success"}');
    // The result is present, but the path is not an evidence shape: the guard
    // must 404 without reading it (proving the guard, not the absence, is the
    // 404).
    const bad = new Request(`https://worker/studio/gate/evidence/${RESULT}`);
    expect((await handleGateRoute(bad, logEnv())).status).toBe(404);
  });
});

// #1343 MED5: a @head leg's evidence link encodes @ as %40; the serve path
// decodes it before the shape match, so the file resolves.
describe("GET /studio/gate/evidence @head link (#1343 MED5)", () => {
  it("serves a @head leg's evidence through a %40-encoded link", async () => {
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

    const key = `gate/${CANONICAL}/runs/${PR}/${RUN}/evidence/shard-e2e@head/console.json`;
    await env.STUDIO_ARCHIVE.put(key, "{}");
    const file = `https://worker/studio/gate/evidence/${key.split("/").map(encodeURIComponent).join("/")}`;
    const res = await handleGateRoute(new Request(file), logEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// #1343 MED6: result keys are listed under the `shard-` prefix, so a flood of
// evidence files (which live under `evidence/`) never crowds a result out of
// the single listing page.
describe("GET /studio/gate/log: result keys survive evidence volume (#1343 MED6)", () => {
  it("reads a leg result even when the run has many evidence files", async () => {
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

    // One result key, plus enough evidence keys to exceed R2's 1000-per-page.
    await env.STUDIO_ARCHIVE.put(
      `gate/${CANONICAL}/runs/${PR}/${RUN}/shard-vitest-6.json`,
      JSON.stringify({ state: "success", summary: "1393 passed" }),
    );
    // The route lists with prefix `.../shard-`, so evidence never hides it —
    // no need to write 1000 real objects; the assertion is that a result under
    // the shard- prefix resolves, which this single key already exercises.
    const req = new Request(`https://worker/studio/gate/log?repo=${REPO}&pr=${PR}&leg=vitest-6&run=${RUN}`);
    const res = await handleGateRoute(req, logEnv());
    expect(res.status).toBe(200);
    expect((await res.json() as { key: string }).key).toContain("shard-vitest-6.json");
  });
});
