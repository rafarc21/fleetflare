import { describe, it, expect, spyOn } from "bun:test";
import {
  GIT_PROXY_HOST,
  handleGateOutbound,
  type GateOutboundProps,
  type GitProxyDeps,
  type OutboundBucket,
} from "../../src/gate/outbound-handler";

// #1137: a 429 from GitHub on clone or checkout is retried server-side, so every
// leg's container does not fail on the same schedule. The retry loop runs on an
// injected fake clock: sleep() advances the clock and records the wait, so no
// test waits on real time.

const REPO = "acme/example";
const OWN: GateOutboundProps = {
  resultKey: "gate/acme/example/runs/1137/run-a/shard-typecheck.json",
  repo: REPO,
  gitToken: "ghs_TESTONLY_not_a_real_token_0000",
};
const TOKEN = OWN.gitToken as string;
const ADVERT = "001e# service=git-upload-pack\n0000";

const noBucket: OutboundBucket = {
  async get() { throw new Error("bucket must not be touched by a git request"); },
  async head() { throw new Error("bucket must not be touched by a git request"); },
  async put() { throw new Error("bucket must not be touched by a git request"); },
};

interface Step {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Upstream that answers each call with the next scripted step (the last step
 *  repeats once the script runs out). `costMs` is how long each upstream call
 *  takes on the fake clock, so a test can exhaust the budget. */
function scriptedGit(script: Step[], opts: { random?: number; startMs?: number; costMs?: number } = {}) {
  const upstream: Array<{ url: string; init: RequestInit; sent: Uint8Array | undefined }> = [];
  const sleeps: number[] = [];
  let clock = opts.startMs ?? 0;
  const deps: GitProxyDeps = {
    async fetch(url, init) {
      const sent = await bytesOf(init.body);
      upstream.push({ url, init, sent });
      clock += opts.costMs ?? 0;
      const step = script[Math.min(upstream.length - 1, script.length - 1)];
      return new Response(step.body ?? ADVERT, {
        status: step.status,
        headers: { "content-type": "application/x-git-upload-pack-advertisement", ...step.headers },
      });
    },
    now: () => clock,
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => opts.random ?? 0,
  };
  return { deps, upstream, sleeps };
}

async function bytesOf(body: RequestInit["body"]): Promise<Uint8Array | undefined> {
  if (body === null || body === undefined) return undefined;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const infoRefs = `http://${GIT_PROXY_HOST}/acme/example.git/info/refs?service=git-upload-pack`;
const uploadPack = `http://${GIT_PROXY_HOST}/acme/example.git/git-upload-pack`;
const gitGet = () => new Request(infoRefs, { method: "GET" });

describe("git proxy: upstream 429 is retried server-side (#1137)", () => {
  it("429 then 200: the container gets the 200 after exactly one retry", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(git.upstream.length).toBe(2);
    expect(git.sleeps.length).toBe(1);
  });

  it("honors Retry-After in seconds: waits exactly that long on the fake clock", async () => {
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "3" } }, { status: 200 }]);
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([3000]);
  });

  it("honors Retry-After as an HTTP date: waits until that instant on the fake clock", async () => {
    const startMs = Date.UTC(2026, 9, 16, 12, 0, 0);
    const at = new Date(startMs + 5000).toUTCString();
    const git = scriptedGit([{ status: 429, headers: { "retry-after": at } }, { status: 200 }], { startMs });
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([5000]);
  });

  it("never retries before Retry-After: a one-hour hint outlasts the budget, so the 429 passes through at once", async () => {
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "3600" } }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(429);
    expect(git.upstream.length).toBe(1);
    expect(git.sleeps).toEqual([]);
  });

  it("waits the full Retry-After when the budget allows: 200s is not cut to 60s", async () => {
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "200" } }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(git.sleeps).toEqual([200_000]);
  });

  it("adds jitter on top of the wait: random() scales the jitter span, never below the Retry-After floor", async () => {
    // Span is max(1s, wait/2) = 1.5s here, so random 0.5 adds 750ms.
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "3" } }, { status: 200 }], { random: 0.5 });
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([3750]);
  });

  it("a 429 with no Retry-After still retries, after a backoff, not immediately", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.upstream.length).toBe(2);
    expect(git.sleeps.length).toBe(1);
    expect(git.sleeps[0]).toBeGreaterThan(0);
  });

  it("403 carrying Retry-After (secondary limit) is retried", async () => {
    const git = scriptedGit([{ status: 403, headers: { "retry-after": "1" } }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(git.upstream.length).toBe(2);
  });

  it("403 without Retry-After is not retried: the permission refusal passes through at once", async () => {
    const git = scriptedGit([{ status: 403 }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(1);
    expect(git.sleeps).toEqual([]);
  });

  it("budget spent: every attempt 429 passes the last 429 through as a bare status", async () => {
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "1", "set-cookie": "sid=1" }, body: "slow down" }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("");
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(git.upstream.length).toBe(4);
    expect(git.sleeps.length).toBe(3);
  });

  it("a retry whose wait would overrun the 10-minute upstream budget is not taken", async () => {
    // One slow upstream call uses 590s of the 600s budget; a 30s wait would overrun it.
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "30" } }, { status: 200 }], { costMs: 590_000 });
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(429);
    expect(git.upstream.length).toBe(1);
    expect(git.sleeps).toEqual([]);
  });

  it("every attempt, retries included, carries a timeout signal", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.upstream.map((u) => u.init.signal)).toEqual([expect.any(AbortSignal), expect.any(AbortSignal)]);
  });

  it("every retry keeps redirect 'manual', so a retry cannot follow a redirect either", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.upstream.map((u) => u.init.redirect)).toEqual(["manual", "manual"]);
  });

  it("a retry re-sends the container's allowed headers and the leg's token, never the container's own auth", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    const req = new Request(infoRefs, {
      method: "GET",
      headers: { authorization: "Bearer attacker", cookie: "a=b", "git-protocol": "version=2" },
    });
    await handleGateOutbound(req, noBucket, OWN, git.deps);
    for (const u of git.upstream) {
      const sent = new Headers(u.init.headers);
      expect(sent.get("authorization")).toBe(`Basic ${btoa(`x-access-token:${TOKEN}`)}`);
      expect(sent.get("cookie")).toBeNull();
      expect(sent.get("git-protocol")).toBe("version=2");
    }
  });
});

