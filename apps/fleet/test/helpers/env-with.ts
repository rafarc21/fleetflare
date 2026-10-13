import { env } from "cloudflare:test";
import type { Env } from "../../src/env";

// Sweep 33 F15: every suite that needs an AGENT_REPO-bound env spells the
// same spread-plus-cast — one helper keeps the cast in one place.
export function repoEnv(repo: string, extra: Record<string, unknown> = {}): Env {
  return { ...env, AGENT_REPO: repo, ...extra } as unknown as Env;
}
