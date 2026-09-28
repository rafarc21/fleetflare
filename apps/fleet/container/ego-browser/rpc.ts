/**
 * Newline-delimited JSON-RPC framing shared by the ego-browser daemon
 * (daemon.ts) and client (client.ts). One JSON object per line:
 * `{id, method, params}` requests, `{id, result}` or `{id, error}`
 * responses. Framing only -- no transport assumptions baked in, so the
 * exact same MessageFramer instance works whether fed from a Bun.listen
 * `data` handler (real unix socket) or a hand-fed string in a test.
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