describe("git proxy: POST body is buffered so a retry resends identical bytes (#1137)", () => {
  const body = "0032want 0123456789abcdef0123456789abcdef01234567\n00000009done\n";
  const postReq = (b: string) =>
    new Request(uploadPack, {
      method: "POST",
      body: b,
      headers: { "content-type": "application/x-git-upload-pack-request" },
    });

  it("POST 429 then 200: the retry sends the same bytes as the first attempt", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200, body: "PACKDATA" }]);
    const res = await handleGateOutbound(postReq(body), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PACKDATA");
    expect(git.upstream.length).toBe(2);
    const want = new TextEncoder().encode(body);
    expect(git.upstream[0].sent).toEqual(want);
    expect(git.upstream[1].sent).toEqual(want);
  });

  it("a body of exactly 1 MiB is still buffered and retried", async () => {
    const big = "x".repeat(1024 * 1024);
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    const res = await handleGateOutbound(postReq(big), noBucket, OWN, git.deps);
    expect(res.status).toBe(200);
    expect(git.upstream.length).toBe(2);
    expect(git.upstream[1].sent?.byteLength).toBe(1024 * 1024);
  });

  it("a body over 1 MiB is not retried: one attempt, the 429 passes through, the body arrives intact", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    const res = await handleGateOutbound(postReq(big), noBucket, OWN, git.deps);
    expect(res.status).toBe(429);
    expect(git.upstream.length).toBe(1);
    expect(git.sleeps).toEqual([]);
    expect(git.upstream[0].sent?.byteLength).toBe(1024 * 1024 + 1);
    expect(new TextDecoder().decode(git.upstream[0].sent)).toBe(big);
  });
});

describe("git proxy: other statuses pass through unchanged, with no retry (#1137)", () => {
  for (const status of [404, 500, 502, 503]) {
    it(`${status} reaches the container as a bare status after one upstream call`, async () => {
      const git = scriptedGit([{ status, headers: { "retry-after": "1" } }, { status: 200 }]);
      const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("");
      expect(git.upstream.length).toBe(1);
      expect(git.sleeps).toEqual([]);
    });
  }
});

// Retried attempts log the same status and framing lines as before, plus one
// line per retry: status and wait. The token never reaches the log.
describe("git proxy: retries are logged, never with the token (#1137)", () => {
  it("each retry logs its status, attempt number and wait", async () => {
    const logged: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    try {
      const git = scriptedGit([{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }]);
      await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
      const line = logged.find((l) => l.includes("gate git-proxy: retry status="));
      expect(line).toBeDefined();
      expect(line).toContain("status=429");
      expect(line).toContain("wait=2000ms");
      expect(line).toContain("attempt=2/4");
      expect(logged.join("\n")).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
    }
  });
});

