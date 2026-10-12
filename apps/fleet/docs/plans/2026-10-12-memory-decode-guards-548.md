# Plan — memory cmd halves guard their 200-body decodes (closes #548)

Sweep-19 findings F4+F5 (docs/maintainability/2026-10-12-exit-codes-sweep-19.md,
parent #539): cmdMemoryCompact JSON.parse's the 200 body unguarded — a
non-JSON 200 crashes into main()'s catch as `fleet: <SyntaxError>`, never
naming that the PR may have landed server-side. cmdMemoryLs casts res.json()
with no shape check — a wrong-shaped 200 throws the same way. Every sibling
decode owns its 200-guard (cmdLs: parseStudioStatusArray → named line +
exit 1, fleet.ts:892-896).

## Change (both guards mirror cmdLs's posture: named line, stderr, exit 1)

- cmdMemoryCompact (fleet.ts:2629): wrap `JSON.parse(text)` in try/catch; on
  failure print `fleet memory compact: 200 but the body was not JSON — the
  pass may have landed; check the board repo's open PRs` to stderr, exit 1.
- cmdMemoryLs (fleet.ts:2578): read body as text, parse+shape-check in one
  try (repo/ref strings, index/unindexed/files arrays — files rows only
  feed formatMemoryTable, which reads target/citations/ageMs/indexed/
  verdict); on failure print `fleet memory ls: answered 200 but the body
  was not the survey shape` to stderr, exit 1.

## TDD

RED (this branch, first commit): extend test/bun/memory-cmd.test.ts with
two malformed-200 cases — ls gets a 200 non-JSON body, compact gets a 200
HTML body; both must exit 1 with the exact lines above, and compact's case
must not throw `fleet: <SyntaxError>`. GREEN: the two guards in fleet.ts.
Two-way door: revert restores the two unguarded decodes.
