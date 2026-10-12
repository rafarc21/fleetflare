# Remaining-src maintainability sweep 6 — plan (board issue #415)

Ref #415. Read-only analysis of `apps/fleet/src/**` minus board/, github/,
junior/, llm/ (sweep 4, #361) and the CLAUDE-ONLY surface (auth, tokens,
credentials, write-proxy, rescue, failover, accounts routing, deploy,
migrations, leak gate). Deliverables: findings doc
`docs/maintainability/2026-10-12-deep-modules-sweep-6.md` (max 10 findings,
each 4-6 lines, tier GLM-OK or CLAUDE-ONLY), one board issue per GLM-OK
finding (`deepen(GLM-OK): S6-Fn <short>`), one PR with the doc only.

## Steps

1. Analysis (done by lead, read-only): walked every in-scope module,
   applied sweep-1's depth metric vocabulary and the deletion test, and
   deduped against sweeps 1-5 docs + every open deepen(*) issue. Every
   line ref verified at `origin/main` `ec85d08`.
2. Findings doc: one file, S6-F1..S6-F10, each file:line evidence,
   proposed change, tier.
3. Board issues: one per GLM-OK finding, title `deepen(GLM-OK): S6-Fn
   <short>`, body names the doc section. Filed by this PR's author via
   `fleet task new --studio fleetflare--web-studio--49` (brief JSON on
   stdin: title/objective/outputFormat/boundaries; milestone null,
   assignee null).
4. PR: doc-only diff (plan doc + findings doc), refs #415, never "closes".

## Constraints

- No code changes anywhere. Two new doc files only.
- No completion record in the repo (gate refuses it). Done record lives at
  /workspace/.fleet/done/415.json.
- Line refs are physical lines at `origin/main` `ec85d08`, paths relative
  to `apps/fleet/`.

## Verification

- `bun run english-check` (from apps/fleet/) -> `english-check: clean`, exit 0.
- `bun run test-lies-check` (from apps/fleet/) -> exit 0, doc-only diff.
- `git diff origin/main --stat` shows exactly the two new doc files.
