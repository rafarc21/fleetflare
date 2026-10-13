// Model pool for non-Claude studio leads (spec 2026-10-13-model-pool-design).
// Per account, per model rate limits on Workers AI: each model adds its own budget.
export type ModelState = "active" | "overflow" | "demoted";

export interface PoolModel {
  key: "glm" | "kimi" | "deepseek";
  id: string;
  /** Floor on max_tokens sent upstream; reasoning models burn budget first (translate.ts GLM_MIN_MAX_TOKENS). */
  minMaxTokens: number;
  /** True only after scripts/model-smoke.ts passed against live Workers AI. */
  smokePassed: boolean;
}

export const POOL: readonly PoolModel[] = [
  { key: "glm", id: "@cf/zai-org/glm-5.3", minMaxTokens: 16000, smokePassed: true },
  { key: "kimi", id: "@cf/moonshotai/kimi-k2.7-code", minMaxTokens: 16000, smokePassed: true },
  { key: "deepseek", id: "@cf/deepseek-ai/deepseek-v4-pro-0813", minMaxTokens: 16000, smokePassed: true },
];

export function modelByKey(key: string): PoolModel | undefined {
  return POOL.find((m) => m.key === key);
}

export function modelById(id: string): PoolModel | undefined {
  return POOL.find((m) => m.id === id);
}
