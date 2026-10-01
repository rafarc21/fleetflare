# Cap review rounds at 2; overflow becomes a board task; deny --output/-o on reviewer git (#167)

**Goal:** Cap the lead's review loop at 2 rounds. Round 1 findings route as
before (Standards → refactor step, Spec → comment, per #166). If round 2 still
returns cited blocking findings, the lead stops looping — it files every
remaining cited finding as one board task (`fleet task new`, a single task
listing all of them) and lets the PR proceed anyway, instead of dispatching
Code Reviewer a third time. Review has no convergence guarantee; looping
until clean burns tokens on a shared account. Separately, close a gap #166
left open: the reviewer's read-only git grant (`Bash(git diff *)`,
`Bash(git log *)`, `Bash(git show *)`) is a prefix wildcard with no
flag-exclusion syntax, so `git diff --output=file` (or `-o file`) would let
a nominally read-only command write a file, breaking the reviewer's
read-only guarantee. There is no mechanical per-member Bash deny mechanism
in this repo — member `tools:` frontmatter is allow-only, scoped Bash
patterns are prefix wildcards with no flag-exclusion syntax, and the only
Bash-blocklist hook in the blueprint (`STUDIO_LEAD_DISALLOWED` in
`apps/fleet/src/studio/studio-blueprint.ts`) applies to the lead, not
members. So the `--output`/`-o` deny is prose only, same "not a wall, the
rule is yours to keep" philosophy `studio.md` already states explicitly for
the lead's own Bash blocklist.

Two files changed:

- `fleet/blueprint/studios/web-studio/members/code-reviewer.md` — the
  read-only-git sentence #166 added now also says: "Never `--output`/`-o` on
  any of them — that flag redirects git's own output to a file instead of
  stdout, which would make a read command write one." Nothing else in the
  file changes — the frontmatter `tools:` line, the Spec/Standards axes,
  citation rules, recursion guard, and verdict format are untouched from
  #162/#166.
- `fleet/blueprint/studios/web-studio/studio.md` — the lead's own prompt.
  A new paragraph, `**Review rounds cap at 2.**`, is inserted immediately
  after the refactor-step paragraph #166 added and before the
  `**Push discipline.**` paragraph. It names the cap explicitly (round 2
  still has cited blocking findings → stop, no round 3), the overflow
  mechanism (`fleet task new`, one task listing every remaining finding),
  that the PR proceeds anyway, and that the filed follow-up belongs in the
  lead's envelope. No other paragraph in `studio.md` changed — push
  discipline, the heavy-gate rule, and the completion-record block are
  byte-identical to before.

## Why no app-code change

Both edited files are prompt files, not application code, consumed verbatim
at provision time by `listStudioMembers` / the studio-blueprint loader in
`apps/fleet/src/studio/provision.ts`, which lists, fetches, and
`validateMemberFile`s every file under a studio's `members/` dir and bundles
the raw markdown as-is — no transformation of the body text happens, and the
lead's own `studio.md` is bundled the same way. `validateMemberFile` only
checks frontmatter fields (`name`, `tools`) and that the body is non-empty;
it never inspects the prose. The frontmatter `tools:` line in
`code-reviewer.md` is unchanged by this task (only the body prose gained a
sentence), so the member still parses exactly as #166 left it.

## Test

Extended `apps/fleet/test/bun/code-reviewer-blueprint-content.test.ts` with
a new `describe("code-reviewer blueprint — deny --output/-o on git reads
(#167)")` block asserting the prose matches both `/--output/` and `/-o\b/`.

Added two new `test`s to `apps/fleet/test/bun/web-studio-refactor-step.test.ts`:

- one asserting `studio.md` mentions a 2-round cap (`/cap.*2|2 rounds|round
  2/i`), contains the literal string `fleet task new`, and contains
  `/no round 3/i`;
- one asserting `studio.md` matches `/proceed/i`, so the PR-proceeds-anyway
  behavior for overflow findings is present in the prose.

RED before the two blueprint edits: 3 of 15 tests across both files failed
(the new `--output`/`-o` assertion in `code-reviewer.md`, and the two new
round-cap/proceed assertions in `studio.md`) — confirmed by running both
files directly. GREEN after editing both files: 15/15 pass.

```
bun test v1.3.12 (700fc117)

 15 pass
 0 fail
 31 expect() calls
Ran 15 tests across 2 files. [32.00ms]
```

Also reran the existing `test/studio.studio-blueprint.test.ts` (22 tests) to
confirm no regression to the generic member-file parser — `code-reviewer.md`'s
frontmatter `tools:` line is unchanged by this task, so it still parses with
the same 6 comma-separated tool entries as #166 left it:

```
bun test v1.3.12 (700fc117)

 22 pass
 0 fail
 46 expect() calls
Ran 22 tests across 1 file. [43.00ms]
```

Finally ran the repo's English-content lint
(`apps/fleet/scripts/english-check.ts`) since this task wrote prose in two
files — exits 0:

```
english-check: clean
```

## Boundaries

Did not run `bun run test` (full vitest-pool-workers suite), `bun run check`
(5x repo-wide tsc), `bun run bun-test` (full lane — needs tmux/Chromium,
hundreds of unrelated container tests), or `test:integration`/
`test:acceptance` (e2e). This is a two-file prompt-content change with no
application-code or type surface touched — those heavy gates are reserved
for CI and the merge gate per this studio's own gate-budget house rules
(`studio.md`'s "One heavy gate at a time" paragraph, unchanged by this
task). Ran only the two targeted test files, the existing blueprint-parser
suite, and the repo's English-content lint, all green.
