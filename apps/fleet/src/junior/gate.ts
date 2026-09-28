// apps/fleet/src/junior/gate.ts
//
// Deliberately does NOT `import type { Env } from "../env"` — CI review
// (PR #9, GitHub Actions "check"): env.ts (and, through it, agents/do.ts,
// deploy/do.ts, studio/do.ts) is only ever meant to be reached from the ROOT
// tsconfig's project (workers-types in scope). This file is imported by
// src/studio/provision.ts, which cli/tsconfig.json's "**/*.ts" reaches
// transitively from cli/fleet.ts — a Bun project whose "types": ["bun"]
// carries no workers-types. Pulling `Env` in here (even as a type-only
// import — TS still adds the file to the project graph) previously dragged
// env.ts and every DO file it type-imports into the cli/container/test-
// integration projects, where D1Database/DurableObjectNamespace/R2Bucket
// etc. don't resolve, breaking `bun run check`'s -p cli/-p container/-p
// test-integration steps with cascades of TS2339/TS2304 having nothing to do
// with this feature. The two fields this function actually reads are named
// here directly instead, matching Env's own field types exactly (see
// env.ts's FLEET_JUNIOR/JUNIOR_REPOS) so every real caller (route.ts's Env,
// do.ts's this.env, test fixtures) is still structurally assignable with no
// cast.
import { parseInstallCacheRepos } from "../studio/install-cache";

/** Measured 2026-09-28 replay eval: the only two models that scored >= 2.9/3
 *  with zero harmful edits. Anything else is refused at the Worker. */
export const JUNIOR_MODELS: readonly string[] = ["@cf/zai-org/glm-5.3", "@cf/deepseek-ai/deepseek-v4-pro-0813"];

export interface JuniorGateEnv { FLEET_JUNIOR?: string; JUNIOR_REPOS?: string }

export function juniorEnabled(
  env: JuniorGateEnv, workRepoSlug: string | undefined,
): boolean {
  if (env.FLEET_JUNIOR !== "on") return false;
  // Same flat "owner/repo" list grammar as INSTALL_CACHE_REPOS.
  const list = parseInstallCacheRepos(env.JUNIOR_REPOS);
  if (list.length === 0) return true;
  return workRepoSlug !== undefined && list.includes(workRepoSlug.toLowerCase());
}

export const JUNIOR_HOUSE_RULE = [
  "## House rules — junior",
  "",
  "The `junior` skill is installed: `~/.claude/skills/junior/junior.sh` sends",
  "a mechanical task to a Workers AI model and returns a diff. You may use it",
  "ONLY while your current task carries the `junior` label — the maestro's",
  "call, made when it filed the task. No label: do the work yourself and never",
  "ask for one. When allowed, use it for boilerplate, scaffolds, renames,",
  "docstrings, log summaries. You are the senior: read every hunk, apply it",
  "yourself, run the tests. You own every line that lands. It goes through the",
  "fleet Worker; no Cloudflare credential exists in this container and none is",
  "needed.",
].join("\n");
