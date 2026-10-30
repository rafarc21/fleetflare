// Issue #1422: the 10-27 outage's root fix. canPushRepo asks the real git
// smart-HTTP receive-pack endpoint (the exact request `git push` itself
// sends first) whether a token can push -- never GET /repos/<repo>
// (github/api.ts's repoIsWritable), which reads false unconditionally for
// an App installation token (measured during this outage's investigation).
import { describe, expect, test } from "bun:test";
import { canPushRepo } from "../../src/studio/push-probe";

describe("canPushRepo", () => {
  test("200: true", async () => {
    const fake = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(true);
  });

  test("401/403/404: false, and never retried -- these are a real, final answer, not flakiness", async () => {
    for (const status of [401, 403, 404]) {
      let calls = 0;
      const fake = (async () => { calls++; return new Response("", { status }); }) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(false);
      expect(calls).toBe(1);
    }
  });

  test("asks the exact URL and service git push itself asks first, with the token as x-access-token Basic auth, and an abortable signal", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init ?? {};
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await canPushRepo("ghs_abc123", "acme/widgets", fake);
    expect(seenUrl).toBe("https://github.com/acme/widgets.git/info/refs?service=git-receive-pack");
    expect(seenInit.method).toBe("GET");
    const headers = seenInit.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("x-access-token:ghs_abc123")}`);
    expect(seenInit.signal).toBeInstanceOf(AbortSignal);
  });

  // Review r1 (PR #1435): no timeout on the real fetch meant a stalled
  // GitHub response held the refresh/rescue tick open indefinitely -- the
  // exact class of problem this whole feature exists to catch, one layer up.
  describe("timeout (review r1, #1422)", () => {
    test("a fetch that never resolves, but honors its AbortSignal, ends at the timeout and reads false", async () => {
      const hangUntilAborted = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      const fake = hangUntilAborted as unknown as typeof fetch;
      // A short timeoutMs keeps this test fast; production uses the real
      // 10s default (PROBE_TIMEOUT_MS).
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake, 20)).toBe(false);
    });
  });

  // Review r1 (PR #1435): a single transient blip must not refuse a refresh
  // or push a rescue branch to the public origin fallback -- both call
  // sites (do.ts's runRefreshCredential, rescue.ts's resolveRescueTarget)
  // ride this one retry for free.
  describe("retry once on a transient failure (review r1, #1422)", () => {
    test("503 then 200: true, exactly 2 calls", async () => {
      let calls = 0;
      const fake = (async () => {
        calls++;
        return new Response("", { status: calls === 1 ? 503 : 200 });
      }) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(true);
      expect(calls).toBe(2);
    });

    test("429 then 200: true -- rate-limited is retried too, not just 5xx", async () => {
      let calls = 0;
      const fake = (async () => {
        calls++;
        return new Response("", { status: calls === 1 ? 429 : 200 });
      }) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(true);
      expect(calls).toBe(2);
    });

    test("a thrown fetch (network error, DNS failure) then 200: true, exactly 2 calls", async () => {
      let calls = 0;
      const fake = (async () => {
        calls++;
        if (calls === 1) throw new Error("network down");
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(true);
      expect(calls).toBe(2);
    });

    test("503 twice in a row: false -- a second transient failure is treated as a real answer, never a third try", async () => {
      let calls = 0;
      const fake = (async () => { calls++; return new Response("", { status: 503 }); }) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(false);
      expect(calls).toBe(2);
    });

    test("a thrown fetch twice in a row: false, exactly 2 calls, never a throw out of canPushRepo itself", async () => {
      let calls = 0;
      const fake = (async () => { calls++; throw new Error("network down"); }) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(false);
      expect(calls).toBe(2);
    });
  });
});
