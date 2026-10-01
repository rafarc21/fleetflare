# Split code-reviewer into Spec + Standards axes with citations and a recursion guard (#162)

**Goal:** Split the web-studio code-reviewer's single checklist into two
independent axes, each producing its own report:

- **Spec axis** — reads the board issue's objective/output/boundaries and
  checks the diff against those three, not against the reviewer's own idea
  of correct.
- **Standards axis** — reads `CODING_STANDARDS.md` at repo root first (repo
  rules override everything), and falls back to the Fowler smell baseline
  (long method, large class, duplicate code, feature envy, data clumps,
  primitive obsession, shotgun surgery, speculative generality) where the
  repo is silent.

The two reports are never merged into one and never reranked against each
other — one axis's findings must not shape the other's wording or severity.
Every finding, on either axis, carries a citation: the Spec axis cites the
issue line/clause it's checked against; the Standards axis cites either
`CODING_STANDARDS.md:<line>` or the named Fowler smell.

The prompt also adds an explicit recursion guard: "review directly, spawn no
agents, invoke no review skill." An upstream reviewer skill (source: Matt
Pocock's "Fixing the PR Bottleneck" talk and github.com/mattpocock/skills)
let a code-reviewer agent spawn sub-reviewers, which recursed past 50 agents.
The code-reviewer member must be a leaf: it reviews the diff itself, never
fans out.

## Why no app-code change

`code-reviewer.md` is a prompt file, not application code. It's consumed at
provision time by `listStudioMembers` in `apps/fleet/src/studio/provision.ts`
(`apps/fleet/src/studio/provision.ts:1776`), which lists, fetches, and
`validateMemberFile`s every file under a studio's `members/` dir and bundles
the raw markdown verbatim — no transformation of the body text happens.
`validateMemberFile` only checks the frontmatter fields (`name`, `tools`) and
that the body is non-empty; it never inspects the prose. Confirmed by
grepping `apps/fleet/test` for `code-reviewer`: the only two prior hits were
`test/studio.observed.test.ts:240` (an unrelated redaction test whose
description happens to mention "code-reviewer finding") and
`test/studio.studio-blueprint.test.ts` (generic member-parsing fixtures using
a different member name). No existing test read the real file's content
before this change — so this is a pure content edit, not an app-code change.

## Test

New file `apps/fleet/test/bun/code-reviewer-blueprint-content.test.ts` reads
the real `fleet/blueprint/studios/web-studio/members/code-reviewer.md` off
disk and asserts:

- it still parses as a valid read-only member (`name: code-reviewer`,
  `tools: Read, Glob, Grep`) via `validateMemberFile`;
- both axes are named ("Spec axis", "Standards axis");
- the Spec axis text references objective/output/boundaries;
- the Standards axis text references `CODING_STANDARDS.md`, the Fowler
  baseline, and that repo rules override it;
- the two reports are explicitly never merged and never reranked;
- every finding carries a citation;
- the recursion guard text is present ("spawn no agents", "invoke no review
  skill").

RED before the blueprint edit: 5 of 7 tests failed (axis names, Spec/
Standards citation wording, never-merge/never-rerank wording, and the
recursion-guard wording all absent from the single-checklist original).
GREEN after rewriting `code-reviewer.md`: 7/7 pass.

Also reran the existing `test/studio.studio-blueprint.test.ts` (22 tests) to
confirm no regression to the generic member-file parser — the rewritten
member still has exactly 3 tools (`Read, Glob, Grep`), well under the
12-tool cap, and still satisfies every other `validateMemberFile` invariant.

## Boundaries

Did not run `bun run test` (full vitest-pool-workers suite), `bun run check`
(5x repo-wide tsc), `bun run bun-test` (full lane — needs tmux/Chromium,
hundreds of unrelated container tests), or `test:integration`/
`test:acceptance` (e2e). This is a single markdown content change with no
application-code or type surface touched — those heavy gates are reserved
for CI and the merge gate per this studio's house rules on gate budget. Ran
only the targeted new test file, the existing blueprint-parser suite, and
the repo's English-content lint (`apps/fleet/scripts/english-check.ts`),
all green.
