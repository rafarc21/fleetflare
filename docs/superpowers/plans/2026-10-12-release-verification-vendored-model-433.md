# release-verification-checklist: version-control section → the vendored model (#433)

Source: sweep-7 S7-F9 (docs/maintainability/2026-10-12-docs-accuracy-sweep-7.md);
refs #421, never closes. Docs-only. Paths repo-root-relative.

## Finding
skills/release-verification-checklist/SKILL.md:91-104 ("## This directory IS
version-controlled (since 2026-08-04)") claims `~/.claude/skills/` is its own
git repo as of `37a9381`, with commits landing directly there and no PR.
fleet/blueprint/README.md:31-37 says skills are vendored in THIS repo — on the
Mac `~/.claude/skills/<name>` is a symlink into this checkout; in studio
containers studio-bringup.sh symlinks to `/opt/blueprint/skills/<name>`, and
`/opt/blueprint` IS this checkout (apps/fleet/container/studio-bringup.sh:866-867).
The two models disagree, and the old section's "commit directly, no PR"
workflow bypasses this repo's review rules.

## Fix design
Rewrite the section in place (between the Files table and EOF), lines outside
91-104 untouched:
1. Retitle the heading to the vendored model — "## Version control: vendored
   in the blueprint repo". Dates/history move into prose.
2. State the model: this skill directory is version-controlled in
   rafarc21/fleetflare under `skills/release-verification-checklist/`. Mac:
   `~/.claude/skills/release-verification-checklist` symlinks into that
   checkout. Containers: studio-bringup.sh symlinks it to
   `/opt/blueprint/skills/release-verification-checklist`, the same checkout
   (apps/fleet/container/studio-bringup.sh:866-867). Local and cloud read the
   one file; no second copy drifts.
3. History stays history: until 2026-08-04 (37a9381) `~/.claude/skills/` was
   its own git repo, no review trail — commits landed directly, no PR. That
   repo is history; the vendored checkout replaced it. The 4.7 MB/464 MB
   on-disk numbers described the old standalone repo — dropped (they read as
   present-tense facts otherwise).
4. Review workflow: every edit — including worker/ and render.ts — lands as a
   PR in this repo, through normal review. No direct-commit path. Keep the
   practical guidance: before editing worker/ or render.ts, re-run worker
   tests (`cd worker && npm ci && npx vitest run`) plus a render diff against
   a known batch before trusting it. Keep "commit per change so a wrong
   claim in a skill is visibly corrected rather than silently replaced" — as
   small per-change PRs.

## Verification
`cd /workspace/fleet && bun run scripts/english-check.ts` (skills/*.md are
scanned) — exit 0; `git diff origin/main..HEAD --stat` shows exactly 2 files.
No test suite, tsc, or vitest — docs-only, no code surface.

## Out of scope
Any file other than this SKILL.md (worker/, render.ts, reference/, other
skills), any code change. PR refs #433 and #421; neither closes.
