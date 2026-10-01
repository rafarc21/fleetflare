#!/usr/bin/env bun
/**
 * Board issue #161: a deterministic, path-based classifier that overrides
 * an agent's own self-graded reversibility judgment on a PR (see "Executing
 * actions with care" in studio lead system prompts — leads already
 * self-assess whether an action is reversible/irreversible before taking
 * it; this adds a hard, path-based override on top, for CI, so that
 * judgment is never the only thing standing between a PR and a forced
 * one-way-door path).
 *
 * The issue body names the dangerous classes in plain English
 * ("secrets/config", "leak gate", "write proxy", migrations, deploy,
 * rescue) — none of those are literal paths in this repo. `ONE_WAY_GLOBS`
 * below is the resolution against the real tree (see
 * docs/superpowers/plans/2026-10-01-merge-danger-161.md for the mapping
 * written out table-by-table); this file is the authoritative source if
 * the two ever drift apart.
 *
 * Deliberately small, same philosophy as scripts/english-check.ts: a noisy
 * check gets disabled, which is worse than no check. `classify` is pure
 * and the only thing under test directly — no subprocess in the unit
 * tests (test/bun/merge-danger.test.ts).
 *
 * Run by its own workflow (.github/workflows/one-way-door.yml), or by hand
 * with a newline-separated list of changed paths on stdin:
 *   git diff --name-only main HEAD | bun run scripts/merge-danger.ts
 */

export interface OneWayGlob {
  pattern: string;
  why: string;
}

export const ONE_WAY_GLOBS: OneWayGlob[] = [
  {
    pattern: "apps/fleet/container/**",
    why: "container image build; replaces running studio containers on deploy",
  },
  {
    pattern: "apps/fleet/migrations/**",
    why: "D1 schema migrations; irreversible once applied --remote",
  },
  {
    pattern: "apps/fleet/src/studio/rescue.ts",
    why: "rescue-push: the last line of defense against losing uncommitted work",
  },
  {
    pattern: "apps/fleet/src/studio/destroy.ts",
    why: "studio teardown",
  },
  {
    pattern: "apps/fleet/src/studio/failover.ts",
    why: "account failover logic",
  },
  {
    pattern: "apps/fleet/src/studio/provision.ts",
    why: "studio provisioning",
  },
  {
    pattern: "apps/fleet/src/studio/accounts.ts",
    why: "account lifecycle/credentials",
  },
  {
    pattern: "apps/fleet/src/leak-gate.ts",
    why: "the leak gate itself; a bug here silently stops catching secrets",
  },
  {
    pattern: "apps/fleet/src/write-proxy/**",
    why: "mediates every push / gh write a studio makes",
  },
  {
    pattern: "apps/fleet/scripts/deploy*",
    why: "deploy.sh, deploy-target.ts, deploy-containers-changed.ts",
  },
  {
    pattern: "apps/fleet/wrangler*.jsonc",
    why: "Worker/container/D1 config",
  },
  {
    pattern: "apps/fleet/.dev.vars*",
    why: "secrets shape; no literal secrets/ dir exists in this repo",
  },
];

/** True when `pattern` has no glob metacharacters — matched by exact equality. */
function isLiteral(pattern: string): boolean {
  return !/[*?[\]{}]/.test(pattern);
}

function matches(pattern: string, path: string): boolean {
  if (isLiteral(pattern)) return pattern === path;
  return new Bun.Glob(pattern).match(path);
}

export interface Classification {
  oneWay: boolean;
  matched: string[];
}

/**
 * Pure. `oneWay` is true iff any entry in `changedFiles` matches any glob in
 * `ONE_WAY_GLOBS`. `matched` lists every matching CHANGED FILE (not the glob
 * pattern), de-duplicated, in the order they first appear in `changedFiles`.
 */
export function classify(changedFiles: string[]): Classification {
  const matched: string[] = [];
  for (const path of changedFiles) {
    if (matched.includes(path)) continue;
    if (ONE_WAY_GLOBS.some((g) => matches(g.pattern, path))) matched.push(path);
  }
  return { oneWay: matched.length > 0, matched };
}

if (import.meta.main) {
  const input = await Bun.stdin.text();
  const changedFiles = input.split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(JSON.stringify(classify(changedFiles)));
  process.exit(0);
}
