# Plan — #876 S43-F2 session-reemit grep-dependency comment (sweep 43, ref #855)

Census: docs/maintainability/2026-10-14-gates-shell-sweep-43.md (F2).

## Problem

gates/session-reemit.sh:31-33 claims grep is "already a dependency of this same
script" via a "settings.json hook-presence check further down". False: this
37-line file holds no settings.json check; grep's only use is line 34
(whitespace check on the working-set file). The check the comment means lives
in apps/fleet/container/studio-bringup.sh:1207 — a different file this hook
never reads. Stale since birth (PR #308, 2026-10-09).

## Change (comment-only)

Reword lines 31-33 to what is true: line 34 is grep's only use in this
script; the dependency adds nothing new to the image because bring-up
(studio-bringup.sh:1207) already uses grep against settings.json in the same
image. No literal `settings.json` string may remain in session-reemit.sh
(verify step greps for 0 hits). No executable line changes.

## Verification

1. `cd apps/fleet && bun test test/bun/bringup-reemit.test.ts` — green
2. `grep -n 'settings.json' gates/session-reemit.sh` — 0 hits
3. `bun run english-check` — clean
4. `bun run test-lies-check` — 0 findings
5. `bun run check` — clean (heavy gate, run alone)

## Boundaries

gates/session-reemit.sh comment block only. Do not touch
activity-heartbeat.sh (F1, separate issue). No executable changes.
