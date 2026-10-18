// apps/fleet/test/bun/llm-translate-fixtures.test.ts
// Replays the raw upstream OpenAI-SSE fixtures under
// test/fixtures/llm-streams/ through translate.ts's real chunk pipeline
// (parseSseDataLine -> applyOpenAIStreamChunk -> closeStreamOrError). The
// fixtures are hand-built from the documented wire shapes pinned in
// translate.ts and llm-translate-stream.test.ts, NOT live-captured — see
// each fixture file's own `: ` header comment for why a studio container
// cannot record live upstream bytes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyOpenAIStreamChunk, closeStreamOrError, createStreamState, parseSseDataLine,
} from "../../src/llm/translate";

const FIXTURES = join(import.meta.dir, "../fixtures/llm-streams");

/** Splits a raw `event: X\ndata: Y\n\n` frame back into its two halves, the
 *  inverse of translate.ts's own sseEvent() — same helper as
 *  llm-translate-stream.test.ts. */
function parseFrame(frame: string): { event: string; data: unknown } {
  const m = /^event: (.+)\ndata: (.+)\n\n$/.exec(frame);
  if (!m) throw new Error(`not a well-formed SSE frame: ${JSON.stringify(frame)}`);
  return { event: m[1], data: JSON.parse(m[2]) };
}

/** Reads one fixture and replays every `data:` line through the stream
 *  translator: parseSseDataLine -> applyOpenAIStreamChunk per line, then
 *  closeStreamOrError once. `: ` header-comment lines parse to null and are
 *  skipped, same as a real blank-line-delimited SSE body. */
function replay(file: string, thinkTags: boolean) {
  const raw = readFileSync(join(FIXTURES, file), "utf8");
  const state = createStreamState({ thinkTags });
  const frames: string[] = [];
  for (const line of raw.split("\n")) {
    const parsed = parseSseDataLine(line);
    if (parsed === null || parsed === "DONE") continue;
    frames.push(...applyOpenAIStreamChunk(state, parsed));
  }
  const closed = closeStreamOrError(state, 64000);
  return { frames, closed };
}

/** Every visible text byte streamed so far, deltas joined in order. */
function texts(frames: string[]): string {
  return frames.map(parseFrame)
    .filter((f) => f.event === "content_block_delta")
    .map((f) => (f.data as { delta?: { text?: string } }).delta?.text ?? "")
    .join("");
}

describe("llm-stream fixtures (#1210)", () => {
  test("stray-closer.sse — kimi: a stray ` response` is dropped, turn ends clean", () => {
    const { frames, closed } = replay("stray-closer.sse", true);
    expect(closed.ok).toBe(true);
    expect(texts(frames)).toBe("Thinking complete. Here is the result.");
    expect(texts(frames)).not.toContain(" response");
    const delta = closed.frames.map(parseFrame).find((f) => f.event === "message_delta");
    expect((delta?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("end_turn");
  });

  test("in-think-tool-after-narration.sse — kimi: a tool call inside think after narration recovers", () => {
    const { frames, closed } = replay("in-think-tool-after-narration.sse", true);
    const start = frames.map(parseFrame).find((f) => f.event === "content_block_start"
      && (f.data as { content_block: { type: string } }).content_block.type === "tool_use");
    expect(start?.data).toMatchObject({ content_block: { type: "tool_use", name: "Read" } });
    expect(texts(frames)).toBe("Let me check that.");
    expect(closed.ok).toBe(true);
    const delta = closed.frames.map(parseFrame).find((f) => f.event === "message_delta");
    expect((delta?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("tool_use");
  });

  test("good-call-then-truncated.sse — kimi: a truncated sibling tool call is a retryable error", () => {
    const { closed } = replay("good-call-then-truncated.sse", true);
    expect(closed.ok).toBe(false);
    expect(closed.reason).toBe("think_tool_call_unrecovered");
    expect(closed.frames.map(parseFrame).some((f) => f.event === "error")).toBe(true);
    expect(closed.frames.some((f) => f.includes("message_stop"))).toBe(false);
  });

  test("deepseek-plain.sse — deepseek thinkTags OFF: literal ` thinking` text streams byte-identical", () => {
    const { frames, closed } = replay("deepseek-plain.sse", false);
    expect(texts(frames)).toBe("Note: ` thinking` is literal for this model. No parsing happens.");
    expect(closed.ok).toBe(true);
    const delta = closed.frames.map(parseFrame).find((f) => f.event === "message_delta");
    expect((delta?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("end_turn");
  });
});
