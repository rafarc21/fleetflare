import { describe, it, expect, vi } from "vitest";
import { TerminalBridge } from "../src/studio/terminal";
import type { PtyHandle } from "../src/studio/sandbox-api";

// #151 — 2026-09-24 prod incident: viewer sockets accepted through the DO
// Hibernation API (ctx.acceptWebSocket) were silently dropped by the runtime
// on their FIRST client frame: the frame never reached webSocketMessage,
// output stopped, no close was dispatched, the edge kept the TCP open. The
// bridge's whole viewer lifecycle (input, fan-out, "last one out closes the
// pty") rode on hibernation dispatch. Production change these pin: the bridge
// accepts viewers ITSELF and learns input/close from the socket's own
// listeners — constructed with the pty opener alone, no host at all.

function fakePty() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const writes: number[][] = [];
  let closes = 0;
  const handle: PtyHandle = {
    readable,
    write: (b) => { writes.push([...b]); },
    resize: () => {},
    close: () => { closes += 1; },
  };
  return { handle, emit: (b: Uint8Array) => controller.enqueue(b), writes, closes: () => closes };
}

function openClient(res: Response) {
  const ws = res.webSocket!;
  const got: number[][] = [];
  ws.binaryType = "arraybuffer";
  ws.accept();
  ws.addEventListener("message", (e) => { if (typeof e.data !== "string") got.push([...new Uint8Array(e.data as ArrayBuffer)]); });
  return { ws, got };
}

const upgrade = () => new Request("https://studio/ws/terminal", { headers: { Upgrade: "websocket" } });

describe("viewer sockets are the bridge's own, not hibernation-dispatched (#151)", () => {
  it("a LATE viewer's input reaches the pty with nothing forwarding it", async () => {
    const pty = fakePty();
    const bridge = new TerminalBridge(async () => pty.handle);
    openClient(await bridge.attach(upgrade()));              // creator
    const late = openClient(await bridge.attach(upgrade())); // joiner
    late.ws.send(new Uint8Array([0x6c, 0x73]));
    await vi.waitFor(() => expect(pty.writes).toEqual([[0x6c, 0x73]]));
  });

  it("a joiner's FIRST frame being a resize does not silence it", async () => {
    const pty = fakePty();
    const bridge = new TerminalBridge(async () => pty.handle);
    openClient(await bridge.attach(upgrade()));
    const late = openClient(await bridge.attach(upgrade()));
    late.ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
    pty.emit(new Uint8Array([9]));
    await vi.waitFor(() => expect(late.got).toEqual([[9]]));
  });

  it("output fans out to every viewer the bridge accepted", async () => {
    const pty = fakePty();
    const bridge = new TerminalBridge(async () => pty.handle);
    const a = openClient(await bridge.attach(upgrade()));
    const b = openClient(await bridge.attach(upgrade()));
    pty.emit(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => {
      expect(a.got).toEqual([[1, 2, 3]]);
      expect(b.got).toEqual([[1, 2, 3]]);
    });
  });

  it("the last viewer leaving closes the pty — learned from the socket, not a runtime event", async () => {
    const pty = fakePty();
    const bridge = new TerminalBridge(async () => pty.handle);
    const a = openClient(await bridge.attach(upgrade()));
    const b = openClient(await bridge.attach(upgrade()));
    a.ws.close(1000, "bye");
    await vi.waitFor(() => expect(bridge.viewerCount()).toBe(1));
    expect(pty.closes()).toBe(0);
    b.ws.close(1000, "bye");
    await vi.waitFor(() => expect(pty.closes()).toBe(1));
  });
});
