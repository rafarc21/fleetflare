import { describe, it, expect, vi, afterEach } from "vitest";
import { TerminalBridge } from "../src/studio/terminal";
import type { PtyHandle } from "../src/studio/sandbox-api";

afterEach(() => { vi.restoreAllMocks(); });

// Measured in local workerd (wrangler dev, real network viewer, PR #153 head):
// a viewer that SENT frames and then closed cleanly fires `close` (1000) AND
// THEN `error` on its server-side socket. adopt() wires both to close(), so
// close() runs twice for one departure. The second run finds the viewer set
// empty and forgets/closes whatever pty is current — a re-attach's attempt
// already in flight included. Production change this pins: close() acts only
// for a socket it actually removed from the viewer set.
function fakePty() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  let closes = 0;
  const handle: PtyHandle = { readable, write: () => {}, resize: () => {}, close: () => { closes += 1; } };
  return { handle, closes: () => closes, emit: (b: Uint8Array) => controller.enqueue(b) };
}
function fakeViewer() {
  const target = new EventTarget();
  const ws = Object.assign(target, { binaryType: "blob", accept() {}, close() {}, send() {} }) as unknown as WebSocket;
  return { ws, fire: (type: string) => target.dispatchEvent(new Event(type)) };
}
const upgrade = () => new Request("https://studio/ws/terminal", { headers: { Upgrade: "websocket" } });

describe("close() is idempotent per viewer (#153 review)", () => {
  it("a departed viewer's late `error` does not tear down the pty a re-attach is opening", async () => {
    const first = fakePty();
    const second = fakePty();
    let n = 0;
    const bridge = new TerminalBridge(async () => (++n === 1 ? first.handle : second.handle));
    const v = fakeViewer();
    bridge.adopt(v.ws);
    await bridge.message(v.ws, JSON.stringify({ t: "resize", cols: 100, rows: 30 })); // opens pty #1

    v.fire("close");                       // last viewer leaves -> pty #1 closed
    await new Promise((r) => setTimeout(r, 0));
    expect(first.closes()).toBe(1);

    const reattach = bridge.attach(upgrade()); // CLI reconnects; pty #2 attempt in flight
    v.fire("error");                          // workerd: `error` after `close`, same socket
    const res = await reattach;
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(101);
    expect(second.closes()).toBe(0);
  });

  it("adopt() wires the `close` event itself to close() — not only `error`", async () => {
    // In-process WebSocketPair test fixtures (studio.ws-own-sockets.test.ts)
    // fire `error` alongside a real `.close()` call, so they pass even with
    // the `close` listener removed from adopt() — 0 tests fail today.
    // A fake viewer that dispatches ONLY "close" pins the listener itself.
    const pty = fakePty();
    const bridge = new TerminalBridge(async () => pty.handle);
    const v = fakeViewer();
    bridge.adopt(v.ws);
    await bridge.message(v.ws, JSON.stringify({ t: "resize", cols: 100, rows: 30 }));

    v.fire("close");
    await new Promise((r) => setTimeout(r, 0));

    expect(pty.closes()).toBe(1);
  });

  // Issue #519 (sweep 13): close()'s `void pending?.then((pty) =>
  // pty.close()).catch(() => {})` used to drop a failed pty close with no
  // trace -- a container whose exec socket refused the close round-trip
  // leaked silently. The swallow itself stays (the last viewer is already
  // gone, there is nobody left to deliver an error to) but one
  // console.error must name the real close failure, and the rejection must
  // never surface as an unhandled one.
  it("a pty close() rejection after the last viewer left logs one console.error, never an unhandled rejection (#519)", async () => {
    const handle: PtyHandle = {
      readable: new ReadableStream<Uint8Array>(),
      write: () => {},
      resize: () => {},
      // The real close() is `ws.close(...)` on the container socket -- an
      // async round-trip that can reject. Sync-throw would be equivalent for
      // the chain, but Promise.reject is the real shape.
      close: () => Promise.reject(new Error("boom: exec socket refused the close")),
    };
    const bridge = new TerminalBridge(async () => handle);
    const v = fakeViewer();
    bridge.adopt(v.ws);
    await bridge.message(v.ws, JSON.stringify({ t: "resize", cols: 100, rows: 30 }));

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    v.fire("close"); // last viewer leaves -> close() runs on the resolved pty
    // The pty promise's .then continuation (and its .catch) run on the
    // microtask queue; two macrotask ticks guarantee both settled.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const closeFailures = errors.mock.calls.filter((c) => c.join(" ").includes("close failed"));
    expect(closeFailures).toHaveLength(1);
    errors.mockRestore();
  });
});
