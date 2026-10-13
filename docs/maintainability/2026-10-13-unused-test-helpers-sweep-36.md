# Unused-test-helpers sweep 36 — apps/fleet test/helpers + test/bun/helpers (2026-10-13)

Ref #739. Doc-only sweep, read-only, no code changed. Thirty-sixth
maintainability sweep; scope the test-helper surface, `apps/fleet/test/helpers/`
and `apps/fleet/test/bun/helpers/`. Line refs = physical lines at `origin/main`
`0cd438f`, paths relative to `apps/fleet/`.

Method: scripted cross-reference of all 19 named exports across the 10 helper
modules — `test/helpers/` (bringup-pins.ts: 3 exports, datetime.ts: 2,
do-storage.ts: 1, fake-namespace.ts: 3, http.ts: 1, studio-row.ts: 4) and
`test/bun/helpers/` (credentials.ts: 1, poll.ts: 1, shell.ts: 2, tmux-env.ts:
1) — against an importer map over test/, test/bun/, test-integration/. Comment
mentions do not count as imports; re-exports do not count; a helper's own golden
self-test (test/helpers/do-storage.test.ts, test/helpers/fake-namespace.test.ts,
test/studio-row.helper.test.ts) counts as sole-test-importer when it is the only
importer — same class as sweep-24's F14 seam record.

**Tier rule:** GLM-OK = none of auth, secrets, tokens, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate,
approvals. CLAUDE-ONLY = touches any of those. All three findings here are
GLM-OK.

**Sweep's rule for what counts:** an export is a finding when no suite file
imports it by name — either zero importers anywhere (zero-importer), or the
only importer is the helper's own golden test (sole-test-importer). In the
helper lane a helper's consumer IS a suite; a golden test alone proves the
contract but serves no suite, so sole-test-importer helpers are recorded with
the keep-or-delete verdict stated.

## Census (full 19-export population — completeness proof)

| export | file:line | suite importers | verdict |
|---|---|---|---|
| bringupSrc | test/helpers/bringup-pins.ts:11 | studio.session.test.ts (1) | used |
| expectBrings | test/helpers/bringup-pins.ts:16 | studio.session.test.ts | used |
| expectBringsNot | test/helpers/bringup-pins.ts:21 | studio.session.test.ts | used |
| fixedNow | test/helpers/datetime.ts:3 | burn, readiness, session, transcript (4) | used |
| b64 | test/helpers/datetime.ts:7 | session, transcript (2) | used |
| fakeStorage | test/helpers/do-storage.ts:10 | wake-gate, readiness, restart-count, stopped-stays-stopped, sweep, transcript, observed, self-heal (8) | used |
| NsStub (type) | test/helpers/fake-namespace.ts:14 | none | zero-importer — F2 |
| nsWith | test/helpers/fake-namespace.ts:20 | fleet-resume, index, profile, paste (4) | used |
| envWithNs | test/helpers/fake-namespace.ts:30 | grid, burn-window-expiry (2) | used |
| authorizedReq | test/helpers/http.ts:4 | grid, burn-window-expiry, paste (3) | used |
| row | test/helpers/studio-row.ts:8 | fleet-resume, repo, burn, grid, readiness, spawn-atomic, cli.studio-row, cli.fleet, do, observation-tick, start-gate-writeback, burn-window-expiry, board.leak + 6 bun fleet-ls files (19) | used |
| runningRow | test/helpers/studio-row.ts:16 | 5 bun fleet-ls files + denominator alias + repo + board.leak (8) | used |
| stoppedRow | test/helpers/studio-row.ts:17 | studio-row.helper.test.ts only (golden self-test) | sole-test-importer — F1 |
| burnRow | test/helpers/studio-row.ts:26 | studio-row.helper, grid, cli.fleet (3) | used |
| writeCredentials | test/bun/helpers/credentials.ts:6 | junior-stats-cli, task-state-cli, cli.task-verify, cli.task-reap, accounts-cli (5) | used |
| waitFor | test/bun/helpers/poll.ts:5 | 4 ego-browser suites | used |
| ShResult (type) | test/bun/helpers/shell.ts:1 | none | zero-importer — F3 |
| sh | test/bun/helpers/shell.ts:5 | memory-migrate, memory-clone, localci-run (3) | used |
| isolatedTmuxEnv | test/bun/helpers/tmux-env.ts:14 | pane-probe, inspect-cmd, wake-submit-check, incarnation-newline, wake-cmd (5) | used |

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | test/helpers/studio-row.ts:17 `stoppedRow` — sole-test-importer (golden self-test only); suites hand-build stopped rows via the override idiom or shadowing local consts | GLM-OK |
| 2 | test/helpers/fake-namespace.ts:14 `NsStub` (type) — zero importers; flows to callers through nsWith/envWithNs signatures | GLM-OK |
| 3 | test/bun/helpers/shell.ts:1 `ShResult` (type) — zero importers; sh()'s signature carries it to every caller | GLM-OK |

### S36-F1. test/helpers/studio-row.ts:17 — `stoppedRow` — sole-test-importer — GLM-OK

