# Plan — S37-F7 sweep-9 SessionFileStat cite drifted (#792, refs #740)

Finding (sweep 37, broken-doc-links): docs/maintainability/
2026-10-12-dead-code-sweep-9.md:95 cites `src/studio/burn.ts:1768`
`SessionFileStat`. PR #533 (039a851, merged 2026-10-12 11:54Z) split
burn.ts and moved the type to `src/studio/session-stats.ts:348`.
Cite correct at the doc pinned base c2cc15f (02:23Z) and at its
re-verify head 775b979 (04:07Z); #533 landed after both — drift,
not error. Verified on current main: grep puts SessionFileStat at
session-stats.ts:348, no hit in burn.ts.

## Steps

1. Branch fix-792-s37-f7-sweep9-cite-drift off origin/main (2a7f1f9).
2. Commit this plan; push.
3. :95 cite -> `src/studio/session-stats.ts:348` `SessionFileStat`
   (moved from burn.ts by #533). Header :5's "the only moved ref is
   F5's" claim is now stale too — extend it to name both moved refs
   (F5 read-repos.ts, F7 SessionFileStat) with their moves.
4. Verify (one gate at a time): english-check, merge-danger (two-way
   expected), diff stat = plan doc + 2-line doc edit.
5. Commit; push; PR closing #792; done/792.json (never committed).

## Verification

- bun run scripts/english-check.ts — exit 0
- bun apps/fleet/scripts/merge-danger.ts — exit 0, oneWay false
- git diff origin/main...HEAD --stat — 2 files, doc-only
- grep SessionFileStat session-stats.ts:348 at head (pre-edit proof)
