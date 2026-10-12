# Dead Type-Alias Deletion Implementation Plan (#469)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete three dead type aliases (`ExecClass`, `JuniorRateLimitResult`, `LeadRateLimitResult`) that have zero references beyond their own definition lines, plus the two import specifiers each orphan leaves behind.

**Architecture:** Compile-time-only deletion, no runtime change. One bounded task, TDD-shaped as "RED = grep proves a reference exists that must not; GREEN = grep returns zero after deletion, typecheck and the three named test files pass." The two `*RateLimitResult` aliases are one-line re-exports of the shared `RateLimitResult`; deleting them orphans the `type RateLimitResult` import specifier in each of the two files, so the import line is trimmed too — leaving an unused import would create fresh dead code, the exact class this sweep removes.

**Tech Stack:** TypeScript on Cloudflare Workers (apps/fleet), vitest with @cloudflare/vitest-pool-workers, tsc via `bun run check` (five tsconfig passes: root, container, cli, test-integration, test).

**Spec:** https://github.com/rafarc21/fleetflare/issues/469 — parent sweep #428 (finding F2, §F3), doc docs/maintainability/2026-10-12-dead-code-sweep-9.md §F2, §F3. Tier GLM-OK.

## Global Constraints

- Delete exactly three alias definition lines + the two orphaned `type RateLimitResult` import specifiers; nothing else changes.
- Keep `EXEC_CLASSES` (src/studio/sandbox-api.ts:158) — live, asserted by test/cli.destroy-outcome.test.ts:166 via the DESTROY_CLIENT_TIMEOUT_MS budget check.
- Keep the `*RateLimitEnv` aliases (`JuniorRateLimitEnv` src/junior/ratelimit.ts:28, `LeadRateLimitEnv` src/llm/ratelimit.ts:36) — they are the generic constraints of their own `makeRateLimitKind<...>` factories (junior :35, lead :43).
- Keep the `RateLimitResult` import in any file where it stays live; it is only orphaned in these two files because the alias line was its only use.
- No behavioral change: compile-time-only deletions, no runtime code path changes.
- Repo language: English only (commit messages, docs, PR body, code comments).
- Heavy gates one at a time; this plan's verification runs `bun run check` once and the three named vitest files once.

## Current state — verified facts

All facts below were verified by grep on branch head 31f0ab3 before this plan was written:

- Repo-wide grep for `ExecClass|JuniorRateLimitResult|LeadRateLimitResult` over apps/fleet (src, cli, test, test-integration, scripts, container) returns EXACTLY three hits, the three definition lines themselves:
  - `apps/fleet/src/studio/sandbox-api.ts:171` — `export type ExecClass = keyof typeof EXEC_CLASSES;`
  - `apps/fleet/src/junior/ratelimit.ts:33` — `export type JuniorRateLimitResult = RateLimitResult;`
  - `apps/fleet/src/llm/ratelimit.ts:41` — `export type LeadRateLimitResult = RateLimitResult;`
- In `src/junior/ratelimit.ts`, `RateLimitResult` appears on exactly two lines: the import at :20 (`import { makeRateLimitKind, type RateLimitResult } from "../ratelimit";`) and the alias at :33. Deleting the alias orphans the import specifier.
- In `src/llm/ratelimit.ts`, same shape: import at :16, alias at :41.
- `src/studio/sandbox-api.ts` does not import anything named `RateLimitResult`; deleting `ExecClass` (line 171) orphans no import.
- The three named test files import only live exports:
  - test/cli.destroy-outcome.test.ts:7 imports `EXEC_CLASSES` (kept), uses it at :166.
  - test/junior.ratelimit.test.ts:8-12 imports `checkAndConsumeJuniorRateLimit`, `DEFAULT_JUNIOR_DAILY_CAP`, `DEFAULT_JUNIOR_RATE_PER_MINUTE`.
  - test/llm.ratelimit.test.ts:10-15 imports `checkAndConsumeLeadRateLimit`, `checkAndConsumeLeadCountTokensRateLimit`, `DEFAULT_LEAD_COUNT_TOKENS_RATE_PER_MINUTE`, `DEFAULT_LEAD_DAILY_CAP`, `DEFAULT_LEAD_RATE_PER_MINUTE`.
- Neither route names `RateLimitResult`: zero hits in src/junior/route.ts and src/llm/anthropic-route.ts.
- `bun run check` passes on the current tree (exit 0) — baseline is green.
- No ONE_WAY_GLOBS path in apps/fleet/scripts/merge-danger.ts matches the three touched files; this diff is two-way by both the classifier and judgment.

---

### Task 1: Delete the three dead aliases (+ the two orphaned import specifiers)

**Files:**
- Modify: `apps/fleet/src/studio/sandbox-api.ts` (delete line 171)
- Modify: `apps/fleet/src/junior/ratelimit.ts` (delete lines 20→rewritten, 33)
- Modify: `apps/fleet/src/llm/ratelimit.ts` (delete lines 16→rewritten, 41)
- Test (existing, unchanged): `apps/fleet/test/cli.destroy-outcome.test.ts`, `apps/fleet/test/junior.ratelimit.test.ts`, `apps/fleet/test/llm.ratelimit.test.ts`

