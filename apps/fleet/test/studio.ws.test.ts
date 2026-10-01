import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { TerminalBridge, TERMINAL_PATH, WS_BUFFER_MAX, type AttachPty } from "../src/studio/terminal";
import { sbAttachPty, STUDIO_SESSION_ID, type PtyHandle } from "../src/studio/sandbox-api";
import { StudioDO } from "../src/studio/do";
import type { Env } from "../src/env";

// A live StudioDO still cannot be constructed under vitest-pool-workers, even
// after Task 5's Step 0 made `import "@cloudflare/sandbox"` load cleanly: the
// class is container-backed, and `env.STUDIO.get(...).fetch(...)` throws
// "Containers have not been enabled for this Durable Object class" (verified
// with a throwaway probe test against the real binding). AgentDO and DeployDO
// are container classes too and are faked the same way throughout this suite
// — see test/telegram.webhook.test.ts's `fakeAgent` and
// test/studio.routes.test.ts's `fakeStudioNamespace`.
//
// So the DO CLASS is faked and everything it wraps is real: these tests drive
// the real handleStudio route, the real TerminalBridge, a real WebSocketPair,
// and a real WebSocket client — the only stand-in is do.ts's one-line fetch
// forward into the bridge. #151: the bridge owns its viewer sockets itself
// (accept + listeners), so there is no hibernation dispatch left to fake.
const STUDIO_ID = "websites--pilot";

afterEach(() => {
  vi.restoreAllMocks();
});

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

function terminalReq(headers: Record<string, string> = { Upgrade: "websocket" }) {
  return new Request(`https://x/studio/${STUDIO_ID}/ws/terminal`, {
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...headers },
  });
}

/** Controllable pty: `emit` pushes bytes at the bridge the way a real
 *  container's pty socket would, and every call the bridge makes back down
 *  the PtyHandle port is recorded. */
function fakePty() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    // The real stream (sandbox-api's sbAttachPty) closes the container pty
    // socket from here — `ws.close(1000, "pty reader cancelled")`. Recorded
    // rather than ignored so a test can assert the bridge actually lets a
    // superseded pty's socket go instead of leaving it attached.
    cancel() {
      cancelled = true;
    },
  });
  const writes: Uint8Array[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  let closes = 0;

  const handle: PtyHandle = {
    readable,
    write: (bytes) => {
      writes.push(new Uint8Array(bytes));
    },
    resize: (cols, rows) => {
      resizes.push({ cols, rows });
    },
    close: () => {
      closes += 1;
    },
  };
  return {
    handle,
    emit: (bytes: Uint8Array) => controller.enqueue(bytes),
    /** The pty exited cleanly — container recycle, shell exit. */
    end: () => controller.close(),
    /** The pty socket failed. sandbox-api errors the stream for this, so the
     *  bridge can tell it from a clean EOF. */
    fail: (err: Error) => controller.error(err),
    writes,
    resizes,
    closes: () => closes,
    cancelled: () => cancelled,
  };
}

/**
 * A pty whose FIRST read reports "already ended", via a freshly-resolved
 * plain Promise rather than a real ReadableStream. Needed only for the
 * attach-TOCTOU tests below: measured directly against this suite, a real
 * ReadableStream's getReader().read() — even one pre-closed before
 * getReader() is ever called — settles through more microtask ticks under
 * vitest-pool-workers than ensurePty()'s own `.then()` chain needs to settle
 * ITS promise, so pump's death-detection loses the race against attach()'s
 * post-await continuation every time (confirmed by instrumenting both with
 * console.log: pump's `reader.read()` resolves strictly AFTER attach()'s
 * `await this.ensurePty()` already resumed). A plain Promise does not have
 * that extra machinery — it settles in the same number of ticks as any
 * other `.then()` chain — which is what lets these tests force the exact
 * race the fix guards against, deterministically rather than by luck.
 *
 * This is a test artifact for forcing that one timing property; it is not a
 * claim about how a real container's pty stream behaves. fakePty() above —
 * a real ReadableStream — is what every other test in this file uses, and
 * remains the accurate model of a pty's ordinary (not same-tick) death.
 */
function fakeInstantlyDeadPty(): PtyHandle {
  return {
    readable: {
      getReader: () => ({
        read: () => Promise.resolve({ value: undefined, done: true }),
        releaseLock: () => {},
      }),
    } as unknown as ReadableStream<Uint8Array>,
    write: () => {},
    resize: () => {},
    close: () => {},
  };
}

