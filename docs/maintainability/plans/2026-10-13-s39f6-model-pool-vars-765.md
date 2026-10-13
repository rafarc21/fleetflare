# S39-F6: LEAD_MODEL_POOL model-pool vars in wrangler.example.jsonc (task #765, refs #742)

## Problem
Sweep 39 finding 6: the lead model pool's env vars — `LEAD_MODEL_POOL`
(env.ts:443, read anthropic-route.ts:658), `LEAD_AI_GATEWAY_ID` (env.ts:445,
read anthropic-route.ts:182), `MODEL_QUALITY_ISSUE` (env.ts:452, read
model-quality-cron.ts:174, index.ts:277) — are documented in
docs/setup.md:45 and docs/operations.md:139+ but absent from
apps/fleet/wrangler.example.jsonc: neither active nor commented. Every other
optional feature flag (FLEET_TELEGRAM, FLEET_DIRECTUS, FLEET_AUTO_FAILOVER,
FLEET_JUNIOR) has at least an `"off"` placeholder there, so the copy-first
template cannot enable the feature. Same family, also absent:
`LEAD_MODEL_OVERFLOW` (env.ts:448, read anthropic-route.ts:667, issue #768)
— included here as a commented line.

## Design
Add to wrangler.example.jsonc's vars block, after the FLEET_JUNIOR /
LEAD_* throttle block (lines 104-132), same shape as the other flags:

- `"LEAD_MODEL_POOL": "off"` — active, off by default, matches
  FLEET_TELEGRAM/FLEET_JUNIOR shape. A commented-out gate is invisible to
  the public-config test's JSON parse and to an operator skimming vars.
- `// "LEAD_AI_GATEWAY_ID": "default",` — commented; unset means the same
  default, so no need to force it active.
- `// "LEAD_MODEL_OVERFLOW": "off",` — commented; unset means overflow ON
  (pool's intended behavior), the "off" value is the niche opt-out (#768).
- `// "MODEL_QUALITY_ISSUE": "<issue-number>",` — commented; unset skips
  posting (model-quality-cron.ts:174).
- 1-2 line WHY comment on the block: pool routes lead calls across a
  Workers AI model pool via AI Gateway, see docs/operations.md "Model pool".

Test-first (public-config.test.ts parses vars with `//` comments stripped,
so commented lines are inert to it): add a RED assertion to
test/bun/public-config.test.ts — `LEAD_MODEL_POOL` is `"off"` and the three
optional vars are undefined in the parsed vars (present only as comments).
Watch it fail (var missing today), then make it green by adding the entries.

Placeholder guard: `<issue-number>` uses the `<YOUR_` prefix? No —
deploy-config-placeholder.test.ts checks the literal `<YOUR_` substring on
non-comment lines only; `<issue-number>` lives on a comment line and even
uncommented would not match `<YOUR_`. No `<PLACEHOLDER>` conflicts.

## Steps
1. RED: extend test/bun/public-config.test.ts with one test:
   `LEAD_MODEL_POOL` off + LEAD_AI_GATEWAY_ID/LEAD_MODEL_OVERFLOW/
   MODEL_QUALITY_ISSUE undefined (commented-only). Run
   `bun test test/bun/public-config.test.ts` from apps/fleet — expect the
   new test to FAIL on the missing var.
2. GREEN: add the four entries + WHY comment to wrangler.example.jsonc
   vars block. Re-run the suite — pass.
3. Full `bun test test/bun` (covers public-config, merge-danger,
   deploy-config-placeholder) — all green, no other suite broken.
4. Commit (plan + test + config in one commit), push branch, PR.
   Note: `bun test test/bun` = 3 config suites, light — not a heavy gate;
   the repo's full `check`/vitest belong to CI.
