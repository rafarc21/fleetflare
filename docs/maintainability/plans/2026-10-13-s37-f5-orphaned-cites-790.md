# Plan — S37-F5 S26-split orphaned cites: annotate the two living-claim cites + note the two history docs (refs #790)

Issue: https://github.com/rafarc21/fleetflare/issues/790. Sweep 37 finding
S37-F5 (docs/maintainability/2026-10-13-broken-doc-links-sweep-37.md:69).
Two sweep docs cite S26-split/deleted test files as if living; the same
class appears in two history docs. Doc-only fix: keep every original
sentence, add dated annotations naming the PR that superseded each cite.
All facts verified against the tree and git history on 2026-10-13.

## Cite 1 — test-helpers-sweep-18:54 (living claim)

`docs/maintainability/2026-10-12-test-helpers-sweep-18.md:54` (F8) cites
`github.webhook.test.ts:15` as a living dedup observation. That file was
split by PR #720 (6fff51b, 2026-10-13) into `github.webhook-core.test.ts`
+ `github.webhook-autoclose.test.ts`. Separately, PR #824 (380e97d, refs
#733, refs #754) later created `test/helpers/webhook-sign.ts` with a
shared `sign(body, secret)`, and all three suites (public-flags,
webhook-core, webhook-autoclose) now import it — F8's copy pair no longer
exists in the tree.

Annotation: append to the end of line 54, after "recorded, no issue
filed.":

  (2026-10-13, #790: `github.webhook.test.ts` split by #720 into
  `github.webhook-core.test.ts` + `github.webhook-autoclose.test.ts`;
  both halves and `public-flags.test.ts` now share
  `helpers/webhook-sign.ts`'s `sign()` since #824.)

## Cite 2 — orphan-tests-sweep-23:30 (living claim)

`docs/maintainability/2026-10-12-orphan-tests-sweep-23.md:30` (S23-F1)
cites `test/bun/install-cache-security.test.ts` (MUTANT PROOF blocks,
~448-500, 539-543) as a living file. Split by PR #736 (0cd438f,
2026-10-13) into `install-cache-security-parse.test.ts` +
`install-cache-security-disk.test.ts`; the MUTANT PROOF blocks now live
in `-parse.test.ts` (~:466-620). The litter problem S23-F1 describes was
itself fixed via #598: the two full-pipeline proofs pass
`join(base, injectionPayload(marker))` (absolute, inside the per-test
tmpdir) and assert `cwdLitter()` stays empty.

Annotation: inject a parenthetical between the filename and the existing
"(MUTANT PROOF blocks, lines ~448-500," parenthetical on line 30:

  (2026-10-13, #790: file split by #736 into
  `install-cache-security-parse.test.ts` +
  `install-cache-security-disk.test.ts`; these proofs now live in
  `-parse.test.ts` ~:466-620, and the litter fix itself landed via #598)

## Cite 3 — deep-modules-sweep F14 heading (history doc, per-cite decision: annotate)

`docs/maintainability/2026-10-08-deep-modules-sweep.md` cites
`src/board/close-outcome.ts` (depth-table row 2 at :50, shortlist row 14
at :218, finding F14 at :348). The doc is a dated sweep whose section-level
pin note ("Line refs = physical lines at `origin/main` `cc9a9a4`", :221)
covers the tables, so the table rows stay untouched history. F14 was
executed: PR #342 (268f725, 2026-10-11, refs #274) deleted the shim;
`close-action.ts` takes the structural `D1Port`. Annotate the finding so a
reader following the cite knows it is resolved.

Annotation: new line immediately under the F14 heading (:348):

  > Resolved 2026-10-11 by #342 (268f725): the shim is deleted,
  `close-action.ts` takes the structural `D1Port`; table row 2 and
  shortlist row 14 are history, true at the doc's pin `cc9a9a4`.

## Cite 4 — fix-416 plan Task 4 heading (history doc, per-cite decision: annotate)

`apps/fleet/docs/plans/2026-10-12-fix-416-carried-review-findings.md` cites
`test/bun/cli-destroy-flags.test.ts` (Task 4 heading :385, files list
:388, cross-reference step :390, exec commands :513-514, verify :542).
This doc is the plan that did it: PR #466 (d060ab5, 2026-10-12) deleted
the file and shipped the behavioral tests in
`test/bun/cli-destroy-unmerged.test.ts`. The plan's own step boxes stay
as they are (completed history, and #466 did not check them off); the
exec-log lines :513-514 and :542 stay untouched. Annotate the Task 4
heading.

Annotation: new line immediately under the Task 4 heading (:385):

  > Executed 2026-10-12 by #466 (d060ab5): `cli-destroy-flags.test.ts`
  deleted, behavioral tests live in `test/bun/cli-destroy-unmerged.test.ts`.
  The unchecked boxes below are completed history.

## Verify

Doc-only change; the repo's checks that can see it:

  cd apps/fleet && bun run english-check    # must print: english-check: clean
  cd apps/fleet && bun run test-lies-check  # 0/0/0 across test files, exit 0

`git diff --stat main..HEAD` must show exactly 5 files: the plan doc plus
the four annotated docs. These two commands are the done-record
verification.
