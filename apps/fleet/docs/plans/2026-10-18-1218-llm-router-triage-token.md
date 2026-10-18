# Plan — task #1218: scoped router-only triage credential for the llm router

Adds Worker secret TRIAGE_ROUTER_TOKEN so the local oss-triage daemon can
call /fleet/llm/anthropic/v1/messages (and count_tokens) without a spawn
token. No issue refs, no closing keyword. One PR.

## Change
1. env.ts: optional TRIAGE_ROUTER_TOKEN?: string.
2. anthropic-route.ts: TRIAGE_DAEMON_ID = "triage--daemon"; when the
   presented token is not spawn-shaped but equals the secret (constant-time,
   SHA-256 digest compare — workerd has no timingSafeEqual), authenticate as
   { id: TRIAGE_DAEMON_ID, repo: "oss-triage", role: "daemon" }. Spawn-token
   path and its leadType gate are untouched; the triage branch skips the
   leadType check and never reads the registry.
3. Rate limits + usage log already key on studio.id, so the daemon draws its
   own lead-rate bucket and logs under "triage--daemon" automatically.
4. wrangler.example.jsonc: note the new secret in the header comment.

## Scope / out-of-scope
Only the two llm routes accept it. Spawn/board/studio routes never read the
secret. Out of scope (flagged, not changed): the daemon's non-small model
names still get withOssLeadContinueRule applied by the messages route.

## Tests (failing first)
test/llm.anthropic-triage.test.ts — accepted on messages (200, usage row
studioId "triage--daemon"); accepted on count_tokens (200, no env.AI.run);
wrong token 401; unset secret = unchanged (triage 401, spawn token still 200);
rate limit applies (LEAD_RATE_PER_MINUTE=1 -> second call 429); rejected on
the spawn route (401).

## Verify
bun run test -- test/llm.anthropic-triage.test.ts; bun run check;
bun run english-check; bun run test-lies-check.