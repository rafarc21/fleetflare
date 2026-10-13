# Sweep 32 F8: wakeStudioWith opts + wake trio clearDraftFirst opts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the long-parameter-list smells sweep-32 flagged (finding F8, tier GLM-OK, refs #663) with zero behavior change. Two independent signatures, both module-boundary refactors of the "same call, named fields" kind: `wakeStudioWith` (do.ts) takes `isMaestro`/`armSweep`/`prompt`/`now`/`studioId` as one inline opts object; the wake trio `runWake`/`runGatedWake`/`afterLimitGate` (wake.ts) takes `clearDraftFirst` as an optional opts object instead of a trailing default-boolean positional.

**Architecture:** Inline type literals, NOT exported — `wakeStudioWith`'s opts and the trio's `{ clearDraftFirst?: boolean }` are both single-caller-family shapes; exporting a name for them would add a public symbol nothing imports. In `wakeStudioWith`, `now` keeps its default in the body (`opts.now ?? (() => new Date())`); in the trio, each body re-derives the local `const clearDraftFirst = opts?.clearDraftFirst ?? false;` so every line below it — the `wakeCmd(flat, clearDraftFirst)` call included — is byte-untouched. `afterLimitGate` takes the same opts shape for uniformity, and `runGatedWake` passes its raw `opts` through at both call sites (switched-block early return and normal exit); `afterLimitGate`'s tail `runWake` call threads the same `opts` object, never a re-derived boolean.

**Spec:** board issue https://github.com/rafarc21/fleetflare/issues/672 (finding S32-F8); sweep-32 census docs (`refs #663`).

## Decisions

- `wakeCmd` (wake.ts `:405`) KEEPS its plain boolean 2nd param: it is a command-string builder, its `clearDraftFirst` is one boolean in a fixed two-arg shape, and `test/bun/wake-cmd.test.ts` executes `wakeCmd("...", true)` against a real tmux pane. Sweep-32 did not flag it; converting it would churn a real-tmux test for zero readability gain.
- `sweepWake` (do.ts `:2297`) NOT touched: its params are `(storage, exec, studioId, prompt, now?)` — all distinct-reading, none a bare boolean or a same-type pair; it is not a long-params finding. Its 2-arg `runGatedWake(...)` call needs nothing.
- `wakeStudioOnAssignment`'s own signature `(prompt: string, clearDraftFirst = false)` NOT touched: it is an RPC surface called with a positional boolean by two do.ts sites (`(prompt) => this.wakeStudioOnAssignment(prompt, true)`, survival-delivery's thunk) and pinned as an exact signature string by two source pins (test/studio.wake-gate.test.ts `:312`, test/studio.wake-race.test.ts `:132`). Only its INNER `runGatedWake` call flips to `{ clearDraftFirst }`.
- failover.ts's 4× `runGatedWake(gatedDeps, AUTO_CONTINUE_PROMPT)` calls stay 2-arg: the optional-3rd-param change is invisible to them.
- RED captures: one vitest suite per change (wake-gate for change 1, wake for change 2) run at the half-flipped signature, verbatim in the completion record.

## Global Constraints

