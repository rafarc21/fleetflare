# Plan — S37-F2+F3 repair-failure.ts cite fix (refs #788)

Sweep 37 findings 2+3: docs/maintainability/2026-10-10-deep-modules-sweep-2.md
cites two line ranges inside cli/repair-failure.ts that never existed. The doc
pins line refs at origin/main f0d178d; at that commit the file is 57 lines,
destroyPath at :45. Today 66 lines, destroyPath at :52. Max ever 69 lines —
:161-173 and :161 never existed at any commit.

Change — that doc only, two lines:

- F13 (line 258): `grab-bag cli/repair-failure.ts:161-173` →
  `grab-bag cli/repair-failure.ts`. The grab-bag claim is file-level
  (repairFailureLine + destroyPath + discardNote, three unrelated helpers),
  so the range drops rather than repoints.
- F14 (line 267): `cli/repair-failure.ts:161` (destroyPath) →
  `cli/repair-failure.ts:45` — the pin's own line, per the doc's line-134
  convention (line refs = physical lines at f0d178d).

Nothing else in the file. No code, no tests affected.

Verify: `bun run english-check` in apps/fleet — zero exit.
