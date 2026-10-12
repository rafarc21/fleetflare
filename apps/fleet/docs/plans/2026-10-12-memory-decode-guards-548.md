# Plan — memory cmd halves guard their 200-body decodes (closes #548)

Sweep-19 F4+F5 (docs/maintainability/2026-10-12-exit-codes-sweep-19.md, parent #539):
cmdMemoryCompact JSON.parse'd the 200 body unguarded — a non-JSON 200 crashed into main()'s
catch as `fleet: <SyntaxError>`, never naming that the PR may have landed server-side. cmdMemoryLs cast
res.json() with no shape check — same crash. Sibling decodes all own 200-guards (cmdLs, fleet.ts:892).

## Change (both guards mirror cmdLs: named line, stderr, exit 1)
- cmdMemoryCompact: wrap JSON.parse(text) in try/catch — on failure print
  `fleet memory compact: 200 but the body was not JSON — the pass may have
  landed; check the board repo's open PRs`, exit 1.
- cmdMemoryLs: parse + shape-check in one try (repo/ref strings,
  index/unindexed/files arrays, truncated boolean) — on failure print
  `fleet memory ls: answered 200 but the body was not the survey shape`.

## TDD
RED (39c2540): two malformed-200 pins. GREEN (71a0448): the guards; 9/9.
Round 1 (d68af38 plan trim, 1c89a23 files-row + compact-shape guards with
two more pins): 11/11 in that file, `bun run check` + english-check green.
Two-way door: revert restores the two unguarded decodes.