- Zero behavior change: no output text, no command string, no order of execs, no gate decisions changes. `wakeCmd` output must stay byte-identical (`wakeStudioWith`'s `now`/`studioId` threading into `runGatedWake` unchanged; `test/bun/wake-cmd.test.ts` runs the real thing).
- All repository content English. Conventional Commits, `refs #672` trailer.
- Never run the full vitest suite; run suites A (bun) and B (the 11 vitest files) one at a time. Heavy gates (`bun run check`, the heavy vitest suite) run under `flock /tmp/fleet-gate.lock`, never in parallel.
- Baseline counts must reproduce EXACTLY at the end.

---

### Task 1: this plan doc
- [x] Commit this file alone: `docs(fleet): S32-F8 plan — wakeStudioWith opts + wake trio clearDraftFirst opts (refs #672)`, then push the branch.

### Task 2: baseline
- [ ] Suite A (bun): `bun test test/bun/wake-cmd.test.ts test/bun/wake-gate-wiring.test.ts test/bun/wake-guard.test.ts test/bun/pane-probe.test.ts test/bun/tmux-socket.test.ts test/bun/wake-submit-check.test.ts` — record pass/fail/expect counts.
- [ ] Suite B (vitest, heavy, ALONE): `bunx vitest run test/studio.wake-gate.test.ts test/studio.wake.test.ts test/studio.wake-race.test.ts test/studio.routes.test.ts test/studio.rate-limited.test.ts test/studio.auto-continue.test.ts test/studio.parked-auto-resume.test.ts test/studio.failover-214.test.ts test/studio.failover-274.test.ts test/studio.failover-real-panes.test.ts test/github.webhook.test.ts` — record pass/fail/expect counts.

### Task 3: change 1 — wakeStudioWith opts (do.ts `:2281` + 2 do.ts callers + 2 test files)
- [ ] RED: flip the signature first, run `bunx vitest run test/studio.wake-gate.test.ts` alone, capture the failure verbatim.
- [ ] Signature → `(storage: StudioStorage, exec: WakeExec, opts: { isMaestro: boolean; armSweep: () => Promise<void>; prompt: string; now?: () => Date; studioId?: string })`; body reads `opts.isMaestro`/`opts.armSweep`, `now = opts.now ?? (() => new Date())`.
- [ ] Callers: `notifyStaleBackgroundShell` (`:6230`) and `wakeStudio` (`:8371`) pass one inline object.
- [ ] Tests: test/studio.wake-gate.test.ts 8 calls (`:56,67,77,87,98,107,117,347`) and test/studio.routes.test.ts:338 — same object shape, assertions unchanged.
- [ ] GREEN: re-run `bunx vitest run test/studio.wake-gate.test.ts test/studio.routes.test.ts` alone.
- [ ] Commit `refactor(fleet): S32-F8 wakeStudioWith takes named opts, isMaestro no longer a bare boolean (refs #672)`, push.

### Task 4: change 2 — wake trio clearDraftFirst opts (wake.ts + do.ts caller)
- [ ] RED: flip `runGatedWake`/`runWake` signatures, run `bunx vitest run test/studio.wake.test.ts` alone, capture verbatim.
- [ ] `runWake(exec, prompt, opts?: { clearDraftFirst?: boolean })` — body derives local `clearDraftFirst`; `wakeCmd(flat, clearDraftFirst)` untouched.
- [ ] `runGatedWake(deps, prompt, opts?: { clearDraftFirst?: boolean })` — both `afterLimitGate(deps, prompt, screen.stdout, opts)` passes (`:791`, `:804`).
- [ ] `afterLimitGate(deps, prompt, screen, opts?: { clearDraftFirst?: boolean })` — tail `runWake(deps.exec, prompt, opts)`.
- [ ] do.ts `wakeStudioOnAssignment`'s inner call (`:8412`) → `runGatedWake({...}, prompt, { clearDraftFirst })`.
- [ ] GREEN: re-run suite B in full (ALONE), then suite A.
- [ ] Commit `refactor(fleet): S32-F8 wake trio clearDraftFirst becomes named opts field (refs #672)`, push.

### Task 5: full gate (one at a time)
- [ ] `cd /workspace/fleet && flock /tmp/fleet-gate.lock bun run check` — the missed-caller net.
- [ ] `bun run scripts/english-check.ts` → `english-check: clean`.
- [ ] `bun run scripts/test-lies-check.ts` → clean.

### Task 6: final re-run + push
- [ ] Suites A and B one more time, counts matching baseline exactly.
- [ ] Verify `git log origin/main..HEAD` shows both commits pushed.

### Task 7: completion record
- [ ] Write /workspace/.fleet/done/672.json (outside the repo) with the real outputs. NEVER commit it.
