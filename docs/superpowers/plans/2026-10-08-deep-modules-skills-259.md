# deep-modules + pr-body skills, standards out of the implementer, review-fix loop (issue #259, Part A)

Issue: https://github.com/rafarc21/fleetflare/issues/259 (Part A only — skills.
Part B/C/D are a separate, future, out-of-scope lane). Spec committed verbatim
at `docs/superpowers/specs/2026-10-08-deep-modules-maintainability-design.md`
— that file is the source of truth for exactly what was asked; this plan is
how it gets built.

Branch: `feat-259-deep-modules-skills` off `origin/main`. Docs/skills only —
no app code, no tests beyond what already exists for skill-file structure.

## Goal

Ship four things, per the spec's own Part A:
1. a new `skills/deep-modules/SKILL.md` — Ousterhout vocabulary, a detection
   checklist, refactor recipes, a hook into superpowers' own design/review
   skills (by reference, not by editing those skills — they're a separate
   installed plugin).
2. a new `skills/pr-body/SKILL.md` — extends `.github/pull_request_template.md`
   (one source of truth, not a second competing shape).
3. standards out of the implementer: drop the one-sentence CODING_STANDARDS
   pointer from `backend-developer.md`/`frontend-developer.md`; have
   `code-reviewer.md` also read the new deep-modules checklist.
4. the review → fix loop, documented in `delivery-standards` — this is
   already the real practice `web-studio/studio.md` describes; write it down
   for the first time, don't invent a new one.

Plus: cross-links from 4 existing files, and a genuine acceptance dry run of
the deep-modules checklist against one real, substantial fleetflare module
(findings go to a new GitHub issue, drafted here, filed by the lead — not
fixed in this PR).

## 1. `skills/deep-modules/SKILL.md` (new)

Frontmatter matches `delivery-standards`/`maestro-playbook`'s shape exactly
(`name:`, one-paragraph `description:` written for skill-selection matching).

Sections, in order:
- **Vocabulary** — module, interface, implementation, depth (functionality ÷
  interface size), information hiding, seam, pass-through method, shallow
  module, temporal decomposition, change amplification, cognitive load,
  unknown unknowns. Each grounded in Ousterhout's own meaning (*A Philosophy
  of Software Design*), not reinvented.
- **Detection checklist** — pass-through wrappers; many tiny exported
  functions callers must sequence; config/flag parameters leaking internals;
  callers repeating the same 3-step dance; tests that import internals or
  assert structure; files split by "step" not by "knowledge". Written as a
  literal checklist (one line each) so a reviewer or the acceptance dry run
  can tick through it mechanically.
- **Refactor recipes** — merge shallow siblings behind one interface; pull
  complexity downward; define errors out of existence; replace flag params
  with distinct methods; move tests to the interface (characterization tests
  first).
- **When NOT to deepen** — one-way-door code, hot security paths, generated
  code.
