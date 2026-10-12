# Sweep 20: CLI arg validation — plan (board issue #541)

Ref #541. Read-only analysis of argv parsing (`src/studio/cli-args.ts`, `src/studio/ff.ts`, `cli/attach-liveness.ts`, cli/fleet.ts call sites) for flags that silently accept bad input. GLM-OK findings filed as fix issues; rescue/accounts/credentials parsers listed CLAUDE-ONLY, nothing filed. Deliverables: findings doc, one `fix(GLM-OK): S20-Fn` issue per batch, one doc-only PR.

## Steps
1. Lead read both parsers + call sites in full and verified every finding with live parser probes (`bun -e` against parseCliArgs/parseFfArgs) at origin/main 1a00124.
2. Backend Developer writes both doc files verbatim (from the lead's brief), commits, pushes.
3. Developer files one `fix(GLM-OK): S20-Fn <short>` issue per batch listed in the doc's follow-ups section.
4. Developer opens the doc-only PR, runs `bun run english-check` (only gate), writes /workspace/.fleet/done/541.json.
5. Code Reviewer (fresh context) reviews; findings routed per delivery-standards. Cap 2 rounds, 30m budget.
6. Lead posts the envelope on https://github.com/rafarc21/fleetflare/issues/541.

## Constraints
- No code changes. Two new doc files + PR only. Record at /workspace/.fleet/done/541.json, never in the repo.

## Verification
- Docs-only: `bun run english-check` from apps/fleet is the one gate.
