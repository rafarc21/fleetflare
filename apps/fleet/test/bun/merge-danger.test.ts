import { describe, expect, test } from "bun:test";
import { classify, ONE_WAY_GLOBS } from "../../scripts/merge-danger";

/**
 * Board issue #161 — a deterministic, path-based classifier that overrides
 * an agent's own self-graded reversibility judgment on a PR. `classify`
 * must flag `oneWay: true` whenever a changed file falls under ANY entry in
 * `ONE_WAY_GLOBS`, and list every matching CHANGED FILE (not the glob
 * pattern itself) in `matched`.
 *
 * `ONE_WAY_GLOBS` resolves the issue body's plain-English paths
 * ("secrets/config", "leak gate", "write proxy", ...) against the real
 * repo tree — see the doc comment above `ONE_WAY_GLOBS` in
 * `scripts/merge-danger.ts` for the resolution, and
 * `docs/superpowers/plans/2026-10-01-merge-danger-161.md` for the full
 * table. One test below per glob class, in the same order as the table.
 */
describe("classify — one glob class per forced one-way-door path", () => {
  test("apps/fleet/container/** — container image build", () => {
    const changed = ["apps/fleet/container/Dockerfile.studio"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/container/Dockerfile.studio"]);
  });

  test("apps/fleet/container/** — two levels deep (real path, ego-browser)", () => {
    const changed = ["apps/fleet/container/ego-browser/api.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/container/ego-browser/api.ts"]);
  });

  test("apps/fleet/migrations/** — D1 schema migrations", () => {
    const changed = ["apps/fleet/migrations/0003_add_column.sql"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/migrations/0003_add_column.sql"]);
  });

  test("apps/fleet/migrations/** — two levels deep (migrations is flat today; ** must still reach a nested subdir)", () => {
    const changed = ["apps/fleet/migrations/archive/0001_old.sql"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/migrations/archive/0001_old.sql"]);
  });

  test("apps/fleet/src/studio/rescue.ts — rescue-push", () => {
    const changed = ["apps/fleet/src/studio/rescue.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/rescue.ts"]);
  });

  test("apps/fleet/src/studio/destroy.ts — studio teardown", () => {
    const changed = ["apps/fleet/src/studio/destroy.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/destroy.ts"]);
  });

  test("apps/fleet/src/studio/failover.ts — account failover logic", () => {
    const changed = ["apps/fleet/src/studio/failover.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/failover.ts"]);
  });

  test("apps/fleet/src/studio/provision.ts — studio provisioning", () => {
    const changed = ["apps/fleet/src/studio/provision.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/provision.ts"]);
  });

  test("apps/fleet/src/studio/accounts.ts — account lifecycle/credentials", () => {
    const changed = ["apps/fleet/src/studio/accounts.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/accounts.ts"]);
  });

  test("apps/fleet/src/leak-gate.ts — the leak gate itself", () => {
    const changed = ["apps/fleet/src/leak-gate.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/leak-gate.ts"]);
  });

  test("apps/fleet/src/write-proxy/** — mediates every push/gh write", () => {
    const changed = ["apps/fleet/src/write-proxy/git-route.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/write-proxy/git-route.ts"]);
  });

  test("apps/fleet/src/write-proxy/** — two levels deep (write-proxy is flat today; ** must still reach a nested subdir)", () => {
    const changed = ["apps/fleet/src/write-proxy/git/auth.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/write-proxy/git/auth.ts"]);
  });

  test("apps/fleet/scripts/deploy* — deploy.sh, deploy-target.ts, deploy-containers-changed.ts", () => {
    for (const path of [
      "apps/fleet/scripts/deploy.sh",
      "apps/fleet/scripts/deploy-target.ts",
      "apps/fleet/scripts/deploy-containers-changed.ts",
    ]) {
      const result = classify([path]);
      expect(result.oneWay).toBe(true);
      expect(result.matched).toEqual([path]);
    }
  });

  test("apps/fleet/wrangler*.jsonc — Worker/container/D1 config", () => {
    const changed = ["apps/fleet/wrangler.example.jsonc"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/wrangler.example.jsonc"]);
  });

  test("apps/fleet/.dev.vars* — secrets shape", () => {
    const changed = ["apps/fleet/.dev.vars.example"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/.dev.vars.example"]);
  });

  // Board issue #160: 5 more forced one-way-door paths added on top of
  // #161's original 12.
  test("apps/fleet/src/studio/do.ts — the studio Durable Object", () => {
    const changed = ["apps/fleet/src/studio/do.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/do.ts"]);
  });

  test("apps/fleet/src/studio/wake.ts — wakes a studio's Claude Code session", () => {
    const changed = ["apps/fleet/src/studio/wake.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/wake.ts"]);
  });

  test("apps/fleet/src/studio/registry.ts — the studio registry", () => {
    const changed = ["apps/fleet/src/studio/registry.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/registry.ts"]);
  });

  test("apps/fleet/src/studio/profile.ts — studio account/profile assignment", () => {
    const changed = ["apps/fleet/src/studio/profile.ts"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/profile.ts"]);
  });

  test("gates/** — the hook scripts gating lead writes, completion, session recovery", () => {
    const changed = ["gates/lead-gate.sh"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["gates/lead-gate.sh"]);
  });

  test("gates/** — two levels deep (gates is flat today; ** must still reach a nested subdir)", () => {
    const changed = ["gates/sub/completion-gate.sh"];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["gates/sub/completion-gate.sh"]);
  });
});

describe("classify — two-way-door cases", () => {
  test("a docs-only PR is two-way", () => {
    const result = classify(["docs/operations.md", "README.md"]);
    expect(result.oneWay).toBe(false);
    expect(result.matched).toEqual([]);
  });

  test("an empty file list is two-way", () => {
    const result = classify([]);
    expect(result.oneWay).toBe(false);
    expect(result.matched).toEqual([]);
  });

  test("a mixed PR flags only the dangerous path(s), not the safe ones", () => {
    const changed = [
      "docs/operations.md",
      "apps/fleet/src/studio/rescue.ts",
      "README.md",
      "apps/fleet/test/bun/english-only.test.ts",
    ];
    const result = classify(changed);
    expect(result.oneWay).toBe(true);
    expect(result.matched).toEqual(["apps/fleet/src/studio/rescue.ts"]);
  });
});

describe("the glob table itself", () => {
  test("every entry carries a non-trivial reason", () => {
    for (const { pattern, why } of ONE_WAY_GLOBS) {
      expect(pattern.length).toBeGreaterThan(0);
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
