# Test micro-helper consolidation (#375) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deduplicate the `fixedNow`/`b64` micro-helpers into one vitest-lane helper file, and the same-shape bun-lane `sh()` copies into one bun-lane helper. Behavior-preserving moves only.

**Architecture:** Pure fixture extraction. New `apps/fleet/test/helpers/datetime.ts` exports `fixedNow` + `b64`; four vitest suites import them and delete local copies. New `apps/fleet/test/bun/helpers/shell.ts` exports `sh(cmd, opts)` covering the three same-shape bun copies; divergent shapes stay local per the sweep doc. No src/ change.

**Tech Stack:** vitest (workers-lane via `cloudflare:test`), bun test (bun lane), TypeScript.

**Spec:** docs/maintainability/2026-10-11-test-sweep-3.md section S3-F5; board issue #375.

## Global Constraints

- OUT of scope, never touch: `studio.destroy.test.ts`, `bun/rescue-push.test.ts`, `studio.backup-guard.test.ts` (chunked b64Large encoder stays local there and in `studio.session.test.ts`).
- Divergent `sh()` shapes stay local: `session-aside.test.ts` (runSnippet), `write-proxy-e2e.test.ts` (async array), `install-cache-security.test.ts` (Node spawnSync + maxBuffer comment).
- Behavior identical — moved code byte-for-byte, per-file env/cwd defaults become option defaults.
- Tests-only diff; no src/ or container/ changes.

## Task 1: vitest lane — datetime.ts + 4 migrations

**Files:** Create `test/helpers/datetime.ts`; modify `test/studio.readiness.test.ts:25`, `test/studio.transcript.test.ts:51,112`, `test/studio.session.test.ts:56,60`, `test/studio.burn.test.ts:718`.

datetime.ts content:
```ts
/** Test-lane shared micro-helpers — moved verbatim from the suites that
 *  duplicated them (sweep-3 S3-F5). fixedNow pins a deps.now; b64 encodes
 *  small byte arrays (large-input chunked encoders stay local per file). */
export function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

export function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}
```
Each suite: add `import { fixedNow } from "./helpers/datetime";` (session/transcript also import `b64`), delete the local `fixedNow` (and `b64` where migrated) definitions and their now-redundant local doc comments. Keep `b64Large` (session), `b64Utf8` (transcript), `status()`, `fakeStorage()` locals untouched.
- [ ] Write datetime.ts, migrate readiness + burn, run `cd apps/fleet && bun vitest run test/studio.readiness.test.ts test/studio.burn.test.ts` — PASS
- [ ] Migrate session + transcript (delete local fixedNow AND b64), run `bun vitest run test/studio.session.test.ts test/studio.transcript.test.ts` — PASS
- [ ] Commit `refactor(fleet): shared fixedNow/b64 test helpers (refs #359, closes #375)` — vitest half

## Task 2: bun lane — shell.ts + 3 migrations

**Files:** Create `test/bun/helpers/shell.ts`; modify `test/bun/memory-clone.test.ts:11`, `test/bun/memory-migrate.test.ts:11`, `test/bun/localci-run.test.ts:26`.

shell.ts content:
```ts
import { join } from "node:path";

export type ShResult = { code: number; out: string; err: string };

/** Bun-lane shared `sh()` — the three suites whose copies were
 *  byte-identical modulo defaults (sweep-3 S3-F5). Divergent shapes
 *  (runSnippet-based, async-array, Node spawnSync+maxBuffer) stay local. */
export function sh(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; git?: boolean; throwOnError?: boolean } = {},
): ShResult {
  const gitEnv = opts.git === false ? {} : {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const r = Bun.spawnSync({ cmd: ["bash", "-c", cmd], cwd: opts.cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...gitEnv, ...opts.env } });
  const res = { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  if (opts.throwOnError && res.code !== 0) throw new Error(`${cmd}: ${res.err}`);
  return res;
}
```
Per-file call-site changes (defaults preserved exactly):
- memory-clone: `import { sh } from "./helpers/shell";`, delete local fn. Every call gains `{ cwd: root }`? NO — instead keep a one-line local `function sh(cmd: string, env: Record<string, string> = {}) { return shShared(cmd, { cwd: root, env }); }`? NO — per plan: import as `shShared` not needed; simplest correct form: `import { sh as shShared } from "./helpers/shell";` then local `function sh(cmd: string, env: Record<string, string> = {}) { return shShared(cmd, { cwd: root, env }); }` — zero call-site edits, git env matches original.
- memory-migrate: same pattern, local `function sh(cmd: string, cwd = root) { return shShared(cmd, { cwd }); }` — zero call-site edits.
- localci-run: same pattern, local `function sh(cmd: string, cwd = repo) { const r = shShared(cmd, { cwd, env: { TMUX: "" }, throwOnError: true }); return r.out; }` — zero call-site edits (throw-on-error + stdout-only preserved).
- [ ] Write shell.ts, migrate all 3, run `cd apps/fleet && bun test test/bun/memory-clone.test.ts test/bun/memory-migrate.test.ts test/bun/localci-run.test.ts` — PASS
- [ ] Commit `refactor(fleet): shared bun-lane sh() helper (refs #359, closes #375)` — bun half

## Task 3: verification + record

- [ ] `cd apps/fleet && bun vitest run test/studio.readiness.test.ts test/studio.transcript.test.ts test/studio.session.test.ts test/studio.burn.test.ts` — PASS
- [ ] `cd apps/fleet && bun test test/bun/` — PASS (full bun lane; one gate, run alone)
- [ ] `cd apps/fleet && bun run check` — PASS (tsc, heavy gate, run ALONE, never alongside vitest/bun-test)
- [ ] Push branch; write completion record `/workspace/.fleet/done/375.json` per studio rules
