// apps/fleet/test/bun/fixtures/model-smoke-fetch-spy.ts — #1476 round 4, R6.
// Loaded via `bun --preload <this file> scripts/model-smoke.ts <key>`
// (model-smoke-wiring.test.ts's "present id" / "absent id" wiring tests),
// strictly BEFORE scripts/model-smoke.ts's own module body ever runs — a
// bun `--preload` runs to completion first, so `globalThis.fetch` is already
// this file's stub by the time model-smoke.ts's `smokeCall`/`main` resolve
// the bare `fetch` identifier (its own default-parameter value) for the
// first time. The real network is never reached, online or offline: this
// replaces `fetch` outright rather than intercepting an outbound call that
// already left the process.
//
// Round 3's wiring test (R2) only ever drove the "absent id" refusal path —
// a present id fell through to a REAL live gateway.ai.cloudflare.com fetch
// with a fake token, distinguished only by the live gateway happening to
// answer 401 (asserted by proxy: `stderr` not containing "HTTP "). That
// never actually observed what the script's own 3 live-shaped calls (tool
// call, multi-turn, stream) sent — not their URLs, not their
// cf-aig-skip-cache header, not whether there were 3 of them or zero. Two
// named mutants survived as a result (see model-smoke-wiring.test.ts's own
// comment above the wiring describe block): deleting the retired-exit
// `process.exit(1); return;` (nothing distinguishes "refused, stopped" from
// "refused, kept going" once outbound network is blocked — both just never
// reach a real server) and dropping the header off the stream call site
// specifically (no test ever read a header off the THIRD request `main()`
// sends).
//
// This spy logs one JSON line per request — `{url, skip, stream}` — to the
// file named by FETCH_SPY_LOG, then answers with a canned OpenAI-chat-
// completions-shape response keyed on the body shape model-smoke.ts's own
// three calls actually send (see scripts/model-smoke.ts's `main`): stream
// request first (checked first — the stream request's translated body also
// has exactly 1 message, same as the first tool-call request, so checking
// `stream` before message count is what tells them apart), then the
// multi-turn request (translated body carries >1 message: the original user
// turn plus the assistant tool_use plus the tool_result), then the first
// tool-call request as the default.
import { appendFileSync } from "node:fs";

const LOG = process.env.FETCH_SPY_LOG;
if (!LOG) {
  throw new Error("model-smoke-fetch-spy: FETCH_SPY_LOG env var required");
}

// Mirrors scripts/model-smoke.ts's own exported AI_GATEWAY_SKIP_CACHE_HEADER
// constant — duplicated as a literal rather than imported so this spy has no
// dependency on the module it is preloaded ahead of (it must finish loading,
// header constant and all, before that module is even parsed).
const AI_GATEWAY_SKIP_CACHE_HEADER = "cf-aig-skip-cache";

const STREAM_BODY = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {
    // Malformed/absent body — logged as an empty object rather than thrown;
    // a test asserting on the logged shape sees that directly instead of a
    // spy crash masking the real assertion failure.
  }
  appendFileSync(
    LOG,
    `${JSON.stringify({
      url: String(input),
      skip: headers.get(AI_GATEWAY_SKIP_CACHE_HEADER),
      stream: body.stream === true,
    })}\n`,
  );

  if (body.stream === true) {
    return new Response(STREAM_BODY, { status: 200 });
  }
  if (Array.isArray(body.messages) && body.messages.length > 1) {
    return Response.json({ choices: [{ message: { content: "18C sunny" }, finish_reason: "stop" }], usage: {} });
  }
  return Response.json({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {},
  });
}) as typeof fetch;
