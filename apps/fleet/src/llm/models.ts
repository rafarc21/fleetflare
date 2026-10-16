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
}

export const POOL: readonly PoolModel[] = [
  { key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: GLM_MIN_MAX_TOKENS, maxMaxTokens: GLM_MAX_MAX_TOKENS, smokePassed: true },
  { key: "kimi", id: "@cf/moonshotai/kimi-k2.7-code", minMaxTokens: GLM_MIN_MAX_TOKENS, maxMaxTokens: KIMI_MAX_MAX_TOKENS, smokePassed: true },
  { key: "deepseek", id: "@cf/deepseek-ai/deepseek-v4-pro-0813", minMaxTokens: GLM_MIN_MAX_TOKENS, maxMaxTokens: GLM_MAX_MAX_TOKENS, smokePassed: true },
];

export function modelByKey(key: string): PoolModel | undefined {
  return POOL.find((m) => m.key === key);
}

export function modelById(id: string): PoolModel | undefined {
  return POOL.find((m) => m.id === id);
}