**Interfaces:**
- Consumes: nothing — pure deletion.
- Produces: the same live exports as before (`EXEC_CLASSES`, `checkAndConsumeJuniorRateLimit`, `checkAndConsumeLeadRateLimit`, `checkAndConsumeLeadCountTokensRateLimit`, defaults, `*RateLimitEnv`). No new names.

- [ ] **Step 1: Create the work branch**

```bash
git checkout -b fix-469-delete-dead-type-aliases origin/main
```

- [ ] **Step 2: RED — prove the dead names still resolve today**

Run:
```bash
grep -rn "ExecClass\|JuniorRateLimitResult\|LeadRateLimitResult" apps/fleet --include="*.ts" | grep -v node_modules
```
Expected: exactly 3 lines, the three definitions listed above. This is the RED state: the names still exist. (No test file can fail on a name nobody references, so the failing-state proof here is the grep itself — it shows what must go to zero.)

- [ 2a. If any hit other than the three definition lines appears — a reference this sweep missed — STOP: post a comment on https://github.com/rafarc21/fleetflare/issues/469 with the grep output and do not delete that name.]

- [ ] **Step 3: Delete `ExecClass` (src/studio/sandbox-api.ts:171)**

Delete exactly this line:
```ts
export type ExecClass = keyof typeof EXEC_CLASSES;
```
The line sits between `} as const satisfies Record<string, SbExecOptions>;` (line 170) and `export class ExecDeadlineError extends Error {` (line 172). Deleting it leaves a single blank line between the `satisfies` statement and the class; keep it that way (the file already separates top-level blocks with one blank line).

- [ ] **Step 4: Delete `JuniorRateLimitResult` + orphaned import specifier (src/junior/ratelimit.ts)**

Delete line 33 and its trailing blank line:
```ts
export type JuniorRateLimitResult = RateLimitResult;
```
Then rewrite line 20 from:
```ts
import { makeRateLimitKind, type RateLimitResult } from "../ratelimit";
```
to:
```ts
import { makeRateLimitKind } from "../ratelimit";
```

- [ ] **Step 5: Delete `LeadRateLimitResult` + orphaned import specifier (src/llm/ratelimit.ts)**

Delete line 41 and its trailing blank line:
```ts
export type LeadRateLimitResult = RateLimitResult;
```
Then rewrite line 16 from:
```ts
import { makeRateLimitKind, type RateLimitResult } from "../ratelimit";
```
to:
```ts
import { makeRateLimitKind } from "../ratelimit";
```

- [ ] **Step 6: GREEN — grep proves zero references**

Run:
```bash
grep -rn "ExecClass\|JuniorRateLimitResult\|LeadRateLimitResult" apps/fleet --include="*.ts" | grep -v node_modules
```
Expected: NO output, exit 1 (zero hits). Any hit = deletion incomplete or a reference appeared mid-flight — resolve before continuing.

- [ ] **Step 7: GREEN — typecheck (heavy gate: run alone)**

Run alone, nothing else in parallel:
```bash
cd apps/fleet && bun run check
```
Expected: exit 0. This runs `tsc --noEmit` five times (root, container, cli, test-integration, test) and is the one heavy gate this task pays. If it fails, the failure output names the file and symbol — fix or revert before continuing.

- [ ] **Step 8: GREEN — the three named test files**

Run:
```bash
cd apps/fleet && npx vitest run test/cli.destroy-outcome.test.ts test/junior.ratelimit.test.ts test/llm.ratelimit.test.ts
```
Expected: 3 test files pass, exit 0. These are the files the issue names as the tests whose modules were touched (they import `EXEC_CLASSES` and the two rate-limit wrappers).

- [ ] **Step 9: Commit + push**

```bash
git add apps/fleet/src/studio/sandbox-api.ts apps/fleet/src/junior/ratelimit.ts apps/fleet/src/llm/ratelimit.ts
git commit -m "refactor(fleet): delete dead type aliases ExecClass + Junior/LeadRateLimitResult (closes #469)

Zero references beyond their own definition lines (sweep 9 F2, §F3 — #428).
Deleting the two *RateLimitResult re-exports orphans the type RateLimitResult
import specifier in each file, so both import lines are trimmed too; leaving
them would create fresh dead code, the class this sweep removes.

Compile-time-only: no runtime code path changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
LEFTHOOK=0 git push -u origin fix-469-delete-dead-type-aliases
```

## Self-review checklist (run after implementation, before review dispatch)

- [ ] Spec coverage: all three aliases from the issue deleted; `EXEC_CLASSES` and both `*RateLimitEnv` kept; import specifiers trimmed only where orphaned.
- [ ] `git diff origin/main --stat` shows exactly 3 files, ~5 lines total, all deletions/rewrites as specified.
- [ ] Grep zero-hits evidence captured verbatim for the completion record.
- [ ] `bun run check` output tail captured for the completion record.
- [ ] Vitest 3-file output tail captured for the completion record.

## Verification evidence for the completion record

The completion record `/workspace/.fleet/done/469.json` needs, with real output tails:
1. grep after deletion (zero hits, exit 1)
2. `cd apps/fleet && bun run check` (exit 0)
3. `cd apps/fleet && npx vitest run test/cli.destroy-outcome.test.ts test/junior.ratelimit.test.ts test/llm.ratelimit.test.ts` (exit 0)

---
