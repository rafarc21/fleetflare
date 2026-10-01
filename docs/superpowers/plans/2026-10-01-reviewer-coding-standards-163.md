# Reviewer-only coding standards, and a stale CONTRIBUTING.md CI claim

**Issue:** https://github.com/rafarc21/fleetflare/issues/163

**Goal:** Implementer prompts (`members/frontend-developer.md`,
`members/backend-developer.md`) are overloaded — an implementer's context
fills up fast with exploring the codebase, making the change, and
debugging, leaving no room to also carry judgement-call style/quality
rules. The Code Reviewer (`members/code-reviewer.md`) is fresh-context and
read-only, so it has the room. Move the judgement/style content out of the
two developer prompts into a new reviewer-only
`fleet/blueprint/CODING_STANDARDS.md`, leaving each developer prompt a
single one-line pointer instead. Push-discipline, heavy-gate-lock, and
TDD-mechanics content in the developer prompts are process/safety rules,
not judgement calls, and stay exactly where they are.

Separately, fix a doc inconsistency: `CONTRIBUTING.md`'s CI section
claimed `local-ci/*` commit statuses gate merges and "there is no hosted
CI". Both `docs/operations.md`'s CI section and live evidence (`gh api
repos/rafarc21/fleetflare/commits/<HEAD-sha>/check-runs` on main) show two
native GitHub Actions workflows (`check`, `english`) actually running and
gating merges via the `github-actions` app, matching
`.github/workflows/fleet-check.yml` and
`.github/workflows/english-check.yml`. `docs/operations.md` already
explains the old `local-ci/*` Mac daemon is superseded by this native
Actions setup, so `CONTRIBUTING.md` was the stale side — fixed to match
`docs/operations.md`.

## Design

1. **New file `fleet/blueprint/CODING_STANDARDS.md`** — reviewer-only
   rubric covering Correctness, Tests, Scope, Style, Security, Simplicity,
   and Verdict sections, each framed as a judgement call with a concrete
   failure scenario rather than a vague preference. Explicitly states who
   reads it (the Code Reviewer, every review) and why implementers get a
   pointer instead of the full file.
2. **`members/frontend-developer.md` / `members/backend-developer.md`** —
   the line that previously read "Real code, not rehearsal. Match
   existing style, existing patterns in the repo. TDD where the step is
   behavior — test first, red, then green." drops the standalone "Match
   existing style" clause and gains a one-line pointer to
   `fleet/blueprint/CODING_STANDARDS.md` in its place: "Real code, not
   rehearsal. TDD where the step is behavior — test first, red, then
   green. Code quality judgement calls: `fleet/blueprint/
   CODING_STANDARDS.md` is the reviewer's rubric — match the surrounding
   file by default, let review catch the rest." Every other line (push
   discipline, gate-lock paragraph, final report-back line) is untouched.
3. **`members/code-reviewer.md`** — `Checklist, every review:` becomes
   `Checklist, every review (full rubric: \`fleet/blueprint/
   CODING_STANDARDS.md\`):`, keeping the existing compact six-bullet list
   unchanged and adding a pointer to the expanded version.
4. **`CONTRIBUTING.md`** — the "Pull requests" bullet claiming CI is the
   `local-ci/*` commit status with "no hosted CI" is replaced with wording
   describing the two native GitHub Actions workflows (`check`, `english`)
   that run on every PR/push to `main` and gate merges, pointing to
   `docs/operations.md`'s CI section for trigger/path-filter detail.

## Byte counts (before / after)

| File | Before | After | Diff |
|---|---:|---:|---:|
| `fleet/blueprint/studios/web-studio/members/frontend-developer.md` | 2098 | 2208 | +110 |
| `fleet/blueprint/studios/web-studio/members/backend-developer.md` | 2219 | 2329 | +110 |
| `fleet/blueprint/studios/web-studio/members/code-reviewer.md` | 1031 | 1084 | +53 |
| `fleet/blueprint/CODING_STANDARDS.md` (new) | — | 3826 | +3826 |

## Deviations

None — the `CODING_STANDARDS.md` content was used verbatim as specified;
no repo convention conflicted with it.

## Files touched

- `fleet/blueprint/CODING_STANDARDS.md` — new reviewer-only rubric.
- `fleet/blueprint/studios/web-studio/members/frontend-developer.md` —
  one-line pointer replacing the inline "match existing style" clause.
- `fleet/blueprint/studios/web-studio/members/backend-developer.md` —
  same edit as above.
- `fleet/blueprint/studios/web-studio/members/code-reviewer.md` —
  checklist line now links the expanded rubric.
- `CONTRIBUTING.md` — CI bullet fixed to match `docs/operations.md`'s
  native GitHub Actions description instead of the superseded
  `local-ci/*` daemon claim.
- `docs/superpowers/plans/2026-10-01-reviewer-coding-standards-163.md` —
  this file.