- **Hook into superpowers** — names `superpowers:brainstorming` and
  `superpowers:writing-plans` (their design step should ask "does this
  deepen or shallow the touched modules?") and `superpowers:requesting-code-
  review` (should read this checklist), by name only — those are a separate
  installed plugin this repo doesn't own, so nothing there gets edited.

## 2. `skills/pr-body/SKILL.md` (new)

Frontmatter `description` says explicitly: reach for this on every PR, not
just when asked.

Opens by naming `.github/pull_request_template.md` as *the* template — this
skill documents and extends it, not a second source of truth. Each of the
template's three sections gets the spec's extra guidance layered on, same
heading names as the template (Summary / Evidence / Merge Danger), so a
reader can map skill-guidance to template-section 1:1:
- **Summary** — the template's existing "smallest visual" instruction, plus:
  pseudocode of the change's shape, and one small diagram (mermaid or ASCII)
  when the change has more than one moving part worth drawing.
- **Evidence** — the template's existing "before -> after, real test output"
  instruction, plus: make it runnable — a command a reviewer can actually
  execute, not a transcript they must trust.
- **Merge Danger** — the template's existing Door/Blast-Radius sub-structure,
  unchanged (one-way/two-way door call; blast radius one line). Cross-
  references `web-studio/studio.md`'s own door-classification rule
  (`merge-danger.ts`'s `ONE_WAY_GLOBS` is a floor, never a ceiling) rather
  than restating it.

No new template file. No second Summary/Evidence/Merge-Danger shape anywhere.

## 3. Standards out of the implementer

- `fleet/blueprint/studios/web-studio/members/backend-developer.md` and
  `frontend-developer.md`: delete the sentence "Code quality judgement
  calls: see `fleet/blueprint/CODING_STANDARDS.md` (reviewer's rubric)."
  verbatim, nothing rephrased in its place — the reviewer already
  independently reads that file (see `code-reviewer.md`'s existing Standards
  axis paragraph), so the implementer-side pointer is now pure redundancy.
- `code-reviewer.md`: its Standards axis paragraph keeps its existing
  `CODING_STANDARDS.md` → repo-rules-override → Fowler-baseline fallback
  chain untouched (pinned by
  `apps/fleet/test/bun/code-reviewer-blueprint-content.test.ts`), and gains
  one new sentence: it also reads `skills/deep-modules/SKILL.md`'s detection
  checklist as part of the same axis — a shallow-module finding is a real
  Standards-axis finding class now, alongside the Fowler baseline, not a
  separate axis.

## 4. Review → fix loop, documented in delivery-standards

Read `fleet/blueprint/studios/web-studio/studio.md` first — it already
describes the exact pattern live: "Standards-axis findings: dispatch a
fresh-context Developer for a refactor step — a new agent, no shared history
with the implementer, that commits the fixes directly instead of leaving
them as comments... Spec-axis findings... go back as a comment to the
original Developer, never silently reworked."

`skills/delivery-standards/SKILL.md` gains a new section (after the existing
content, before nothing — append at the end) writing this down for the first
time as a named pattern: reviewer stays independent (never fixes anything
itself), a SEPARATE fresh-context fixer commits the fix directly, before the
PR opens, closing the loop without the reviewer ever touching code. Cross-
references `web-studio/studio.md` by name rather than restating its words,
so the two can't drift into contradiction.

## 5. Cross-links (small, one sentence or one "See also" line each)

- `fleet/blueprint/studios/web-studio/studio.md` — one sentence near the
  existing PR-template paragraph, pointing at `skills/pr-body` for the
  extended guidance, and at `skills/deep-modules` near the Code-
  Reviewer/fix-loop paragraph.
- `skills/delivery-standards/SKILL.md` — one line in (or right after) the
  new review-fix-loop section pointing at `skills/deep-modules` for what a
  Standards-axis finding actually looks like.
- `skills/maestro-playbook/SKILL.md` — one sentence, likely in the brief-
  discipline or evidence-culture section, naming both new skills.
- `skills/fleet-cockpit/SKILL.md` — one sentence, likely near "Repository
  language" or "What not to do", naming both new skills.

None of these four edits touch the `skills:` frontmatter array of any
`studio.md` — that array is what
`apps/fleet/test/bun/studio-skills-resolve.test.ts` walks and resolves; this
issue only asks for prose links, not a new runtime skill dependency for any
studio role, so that array stays as-is.

## 6. Acceptance dry run (not fixed here)

Apply the Step 1 checklist, by hand, to one real fleetflare module with
genuine history. Write the findings as a draft issue title + body (the lead
files it with `gh issue create` — not `fleet task new`, since this is a
plain informational issue, not a studio-assignment action). Honest result
either way: if the module holds up against the checklist, say so.

## Files touched

- `docs/superpowers/specs/2026-10-08-deep-modules-maintainability-design.md` — step 0, issue body verbatim.
- `docs/superpowers/plans/2026-10-08-deep-modules-skills-259.md` — this file.
- `skills/deep-modules/SKILL.md` — new.
- `skills/pr-body/SKILL.md` — new.
- `fleet/blueprint/studios/web-studio/members/backend-developer.md` — one sentence removed.
- `fleet/blueprint/studios/web-studio/members/frontend-developer.md` — one sentence removed.
- `fleet/blueprint/studios/web-studio/members/code-reviewer.md` — one sentence added to the Standards axis paragraph.
- `skills/delivery-standards/SKILL.md` — new review-fix-loop section.
- `fleet/blueprint/studios/web-studio/studio.md` — two small cross-link sentences.
- `skills/maestro-playbook/SKILL.md` — one cross-link sentence.
- `skills/fleet-cockpit/SKILL.md` — one cross-link sentence.

No code changes, no new/changed tests — this is a docs/skills-only PR. Gate:
`bun run check` (tsc, no-op expected for pure Markdown) + `bun run
test-lies-check`, both under `flock /tmp/fleet-gate.lock`, run once each, not
twice — no mutation-testing of a heavy check in this task. `bun run test` /
`bun run bun-test` run once at the end, sequentially, same lock, to confirm
nothing broke (the two blueprint-content test files above are the only ones
with any real exposure to this diff).
