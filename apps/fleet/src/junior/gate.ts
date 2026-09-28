// apps/fleet/src/junior/gate.ts
import type { Env } from "../env";
import { parseInstallCacheRepos } from "../studio/install-cache";

/** Measured 2026-09-28 replay eval: the only two models that scored >= 2.9/3
 *  with zero harmful edits. Anything else is refused at the Worker. */
export const JUNIOR_MODELS: readonly string[] = ["@cf/zai-org/glm-5.3", "@cf/deepseek-ai/deepseek-v4-pro-0813"];

export function juniorEnabled(
  env: Pick<Env, "FLEET_JUNIOR" | "JUNIOR_REPOS">, workRepoSlug: string | undefined,
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