/** A viewer socket the bridge can `adopt()` whose events a test fires by
 *  hand — the only way to stage an abrupt `error` (a healthy in-process pair
 *  cannot produce one) or a send that throws. */
function fakeViewer(opts: { send?: (bytes: Uint8Array) => void; bufferedAmount?: () => number } = {}) {
  const target = new EventTarget();
  const ws = Object.assign(target, {
    binaryType: "blob",
    accept() {},
    close() {},
    send: opts.send ?? (() => {}),
  }) as unknown as WebSocket;
  if (opts.bufferedAmount) Object.defineProperty(ws, "bufferedAmount", { get: opts.bufferedAmount });
  return { ws, fire: (type: string) => target.dispatchEvent(new Event(type)) };
}

function envWithFakeStudio(attachPty: AttachPty) {
  const bridge = new TerminalBridge(attachPty);
  const seen: Request[] = [];
  const stub = {
    fetch: (req: Request) => {
      seen.push(req);
      return bridge.attach(req);
    },
  };
  const testEnv = {
    ...env,
    STUDIO: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => stub as unknown as ReturnType<Env["STUDIO"]["get"]>,
    },
  } as unknown as Env;
  return { testEnv, seen, bridge };
}

/** Accepts the client end of a 101 and records everything it receives. */
function openClient(res: Response) {
  const ws = res.webSocket;
  if (!ws) throw new Error("expected an upgraded response");
  const binary: Uint8Array[] = [];
  const text: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  ws.binaryType = "arraybuffer";
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") text.push(event.data);
    else binary.push(new Uint8Array(event.data as ArrayBuffer));
  });
  ws.addEventListener("close", (event) => {
    closed.push({ code: event.code, reason: event.reason });
  });
  return { ws, binary, text, closed };
}

function flatten(chunks: Uint8Array[]): number[] {
  return chunks.flatMap((c) => [...c]);
}

describe("GET /studio/:id/ws/terminal", () => {
  it("401 without an Access header, and no upgrade (real verifyAccess, not mocked)", async () => {
    const pty = fakePty();
    const attach = vi.fn(async () => pty.handle);
    const { testEnv } = envWithFakeStudio(attach);

    const res = await handleStudio(
      new Request(`https://x/studio/${STUDIO_ID}/ws/terminal`, { headers: { Upgrade: "websocket" } }),
      testEnv,
    );

    expect(res.status).toBe(401);
    expect(res.status).not.toBe(101);
    expect(res.webSocket).toBeNull();
    // The gate must be reached before the pty is ever touched.
    expect(attach).not.toHaveBeenCalled();
  });

  it("101 with a websocket once authorized", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);

    const res = await handleStudio(terminalReq(), testEnv);

    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
  });

  it("426 when the Upgrade header is missing, and the pty is never opened", async () => {
    authorized();
    const attach = vi.fn(async () => fakePty().handle);
    const { testEnv } = envWithFakeStudio(attach);

    const res = await handleStudio(terminalReq({}), testEnv);

    expect(res.status).toBe(426);
    expect(attach).not.toHaveBeenCalled();
  });

  it("400 on a malformed studio id before any upgrade", async () => {
    authorized();
    const attach = vi.fn(async () => fakePty().handle);
    const { testEnv } = envWithFakeStudio(attach);

    const res = await handleStudio(
      new Request("https://x/studio/BAD_ID/ws/terminal", {
        headers: { "Cf-Access-Jwt-Assertion": "test-jwt", Upgrade: "websocket" },
      }),
      testEnv,
    );

    expect(res.status).toBe(400);
    expect(attach).not.toHaveBeenCalled();
  });

  it("hands the DO a normalized internal URL that still carries the Upgrade header", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv, seen } = envWithFakeStudio(async () => pty.handle);

    await handleStudio(terminalReq(), testEnv);

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe(TERMINAL_PATH);
    // If this header were dropped in transit the DO would answer 426 and the
    // terminal would never open — the one thing the rewrite must preserve.
    expect(seen[0].headers.get("Upgrade")?.toLowerCase()).toBe("websocket");
  });
});

