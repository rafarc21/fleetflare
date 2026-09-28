import { describe, it, expect } from "vitest";
import { TerminalBridge } from "../src/studio/terminal";
import type { PtyHandle } from "../src/studio/sandbox-api";

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
});
