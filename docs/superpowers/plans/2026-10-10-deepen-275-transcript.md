# Deepen: transcript.ts — 22 test-only exports behind the production interface (board issue #275)

Issue: https://github.com/rafarc21/fleetflare/issues/275. Tier **GLM-OK**:
behavior-preserving, characterization tests at the interface first, one
module per PR. Refs #259, never closes.

## Source

Board issue #275, filed from the deep-modules sweep (#259 Part B1) —
`docs/maintainability/2026-10-08-deep-modules-sweep.md`, finding F15
(lines 357-366), Strength: Worth exploring. Skill step: CD "the interface
is the test surface" + DEEPENING "replace, don't layer". Dependency:
in-process + exec (local-substitutable) — fake `exec`/`r2Put`/storage
already exist in the test suite.

The sweep doc's "9 shell-string asserts" undercounts today's file: the
shell-shape describe block has 6 `it`s, and ~30 more asserts across the
file pin `shipTickCmd`/`rotateCmd` output strings or call the `parse*`/
`read*`/`decodeTailPreview` helpers directly. All re-verified against
HEAD d571954 in this plan's research pass.

## Problem

`apps/fleet/src/studio/transcript.ts` exports 25 values (+5 types). Its
ONE production importer, `src/studio/do.ts:96-98`, uses three values —
`shipTranscriptTick`, `getTranscriptTailWithStorage`, types
`ShipDeps`/`TranscriptStorage`/`ShipResult`. The other 22 values exist
only so tests can reach inside:

- 2 paths: `TRANSCRIPT_LOG_PATH`, `TRANSCRIPT_BOOT_ID_PATH`
- 3 keys: `TRANSCRIPT_MANIFEST_KEY`, `TRANSCRIPT_TAIL_KEY`,
  `TRANSCRIPT_BOOT_ID_KEY`
- 7 markers: `SECTION_BOOTID/STAT/INCARNATION/CHUNK/TAIL/PANE/
  ACTIVITY_HOOK/MEMGUARD` (+ `ACTIVITY_HOOK_PATH`, never used by
  production code either)
- 2 command builders: `shipTickCmd`, `rotateCmd`
- 7 parse/read/decode helpers: `parsePaneSection`,
  `readShipTickActivity`, `parseMemguardSection`,
  `readShipTickMemguardKills`, `parseActivityHookSection`,
  `readShipTickHookHeartbeat`, `decodeTailPreview`

