# S26-F15 webhook test split — github.webhook.test.ts (refs #702)

Pure move, zero src changes, zero assertion edits. Sibling precedent: PR 714 (S26-F6 orca split, merged pattern).

- before: `apps/fleet/test/github.webhook.test.ts` — 1797 lines, 8 describes, 67 it()
- after: `test/github.webhook-core.test.ts` — lines :165-894 → 7 describes, 48 it()
- after: `test/github.webhook-autoclose.test.ts` — lines :895-1797 → 1 describe, 19 it()  (auto-close promote + junior authz revoke, incl. the `:1732` issues-webhook describe)
- counts guard (maestro, issue #702 comment): it() per file before vs after, sum equal (48+19=67); expect() calls 122+73=195; no assertion text changed.

Seams per sweep-26 doc F15 (docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md):
1. Move describes whole, titles verbatim, `#NNN` provenance intact (hazard 5).
2. Shared harness (:11-163: SECRET, sign(), push(), wakes/wakeOutcome/getCalls/rpcCalls/onWake, envWithStudio(), fakeCtx(), lastCtx/post()/drainLast(), file-level beforeEach D1-clear + afterEach fetch restore) DUPLICATED in both files per hazard 2 — no helper extraction (sweep-18's lane, separate PR).
3. Autoclose half keeps its own nested beforeEach (:963) with the full GitHub API fake, githubCalls/issueState/etc. (moves with its cluster, hazard 3).
4. Both halves re-seed D1 independently via duplicated file-level beforeEach (hazard 4).
5. Imports trimmed per half (autoclose drops verifySignature; core may drop junior/authz + studio/types if unused) — verify with grep after split.
6. Comments at :1729-1731 (before the `:1732` describe) move verbatim with autoclose.

Verification (serial, one gate at a time): `bun vitest run test/github.webhook-core.test.ts test/github.webhook-autoclose.test.ts` (67 pass), `tsc --noEmit -p test`, `bun run scripts/english-check.ts`, `bun run scripts/test-lies-check.ts`.
