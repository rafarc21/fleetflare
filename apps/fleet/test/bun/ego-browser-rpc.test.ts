import { describe, expect, test } from "bun:test";
import {
  createRpcClient,
  encodeMessage,
  isRpcFailure,
  MessageFramer,
  serveRpc,
  type RpcRequest,
  type RpcResponse,
  type RpcTransport,
} from "../../container/ego-browser/rpc";

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

interface PairEnd {
  dataCbs: Array<(chunk: string) => void>;
  closeCbs: Array<(err?: Error) => void>;
  transport: RpcTransport;
}

/**
 * In-memory stand-in for the real unix socket. A write on one end delivers
 * the string chunk synchronously to the other end's onData callbacks; a
 * close on either end drops all further delivery both ways and fires the
 * peer end's onClose callbacks.
 */
function makeSocketPair(opts?: { fragmentClientWrites?: boolean }) {
  function makeEnd(): PairEnd {
    const dataCbs: Array<(chunk: string) => void> = [];
    const closeCbs: Array<(err?: Error) => void> = [];
    return {
      dataCbs,
      closeCbs,
      transport: {
        // Wired below, once both ends exist: one end's write must reach the
        // OTHER end, which makeEnd can't know on its own.
        write(_data: string): void {},
        onData(cb: (chunk: string) => void): void {
          dataCbs.push(cb);
        },
        onClose(cb: (err?: Error) => void): void {
          closeCbs.push(cb);
        },
      },
    };
  }

  const clientEnd = makeEnd();
  const serverEnd = makeEnd();
  let clientOpen = true;
  let serverOpen = true;

  function deliver(to: PairEnd, data: string): void {
    for (const cb of to.dataCbs) cb(data);
  }

  clientEnd.transport.write = (data: string) => {
    if (!clientOpen || !serverOpen) return; // a close on either end kills delivery both ways
    if (opts?.fragmentClientWrites) {
      // Deliver each write as two chunks split mid-message -- a real socket
      // can split a large request across two data callbacks the same way.
      const splitAt = Math.max(1, Math.floor(data.length / 2));
      deliver(serverEnd, data.slice(0, splitAt));
      deliver(serverEnd, data.slice(splitAt));
    } else {
      deliver(serverEnd, data);
    }
  };
  serverEnd.transport.write = (data: string) => {
    if (!clientOpen || !serverOpen) return;
    deliver(clientEnd, data);
  };

  return {
    clientTransport: clientEnd.transport,
    serverTransport: serverEnd.transport,
    /** The client process exits: the server end sees its onClose fire. */
    closeClient() {
      clientOpen = false;
      for (const cb of serverEnd.closeCbs) cb();
    },
    /** The daemon hangs up: the client end sees its onClose fire. */
    closeServer() {
      serverOpen = false;
      for (const cb of clientEnd.closeCbs) cb();
    },
  };
}

/**
 * Taps the wire with its own framer, seeing the same chunks serveRpc does,
 * so tests can answer with the REAL request ids instead of trusting
 * hard-coded numbering.
 */
function tapRequests(transport: RpcTransport): RpcRequest[] {
  const requests: RpcRequest[] = [];
  const framer = new MessageFramer<RpcRequest>();
  transport.onData((chunk) => {
    for (const req of framer.push(chunk)) requests.push(req);
  });
  return requests;
}

