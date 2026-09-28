import { describe, expect, it, vi } from "vitest";
import { postTaskNew, sendWithRetry, taskNewFailureLine } from "../cli/task-new-retry";

// Issue #139. Imports the pure module, not cli/fleet.ts — same reason
// test/cli.backoff.test.ts does (see test/cli.fleet.test.ts's header).
// The caller builds the request body ONCE, idempotency key included, so
// every attempt below replays the same key; the Worker turns a replay of a
// create that already landed into the existing issue.
const noSleep = vi.fn(async () => {});

describe("sendWithRetry (fleet task new)", () => {
  it("retries a 5xx and returns the first success", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(new Response("board upstream failed (520)", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await sendWithRetry(send, [1, 1], noSleep);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries a network error", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await sendWithRetry(send, [1], noSleep)).status).toBe(200);
  });

  it("never retries a 4xx — the request itself is wrong", async () => {
    const send = vi.fn().mockResolvedValue(new Response("bad brief", { status: 400 }));
    expect((await sendWithRetry(send, [1, 1], noSleep)).status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last delay and hands back the last response", async () => {
    const send = vi.fn().mockImplementation(async () => new Response("down", { status: 502 }));
    const res = await sendWithRetry(send, [1, 1], noSleep);
    expect(res.status).toBe(502);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rethrows the last network error when every attempt threw", async () => {
    const send = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendWithRetry(send, [1], noSleep)).rejects.toThrow("fetch failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("postTaskNew (fleet task new, #139)", () => {
  it("replays ONE body, carrying ONE key, across every retry", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce(new Response("board upstream failed (520)", { status: 502 }))
      .mockResolvedValueOnce(new Response("board upstream failed (520)", { status: 502 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await postTaskNew(post, { title: "t", repo: "o/r" }, undefined, [1, 1], noSleep);

    expect(res.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(3);
    const bodies = post.mock.calls.map((c) => c[0] as string);
    expect(new Set(bodies).size).toBe(1);
    const sent = JSON.parse(bodies[0]) as Record<string, unknown>;
    expect(sent).toMatchObject({ title: "t", repo: "o/r" });
    expect(sent.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("two invocations mint two different keys", async () => {
    const post = vi.fn(async (_body: string) => new Response("{}", { status: 200 }));
    await postTaskNew(post, { title: "t" }, undefined, [], noSleep);
    await postTaskNew(post, { title: "t" }, undefined, [], noSleep);
    const keys = post.mock.calls.map((c) => (JSON.parse(c[0] as string) as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("taskNewFailureLine", () => {
  it("a 5xx names the key and says the task may already exist — a blind rerun is how #56 was duplicated", () => {
    const line = taskNewFailureLine(502, "board upstream failed (520)", "k-abc12345");
    expect(line).toContain("502");
    expect(line).toContain("k-abc12345");
    expect(line).toContain("fleet task ls");
  });

  it("a 4xx is the request being wrong — no may-exist warning", () => {
    expect(taskNewFailureLine(400, "bad brief", "k-abc12345")).not.toContain("fleet task ls");
  });
});
