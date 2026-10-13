# 698 — S26-F11 observation-tick split (refs #635)

Sweep 26 F11 (docs/maintainability/2026-10-13-oversized-test-files-sweep-26.md):
test/studio.observation-tick.test.ts (2163 lines, 15 describes) splits on topic.
Pure move: 7 gate describes (incarnationPatch table, one-exec adoption, op-lock
guard, immediate D1 write, hook heartbeat merge, reachability, adoption verdict)
go verbatim to new test/studio.observation-gates.test.ts; the 8 tick describes
keep the old name and 8-line header. Shared preamble is duplicated then trimmed
per file — dup-not-extract (extraction is sweep-18's lane, never both at once).

## Plan

1. Baseline vitest + per-describe it() counts (89), saved outside the repo.
2. Gates: new 4-line header + trimmed preamble + old :123-954 verbatim; tick:
   kept header + trimmed preamble + old :956-2163 verbatim.
3. Preservation proof: per-describe + whole-region diff vs HEAD, exit 0 each.

## Verification

- Both files: 89 passed (= baseline), recount matches; then sequentially: bun run check, english-check, test-lies-check.