describe("terminal bridge wire contract", () => {
  it("a client binary frame reaches pty.write with exactly the same bytes", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const client = openClient(await handleStudio(terminalReq(), testEnv));

    client.ws.send(new Uint8Array([104, 116, 111, 112, 13]));

    await vi.waitFor(() => expect(pty.writes).toHaveLength(1));
    expect([...pty.writes[0]]).toEqual([104, 116, 111, 112, 13]);
  });

  it("preserves non-UTF8 input bytes exactly (the frame is bytes, not text)", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const client = openClient(await handleStudio(terminalReq(), testEnv));

    client.ws.send(new Uint8Array([0, 27, 91, 65, 255, 254]));

    await vi.waitFor(() => expect(pty.writes).toHaveLength(1));
    expect([...pty.writes[0]]).toEqual([0, 27, 91, 65, 255, 254]);
  });

  it("pty output reaches the client as a binary frame", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const client = openClient(await handleStudio(terminalReq(), testEnv));

    pty.emit(new Uint8Array([27, 91, 50, 74]));

    await vi.waitFor(() => expect(client.binary).toHaveLength(1));
    expect([...client.binary[0]]).toEqual([27, 91, 50, 74]);
    expect(client.text).toEqual([]);
  });

  it("a resize control frame calls pty.resize(cols, rows)", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const client = openClient(await handleStudio(terminalReq(), testEnv));

    client.ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));

    await vi.waitFor(() => expect(pty.resizes).toHaveLength(1));
    expect(pty.resizes[0]).toEqual({ cols: 120, rows: 40 });
    expect(pty.writes).toHaveLength(0);
  });

  it("ignores unknown text frames — no write, no resize", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const client = openClient(await handleStudio(terminalReq(), testEnv));

    client.ws.send(JSON.stringify({ t: "nonsense" }));
    client.ws.send("not json at all");
    client.ws.send(JSON.stringify({ t: "resize", cols: 0, rows: 24 }));
    // A real frame afterwards proves the socket still works and that the
    // assertions below are not just racing ahead of delivery.
    client.ws.send(new Uint8Array([1]));

    await vi.waitFor(() => expect(pty.writes).toHaveLength(1));
    expect(pty.resizes).toHaveLength(0);
    expect([...pty.writes[0]]).toEqual([1]);
  });
});

describe("multiple concurrent attachers", () => {
  it("opens exactly one shared pty for two clients", async () => {
    authorized();
    const pty = fakePty();
    const attach = vi.fn(async () => pty.handle);
    const { testEnv } = envWithFakeStudio(attach);

    openClient(await handleStudio(terminalReq(), testEnv));
    openClient(await handleStudio(terminalReq(), testEnv));

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("fans pty output out to both clients", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));
    const b = openClient(await handleStudio(terminalReq(), testEnv));

    pty.emit(new Uint8Array([65, 66]));

    await vi.waitFor(() => {
      expect(flatten(a.binary)).toEqual([65, 66]);
      expect(flatten(b.binary)).toEqual([65, 66]);
    });
  });

  it("interleaves input from both clients into the one pty", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));
    const b = openClient(await handleStudio(terminalReq(), testEnv));

    a.ws.send(new Uint8Array([97]));
    b.ws.send(new Uint8Array([98]));
    a.ws.send(new Uint8Array([99]));

    await vi.waitFor(() => expect(pty.writes).toHaveLength(3));
    expect(flatten(pty.writes).sort()).toEqual([97, 98, 99]);
  });

  it("a late attacher receives output emitted after it joined", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));

    pty.emit(new Uint8Array([1]));
    await vi.waitFor(() => expect(flatten(a.binary)).toEqual([1]));

    const b = openClient(await handleStudio(terminalReq(), testEnv));
    pty.emit(new Uint8Array([2]));

    await vi.waitFor(() => {
      expect(flatten(a.binary)).toEqual([1, 2]);
      expect(flatten(b.binary)).toEqual([2]);
    });
  });
});

