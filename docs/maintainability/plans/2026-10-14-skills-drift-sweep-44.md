# Plan — sweep 44: skills/ markdown accuracy (#856)

Doc-only sweep, no code changes. Scope skills/**/*.md at origin/main bf0e8d4 only: every backticked command (`fleet …`, `ff …`, `orca …`, `bun …`, `wrangler …`, `gh …`, `git …`, `agent-browser …`, `ego-browser …`, junior.sh flags), every `--flag` token, and every repo path cited — each verified against the live parsers (apps/fleet/src/studio/cli-args.ts, apps/fleet/src/studio/ff.ts, apps/fleet/container/studio-fleet, apps/fleet/cli/orca-workspace.ts), against ~/.claude/skills/junior/src/main.ts (the junior skill's own arg parser), against apps/fleet/scripts/deploy.sh + package.json scripts, and against the agent-browser README (upstream vercel-labs/agent-browser). `bun install -g agent-browser` itself executed and removed after verification. Vendored-skill attribution lines (skills/engineering/… upstream paths, skills/VENDORED.md, THIRD-PARTY-LICENSES.md) excluded by construction — they cite upstream provenance, not this repo. Fictional Acme examples in release-verification-checklist (scripts/checklist/README.md) excluded — template placeholders, marked as such in the doc.

## Steps

1. Branch fix-856-skills-drift-sweep-44 off origin/main bf0e8d4 (done).
2. Extraction greps over skills/**/*.md; verify every candidate against the owning parser or the real file (method above).
3. Write docs/maintainability/2026-10-14-skills-drift-sweep-44.md — 3 findings (2 GLM-OK, 1 CLAUDE-ONLY), each skill file:line + cited thing + what exists instead.
4. Commit both docs, push branch.
5. File follow-up issues per batch: `docs(GLM-OK): S44-Fn <short>`, refs #856, no closing keywords. CLAUDE-ONLY finding recorded in the doc only, not filed.
6. Open doc-only PR referencing #856, no closing keywords.

## Verification

- No build/test gate applies: doc-only diff; `git diff origin/main --stat` shows only the two new .md files.
- Every cited command/flag/path re-checked against the working tree before commit; verified-clean list recorded in the findings doc.
