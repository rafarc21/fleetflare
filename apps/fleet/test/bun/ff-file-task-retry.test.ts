// Issue #147: `ff <role> "<task>"` (cli/ff.ts's fileTask) posted the new task
// with no idempotency key and no retry. An upstream 5xx (a 520) that landed
// AFTER GitHub had already created the issue looked like a failure, the
// operator reran `ff`, and that filed a SECOND issue and spawned a SECOND
// studio — the exact duplicate risk #139/PR #142 already fixed for
// `fleet task new`. fileTask now reuses that same cli/task-new-retry.ts
// machinery: one key minted per invocation, the body built once and replayed
// unchanged on every retry.
//
// bun:test, not vitest: cli/ff.ts is Bun-only (Bun.spawn, process.exit
// elsewhere in the file) and is never imported from the vitest suite — same
// precedent as test/bun/ff-no-tty.test.ts's header. `main()` is guarded by
// `import.meta.main`, so importing just `fileTask` here runs none of that.
import { afterEach, describe, expect, test } from "bun:test";
import { fileTask } from "../../cli/ff";
import type { Credentials } from "../../cli/fleet";

const creds: Credentials = { workerUrl: "https://board.example", accessClientId: "id", accessClientSecret: "secret" };
const noSleep = async () => {};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fileTask retries a 5xx with one replayed idempotency key (#147)", () => {
  test("a 520 after the issue already landed is retried, and the SAME key is replayed both times", async () => {
    const calls: { url: string; body: string }[] = [];
    let attempt = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      attempt++;
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      if (attempt === 1) return new Response("upstream 520", { status: 502 });
      return Response.json({ number: 771, url: "https://github.com/o/r/issues/771" });
    }) as typeof fetch;

    const number = await fileTask(creds, "o/r", "o--pilot", "do the thing", [1], noSleep);

    expect(number).toBe(771);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(calls[1].url);
    const keys = calls.map((c) => (JSON.parse(c.body) as { idempotencyKey: string }).idempotencyKey);
    // Same key both times: a replay of a create that already landed resolves
    // to the SAME issue instead of filing — and spawning — a second one.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    const bodies = calls.map((c) => JSON.parse(c.body) as Record<string, unknown>);
    expect(bodies[0].repo).toBe("o/r");
    expect(bodies[0].title).toBe(bodies[1].title);
  });

  test("no retry needed: one call, one key, the issue number comes straight back", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return Response.json({ number: 42, url: "https://github.com/o/r/issues/42" });
    }) as typeof fetch;

    const number = await fileTask(creds, null, "o--pilot", "do the thing", [1], noSleep);

    expect(number).toBe(42);
    expect(calls).toHaveLength(1);
  });
});
