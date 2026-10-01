# Reviewer gets read-only git; refactor step commits standards fixes (#166)

**Goal:** Give the web-studio Code Reviewer read-only git access — `git diff`,
`git log`, `git show` — so it can pull context itself (history, blame-adjacent
detail, the actual diff) instead of only ever seeing a diff handed to it.
Add a refactor step to the lead's workflow: Standards-axis findings from
review get fixed by a fresh-context Developer that commits the fix directly,
rather than being routed back to the implementer as a review comment.
Spec-axis findings, and any genuine open question the refactor step can't
resolve mechanically, still go back as a comment — never silently reworked.
This builds directly on #162's Spec/Standards axis split (merged in PR #171):
the axis split is what makes the routing decision in this task well-defined
(Standards → refactor-and-commit, Spec → comment).

Two files changed:

- `fleet/blueprint/studios/web-studio/members/code-reviewer.md` — the
  frontmatter `tools:` line now grants `Bash(git diff *)`, `Bash(git log *)`,
  `Bash(git show *)` alongside the existing `Read, Glob, Grep`. The prose
  previously reading "Read-only. No Edit, no Write, no Bash." now says
  Bash is limited to those three read-only git forms, nothing that changes
  the tree, and that the reviewer should go look at the diff and its history
  itself rather than wait to be handed one. Everything else in the file —
  the Spec/Standards axes, citation rules, recursion guard, verdict format —
  is untouched from #162.
- `fleet/blueprint/studios/web-studio/studio.md` — the lead's own prompt.
  The paragraph that dispatches Code Reviewer and routes its findings now
  names the refactor step: Standards-axis findings go to a fresh-context
  Developer (new agent, no shared history with the implementer) that commits
  the fix directly, under the same push-discipline and one-heavy-gate-at-a-
  time rules as any other implementation step; Spec-axis findings and
  anything the refactor step can't resolve mechanically still go back as a
  comment to the original Developer. Nothing else in `studio.md` changed —
  push discipline, the heavy-gate rule, and the completion-record block are
  byte-identical to before.

## Why no app-code change

Both edited files are prompt files, not application code, consumed verbatim
at provision time by `listStudioMembers` / the studio-blueprint loader in
`apps/fleet/src/studio/provision.ts`, which lists, fetches, and
`validateMemberFile`s every file under a studio's `members/` dir and bundles
the raw markdown as-is — no transformation of the body text happens, and the
lead's own `studio.md` is bundled the same way. `validateMemberFile` only
checks frontmatter fields (`name`, `tools`) and that the body is non-empty;
it never inspects the prose. No test read either file's content before this
change except the tests this task adds itself (the #162 test file already
existed and asserted on `code-reviewer.md`'s content, but not on git-tool
grants or git-access prose). So this is a pure content edit on both files,
not an app-code change.

## Test

Extended `apps/fleet/test/bun/code-reviewer-blueprint-content.test.ts`
(already reading the real `code-reviewer.md` from #162) with a new
`describe("code-reviewer blueprint — read-only git (#166)")` block asserting:

- `tools` parses to exactly `Read, Glob, Grep, Bash(git diff *),
  Bash(git log *), Bash(git show *)` via `validateMemberFile`;
- the prose mentions `git diff`, `git log`, and `git show`.

Also updated the single pre-existing #162 assertion that hardcoded the old
tools string (`Read, Glob, Grep`) to the new post-#166 value — that
assertion necessarily goes stale the moment the tools line changes, since it
exists specifically to assert on the current tools grant; everything else in
the #162 describe block (axis names, citation rules, recursion guard) is
untouched.

New file `apps/fleet/test/bun/web-studio-refactor-step.test.ts` reads the
real `fleet/blueprint/studios/web-studio/studio.md` and asserts:

- the review-dispatch paragraph mentions a "refactor step", "fresh context",
  and that it "commits the fix" (not just comments);
- "comment" still appears, for Spec-axis findings and genuine questions;
- the push-discipline and one-heavy-gate-at-a-time language is still present
  and still governs the refactor step.

RED before the two blueprint edits: 3 of 12 tests across both files failed
(the new tools-string assertion, the new git-access prose assertion in
`code-reviewer.md`, and the new refactor-step-paragraph assertion in
`studio.md`). GREEN after editing both files (and the one stale #162
assertion): 12/12 pass.

Also reran the existing `test/studio.studio-blueprint.test.ts` (22 tests) to
confirm no regression to the generic member-file parser: `code-reviewer.md`
now declares 6 comma-separated tool entries (`Read`, `Glob`, `Grep`,
`Bash(git diff *)`, `Bash(git log *)`, `Bash(git show *)`), each one Bash
grant counting as a single entry when split on commas — still well under the
12-tool cap, and the file still satisfies every other `validateMemberFile`
invariant.

Finally ran the repo's English-content lint
(`apps/fleet/scripts/english-check.ts`) since this task wrote prose in two
files — exits 0.

## Boundaries

Did not run `bun run test` (full vitest-pool-workers suite), `bun run check`
(5x repo-wide tsc), `bun run bun-test` (full lane — needs tmux/Chromium,
hundreds of unrelated container tests), or `test:integration`/
`test:acceptance` (e2e). This is a two-file prompt-content change with no
application-code or type surface touched — those heavy gates are reserved
for CI and the merge gate per this studio's own gate-budget house rules (the
same rules edited into `studio.md`'s "One heavy gate at a time" paragraph by
#166 — unchanged by this task). Ran only the two targeted test files, the
existing blueprint-parser suite, and the repo's English-content lint, all
green.