describe("createRpcClient + serveRpc over an in-memory pair", () => {
  test("responses arriving out of order resolve to their own requests", async () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);
    const requests = tapRequests(pair.serverTransport);
    serveRpc(pair.serverTransport, {
      // Never settles, so serveRpc never writes a response -- the test
      // writes them by hand below to control the ORDER they arrive in.
      slowAdd(_params: unknown): unknown {
        return new Promise(() => {});
      },
    });

    const p1 = client.call("slowAdd", { n: 1 });
    const p2 = client.call("slowAdd", { n: 2 });
    expect(requests.length).toBe(2);

    // Answer in REVERSE order -- a correct client correlates by id, never
    // by arrival order.
    const [first, second] = requests;
    pair.serverTransport.write(encodeMessage({ id: second.id, result: "r2" }));
    pair.serverTransport.write(encodeMessage({ id: first.id, result: "r1" }));

    expect(await Promise.all([p1, p2])).toEqual(["r1", "r2"]);
  });

  test("a call with no response rejects on its own timeout and ignores the late response", async () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);
    const requests = tapRequests(pair.serverTransport);
    serveRpc(pair.serverTransport, {
      hang(_params: unknown): unknown {
        return new Promise(() => {}); // never responds -- only the client's timer can settle this
      },
      late(_params: unknown): unknown {
        return "still works";
      },
    });

    await expect(client.call("hang", undefined, 30)).rejects.toThrow(
      'ego-browser: RPC call "hang" timed out after 30ms',
    );

    // A late response for the timed-out id must be dropped silently: no
    // throw, no unhandled rejection, and the client still works afterwards.
    pair.serverTransport.write(encodeMessage({ id: requests[0]!.id, result: "too late" }));
    await new Promise((r) => setTimeout(r, 5));

    const second = client.call("late", undefined, 1000);
    await expect(second).resolves.toBe("still works");
  });

  test("socket close rejects every pending call with the daemon-closed message", async () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);
    serveRpc(pair.serverTransport, {
      stall(_params: unknown): unknown {
        return new Promise(() => {}); // never responds -- only the close below can settle these
      },
    });

    const calls = [
      client.call("stall", { n: 1 }),
      client.call("stall", { n: 2 }),
      client.call("stall", { n: 3 }),
    ];
    pair.closeServer();

    await Promise.all(
      calls.map((c) => expect(c).rejects.toThrow("ego-browser: daemon connection closed")),
    );
  });

  test("socket close fires the client's onClosed callbacks exactly once", () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);

    let a = 0;
    let b = 0;
    client.onClosed(() => {
      a += 1;
    });
    client.onClosed(() => {
      b += 1;
    });
    pair.closeServer();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("unknown method rejects with the exact unknown-method message", async () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);
    serveRpc(pair.serverTransport, {}); // no handlers -- every method is unknown

    await expect(client.call("nope")).rejects.toThrow('ego-browser: unknown RPC method "nope"');
  });

  test("a handler that throws rejects the call with the handler's own message", async () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);
    serveRpc(pair.serverTransport, {
      boom(_params: unknown): unknown {
        throw new Error("boom");
      },
    });

    await expect(client.call("boom")).rejects.toThrow("boom");
  });

  test("a response split across two chunk deliveries resolves once complete", async () => {
    const pair = makeSocketPair();
    const client = createRpcClient(pair.clientTransport);
    const requests = tapRequests(pair.serverTransport);
    serveRpc(pair.serverTransport, {
      slow(_params: unknown): unknown {
        return new Promise(() => {}); // never settles -- the test writes the response itself
      },
    });

    const pending = client.call("slow", { n: 1 });
    // Split the response mid-message: the first half has no newline, so the
    // client must hold it until the second half completes the line.
    const response = encodeMessage({ id: requests[0]!.id, result: "split-response" });
    const splitAt = Math.floor(response.length / 2);
    pair.serverTransport.write(response.slice(0, splitAt));
    pair.serverTransport.write(response.slice(splitAt));
    await expect(pending).resolves.toBe("split-response");
  });

  test("a request split across two chunk deliveries reaches the handler once complete", async () => {
    const pair = makeSocketPair({ fragmentClientWrites: true });
    const client = createRpcClient(pair.clientTransport);
    const seen: Array<{ params: unknown }> = [];
    serveRpc(pair.serverTransport, {
      echo(params: { n: number }): unknown {
        seen.push({ params });
        return params.n;
      },
    });

    const pending = client.call("echo", { n: 42 });
    await expect(pending).resolves.toBe(42);
    // Exactly one dispatch, with the full params -- never one per chunk.
    expect(seen).toEqual([{ params: { n: 42 } }]);
  });
});
