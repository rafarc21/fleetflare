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

  test("403/404/401/5xx: false -- none of them are push access", async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      const fake = (async () => new Response("", { status })) as unknown as typeof fetch;
      expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(false);
    }
  });

  test("a thrown fetch (network error, DNS failure, timeout) is false, never a throw -- callers decide the refusal, this never crashes the refresh/rescue tick that calls it", async () => {
    const fake = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await canPushRepo("ghs_fake", "acme/widgets", fake)).toBe(false);
  });

  test("asks the exact URL and service git push itself asks first, with the token as x-access-token Basic auth", async () => {
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
  });
});
