# Magic-numbers sweep 14 — plan (board issue #485)

Ref #485. Read-only analysis of `apps/fleet/src/**` and `apps/fleet/cli/**`
for duplicated numeric literals — ms timeouts, retry caps, poll intervals,
size limits — same number for the same purpose in 2+ files, or a named const
shadowed by a raw literal elsewhere. Skip `container/` (image changes held)
and the CLAUDE-ONLY lanes (auth, secrets, credentials, rescue, failover,
accounts routing, deploy, migrations, write-proxy, leak-gate). Deliverables:
findings doc `docs/maintainability/2026-10-12-magic-numbers-sweep-14.md`
(max 12 findings, file:line each copy, same-purpose evidence, proposed
single home), one board issue per batch (`deepen(GLM-OK): S14-Fn <short>`;
disagreeing copies get `fix(GLM-OK)` prefix), one PR with the doc only
(refs #485, never closing keywords).

## Steps

1. Sweep literals by frequency (grep, sorted by count), then for each
   candidate verify same-purpose by reading the surrounding doc comments —
   a shared number is only a finding when the copies serve one purpose,
   not when two modules coincidentally pick 60_000.
2. Lead hand-verified every reported copy's file:line at origin/main b1d204b
   before writing the doc; disagreeing-copy finding (S14-F2) verified by
   reading both sites' comments.
3. Write the findings doc: S14-F1..S14-F10, each with Files / Evidence /
   Proposed single home, tier marked, disagreeing copies flagged.
4. File one deepen(GLM-OK): S14-Fn issue per batch via gh; the disagreeing
   copies get their own fix(GLM-OK) issue.
5. One PR, doc only, refs #485, no closing keywords. local-ci gate,
   completion record, envelope.

## Constraints

- No code changes anywhere. Two new doc files only.
- CLAUDE-ONLY-adjacent items are described but filed by nobody — rescue/
  failover/write-proxy/deploy lanes stay out of the filed set.
- No completion record in the repo (gate refuses it) — it lives under
  /workspace/.fleet/done/485.json.

## Verification

- No heavy gates — docs-only diff. `bun run english-check` (from apps/fleet/)
  only. Full suite belongs to CI.
