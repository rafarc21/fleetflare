# Plan — sweep 34: CLI docs drift (#734)

Doc-only sweep, no code changes. Every `fleet`/`ff` verb and flag claim in
README.md, docs/architecture.md, docs/operations.md, docs/setup.md,
docs/threat-model.md, docs/fleet/*.md, CONTRIBUTING.md checked against the
real CLI: `bun cli/fleet.ts help` output, src/studio/cli-args.ts,
src/studio/ff.ts, cli/fleet.ts, container/studio-fleet, scripts/deploy.sh.
apps/fleet/docs/** scanned (plans = dated records, same exclusion sweep 17
applied to docs/superpowers).

## Steps

1. Branch sweep-734-cli-docs-drift off origin/main cbc1c6f (done).
2. Grep every `fleet <verb>` / `ff` / `--flag` token in scope docs; verify each against parser + help; dated records (docs/fleet/README.md 2026-08-03 snapshot, plans/) excluded by precedent.
3. Write docs/maintainability/2026-10-13-cli-docs-drift-sweep-34.md — findings, each: doc file:line, CLI truth file:line, proposed fix, lane.
4. Commit both docs, push branch (LEFTHOOK=0 git push -u origin sweep-734-cli-docs-drift).
5. File follow-up issue(s): docs(GLM-OK): S34-Fn <short>, refs #734, never closing keywords.
6. Open doc-only PR referencing #734, no closing keywords.

## Verification

- No build/test gate: doc-only diff. git diff origin/main --stat = 2 new .md files only.
- Every file:line ref re-checked against working tree before commit.
- cd apps/fleet && bun run english-check exit 0 (doc text is repo content).
