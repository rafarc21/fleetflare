# PR3b — hook heartbeat, the second ACTIVITY leg

**Issue:** https://github.com/rafarc21/fleetflare/issues/221 (Refs, not Closes — PR3a already shipped the pane leg, #280/#283; this PR is the hook leg, not the whole feature)

**Spec:** `docs/superpowers/specs/2026-09-24-row-tells-truth-design.md`, "PR3 — activity states", specifically "### M4, and what it changes" and the paragraph beginning "Preserved from the pre-existing PR3 sketch... for PR3b" (line ~553).

**Goal:** Claude Code hooks running inside a studio's own container write a small heartbeat file (`/workspace/.fleet/activity.json`) on turn-boundary events. The existing 30s ship tick reads it (one more guarded shell fragment in the exec it already runs — zero new execs). `activity.ts`'s `nextActivity` composes the hook's claim with the pane's own claim: **hooks never override the pane** on `LIMIT`/`WAITING MEMBERS` (a hook has no event for either), and on the `WORKING`/`IDLE`/`waiting-question` axis the **fresher observation wins, ties go to the pane**. `source: "hook"` becomes a real, reachable value on `Activity` for the first time; the rendered string names it (`WORKING 40s (hook)`).

This is additive only — PR3a's pane leg is untouched in its own right. A studio whose container image predates this PR (no heartbeat file ever written) behaves exactly as it does today: the new section reads empty/absent, `nextActivity` sees no hook evidence, the pane decides alone.

## M4 handling (explicit, not an oversight)

**M4** ("does claude 2.1.x hot-reload hooks appended to a live `settings.json` mid-session?") is still unmeasured — Task 6 of the PR3a plan, skipped in every PR3a round. Per the spec's own ruling ("### M4, and what it changes"), M4 decides only how much of the *already-running fleet* lights up immediately; it decides nothing about this PR's own correctness, and #70 forbids forcing a relaunch to find out.

**Decision: build for M4 = no.** Hooks install at bring-up only — `container/studio-bringup.sh`'s existing exec sequence (already re-run by `runProvision`/`runRestart` on every provision/restart, and `/workspace` — with it, any live `~/.claude/settings.json` — is wiped on container replacement). `ACTIVITY`'s *meaning* does not change either way (a hook-sourced verdict is still just a fresher pane-comparable observation, never a new state); coverage of already-running leads grows organically as studios cycle (restart/recycle/replace) on their own, exactly as the spec's "M4 = no" branch describes. This PR does not attempt to measure M4 as a side quest — it would cost a live studio's own `settings.json` edit and add nothing this PR's correctness depends on.

## Global constraints (every task)

- TDD, RED first: write the failing test against the current code, confirm it fails, implement, confirm green.
- `apps/fleet/container/` **is** touched this time — the maestro's brief flags this explicitly ("Container/hook change → image window"), so `git diff --stat origin/main...` for that path is expected to be non-empty, unlike every other PR3 round.
- No new container exec. The heartbeat file read rides `transcript.ts`'s existing `shipTickCmd` chained exec, the same "new section marker, same exec" pattern issue #311's own memguard-log read already established (for the OTHER new section in that same exec — untouched by this PR).
- Hooks never override the pane on `LIMIT`/`WAITING MEMBERS`. Ties go to the pane. `source` only ever reads `"hook"` when the hook's own claim actually won this tick.
- Silent, always exit 0, container-side. `SessionStart`/`UserPromptSubmit` hook stdout enters the lead's own context, and a nonzero exit from `UserPromptSubmit` blocks the call — this hook must never be able to interrupt a turn.
- Do not touch `gates/lead-gate.sh`, `gates/completion-gate.sh`, `gates/session-reemit.sh`, `member-alerts.ts`, or anything under issue #311's own scope — only add alongside them.
- Commit after every task; push incrementally with an explicit refspec.

## Task 1 — `HookHeartbeat` type + `parseHookHeartbeat` + `nextActivity`'s freshest-wins merge

**Files:**
- Modify: `apps/fleet/src/studio/activity.ts`
- Test: `apps/fleet/test/studio.activity.test.ts`

**Design:**

```ts
export type HookHeartbeat = {
  state: "working" | "idle" | "waiting-question"; // the only 3 states a hook can ever observe
  at: string; // ISO — the container's own clock, when THIS event fired
};

export function parseHookHeartbeat(raw: string): HookHeartbeat | null;

export function nextActivity(
  prev: Activity | null,
  verdict: FrameVerdict,
  limit: RateLimitObservation | null,
  membersTickingAt: string | null,
  now: Date,
  hook?: HookHeartbeat | null,   // NEW, optional — every existing call site is unaffected
): Activity;
```