describe("pty lifecycle across disconnects", () => {
  it("keeps the pty open when one of two clients disconnects", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv, bridge } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));
    const b = openClient(await handleStudio(terminalReq(), testEnv));
    expect(bridge.viewerCount()).toBe(2);

    a.ws.close();

    await vi.waitFor(() => expect(bridge.viewerCount()).toBe(1));
    expect(pty.closes()).toBe(0);

    // The session really is still live: the survivor keeps receiving.
    pty.emit(new Uint8Array([7]));
    await vi.waitFor(() => expect(flatten(b.binary)).toEqual([7]));
  });

  it("closes the pty when the last client disconnects", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv, bridge } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));
    const b = openClient(await handleStudio(terminalReq(), testEnv));

    a.ws.close();
    await vi.waitFor(() => expect(bridge.viewerCount()).toBe(1));
    expect(pty.closes()).toBe(0);

    b.ws.close();
    await vi.waitFor(() => expect(pty.closes()).toBe(1));
  });

  it("a single client's disconnect closes the pty", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const only = openClient(await handleStudio(terminalReq(), testEnv));

    only.ws.close();

    await vi.waitFor(() => expect(pty.closes()).toBe(1));
  });

  it("re-attaching after the last disconnect opens a fresh pty", async () => {
    authorized();
    const first = fakePty();
    const second = fakePty();
    const ptys = [first, second];
    const attach = vi.fn(async () => ptys.shift()!.handle);
    const { testEnv } = envWithFakeStudio(attach);

    const a = openClient(await handleStudio(terminalReq(), testEnv));
    a.ws.close();
    await vi.waitFor(() => expect(first.closes()).toBe(1));

    const b = openClient(await handleStudio(terminalReq(), testEnv));
    expect(attach).toHaveBeenCalledTimes(2);

    second.emit(new Uint8Array([9]));
    await vi.waitFor(() => expect(flatten(b.binary)).toEqual([9]));
  });

  it("503, not a dead 101, when the pty cannot be opened", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(async () => {
      throw new Error("container unavailable");
    });

    const res = await handleStudio(terminalReq(), testEnv);

    expect(res.status).toBe(503);
    expect(res.webSocket).toBeNull();
  });
});

// P1 T5 ledger: attach() awaits ensurePty(), which crosses a microtask
// boundary. The resolved pty can already be dead by the time attach()'s own
// continuation runs (ptyEnded — see terminal.ts — clears `this.live` the
// instant the pty's readable stream ends or errors, and that can happen
// before attach() gets its own turn). Without the fix, this 101s a socket
// onto a pty the bridge has already forgotten — a silent, permanently dead
// terminal, and a leaked accepted socket on top.
describe("attach TOCTOU (resolved pty died before the 101 accept)", () => {
  it("503s, accepts nothing, when the pty dies in the window between ensurePty resolving and acceptWebSocket", async () => {
    authorized();
    const attach = vi.fn(async () => fakeInstantlyDeadPty());
    const { testEnv, bridge } = envWithFakeStudio(attach);

    const res = await handleStudio(terminalReq(), testEnv);

    expect(res.status).toBe(503);
    expect(res.webSocket).toBeNull();
    expect(bridge.viewerCount()).toBe(0); // no accept, no socket leak
  });

  it("a following attach opens a fresh pty rather than reusing the dead one", async () => {
    authorized();
    const fresh = fakePty();
    let calls = 0;
    const attach = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? fakeInstantlyDeadPty() : fresh.handle;
    });
    const { testEnv } = envWithFakeStudio(attach);

    const first = await handleStudio(terminalReq(), testEnv);
    expect(first.status).toBe(503);

    const second = await handleStudio(terminalReq(), testEnv);
    expect(second.status).toBe(101);
    expect(attach).toHaveBeenCalledTimes(2);

    const b = openClient(second);
    fresh.emit(new Uint8Array([42]));
    await vi.waitFor(() => expect(flatten(b.binary)).toEqual([42]));
  });
});

describe("abrupt drops (a viewer socket's error event)", () => {
  it("StudioDO implements NONE of the hibernation handlers (#151)", () => {
    // 2026-09-24: viewers accepted through ctx.acceptWebSocket were silently
    // dropped by the runtime on their first client frame — no
    // webSocketMessage, no webSocketClose. The bridge now owns its viewers
    // (accept + listeners); a leftover handler would mean some socket still
    // rides hibernation dispatch.
    const own = Object.getOwnPropertyNames(StudioDO.prototype);
    expect(own).not.toContain("webSocketMessage");
    expect(own).not.toContain("webSocketClose");
    expect(own).not.toContain("webSocketError");
  });

  it("an errored last socket closes the pty (it must not leak an attacher)", async () => {
    const pty = fakePty();
    const bridge = new TerminalBridge(async () => pty.handle);
    const viewer = fakeViewer();
    bridge.adopt(viewer.ws);
    await bridge.message(viewer.ws, JSON.stringify({ t: "resize", cols: 100, rows: 30 }));

    viewer.fire("error");

    await vi.waitFor(() => expect(pty.closes()).toBe(1));
    expect(bridge.viewerCount()).toBe(0);
  });

  it("an errored socket while another remains leaves the pty open", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv, bridge } = envWithFakeStudio(async () => pty.handle);
    const b = openClient(await handleStudio(terminalReq(), testEnv));
    const viewer = fakeViewer();
    bridge.adopt(viewer.ws);

    viewer.fire("error");

    await vi.waitFor(() => expect(bridge.viewerCount()).toBe(1));
    expect(pty.closes()).toBe(0);

    pty.emit(new Uint8Array([5]));
    await vi.waitFor(() => expect(flatten(b.binary)).toEqual([5]));
  });
});

