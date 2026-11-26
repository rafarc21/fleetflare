// Model pool for non-Claude studio leads (spec 2026-10-13-model-pool-design).
// Per account, per model rate limits on Workers AI: each model adds its own budget.

import { GLM_MAX_MAX_TOKENS, GLM_MIN_MAX_TOKENS, KIMI_MAX_MAX_TOKENS } from "./translate";

export type ModelState = "active" | "overflow" | "demoted";

export interface PoolModel {
  key: "glm" | "kimi" | "deepseek";
  id: string;
  /** Floor on max_tokens sent upstream; reasoning models burn budget first (translate.ts GLM_MIN_MAX_TOKENS). */
  minMaxTokens: number;
  /** Ceiling on max_tokens sent upstream (incident #717): a reasoning
   *  model's `reasoning_content` can push TOTAL output past Claude Code's
   *  own hard 64k output-token limit even when the client's own request
   *  asked for far less — this never lets the floor-adjusted max_tokens
   *  exceed it (translate.ts anthropicRequestToOpenAI). */
  maxMaxTokens: number;
  /** True only after scripts/model-smoke.ts passed against live Workers AI. */
  smokePassed: boolean;
  /** Issue #1073: this model writes reasoning inside `<think>` tags in its
   *  message content, and sometimes a tool call inside them. Only then does
   *  the stream translator parse think regions (translate.ts thinkTags). */
  thinkTags?: boolean;
}

export const POOL: readonly PoolModel[] = [
  { key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: GLM_MIN_MAX_TOKENS, maxMaxTokens: GLM_MAX_MAX_TOKENS, smokePassed: true },
  // Issue #1476 round 3: maestro re-ran a corrected, live, cache-skipped
  // model-smoke 3x against the real catalog — 3/3 PASS, reasoning in
  // `reasoning` (not `reasoning_content`), 0 `<think>` in content, tool
  // calls OK, max_tokens honored (first run 59.1s cold, see PR body for the
  // full per-run probe-ms table). The #717 output-ceiling risk flagged in
  // round 2 (catalog's `supports_max_tokens:false`) did not reproduce live.
  { key: "kimi", id: "@cf/qwen/qwen3.8-27b", minMaxTokens: GLM_MIN_MAX_TOKENS, maxMaxTokens: KIMI_MAX_MAX_TOKENS, smokePassed: true },
  // Issue #1476 round 3: same live, cache-skipped model-smoke, 3/3 PASS —
  // reasoning in `reasoning_content` (+ `reasoning` in stream), 0 `<think>`,
  // tool calls OK, max_tokens honored. See PR body for the full table.
  { key: "deepseek", id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", minMaxTokens: GLM_MIN_MAX_TOKENS, maxMaxTokens: GLM_MAX_MAX_TOKENS, smokePassed: true },
];

export function modelByKey(key: string): PoolModel | undefined {
  return POOL.find((m) => m.key === key);
}

export function modelById(id: string): PoolModel | undefined {
  return POOL.find((m) => m.id === id);
}

/** Issue #1476 round 2: a retired Workers AI id that was PREVIOUSLY a live
 *  id for a pool key, keyed to that key — lets a stale D1 pin follow its
 *  key through a catalog repoint instead of silently going unresolvable. */
const RETIRED_TO_KEY: Readonly<Record<string, PoolModel["key"]>> = {
  "@cf/moonshotai/kimi-k2.7-code": "kimi",
  "@cf/deepseek-ai/deepseek-v4-pro-0813": "deepseek",
};

/** A stored id that no longer resolves (`modelById` miss) but WAS a
 *  previous live id for a pool key resolves to that key's CURRENT id —
 *  `fleet spawn --lead deepseek` stays on the deepseek key across a
 *  catalog repoint. A truly unknown id (typo, never-pool-member) still
 *  returns null. */
export function resolveStaleId(id: string): string | null {
  if (modelById(id)) return id;
  const key = RETIRED_TO_KEY[id];
  return key !== undefined ? modelByKey(key)!.id : null;
}