// Maestro review of #1137 (findings 1-4, 5, and the low parse/cleanup items).
// Each block pins one finding; the fake clock keeps every wait exact.
describe("git proxy: a 429 with no Retry-After waits GitHub's one-minute floor (review finding 1)", () => {
  it("a hintless 429 waits at least one minute before the retry, not 1s", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 200 }]);
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([60_000]);
  });

  it("a second hintless 429 doubles the wait: 60s then 120s", async () => {
    const git = scriptedGit([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }]);
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([60_000, 120_000]);
  });

  it("x-ratelimit-remaining 0 with x-ratelimit-reset: waits until the reset instant", async () => {
    const startMs = Date.UTC(2026, 9, 16, 12, 0, 0);
    const reset = String(Math.floor(startMs / 1000) + 120);
    const git = scriptedGit(
      [{ status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }, { status: 200 }],
      { startMs },
    );
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([120_000]);
  });
});

describe("git proxy: jitter spans at least half the wait (review finding 2)", () => {
  it("a 60s Retry-After can add up to 30s of jitter, so legs spread across the window", async () => {
    // random 0.999 of a 30s span (wait/2) is 29_970ms.
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "60" } }, { status: 200 }], { random: 0.999 });
    await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(git.sleeps).toEqual([60_000 + 29_970]);
  });
});

describe("git proxy: budget floor and Retry-After (review findings 3 and 4)", () => {
  it("a retry that would leave under 5 minutes of the 10-minute budget is not taken", async () => {
    // First call costs 300s; a 200s wait leaves 100s, under the 5-minute floor.
    const git = scriptedGit([{ status: 429, headers: { "retry-after": "200" } }, { status: 200 }], { costMs: 300_000 });
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(429);
    expect(git.upstream.length).toBe(1);
    expect(git.sleeps).toEqual([]);
  });

  it("every attempt's timeout is a positive delay, so a late retry cannot throw on AbortSignal.timeout", async () => {
    const spy = spyOn(AbortSignal, "timeout");
    try {
      const git = scriptedGit([{ status: 429, headers: { "retry-after": "200" } }, { status: 200 }]);
      await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
      const delays = spy.mock.calls.map(([ms]) => ms as number);
      expect(delays.length).toBe(2);
      for (const ms of delays) expect(ms).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("git proxy: upstream log names Retry-After and rate-limit headers (review finding 5)", () => {
  it("the upstream line shows the raw Retry-After, or '-' when GitHub sent none", async () => {
    const logged: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.join(" ")); });
    try {
      const withHint = scriptedGit([{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }]);
      await handleGateOutbound(gitGet(), noBucket, OWN, withHint.deps);
      expect(logged.find((l) => l.includes("upstream 429"))).toContain("retry-after=2 ");

      logged.length = 0;
      const noHint = scriptedGit([{ status: 429 }, { status: 200 }]);
      await handleGateOutbound(gitGet(), noBucket, OWN, noHint.deps);
      expect(logged.find((l) => l.includes("upstream 429"))).toContain("retry-after=- ");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("git proxy: parse and cleanup edges (review optional lows)", () => {
  it("a non-integer Retry-After ('1.5') is not a date: a 403 carrying it is not retried", async () => {
    // Date.parse("1.5") reads as a 2001 date, which would make the 403 look rate-limited.
    const git = scriptedGit([{ status: 403, headers: { "retry-after": "1.5" } }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(1);
  });

  it("a negative Retry-After ('-5') is not a hint: a 403 carrying it is not retried", async () => {
    const git = scriptedGit([{ status: 403, headers: { "retry-after": "-5" } }, { status: 200 }]);
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, git.deps);
    expect(res.status).toBe(403);
    expect(git.upstream.length).toBe(1);
  });

  it("a request body that errors mid-read becomes a 502, not a thrown error", async () => {
    const bad = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client hung up"));
      },
    });
    const req = new Request(uploadPack, { method: "POST", body: bad } as RequestInit);
    const git = scriptedGit([{ status: 200 }]);
    const res = await handleGateOutbound(req, noBucket, OWN, git.deps);
    expect(res.status).toBe(502);
    expect(git.upstream.length).toBe(0);
  });

  it("a 429 whose body cannot be cancelled still retries, instead of throwing", async () => {
    let calls = 0;
    const deps: GitProxyDeps = {
      async fetch() {
        calls++;
        if (calls === 1) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("slow down"));
            },
            cancel() {
              throw new Error("cancel boom");
            },
          });
          return new Response(body, { status: 429, headers: { "retry-after": "1" } });
        }
        return new Response(ADVERT, { status: 200 });
      },
      now: () => 0,
      async sleep() {},
      random: () => 0,
    };
    const res = await handleGateOutbound(gitGet(), noBucket, OWN, deps);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});
