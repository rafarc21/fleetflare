# Plan — sweep 38: misleading test names, apps/fleet test (#741)

Doc-only sweep at origin/main 0cd438f. Scope: apps/fleet/test/ + apps/fleet/test/bun/
(364 test files). Zero code changes; src/ and container/ untouched.

## Steps

1. Branch sweep-741-test-names-vs-assertions off origin/main (done).
2. Hunt it()/test() titles claiming behavior the body never asserts:
   "refuses/throws/rejects" with no refusal assertion, "returns X" asserting
   only truthy, "when Y" with no Y in the body, negated-claim titles over
   positive-only assertions. Machine pass (grep title verbs, read bodies) +
   hand-read suspects. Cross-check each with grep for the claimed behavior.
3. Triage: max 15 findings. Titles in auth/secrets/tokens/credentials/rescue/
   failover/accounts-routing/deploy/migrations/write-proxy/leak-gate/approvals
   → CLAUDE-ONLY lane, else GLM-OK.
4. Write docs/maintainability/2026-10-13-test-names-vs-assertions-sweep-38.md:
   method, findings table (file:line, title, actually-asserted, proposed rename
   or missing assertion), ruled-out section.
5. Commit both docs, push branch (LEFTHOOK=0 git push).
6. File one issue per batch: `test(GLM-OK): S38-Fn <short>` (CLAUDE-ONLY title
   for sensitive-lane findings), refs #741, no closing keywords.
7. Open doc-only PR referencing #741. No CI polling; review cap 30m.

## Verification

- Doc-only diff: `git diff origin/main --stat` = plan + sweep doc only.
- Every file:line ref re-checked against tree before commit.
- `cd apps/fleet && bun run scripts/english-check.ts` exit 0.