- **Export:** `export const stoppedRow = (o: Partial<StudioStatus> = {}) => row({ state: "stopped", ...o });` (studio-row.ts:17) — the stopped-state counterpart of runningRow.
- **Zero-suite-importer proof:** `grep -rn "stoppedRow" --include="*.ts" apps/fleet --exclude-dir=node_modules` returns exactly four files: studio-row.ts itself (:17), test/studio-row.helper.test.ts (:3 import, :24-28 and :37-38 golden pins), and the two suites whose local consts shadow the name (below). Zero of the hits are import statements — no suite builds a stopped row through the helper.
- **The idiom that displaced it:** suites spell the stopped state as an override on the shared builders — `row({ id: "...", state: "stopped", ... })` at test/studio.fleet-resume.test.ts:29 (imports the shared row() plainly), and the same override idiom on runningRow via the runningRow-as-row alias at test/bun/fleet-ls-denominator.test.ts:13, :15, :16; `{ ...running(), state: "stopped" }` at test/studio.observation.test.ts:239; two files shadow the name with local consts: test/studio.session.test.ts:1585 (`const stoppedRow = { ...runningRow, state: "stopped" as const }`) and test/studio.readiness.test.ts:275, :304 (`const stoppedRow = status({ state: "stopped", readiness: null })` via local status() builders). A local const named stoppedRow in two suites is itself evidence the helper lost the name race: an import and the local const cannot coexist unaliased.
- **Proposed action:** either delete (un-export + drop the two golden-test pins at studio-row.helper.test.ts:24-28, :37-38 — the override idiom `row({ state: "stopped", ... })` is established and states its intent equally well) or adopt at the one clean site (fleet-resume.test.ts:29's local status() wrapper, where stoppedRow would replace the state pin) where `stoppedRow({...})` reads better than the override. Recommend delete: runningRow earns its 8 importers; stoppedRow's zero suite importers after a full sweep-18 adoption pass (#596, merged in #397 and follow-ups) is the market's verdict. Caveat for the fix task: the 2 shadowing files must NOT be touched in an adoption pass — their local consts are load-bearing names.
- **Note:** test/studio.spawn.test.ts:388, :409 and test/studio.resume-guards.test.ts:23-29 also hand-build stopped rows, but via their own local status()/row() builders with divergent defaults (resume-guards pins parked/stoppedAt) — listed for the record, NOT adoption candidates (spawn is CLAUDE-ONLY lane per sweep-18 F9; resume-guards' builder diverges by design).

### S36-F2. test/helpers/fake-namespace.ts:14 — `NsStub` (type) — zero-importer — GLM-OK

- **Export:** `export type NsStub = Record<string, unknown> | ((id: string) => Record<string, unknown>);` (fake-namespace.ts:14).
- **Zero-importer proof:** `grep -rn "NsStub" --include="*.ts" apps/fleet --exclude-dir=node_modules` returns only fake-namespace.ts (:14 declaration; :20 and :30 in its own signatures). The module's 6 suite importers (grid, burn-window-expiry, fleet-resume, profile, paste, index) import nsWith/envWithNs only; the type flows to callers through those signatures.
- **Proposed action:** un-export — drop the keyword, keep the type for the module's own two signatures (sweep-24 F9's Intercept precedent: a convenience type export nobody took). One line, tsc pins it. Same-day alternative: keep exported as documentation-grade surface; not recommended while sweep-24's precedent (un-export unused types) stands.

### S36-F3. test/bun/helpers/shell.ts:1 — `ShResult` (type) — zero-importer — GLM-OK

- **Export:** `export type ShResult = { code: number; out: string; err: string };` (shell.ts:1).
- **Zero-importer proof:** `grep -rn "ShResult" --include="*.ts" apps/fleet --exclude-dir=node_modules` returns only shell.ts (:1 declaration; :8 return type of sh()). The 3 suite importers (memory-migrate, memory-clone, localci-run — each `import { sh as shShared }`) import sh only.
- **Proposed action:** un-export — same class as F2, one-line keyword drop; sh()'s signature carries the type to every caller.

## Not filed (counted, no issue)

- The two co-located golden tests export nothing (`grep -c export` = 0 on test/helpers/do-storage.test.ts and test/helpers/fake-namespace.test.ts) — counted, nothing to flag.
- test/helpers/bringup-pins.ts (3 exports), datetime.ts (2), do-storage.ts (1), http.ts (1) and test/bun/helpers/credentials.ts (1), poll.ts (1), tmux-env.ts (1): every export imported by at least one suite — clean.
- test/studio.routes-accounts.test.ts:399 and test/studio.routes-handle.test.ts:397 each hand-roll a local authorizedReq instead of importing helpers/http.ts — a sweep-18-shaped adoption gap, but routes-accounts is accounts-routing lane (CLAUDE-ONLY) and routes-handle's local copy was out of this sweep's zero-importer scope (the helper itself has 3 importers). Recorded for a future duplication sweep, not filed here.

## Summary

3 findings, all GLM-OK: 1 sole-test-importer builder (F1 stoppedRow — recommend delete, adoption alternative recorded), 2 zero-importer convenience types (F2 NsStub, F3 ShResult — un-export, one batch). 16 of 19 exports clean. Follow-up issues: F1 (one issue), F2+F3 (one combined un-export issue).
