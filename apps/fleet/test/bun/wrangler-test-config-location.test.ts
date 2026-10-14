import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Board issue #769: `@cloudflare/vitest-pool-workers` feeds the ambient test
 * env from `.dev.vars`, resolved against the DIRECTORY OF THE WRANGLER CONFIG
 * FILE it is pointed at (wrangler's getVarsForDev → loadDotDevDotVars —
 * `path.resolve(path.dirname(configPath), ".dev.vars")`, unconditional when no
 * envFiles are forwarded, which the pool never does). With
 * `wrangler.test.jsonc` at `apps/fleet/`, the lookup hits
 * `apps/fleet/.dev.vars` — exactly where the operator's untracked secrets sit
 * in every studio container (written by test-integration/harness.ts and by
 * `wrangler dev` convention) — and every key in it leaks into the ambient test
 * env. The operator measured 7 failing github.webhook-core tests in a real
 * studio container (issue #769); re-measured in this branch's own repro, the
 * misconfigured-secret 503 test fails deterministically and the count tests
 * fail on the same leaked keys depending on the leaked file's exact shape.
 *
 * The fix moves the config to `apps/fleet/test/wrangler.test.jsonc`, so the
 * lookup targets `test/.dev.vars`, a path nothing ever writes. THIS test pins
 * that structural fact, the same source-pin posture the repo already uses for
 * files no test can import (see vitest.config.ts's own header comments): a
 * future move of the config back to `apps/fleet/` silently reintroduces the
 * ambient-env leak for every secret name an operator ever puts in `.dev.vars`,
 * and that regression must fail a test, not just a studio's full-suite run.
 *
 * Bun test, not vitest-pool-workers: it reads the repo's real files as text,
 * which workerd has no filesystem to do — same reason test/bun/ exists at all
 * (see test/tsconfig.json's own header).
 */
describe("wrangler.test.jsonc location — outside the .dev.vars lookup directory (#769)", () => {
  const ROOT = join(import.meta.dir, "..", ".."); // apps/fleet
  const vitestConfigSrc = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");

  test("vitest.config.ts points the pool at ./test/wrangler.test.jsonc, not the app root", () => {
    // The pool's configPath decides the .dev.vars lookup dir. It must name
    // the test/ copy. Literal string pin, not a glob, so whitespace or
    // formatting changes cannot silently re-point it.
    expect(vitestConfigSrc).toContain('wrangler: { configPath: "./test/wrangler.test.jsonc" }');
  });

  test("no wrangler config remains at the app root, where .dev.vars lives", () => {
    // The move itself. apps/fleet/.dev.vars is the file the lookup would
    // load; a config left beside it re-opens the leak for every future key.
    expect(existsSync(join(ROOT, "wrangler.test.jsonc"))).toBe(false);
  });

  test("the moved config exists under test/", () => {
    expect(existsSync(join(ROOT, "test", "wrangler.test.jsonc"))).toBe(true);
  });
});
