# S45-F6 plan — llm.anthropic-route.test.ts split (refs #907, refs #919)

Pure move: split apps/fleet/test/llm.anthropic-route.test.ts (1759
lines, 10 describes, 93 runtime-pass tests, 292 expect() calls) into
llm.anthropic-core.test.ts + llm.anthropic-stream.test.ts, per sweep-45
F6 (docs/maintainability/2026-10-15-oversized-tests-sweep-45.md).
Titles verbatim, describes moved whole, no new tests, no assertion
edits, no helper extraction (split hazard 2: split first, dedup later).

## Baseline (measured on origin/main aa934e3)

cd apps/fleet && npx vitest run test/llm.anthropic-route.test.ts
→ 93 passed (93), 5.37s.

## Seams (current line numbers)

- llm.anthropic-core.test.ts ← old :1-386: file header comment (trimmed
  to its own coverage), imports, ME/row/ctx/usageRows/FAST_RETRY/setup/
  good/callRoute/req helpers + beforeEach (both halves re-seed their own
  beforeEach — hazard 4), describes: gates (:107), spend controls MAJOR 2
  (:172), non-streaming round trip (:319). 26 it(), 56 expect().
- llm.anthropic-stream.test.ts ← old :386-1759: same shared preamble
  copied (setup/good/req/callRoute/usageRows/FAST_RETRY — stream half
  uses all of them), describes: streaming (:386), idle timeout #302
  (:755), pre-stream retry #335 (:1009), runAiWithRetry (:1156),
  countTokens #284 4(b) (:1195), model pool + gateway (:1345), #767
  backoff (:1618). 67 it(), 236 expect().
- Core-only imports: ANTHROPIC_MESSAGES_PATH, ANTHROPIC_BODY_CAP,
  handleFleetAnthropicMessages; stream half keeps everything
  (countTokens, POOL/PoolModel, setAssignedModel, GLM_LEAD_MODEL,
  GLM_MIN_MAX_TOKENS all used there; core uses GLM_LEAD_MODEL too —
  import pruning per half by what compiles).
- No vi.mock/mock.module anywhere in this file (hazard 3 moot).

## Steps

1. This plan doc, committed first.
2. RED-ish guard for a pure move: create both new files, move all 10
   describes per seams, DELETE old file, run
   `npx vitest run test/llm.anthropic-core.test.ts test/llm.anthropic-stream.test.ts`
   from apps/fleet — incomplete move fails on unresolved names.
3. GREEN: sums hold — 93 passed, 292 expect() calls total (26+67, 56+236).
4. Verify (one heavy gate at a time): vitest run of the two files;
   `bun run check` alone; `bun run english-check`; `bun run
   test-lies-check`. All exit 0.
5. Update stale doc references (comment-only):
   apps/fleet/docs/plans/2026-10-15-d1-locked-helper-883.md:279/:705
   cite the OLD file name with line numbers — the helper move already
   landed; do not rewrite history, leave that doc. Only in-code comments
   updated if they name the old file (grep after the move).
6. Push, open PR.

## Guard rails (violations = rework)

- Titles verbatim; comments attached to a describe/test move WITH it.
- Sums: 93 passed / 292 expect() must hold.
- Old file DELETED from disk, not left empty.
- No helper extraction, no fixture files, no test renames.
- Commit messages English, conventional, "refs #919" (never closes).
- Push: LEFTHOOK=0 git push origin fix-919-anthropic-route-split.
