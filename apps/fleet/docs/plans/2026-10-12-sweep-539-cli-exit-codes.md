# Sweep 19: CLI exit codes + stream correctness — plan (board issue #539)

Ref #539. Read-only analysis of `apps/fleet/cli/**` for exit-0-on-failure, success-on-stderr, error-on-stdout, and inconsistent same-failure exit codes across commands. CLAUDE-ONLY lanes (auth, secrets, credentials, rescue, failover, accounts routing, deploy) listed, nothing filed. Deliverables: findings doc, one `fix(GLM-OK): S19-Fn` issue per batch, one doc-only PR.

## Steps
1. Lead read every cli/ command file in full and verified each finding at origin/main 13f445f, with test-pin status grepped from test/ and test/bun/.
2. Backend Developer writes both doc files verbatim (below), commits, pushes.
3. Developer files one `fix(GLM-OK): S19-Fn <short>` issue per batch listed in the doc's follow-ups section.
4. Developer opens the doc-only PR, runs `bun run english-check` (only gate), writes /workspace/.fleet/done/539.json.
5. Code Reviewer (fresh context) reviews; findings routed per delivery-standards. Cap 2 rounds, 30m budget.
6. Lead posts the envelope on https://github.com/rafarc21/fleetflare/issues/539.

## Constraints
- No code changes. Two new doc files + PR only. Record at /workspace/.fleet/done/539.json, never in the repo.

## Verification
- Docs-only: `bun run english-check` from apps/fleet is the one gate.