describe("a throwing client must not silence the others", () => {
  it("keeps fanning out when one socket's send throws", async () => {
    // The window is real: a socket is still in the viewer set while its close
    // is being dispatched, and send on it throws. Before the
    // per-socket guard that throw escaped fanOut into pump's catch, which
    // RETURNS — ending output for every remaining client, permanently.
    const pty = fakePty();
    const recorder = () => {
      const got: Uint8Array[] = [];
      return { got, ws: fakeViewer({ send: (bytes) => got.push(new Uint8Array(bytes)) }).ws };
    };
    const first = recorder();
    const third = recorder();
    const broken = fakeViewer({
      send() {
        throw new Error("socket is closing");
      },
    }).ws;

    const bridge = new TerminalBridge(async () => pty.handle);
    for (const ws of [first.ws, broken, third.ws]) bridge.adopt(ws);
    await bridge.message(first.ws, JSON.stringify({ t: "resize", cols: 100, rows: 30 }));

    pty.emit(new Uint8Array([1]));
    pty.emit(new Uint8Array([2]));

    await vi.waitFor(() => {
      expect(flatten(first.got)).toEqual([1, 2]);
      expect(flatten(third.got)).toEqual([1, 2]);
    });
  });
});

describe("a dead pty must not be served to anyone", () => {
  it("tells attached clients the terminal ended, with 1011", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));
    const b = openClient(await handleStudio(terminalReq(), testEnv));

    // The container recycled: the pty stream ends on its own, with clients
    // still attached. Silence here is the whole bug — a terminal that will
    // never print again and never says so.
    pty.end();

    await vi.waitFor(() => {
      expect(a.closed).toHaveLength(1);
      expect(b.closed).toHaveLength(1);
    });
    expect(a.closed[0].code).toBe(1011);
    expect(a.closed[0].reason).toBe("pty ended");
    expect(b.closed[0].code).toBe(1011);
  });

  it("a pty that FAILS recovers the same way as one that ends", async () => {
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const a = openClient(await handleStudio(terminalReq(), testEnv));

    pty.fail(new Error("pty socket error"));

    await vi.waitFor(() => expect(a.closed).toHaveLength(1));
    expect(a.closed[0].code).toBe(1011);
  });

  it("a NEW attacher after the pty died gets a fresh pty, not the corpse", async () => {
    authorized();
    const dead = fakePty();
    const fresh = fakePty();
    const ptys = [dead, fresh];
    const attach = vi.fn(async () => ptys.shift()!.handle);
    const { testEnv } = envWithFakeStudio(attach);

    const a = openClient(await handleStudio(terminalReq(), testEnv));
    dead.end();
    await vi.waitFor(() => expect(a.closed).toHaveLength(1));

    // Without clearing the settled promise, ensurePty would hand this
    // connection the dead handle and answer 101 onto it.
    const res = await handleStudio(terminalReq(), testEnv);
    expect(res.status).toBe(101);
    expect(attach).toHaveBeenCalledTimes(2);

    const b = openClient(res);
    fresh.emit(new Uint8Array([42]));
    await vi.waitFor(() => expect(flatten(b.binary)).toEqual([42]));
  });

  it("the last client leaving does not fire the 1011 teardown at its own socket", async () => {
    // pty.close() ends the stream too, so the pump unwinds either way — but
    // that is a deliberate detach, not a death, and must not be reported as
    // one to a socket that is already gone.
    authorized();
    const pty = fakePty();
    const { testEnv } = envWithFakeStudio(async () => pty.handle);
    const only = openClient(await handleStudio(terminalReq(), testEnv));

    only.ws.close();
    await vi.waitFor(() => expect(pty.closes()).toBe(1));

    pty.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(only.closed.every((c) => c.code !== 1011)).toBe(true);
  });
});

