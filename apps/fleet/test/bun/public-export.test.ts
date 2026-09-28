// apps/fleet/test/bun/public-export.test.ts
//
// Issue #335 (review round 3): scripts/test/public-export.test.sh is a
// plain bash suite for scripts/public-export.sh -- nothing wired it into
// automation before this, so a regression there could ship undetected.
// bun's own test runner only picks up .test.ts/.test.js files, never a raw
// .sh script, so this is a thin wrapper: shells out to the REAL suite (no
// re-implementation, no duplicated assertions) and fails loudly with its
// full output if anything in there fails. Lives under test/bun/ (not
// test/) specifically so it runs as part of this repo's existing
// `bun run bun-test` lane (package.json's own glob already covers this
// directory) rather than needing a new CI entry point of its own.
//
// scripts/public-export.sh and its own test suite both operate on the
// WHOLE repo tree (git archive of a ref), not just apps/fleet/ -- so this
// wrapper's cwd is set to the repo ROOT, not apps/fleet/ (unlike most other
// tests in this directory).
import { test, expect } from "bun:test";
import { join } from "node:path";
import { requireTools } from "./require-tool";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const SUITE = join(REPO_ROOT, "scripts/test/public-export.test.sh");

// gitleaks: needed by every real invocation of public-export.sh (its own
// secret-scan section) — requireTools() skips gracefully on an arbitrary
// dev machine or this studio's own sandboxed container, and fails loudly
// only inside the pinned localci image (scripts/localci/Dockerfile, which
// this PR also adds a pinned gitleaks install to), matching issue #356's
// own established "never a quiet skip on the one image that must guarantee
// this" pattern.
const LANE = requireTools("gitleaks", "public-export.sh's own gitleaks secret scan");

LANE("scripts/public-export.sh — the real bash suite, run for real", () => {
  test("bash scripts/test/public-export.test.sh exits 0, every test group passes", () => {
    const r = Bun.spawnSync({ cmd: ["bash", SUITE], cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString() + r.stderr.toString();
    // The suite's own final line names how many test GROUPS ran, not raw
    // assertion count -- matching that (rather than a hardcoded number)
    // means this wrapper never needs editing when the real suite grows.
    expect(out).toMatch(/all \d+ test group\(s\) passed/);
    if (r.exitCode !== 0) {
      console.error(out);
    }
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