Interface 3× wider than production needs (CD: shallow). Tests pin
internals, so any internal refactor breaks them (DEEPENING: "If a test
has to change when implementation changes, it's testing past the
interface"). Worst offenders are tautologies —
`expect(deps.execCalls[0]).toBe(shipTickCmd(0, undefined))` builds the
expected string with the same builder that produced the actual; a bug in
the builder passes (test-lies-check's tautological class, #164).

F15 note: incarnation fragments at `transcript.ts:395-404` overlap F9 —
this PR lands first, so no coordination needed; F9 must not un-export
anything this PR keeps exported.

## Interface (after)

```
shipTranscriptTick(deps, storage, id, adoptionToken?, bringupVia?) -> ShipResult
getTranscriptTailWithStorage(storage) -> string
types: ShipDeps, TranscriptStorage, ShipResult
```

Nothing else. All 22 test-only values lose `export`. No production code
change — `do.ts` imports stay valid untouched.

## Test migration — what each internal-pinning test becomes

Every behavior the current suite pins must survive as an assertion
through `shipTranscriptTick`/`getTranscriptTailWithStorage` with the
existing fake `exec` + fake storage. Direct commands no longer
importable → tests synthesize `exec` responses (the `fakeDeps` +
`rawTickStdout` machinery already does this) and assert on OBSERVED
outcomes: R2 keys/bytes, storage writes, `ShipResult` fields, thrown
messages.

Tautology fix: instead of `expect(execCalls[0]).toBe(shipTickCmd(...))`,
assert the command string the tick sent with hardcoded literals
(`test/studio.observation-tick.test.ts:33-34` precedent — markers are
part of the container↔Worker wire format, stable by the same
"convention lockstep" argument `ACTIVITY_HOOK_PATH`'s own doc comment
makes for the script path). A hardcoded-literal assert CAN fail when the
builder drifts — that is the point.

Migration map (old -> new test surface):

| Current internal assert | New characterization (same behavior) |
| --- | --- |
| `shipTickCmd` exact-shell-string block (6 its) | tick-path asserts: command sent starts `FLEET_FRESH_BOOT_ID=` / contains hardcoded marker echoes + read shapes; chunk/tail only when size ≥ 0 |
| `rotateCmd` exact string | rotate exec call observed when over-threshold+caught-up; second-exec call with `stat ... -le <N>` literal gated on shipped size |
| `decodeTailPreview` direct calls (6 its) | through tick: tail bytes with orphaned UTF-8 heads -> stored `transcriptTail` has no U+FFFD (already one such; extend to 1/2/3-orphan + clean cases via `rawTickStdout`/`tail` options) |
| `parsePaneSection`/`parseActivityHookSection`/`parseMemguardSection` direct | through tick: `result.paneFrame`/`hookHeartbeat`/`memguardKills` on the same fake stdout (these ARE the production read path — do.ts consumes `ShipResult` fields) |
| `readShipTickActivity/HookHeartbeat/MemguardKills` direct | same fake stdout through `shipTranscriptTick`: verdict/heartbeat/kills fields, undefined-on-absent, empty/degraded postures |
| base64 alphabet '-'-collision its | keep — pure btoa math, no transcript import needed after markers go local |
| parser matrix (`rawTickStdout` partials) | unchanged — already goes through `shipTranscriptTick` |
| incarnation/adoption its | unchanged — already through the tick |

Sibling test files (imports must survive un-export):

- `test/studio.restart-count.test.ts` — uses `SECTION_*`,
  `TRANSCRIPT_BOOT_ID_KEY/MANIFEST_KEY` only to BUILD fake stdout and
  read fake storage. Markers/keys go local-literal (same values, now
  pinned as wire format), imports drop.
- `test/studio.observation-tick.test.ts` — already local-literal for
  PANE/MEMGUARD; imports only `SECTION_ACTIVITY_HOOK` (value) — goes
  local-literal too.
- `test/studio.do.test.ts` — imports `SECTION_PANE` value — local literal.
- `test/studio.grid.test.ts` — uses only `getTranscriptTailWithStorage` +
  type. Untouched.
- `test/studio.failover-274.test.ts` — type-only import. Untouched.
- `test/bun/cmd-syntax.test.ts` — `bash -n` on `shipTickCmd`/`rotateCmd`
  output. The two-line script shape is a load-bearing fleet-wide safety
  net (issue #85 BLOCKER 1: real-shell glue bugs). Cannot build the
  command through the interface. Decision: keep the bash -n net, source
  the command locally — a faithful re-declaration of the builder's
  contract in the test (path literals + marker echoes + the exact
  `paneLeadProbeCmd()`-embedding shape is what #85 proved must be
  `bash -n`'d). Reviewed in step 2 for drift against the real builder by
  a one-line runtime equivalence: ship tick's sent-command captured via
  `fakeDeps`-style capture is what vitest pins (hardcoded literals), so
  vitest holds the builder, bun holds the shell grammar.
- `test/bun/incarnation-newline.test.ts` — real-shell round-trip on the
  incarnation read/write fragments. Same decision: local literal
  command + markers (the file's own hermetic `replaceAll` redirect
  convention already depends on path literals, not imports).

## Steps (TDD)

1. **Characterization first (RED where new, then GREEN on same HEAD):**
   rewrite `test/studio.transcript.test.ts` to import ONLY
   `shipTranscriptTick` + `getTranscriptTailWithStorage` + the 3 types
   (+ archive/observed/restarts values that are themselves production
   interfaces of THEIR modules). Hardcoded wire literals for markers,
   paths, keys. Run against UNMODIFIED transcript.ts — all pass
   (characterization). Fix the 3 sibling vitest files' imports same
   commit. Commit + push.
2. **Un-export (GREEN):** drop `export` from the 22 values in
   `transcript.ts` (types `ShipDeps`/`TranscriptStorage`/`ShipResult` and
   the two functions keep it). Update the two bun test files to local
   literals. `tsc --noEmit` + targeted vitest + `bun test test/bun` all
   green. Commit + push.
3. **Gates, one heavy at a time:** targeted vitest files
   (`studio.transcript`, `studio.restart-count`, `studio.observation-tick`,
   `studio.do`, `studio.grid`, `studio.failover-274`), then
   `bun test test/bun`, then `bun run check` (flock), english-check,
   test-lies-check (must stay 0 findings).
4. **Review + PR** per delivery-standards loop (max 2 rounds), envelope
   on the issue, done record `/workspace/.fleet/done/275.json`.

## Boundaries

- `apps/fleet/src/studio/transcript.ts`, its two test files, and the
  three sibling vitest files' import lines ONLY. No `do.ts` change
  needed (its imports stay valid). No `archive.ts`/`observed.ts`/
  `restarts.ts`/`activity.ts`/`memguard-log.ts` change.
- Verifying step 1+2 runs the vitest transcript-family files and
  `bun test test/bun` several times and `bun run check` once — heavy
  gates queued, never parallel (house rule).
- No behavior change: `shipTranscriptTick`'s observable contract
  (throws, results, R2 keys, storage writes) byte-identical. The ONE
  intended observable diff: the module's export surface shrinks.