// Issue #48. The trigger is close(): when the LAST client leaves it calls
// forgetPty() SYNCHRONOUSLY and only then asks the pty to close, which is
// asynchronous (sandbox-api's pty.close() is `ws.close(1000, "studio
// detached")` — the container socket's close event, and therefore the end of
// the readable stream, lands later). The pump that owns that pty is still
// parked in `await reader.read()` for the whole of that window. A client
// attaching inside the window finds `this.pty === null`, gets a SECOND pty
// and a second pump, and the first pump is still fanning its chunks into
// `this.host.getWebSockets()` — the same socket set the new client is now in.
// Two pty streams, one socket: the operator sees them interleaved character
// by character.
//
// fakePty models that window exactly: its close() records the call without
// ending the stream, which is what a real pty socket does until its close
// actually round-trips.
describe("a superseded pty must not reach any client (issue #48)", () => {
  it("output from the pty of a departed client never reaches the client on the new pty", async () => {
    authorized();
    const first = fakePty();
    const second = fakePty();
    const ptys = [first, second];
    const attach = vi.fn(async () => ptys.shift()!.handle);
    const { testEnv } = envWithFakeStudio(attach);

    const a = openClient(await handleStudio(terminalReq(), testEnv));
    a.ws.close();
    await vi.waitFor(() => expect(first.closes()).toBe(1));

    const b = openClient(await handleStudio(terminalReq(), testEnv));
    expect(attach).toHaveBeenCalledTimes(2);

    // pty#1's stream has NOT ended yet, so pump#1 is still live and still
    // reading. These are the bytes that corrupt the operator's screen.
    first.emit(new Uint8Array([0xde, 0xad]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.binary).toHaveLength(0);

    // The live pty still reaches the client, unchanged — the guard must drop
    // the superseded stream, not the terminal.
    second.emit(new Uint8Array([2]));
    await vi.waitFor(() => expect(flatten(b.binary)).toEqual([2]));
  });

  it("the superseded pump cancels its reader, releasing the old pty's socket", async () => {
    // Dropping the chunk alone would leave pump#1 parked on a reader forever
    // for any superseded pty nobody closes, and that reader holds the
    // container socket — the exact "pins the DO resident and billed" leak
    // close()'s own comment is written to avoid. Cancelling is what actually
    // lets go: sandbox-api's stream closes the pty socket from cancel().
    authorized();
    const first = fakePty();
    const second = fakePty();
    const ptys = [first, second];
    const { testEnv } = envWithFakeStudio(async () => ptys.shift()!.handle);

    const a = openClient(await handleStudio(terminalReq(), testEnv));
    a.ws.close();
    await vi.waitFor(() => expect(first.closes()).toBe(1));
    openClient(await handleStudio(terminalReq(), testEnv));

    first.emit(new Uint8Array([0xde, 0xad]));

    await vi.waitFor(() => expect(first.cancelled()).toBe(true));
  });
});

// Issue #48, point 3. `this.pty ??= ...` stores the promise, not the handle,
// so a REJECTED attempt is cached exactly like a successful one — and a
// settled rejection replays forever, it is never retried. attach() clears it
// in its own catch, but message() awaits ensurePty() with no catch at all, so
// a failure reached through that path leaves the rejection cached with
// nothing to clear it.
describe("a failed pty attempt must not be cached (issue #48)", () => {
  const upgradeReq = () =>
    new Request("https://studio/ws/terminal", { headers: { Upgrade: "websocket" } });

  it("a rejected attempt is retried on the next frame, not replayed from cache", async () => {
    const attach = vi.fn(async () => {
      throw new Error("container unavailable");
    });
    const bridge = new TerminalBridge(attach);
    const frame = new Uint8Array([97]).buffer;

    await expect(bridge.message({} as WebSocket, frame)).rejects.toThrow("container unavailable");
    await expect(bridge.message({} as WebSocket, frame)).rejects.toThrow("container unavailable");

    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("a failure reached through message() does not make the next upgrade refuse", async () => {
    // This is the operator-visible half: `1002 Expected 101 status code` on a
    // brand-new socket against a container that is running and healthy,
    // because the upgrade replayed a rejection cached by an earlier frame.
    const pty = fakePty();
    let calls = 0;
    const attach = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("container unavailable");
      return pty.handle;
    });
    const bridge = new TerminalBridge(attach);

    await expect(bridge.message({} as WebSocket, new Uint8Array([97]).buffer)).rejects.toThrow();

    const res = await bridge.attach(upgradeReq());

    expect(res.status).toBe(101);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("a failed attach must not forget the healthy pty another client is already on", async () => {
    // attach()'s own TOCTOU comment says the SUCCESS path must not call
    // forgetPty(), because `this.live` may by then be a different, healthy pty
    // other clients are attached to and clearing it would tear that down. The
    // FAILURE path did exactly that, unconditionally. Staged here in the order
    // that makes it reachable: a slow attempt that is superseded before it
    // finally rejects.
    const healthy = fakePty();
    let rejectFirst!: (err: Error) => void;
    let calls = 0;
    const attach = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Promise<PtyHandle>((_resolve, reject) => (rejectFirst = reject));
      return healthy.handle;
    });
    const bridge = new TerminalBridge(attach);

    // Attempt #1 is in flight and will not settle for a while.
    const slow = bridge.attach(upgradeReq());
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));

    // A socket from the previous pty generation finishes closing. It is the
    // last one, so close() forgets the in-flight attempt #1.
    const stale = fakeViewer().ws;
    bridge.adopt(stale); // it was a viewer of the previous generation
    bridge.close(stale);

    // A second client attaches and gets a healthy pty, which becomes live.
    expect((await bridge.attach(upgradeReq())).status).toBe(101);
    expect(attach).toHaveBeenCalledTimes(2);

    // Only NOW does attempt #1 fail. It must answer 503 and step aside.
    rejectFirst(new Error("container unavailable"));
    expect((await slow).status).toBe(503);

    // The healthy pty is still the bridge's: the attached client's input
    // reaches it, and no third pty is opened underneath it.
    await bridge.message({} as WebSocket, new Uint8Array([97]).buffer);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(flatten(healthy.writes)).toEqual([97]);
  });
});

