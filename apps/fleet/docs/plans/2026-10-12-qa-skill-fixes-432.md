# QA skill dead references fix — plan (board issue #432)

Ref #432. Fixes three documentation-accuracy findings in
`skills/qa/SKILL.md` ONLY (S7-F6/F7/F8 from
`docs/maintainability/2026-10-12-docs-accuracy-sweep-7.md`). No code
changes, no other file touched. Doc-only diff.

## Steps

1. F6 (SKILL.md:24 Prerequisites): the agent-browser install line gets
   scoped — Mac-only install, studio containers never install it
   (studio image ships ego-browser, not agent-browser —
   `apps/fleet/container/Dockerfile.studio:272-273`), studios drive the
   browser via the ego-browser skill (`skills/ego-browser/SKILL.md` —
   `ego-browser nodejs` with `taskSpace`/Page, snapshot and screenshot
   included). All 38 `agent-browser …` command lines stay as written —
   they target the Mac; rewriting them would invent ego-browser API
   (no video recording, no direct CLI subcommands).
2. F7 (SKILL.md:700-701 Reference): delete the two dead entries
   `playbooks/tracking-validation.md` and `configs/zaraz-base.json` —
   neither path exists anywhere in this repo.
3. F8 (SKILL.md:70 and :699): scope `docs/platform-spec.md` to the
   client repo under test, not this repo — both mentions say so.
4. Commit both files (SKILL.md + this plan) in one commit, refs #432,
   push branch.

## Verification

- `grep -n "agent-browser" skills/qa/SKILL.md` — line 24 carries the
  Mac-only + ego-browser note.
- `grep -n "playbooks/\|configs/zaraz" skills/qa/SKILL.md` — no output.
- `grep -n "platform-spec" skills/qa/SKILL.md` — both hits (lines ~70
  and ~699) say client repo.
- `git diff origin/main --stat` — exactly 2 files: skills/qa/SKILL.md
  and this plan doc.
