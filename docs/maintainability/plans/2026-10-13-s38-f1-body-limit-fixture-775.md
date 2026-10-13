# Plan — S38-F1 board.brief body-limit fixture sits AT the limit (#775, refs #741)

Finding: test/board.brief.test.ts:60 "refuses a body over GitHub's
own issue body limit, naming the limit" builds its fixture at exactly
TASK_BODY_MAX ("x".repeat(TASK_BODY_MAX)). The refusal fires only
after renderTaskBody adds its section headers and footer — template
overhead the test never chose. The sibling title test at :53 has the
intended one-over shape (TASK_TITLE_MAX + 1).

## Steps

1. Branch fix-775-s38-f1-body-limit-fixture off origin/main (ccf9642).
2. RED mutation proof: point the body check at the raw objective
   (body_ = brief.objective in parseBrief) — the :60 test fails with
   the old fixture, proving it depended on renderTaskBody's overhead.
   Revert the mutation.
3. GREEN: fixture "x".repeat(TASK_BODY_MAX + 1), same one-over shape
   as the title test. Test name unchanged — fixture now matches it.
4. Verify (one gate at a time): touched vitest suite, english-check,
   merge-danger (two-way expected), diff stat = plan doc + 1-line test
   change.
5. Commit, push, PR closing #775.

## Verification

- vitest run test/board.brief.test.ts — exit 0, all pass
- RED evidence: same run under mutation fails only the :60 test
- bun run scripts/english-check.ts — exit 0
- bun apps/fleet/scripts/merge-danger.ts — exit 0, oneWay false
- git diff origin/main...HEAD --stat — 2 files, 1-line test change
