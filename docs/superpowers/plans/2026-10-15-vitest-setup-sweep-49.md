# Task 992 — vitest per-file setup cost sweep (sweep 49, refs #992, #715)

Doc-only PR: one findings doc, no code changes. Each finding = evidence
(file:line + measured ms) + proposed change + expected saving + isolation risk.

Measured locally (vitest run <single file> --reporter=verbose, bun 1.3.12,
vitest-pool-workers 0.19.1):
- board.envelope.test.ts: Duration 10.13s (setup 8.15s, tests 32ms)
- board.leak.test.ts: Duration 7.46s (setup 6.05s, tests 32ms)
- studio.burn.test.ts: Duration 72.35s (setup 5.94s, tests 64.96s)
- agents.do.test.ts: Duration 6.82s (setup 5.55s, tests 179ms)

Findings feed #715: a sharded gate runner must not multiply this per-file
fixed cost across N shards.

## Steps
1. Write docs/maintainability/2026-10-15-vitest-setup-sweep-49.md (max 12 findings)
2. Commit + push branch sweep-49-vitest-setup-cost
3. File one issue per change: test(GLM-OK): S49-Fn <short> (lead does this after push)
4. Lead opens doc-only PR