describe("WS_BUFFER_MAX backpressure", () => {
  // WS_BUFFER_MAX's real behavior coverage: the test below offers three
  // hardcoded 524_288-byte (512KB) chunks — two of which exactly fill the
  // real 1_048_576-byte cap — and proves the oldest is dropped once that
  // real cap is crossed. A drift in the constant's own value would change
  // whether/which chunk gets dropped, breaking this test.
  it("drops the OLDEST queued output for a backpressured socket, never the newest", async () => {
    // A real Worker WebSocket has no bufferedAmount at all, so backpressure
    // can only be staged through a socket that reports one. Faked at exactly
    // the port the bridge uses — send sink, plus a bufferedAmount this test
    // drives. Everything else (bridge, pty, pump, fan-out) is real.
    const pty = fakePty();
    const sent: Uint8Array[] = [];
    let buffered = WS_BUFFER_MAX + 1;
    let reads = 0;
    const slow = fakeViewer({
      send: (bytes) => sent.push(new Uint8Array(bytes)),
      bufferedAmount: () => {
        reads += 1;
        return buffered;
      },
    }).ws;

    const bridge = new TerminalBridge(async () => pty.handle);
    bridge.adopt(slow);
    await bridge.message(slow, JSON.stringify({ t: "resize", cols: 100, rows: 30 }));

    // Backpressured: nothing may be sent, and the backlog may not grow past
    // the cap. 3 x 512KB = 1.5MB offered, so the oldest must be dropped.
    // `reads` is what proves the pump has actually consumed all three before
    // the pressure is released — asserting on `sent` alone would pass while
    // the chunks were still in the stream.
    const chunk = (fill: number) => new Uint8Array(524_288).fill(fill);
    pty.emit(chunk(1));
    pty.emit(chunk(2));
    pty.emit(chunk(3));
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    expect(sent).toHaveLength(0);

    // Drain: the survivors are the NEWEST two, in order.
    buffered = 0;
    pty.emit(new Uint8Array([4]));

    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.map((c) => c[0])).toEqual([2, 3, 4]);
    expect(sent.map((c) => c.byteLength)).toEqual([524_288, 524_288, 1]);
  });
});

