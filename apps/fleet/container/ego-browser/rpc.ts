/**
 * Newline-delimited JSON-RPC framing shared by the ego-browser daemon
 * (daemon.ts) and client (client.ts). One JSON object per line:
 * `{id, method, params}` requests, `{id, result}` or `{id, error}`
 * responses. Framing only -- no transport assumptions baked in, so the
 * exact same MessageFramer instance works whether fed from a Bun.listen
 * `data` handler (real unix socket) or a hand-fed string in a test.
 *
 * createRpcClient and serveRpc own the two halves of the protocol on top
 * of that framing: id correlation, per-call timeout, and fail-all-pending-
 * on-close on the client side; decode, dispatch, and error responses on
 * the server side. Both are transport-agnostic -- they take an
 * RpcTransport (write + callback slots) instead of a Bun socket, so the
 * same code runs over the real unix socket or an in-memory test pair.
 */

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcSuccess {
  id: number;
  result: unknown;
}

export interface RpcFailure {
  id: number;
  error: { message: string };
}

export type RpcResponse = RpcSuccess | RpcFailure;

export function isRpcFailure(res: RpcResponse): res is RpcFailure {
  return "error" in res;
}

export function encodeMessage(msg: RpcRequest | RpcResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Incremental line-splitter. Feed it raw chunks of text as they arrive; it
 * returns zero or more complete, parsed messages per chunk and buffers any
 * trailing partial line for the next push(). A message split across two
 * separate `data` callbacks (real possibility for a large payload -- a big
 * pages() list or a long snapshot() string) is never parsed early: it
 * waits for its newline regardless of how many pushes that takes.
 */
export class MessageFramer<T> {
  private buffer = "";

  push(chunk: string): T[] {
    this.buffer += chunk;
    const messages: T[] = [];
    let newlineAt = this.buffer.indexOf("\n");
    while (newlineAt !== -1) {
      const line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      if (line.length > 0) {
        messages.push(JSON.parse(line) as T);
      }
      newlineAt = this.buffer.indexOf("\n");
    }
    return messages;
  }
}

/** The transport half of a socket: write raw text out, receive chunks and
 * close/error events back through callbacks. The client/daemon adapters
 * construct this around their Bun socket; tests use an in-memory pair. */
export interface RpcTransport {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: (err?: Error) => void): void;
}

/** A connected client's call surface: fire requests, learn when the
 * connection died. */
export interface RpcClient {
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onClosed(cb: () => void): void;
}

const DEFAULT_CALL_TIMEOUT_MS = 60000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Rejects every still-pending call and fires the close callbacks once.
 * Used both for a clean socket close and a socket error (err set): either
 * way no response can ever arrive, so every waiter must hear about it and
 * nobody may register a call afterwards that would silently hang. */
function failAllPending(pending: Map<number, PendingCall>, err: Error, closedCbs: Array<() => void>): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
  for (const cb of closedCbs) cb();
}

/**
 * The client half of the protocol. Ids start at 1 and increment per call;
 * responses are matched back by id, never by arrival order, so any number
 * of calls can be in flight concurrently. On a per-call timeout the call
 * rejects and forgets its id -- a response arriving later for it is
 * ignored, since nobody is waiting anymore.
 */
export function createRpcClient(transport: RpcTransport): RpcClient {
  const framer = new MessageFramer<RpcResponse>();
  const pending = new Map<number, PendingCall>();
  const closedCbs: Array<() => void> = [];
  let nextId = 1;

  transport.onData((chunk) => {
    for (const msg of framer.push(chunk)) {
      const entry = pending.get(msg.id);
      if (!entry) continue; // late response for an already-settled call
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (isRpcFailure(msg)) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
  });

  transport.onClose((err?) => {
    failAllPending(pending, err ?? new Error("ego-browser: daemon connection closed"), closedCbs);
  });

  return {
    call(method: string, params?: unknown, timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ego-browser: RPC call "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        transport.write(encodeMessage({ id, method, params }));
      });
    },
    onClosed(cb: () => void): void {
      closedCbs.push(cb);
    },
  };
}

/**
 * The server half of the protocol. Decodes requests through its own
 * framer, dispatches each to `handlers[method]`, and always answers with
 * exactly one response per request: the handler's result (`null` when the
 * handler returned null/undefined -- the wire encodes null, not
 * undefined) or an error response carrying the handler's own message.
 * Unknown methods get the same error-response shape, so a client never
 * hangs on a typo'd method name.
 */
export function serveRpc(transport: RpcTransport, handlers: Record<string, (params: any) => unknown>): void {
  const framer = new MessageFramer<RpcRequest>();

  transport.onData((chunk) => {
    for (const req of framer.push(chunk)) {
      void (async () => {
        try {
          const handler = handlers[req.method];
          if (!handler) throw new Error(`ego-browser: unknown RPC method "${req.method}"`);
          const result = await handler(req.params);
          transport.write(encodeMessage({ id: req.id, result: result ?? null }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          transport.write(encodeMessage({ id: req.id, error: { message } }));
        }
      })();
    }
  });
}
