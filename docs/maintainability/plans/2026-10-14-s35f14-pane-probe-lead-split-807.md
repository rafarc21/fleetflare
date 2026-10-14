# Plan — S35-F14 split test/bun/pane-probe-lead.test.ts into identity vs scope halves

Task: https://github.com/rafarc21/fleetflare/issues/807 (parent sweep #735, finding F14, GLM-OK lane).
Doc: docs/maintainability/2026-10-13-mid-size-test-files-sweep-35.md §F14.

## Problem

657 lines, ONE describe.skipIf(!isLinux) lane suite (:312) wrapping 11 flat
tests against a REAL tmux server. Preamble :1-311 is load-bearing isolation
(the 2026-09-24 incident comment records two leads dying when it was weaker):
isolatedTmuxEnv + socketFlag + assertIsolatedEnv hard guards, plus
installFakeClaude / quoteSingle / fakeLead / LEAD_* fixtures /
waitForPane / startLeadInPane builders.

## Change

Pure move, one file becomes two. Tests whole, titles verbatim, zero
assertion edits. Both halves copy the preamble VERBATIM (sweep-33 fold bar
is 3 copies; this makes 2). Extraction to test/bun/helpers is a later
dedup step — the split copies verbatim first.

1. `test/bun/pane-probe-lead-identity.test.ts` — current :313-474 (7
   tests): member `claude -p` never the lead, missing studio:claude window
   found:false, per-argv --continue detection, no raw argv / lead cwd,
   lead-vs-member argv+cwd, substring-containment (argv elem) and
   --append-system-prompt value containment.
2. `test/bun/pane-probe-lead-scope.test.ts` — current :476-657 (4 tests):
   foreign pane/unrelated claude never found, foreign lower-pid claude
   never confuses pid-tree scoping, shell-only session found:false, private
   -L fleet-studio socket auto-detection (#117). Each half gets a short
   new header naming it as one half of the former
   pane-probe-lead.test.ts and pointing at the other half.
3. Delete test/bun/pane-probe-lead.test.ts.

No stale-name comments elsewhere cite the old file (verified by grep;
only historical sweep docs name it, they stay untouched). No tsc project
wiring changes — test/tsconfig.json includes bun/**/*.ts by glob.

## Verification

- Baseline (captured on origin/main): `cd apps/fleet && bun test
  test/bun/pane-probe-lead.test.ts` — 11 pass, 43 expect(), 9.56s.
- After: `cd apps/fleet && bun test test/bun/pane-probe-lead-identity.test.ts
  test/bun/pane-probe-lead-scope.test.ts` — 11 tests, 0 fail (7+4).
- Invariance, run against `git show origin/main:apps/fleet/test/bun/pane-probe-lead.test.ts`:
  sorted test titles identical; sorted expect() lines identical; preamble
  byte-identical in both halves.
- `cd apps/fleet && bun run english-check` — clean.
- `cd apps/fleet && bun run test-lies-check` — 0 findings.
- `cd apps/fleet && bun run check` — heavy gate (five tsc projects), once,
  alone, under flock /tmp/fleet-gate.lock.
