// Issue #1147 (review round 2): the real-disconnect fixture for
// test/bun/llm-disconnect-workerd.test.ts. Runs the REAL pumpAnthropicStream
// under `wrangler dev` (workerd). The upstream sends one chunk, then nothing
// (the GLM shape: a long generation sends no bytes after its first ones), so a
// dropped client is only noticed through a write, i.e. a keepalive ping.
//   /stream   streaming reply: a drop must end the pump as client_abort
//   /collect  non-streaming shape: the pump runs before any Response is returned
//   /state    what the pump reported per request id, and upstream cancel count
// Query: `ping=<ms>` keepalive interval (0 = off), `id=<tag>` for the state row.
import { pumpAnthropicStream } from "../../src/llm/anthropic-route";

const frame = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`;
const TEXT = frame({ choices: [{ delta: { content: "partial" } }] });

type Row = { route: string; id: string; ok: boolean; failure?: string };
const state = { results: [] as Row[], cancels: 0 };

/** One text chunk, then silence forever. */
function stalledUpstream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(enc.encode(TEXT)); return; }
      await new Promise<void>(() => {});
    },
    cancel() { state.cancels += 1; },
  });
}

export default {
  async fetch(req: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/state") return Response.json(state);
    const route = url.pathname.slice(1);
    const id = url.searchParams.get("id") ?? "";
    const pingMs = Number(url.searchParams.get("ping") ?? 0) || 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const pump = pumpAnthropicStream(stalledUpstream(), writer, "msg_fixture", "glm-5.3", 1_000_000, 60_000, undefined, { pingMs, signal: req.signal })
      .then((r) => { state.results.push({ route, id, ok: r.ok, failure: r.failure }); })
      .finally(() => { writer.close().catch(() => {}); });
    if (route === "stream") {
      ctx.waitUntil(pump);
      return new Response(readable, { headers: { "content-type": "text/event-stream" } });
    }
    if (route === "collect") {
      const sse = new Response(readable).text();
      await pump;
      await sse;
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
