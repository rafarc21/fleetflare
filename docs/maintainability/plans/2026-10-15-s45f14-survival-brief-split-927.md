# #927 plan — S45-F14 split studio.survival-brief.test.ts: compose vs invariants (refs #907)

Sweep 45 finding F14 (docs/maintainability/2026-10-15-oversized-tests-sweep-45.md F14).
Pure move: 1429-line vitest file -> two files, describes whole, titles verbatim,
24 describes / 146 tests unchanged (baseline: 146 pass). Split hazards read + honored:
in-file fakes duplicated not extracted (h2), no shared beforeEach (h4), #NNN provenance
verbatim (h5).

## Seams (grep-verified against working file)
- test/studio.brief-compose.test.ts <- old :1-328 (preamble + 6 describes :44 :221 :248
  :269 :285 :313).
- test/studio.brief-invariants.test.ts <- old :329-1429 (18 describes :329 :418 :475 :507
  :534 :587 :621 :739 :806 :864 :902 :937 :966 :1021 :1113 :1149 :1214 :1359).

## Shared setup (duplicated verbatim, no extraction)
- Both: NOW/CONTROL_CHAR_RE :13-14, baseInput :16-27, baseSession :31-42.
- Compose imports: composeSurvivalBrief, SurvivalInput, SurvivalWipRef, ObservedSession.
- Invariants imports: + sanitizeBranch, RESUMED_TRUST_ORIGIN_LINE, RestoreOutcome,
  formatAge (+ its S14-F7 comment) — exact, no unused. Invariants-only helpers
  sessionLineOf/HOSTILE/SAFE :857-862. No file-set guard references this file.