`parseHookHeartbeat` is whitelist-strict on `state` (only the 3 hook-observable values; anything else, including `"limit"`/`"waiting-members"`, is treated as unparseable) and requires `at` to be a `Date.parse`-able string — malformed JSON, a missing field, or an out-of-union `state` all collapse to `null` ("no hook evidence this tick"), never a throw.

`nextActivity`'s precedence, unchanged at the top, new at the bottom:
1. `limitStillLive` → `"limit"`, `source: "pane"` (hook never consulted).
2. `verdict.kind === "waiting-members"` or a fresh `membersTickingAt` → `"waiting-members"`, `source: "pane"` (hook never consulted).
3. Otherwise: hook wins the axis iff `hook !== null/undefined`, `hook.state` is one of the 3 hook-observable values (defense in depth — belt-and-suspenders against a `parseHookHeartbeat` regression, since this is the one seam Principle 5 constrains), `Date.parse(hook.at)` is finite, **and that instant is strictly later than `now`** (the pane's own capture instant for this tick) — ties go to the pane. When the hook wins, `state = hook.state`, `source = "hook"`. Otherwise `state = verdict.kind`, `source = "pane"` (unchanged from PR3a).

`since`/`anchored` bookkeeping is unchanged in shape (holds across same-state ticks, resets on a real change) with one addition: on a **new** state that the hook just won, `since = hook.at` (the hook's own precise transition instant) instead of `now` — this is what lets the rendered string report a hook-sourced age more precise than the 30s tick granularity (`WORKING 40s (hook)`). A new state the pane won still uses `since = now`, exactly as before.

**Why "later than now" is the real-world trigger, not a hypothetical:** `deps.now()` is captured once at the *start* of a ship tick, before the chained exec runs; the exec itself takes real time, during which the lead's own hook can fire and write a timestamp that lands chronologically after that captured `now` but before the tick finishes processing. This is the actual, non-contrived case B1's "0–30s, mean 15s" latency description describes shrinking.

> **Round 2 correction (maestro review, PR #352, HIGH finding) — the paragraph above is WRONG, kept only for history.** Read the actual call chain: `applyActivityVerdict` (do.ts) calls `deps.now()` fresh, INSIDE itself, at the point it calls `nextActivity` — and `applyActivityVerdict` is called from `runShipTickWithObservation`'s SUCCESS path, i.e. AFTER `shipTranscriptTick`'s chained exec has ALREADY returned with both the pane verdict and the hook heartbeat in hand. `now` is therefore always the Worker-side clock read AFTER the whole round trip completes — chronologically LATER than anything a hook could ever have stamped, whether it fired seconds ago or during the exec itself. Combined with the hook's own whole-second-truncated `at` (`gates/activity-heartbeat.sh`'s `write_state`), `hook.at > now` was unreachable in real operation — every test that passed did so only by handing `nextActivity` an artificial future `hook.at`. The hook leg of this PR shipped as a silent production no-op.
>
> **The actual fix:** compare `hook.at` against `prev.observedAt` — the PREVIOUS tick's own stored capture instant — not a freshly-read `now`. `prev.observedAt` is safely anchored in the past by construction (written on an earlier tick), so `hook.at > prev.observedAt` correctly answers "does the hook know about something that happened since we last looked," without "now always exceeds a past stamp" contaminating the comparison. `prev === null` (no prior tick) treats any within-budget hook as new. A tie still goes to the pane, per spec, unchanged. This is also self-limiting: once a hook wins a tick, that tick's own `observedAt` becomes the next `prevObservedAt`, so the SAME `hook.at` can never win twice in a row on its own. A separate absolute staleness budget (`HOOK_STALE_BUDGET_MS`, 90s, mirroring `ACTIVITY_DO_STALE_SECONDS`) additionally guards the case where ticking itself paused for a while (a stopped studio, a held operation lock) — see `hookWinsAxis`'s own doc comment in `activity.ts` for the full reasoning, including why a separate "hook and pane agree, sharpen `since`" path was evaluated and declined.

- [ ] Write RED tests in `studio.activity.test.ts`:
  - `parseHookHeartbeat`: valid working/idle/waiting-question payloads parse; unknown `state` (including `"limit"` and `"waiting-members"`) → `null`; malformed JSON → `null`; missing/unparseable `at` → `null`.
  - `nextActivity` mutant proof (a): a hook claim with `at` later than `now` and a *contradicting* pane verdict wins the WORKING/IDLE axis, `source: "hook"`, `since` = the hook's own `at`.
  - `nextActivity` mutant proof (b), two cases: a live `limit` observation stays `"limit"` even when the hook claims something else and is fresher; a `waiting-members` verdict (or fresh `membersTickingAt`) stays `"waiting-members"` even when the hook claims something else and is fresher. Both prove the hook is never even consulted on these two axes.
  - A tie (`hook.at === now`) or a stale hook (`hook.at <= now`) → pane wins, `source: "pane"`.
  - No `hook` argument at all (existing 5-arg call shape) → identical output to before this task, proving backward compatibility for every untouched PR3a call site.
- [ ] Implement. Confirm green.

## Task 2 — `SECTION_ACTIVITY_HOOK` on the ship tick

**Files:**
- Modify: `apps/fleet/src/studio/transcript.ts`
- Test: `apps/fleet/test/studio.transcript.test.ts`

**Design:** A new marker `SECTION_ACTIVITY_HOOK = "---FLEET-ACTIVITY-HOOK---"`, and a guarded fragment (`cat ${ACTIVITY_HOOK_PATH} 2>/dev/null | base64`) appended to `shipTickCmd`'s returned string **after** the existing `if [ "$FLEET_SIZE" -ge 0 ]; then ... fi` block — i.e., unconditionally, as the very last thing the command emits, regardless of whether the transcript file exists yet. `ACTIVITY_HOOK_PATH = "/workspace/.fleet/activity.json"`, kept in lockstep with `gates/activity-heartbeat.sh`'s own hardcoded path by convention (same container/Worker constant duplication `TRANSCRIPT_LOG_PATH` already accepts against `studio-bringup.sh`'s pipe-pane write — different runtimes, neither can import the other's constant).

**Why appended at the very end, not folded in next to `SECTION_PANE`:** every existing section's end-boundary is computed as "up to the next *known* marker, or end of stdout" (`parsePaneSection`, `parseShipTickSections`). Inserting a brand new marker between `SECTION_PANE` and `SECTION_CHUNK` (or between `SECTION_TAIL` and end-of-stdout) would get swallowed into whichever section precedes it unless every existing boundary computation also learns about the new marker. Placing it last needs only two, surgical boundary fixes instead of rewriting the whole parser:
- `parsePaneSection`'s end becomes `chunkIdx` if present, else `hookIdx` if present (the no-file case, where CHUNK/TAIL are never emitted), else end of stdout.
- `parseShipTickSections`'s `tailB64` end becomes `hookIdx` if present, else end of stdout (previously always end of stdout).

A new function reads the new section itself, with nothing after it to worry about:

```ts
export function parseActivityHookSection(stdout: string): string | undefined; // raw decoded text, or undefined if the marker itself is absent (pre-feature container)
export function readShipTickHookHeartbeat(stdout: string): HookHeartbeat | null | undefined; // undefined = section absent; null = present but empty/malformed; else parsed
```

`ShipResult` gains `hookHeartbeat?: HookHeartbeat | null`, populated on **every** return path of `shipTranscriptTick` (both the no-file skip and the full return — mirroring how `paneVerdict`/`paneFrame` are already populated on both), read unconditionally the same tick the pane frame is.

- [ ] Write RED tests:
  - `shipTickCmd` emits `SECTION_ACTIVITY_HOOK` exactly once, after the existing `if...fi` block, with no added `sleep` and no second exec.
  - `parsePaneSection` and `parseShipTickSections`'s `tailB64` still round-trip correctly now that a marker follows them (regression proof for the boundary fix — this is the one place a mistake here silently corrupts PR3a's own pane/tail reads).
  - `parseActivityHookSection`: round-trips a real heartbeat JSON through base64; absent marker → `undefined`, never a throw; empty section → `""`.
  - `readShipTickHookHeartbeat`: absent → `undefined`; empty/malformed → `null`; valid → the parsed `HookHeartbeat`.
  - `shipTranscriptTick`: `result.hookHeartbeat` reflects the same exec's own section on both the no-file and full-return paths.
- [ ] Implement. Confirm green.

## Task 3 — wire the hook into the tick's merge and storage

**Files:**
- Modify: `apps/fleet/src/studio/do.ts`
- Test: `apps/fleet/test/studio.observation-tick.test.ts`

**Design:** `applyActivityVerdict` gains a new parameter `hookHeartbeat: HookHeartbeat | null | undefined`, threaded straight into `nextActivity`'s new 6th argument. Both existing call sites update:
- The success path (`result.paneVerdict !== undefined` guard) passes `result.hookHeartbeat`.
- The catch-block synthetic `"probe failed"` path passes `undefined` explicitly (no exec result exists there at all — no hook evidence either, same as it already has no real pane evidence).

D1 write-on-state-change-only behavior is untouched — `applyActivityVerdict`'s existing `prevActivity?.state !== nextAct.state` check already covers a hook-driven transition with no code change, since the hook is just one more input to the same `nextAct` value.

- [ ] Write RED tests in `studio.observation-tick.test.ts` (extends the existing `stdoutWithPane` fixture helper to also embed a `SECTION_ACTIVITY_HOOK` section):
  - A fresher, contradicting hook claim flips `ACTIVITY_KEY`'s stored `state`/`source` to the hook's claim (mutant proof (a), exercised through the full `runShipTickWithObservation` path, not just the pure function).
  - A live rate limit, or a fresh `membersTickingAt`, is never overridden by a fresher, contradicting hook claim (mutant proof (b), same full-path exercise).
  - A hook-driven state CHANGE still fires the immediate D1 write (`recordStudioFn`); a hook-driven tick that agrees with the already-stored state does not.
- [ ] Implement. Confirm green.

## Task 4 — `formatActivity` names the hook source

**Files:**
- Modify: `apps/fleet/cli/readiness-format.ts`
- Test: `apps/fleet/test/cli.fleet.test.ts`

**Design:** `formatActivityVerdict` appends `" (hook)"` to the rendered word+age string when `activity.source === "hook"` — this can only ever be true for the `working`/`idle`/`waiting-question` states (limit/waiting-members/unknown never carry `source: "hook"` by construction, Task 1), so no extra state-gating is needed at the render layer.

- [ ] Write RED test: a stored `Activity` with `source: "hook"` renders `WORKING 40s (hook)` (the spec's own example string); a `source: "pane"` verdict is unchanged from PR3a's existing rendering.
- [ ] Implement. Confirm green.

## Task 5 — the container-side hook script

**Files:**
- Create: `gates/activity-heartbeat.sh`
- Test: `apps/fleet/test/bun/bringup-hooks.test.ts` (extends the existing file, same `runSnippet` idiom already used for `lead-gate.sh`/`completion-gate.sh`/`session-reemit.sh`)

**Design:** One script registered on all four events (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`). Event → state map:
- `UserPromptSubmit` → `working`
- `Stop` → `idle`
- `Notification`, payload's own type/category matching `permission_prompt`/`elicitation_dialog` (or, best-effort, the message text containing "permission") → `waiting-question`
- `Notification`, matching `idle_prompt` (or the message text's own "waiting for your input" nudge) → `idle`
- `SessionStart` → **no state write.** Its own `source` field (`startup`/`resume`/`clear`/`compact`) is a cross-check against PR1's container-boot session verdict (`observed.ts`'s `computeSessionVerdict`), a genuinely separate concern from this axis — wiring that cross-check into a stored field is explicitly out of this PR's scope (see "What to build" in the dispatch brief: 4 items, none of which is a SessionStart-driven verdict field). The hook still registers on `SessionStart` (every studio, unconditionally) so a future PR can add the cross-check without a second container/image change; today it is a guarded no-op that always exits 0, same as every other unmatched branch.

Behavior, all load-bearing:
- `[ -n "${STUDIO_ID:-}" ] || exit 0` at the top — same defense-in-depth as `lead-gate.sh`/`completion-gate.sh` (board issue #20): does nothing at all outside a real cloud studio.
- One `python3` read of stdin JSON, extracting `hook_event_name`, a best-effort notification type/category, and the message text — swallowed to empty strings on any parse failure, never a throw past this point.
- Atomic tmp-then-mv write into `${FLEET_ACTIVITY_PATH:-${FLEET_WORKSPACE:-/workspace}/.fleet/activity.json}` — same durability idiom already established elsewhere in this repo's container scripts (`studio-bringup.sh`'s own session-restore placement steps: write to a temp path first, `mv` on the same filesystem, so a mid-write read of the real path is impossible by construction).
- **Fail OPEN**, the one deliberate departure from `lead-gate.sh`/`completion-gate.sh`'s own fail-closed guard shape: no `set -e`, every guarded command falls through to a silent no-op on failure (`|| return 0`, `2>/dev/null`), and the script's last line is an unconditional `exit 0` no matter what happened above.

- [ ] Write RED tests in `test/bun/bringup-hooks.test.ts`:
  - `UserPromptSubmit` → writes `{"state":"working","at":...}`; `Stop` → `idle`; `Notification` with a `permission_prompt`-shaped payload → `waiting-question`; `Notification` with an `idle_prompt`-shaped payload → `idle`.
  - `SessionStart` → the heartbeat file is NOT written (proves the deliberate scope cut above), exit 0.
  - Malformed stdin (`"not json"`) → exit 0, no file written, no stderr noise.
  - An unwritable target directory (mutant proof (c)) → exit 0 regardless — the file write fails silently, the script never propagates that failure into a nonzero exit.
  - `STUDIO_ID` absent → no-op entirely, same guard shape as the existing gates.
  - The write is atomic: a killed mid-write (or a pre-existing file) never leaves a torn/partial JSON body — assert the `.tmp` suffix pattern is never left behind on a successful run.
- [ ] Implement. Confirm green.

## Task 6 — `studio-bringup.sh` wiring

**Files:**
- Modify: `apps/fleet/container/studio-bringup.sh`
- Test: `apps/fleet/test/bun/bringup-hooks.test.ts`

**Design:** A new, unconditional block inside the existing `if [ -n "${STUDIO_NAME:-}" ]; then ... fi` materialization block (same scope `session-reemit.sh`'s own installation already uses — "every studio gets this, maestro included"), placed as a **sibling** of (not nested inside) the `STUDIO_LEAD_DISALLOWED`/`STUDIO_COMPLETION_GATE` conditionals — this heartbeat is observability, not a write-permission gate, so it must not be gated on either. Same copy-then-chmod single-source-of-truth idiom every other hook in this file already uses (`cp /opt/blueprint/gates/activity-heartbeat.sh ~/.claude/hooks/activity-heartbeat.sh`, missing-source warns loudly and falls through, never aborts bring-up), and the same merge-never-clobber settings.json idiom (drop any prior entry mentioning this hook's own filename, then append) — but across **four** hook-event arrays (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`), the last two brand new in this codebase, `SessionStart` appending alongside `session-reemit.sh`'s existing entry, never replacing the array.

The installed command is fail-open, not fail-closed (`[ -x "$S" ] && exec "$S"; exit 0` — no refusal branch), the deliberate one difference from `lead-gate.sh`/`completion-gate.sh`'s guarded command shape right above it in the same file.

**Not added:** no new "fail closed on the gate" check for this hook in the existing refusal block (`~/.claude/hooks/lead-gate.sh` missing/not-executable still refuses bring-up; a missing `activity-heartbeat.sh` must never refuse bring-up — that would turn an observability feature into a boot-blocking one, the opposite of Task 5's fail-open design).

- [ ] Write RED tests in `test/bun/bringup-hooks.test.ts` (extract-and-run the real settings.json-merge python block the same way the existing `PreCompact`-absence test does, via string slicing of `BRINGUP`):
  - The merge block appends `activity-heartbeat.sh` entries to all four event arrays, never replacing `session-reemit.sh`'s own existing `SessionStart` entry.
  - A second run of the same merge (simulating a re-provision) does not accumulate duplicate entries.
  - The installed command string is fail-open (`exec` guarded by `-x`, followed by an unconditional `exit 0`), never the fail-closed `exit 2` shape `lead-gate.sh`/`completion-gate.sh` use.
- [ ] Implement. Confirm green.
- [ ] Confirm `git diff --stat origin/main...HEAD -- apps/fleet/container/` is non-empty (expected and correct for this PR, per the maestro's own note).

## Task 7 — full local gates

Run from `apps/fleet/`: `bun run check && bun run test && bun run english-check && bun run bun-test`. GitHub Actions CI is down for billing this session — local gates are the evidence of record. `bun run bun-test`'s ~149 pre-existing `git-wrapper.test.ts`/`rescue-push.test.ts`/`localci.sh` failures are confirmed unrelated (measured via `git worktree` comparison against unmodified `origin/main` in a prior session) — do not chase them; confirm only this PR's own new/touched tests are green within that run.

## Out of scope, stated here on purpose

- No `member-alerts.ts`, no `memguard-log.ts`, no issue #311 signals of any kind (`MemberAlert[]`, `Observed.memberAlerts`) — a completely separate field on a completely separate path, composed side by side with `Observed.activity`, never merged into it.
- No SessionStart-driven cross-check field, no new `Activity`/`Observed` field beyond what PR3a already shipped — `source: "hook"` becoming reachable is the only shape change.
- No threshold acted on. No wake, no kill, no stop. Observation only, same Principle 2 every PR3 round already holds to.
- No M4 measurement as a side quest (see "M4 handling" above).
