import { describe, expect, test } from "bun:test";
import { encodeMessage, isRpcFailure, MessageFramer, type RpcResponse } from "../../container/ego-browser/rpc";

describe("encodeMessage / MessageFramer round-trip", () => {
  test("a single message fed whole comes back out parsed and equal", () => {
    const framer = new MessageFramer<RpcResponse>();
    const encoded = encodeMessage({ id: 1, result: { url: "https://x.test" } });
    const [msg] = framer.push(encoded);
    expect(msg).toEqual({ id: 1, result: { url: "https://x.test" } });
  });

  test("a message split across multiple pushes is only parsed once its newline arrives", () => {
    const framer = new MessageFramer<RpcResponse>();
    const encoded = encodeMessage({ id: 2, result: "hello world" });
    const splitAt = Math.floor(encoded.length / 2);
    const first = framer.push(encoded.slice(0, splitAt));
    expect(first).toEqual([]); // no newline yet -- nothing parsed early
    const second = framer.push(encoded.slice(splitAt));
    expect(second).toEqual([{ id: 2, result: "hello world" }]);
  });

  test("multiple complete messages arriving in one chunk are all returned, in order", () => {
    const framer = new MessageFramer<RpcResponse>();
    const chunk = encodeMessage({ id: 1, result: "a" }) + encodeMessage({ id: 2, result: "b" });
    const messages = framer.push(chunk);
    expect(messages).toEqual([
      { id: 1, result: "a" },
      { id: 2, result: "b" },
    ]);
  });

  test("isRpcFailure distinguishes an error response from a success response", () => {
    const framer = new MessageFramer<RpcResponse>();
    const [ok] = framer.push(encodeMessage({ id: 1, result: null }));
    const [fail] = framer.push(encodeMessage({ id: 2, error: { message: "boom" } }));
    expect(isRpcFailure(ok!)).toBe(false);
    expect(isRpcFailure(fail!)).toBe(true);
    if (isRpcFailure(fail!)) expect(fail.error.message).toBe("boom");
  });
});

describe("concurrent in-flight requests do not cross-wire", () => {
  test("responses matched by id survive being interleaved and reordered on the wire", () => {
    // Models what a real socket can legitimately do: two requests fire
    // (ids 10 and 11), and the responses come back on the wire in the
    // OPPOSITE order (11 before 10), split across arbitrary chunk
    // boundaries. A correct consumer must match each response to its own
    // request by id, never by arrival order.
    const framer = new MessageFramer<RpcResponse>();
    const wire =
      encodeMessage({ id: 11, result: "second-request-first-response" }) +
      encodeMessage({ id: 10, result: "first-request-second-response" });

    // Feed it in three arbitrary, mid-message chunk boundaries.
    const chunks = [wire.slice(0, 5), wire.slice(5, 40), wire.slice(40)];
    const pendingById = new Map<number, unknown>();
    for (const chunk of chunks) {
      for (const msg of framer.push(chunk)) {
        pendingById.set(msg.id, "result" in msg ? msg.result : msg.error);
      }
    }
    expect(pendingById.get(11)).toBe("second-request-first-response");
    expect(pendingById.get(10)).toBe("first-request-second-response");
  });
});