describe("sbAttachPty adapter", () => {
  /** Stands in for the container end of the pty socket the SDK's own
   *  proxyTerminal opens. */
  function fakeSandboxPtyHost() {
    const pair = new WebSocketPair();
    const container = pair[0];
    const seen: Request[] = [];
    const createSession = vi.fn(async () => ({ id: STUDIO_SESSION_ID }));
    const host = {
      createSession,
      fetch: async (req: Request) => {
        seen.push(req);
        return new Response(null, { status: 101, webSocket: pair[1] });
      },
    };

    const binary: Uint8Array[] = [];
    const text: string[] = [];
    container.binaryType = "arraybuffer";
    container.accept();
    container.addEventListener("message", (event) => {
      if (typeof event.data === "string") text.push(event.data);
      else binary.push(new Uint8Array(event.data as ArrayBuffer));
    });
    // pair[1] is the end sbAttachPty accepts and listens on — the one whose
    // error event the adapter has to map.
    return { host, container, ptySocket: pair[1], seen, binary, text, createSession };
  }

  it("creates the shared studio session and requests the pty with the given size", async () => {
    const sb = fakeSandboxPtyHost();

    await sbAttachPty(sb.host, { cols: 100, rows: 30 });

    expect(sb.createSession).toHaveBeenCalledWith({ id: STUDIO_SESSION_ID });
    expect(sb.seen).toHaveLength(1);
    const url = new URL(sb.seen[0].url);
    expect(url.searchParams.get("sessionId")).toBe(STUDIO_SESSION_ID);
    expect(url.searchParams.get("cols")).toBe("100");
    expect(url.searchParams.get("rows")).toBe("30");
    expect(sb.seen[0].headers.get("Upgrade")?.toLowerCase()).toBe("websocket");
  });

  it("asks the container to run the tmux-attaching shell, so an attach needs no typing", async () => {
    // The spec's terminal is "you land in the shared tmux session". Without
    // this the container falls back to its own `?? "bash"` default and every
    // consumer (CLI, xterm page, phone) has to type `tmux attach -t studio`
    // by hand. Asserted on the query param proxyTerminal actually builds, so
    // a rename of PtyOptions.shell cannot pass silently.
    const sb = fakeSandboxPtyHost();

    await sbAttachPty(sb.host, { cols: 80, rows: 24 });

    // The literal, not the import — ties the test to the real query param.
    expect(new URL(sb.seen[0].url).searchParams.get("shell")).toBe("/opt/fleet/studio-shell.sh");
  });

  it("survives a duplicate-session error — the upgrade is the real health check", async () => {
    const sb = fakeSandboxPtyHost();
    sb.createSession.mockRejectedValueOnce(new Error("session 'studio' already exists"));

    const pty = await sbAttachPty(sb.host, { cols: 80, rows: 24 });

    expect(pty).toBeDefined();
    expect(sb.seen).toHaveLength(1);
  });

  it("write sends terminal bytes as a binary frame", async () => {
    const sb = fakeSandboxPtyHost();
    const pty = await sbAttachPty(sb.host, { cols: 80, rows: 24 });

    pty.write(new Uint8Array([108, 115, 13]));

    await vi.waitFor(() => expect(sb.binary).toHaveLength(1));
    expect([...sb.binary[0]]).toEqual([108, 115, 13]);
  });

  it("resize speaks the container's own {type:'resize'} control format, not the browser frame", async () => {
    const sb = fakeSandboxPtyHost();
    const pty = await sbAttachPty(sb.host, { cols: 80, rows: 24 });

    pty.resize(132, 43);

    await vi.waitFor(() => expect(sb.text).toHaveLength(1));
    expect(JSON.parse(sb.text[0])).toEqual({ type: "resize", cols: 132, rows: 43 });
  });

  it("container output surfaces on readable; container control text does not", async () => {
    const sb = fakeSandboxPtyHost();
    const pty = await sbAttachPty(sb.host, { cols: 80, rows: 24 });
    const reader = pty.readable.getReader();

    sb.container.send(JSON.stringify({ type: "ready" }));
    sb.container.send(new Uint8Array([120, 121]));

    const first = await reader.read();
    expect([...(first.value ?? [])]).toEqual([120, 121]);
    reader.releaseLock();
  });

  it("closing the container socket ends the readable stream cleanly", async () => {
    const sb = fakeSandboxPtyHost();
    const pty = await sbAttachPty(sb.host, { cols: 80, rows: 24 });
    const reader = pty.readable.getReader();

    sb.container.close();

    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it("a socket ERROR errors the stream instead — a crashed pty is not an EOF", async () => {
    // Both end the pump, but only one is worth alerting on, and reporting a
    // failure as a clean exit hides it completely.
    const sb = fakeSandboxPtyHost();
    const pty = await sbAttachPty(sb.host, { cols: 80, rows: 24 });
    const reader = pty.readable.getReader();

    sb.ptySocket.dispatchEvent(new Event("error"));

    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
  });

  it("throws when the upgrade does not produce a websocket", async () => {
    const host = {
      createSession: vi.fn(async () => ({ id: STUDIO_SESSION_ID })),
      fetch: async () => new Response("no container", { status: 502 }),
    };

    await expect(sbAttachPty(host, { cols: 80, rows: 24 })).rejects.toThrow(/502/);
  });
});
