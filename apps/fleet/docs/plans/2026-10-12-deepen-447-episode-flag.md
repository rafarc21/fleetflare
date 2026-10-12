# One episode-flag module behind the "1"/"0" flag dances — board #447

**Goal:** Fold the "a fleet_state flag is an episode marker: '1' until the episode ends, then '0'" rule into three named wrappers (flagIsSet/markEpisode/clearEpisode) in src/state.ts, and route the four hand-rolled sites through them. Wire values stay "1"/"0", keys unchanged, behavior byte-identical.

**Architecture:** Pure refactor over the existing getFlag/setFlag — the three wrappers ARE thin calls into them, no new SQL. Three homes today: watchdog.ts's clearRearm (clears rearmKey+alertedKey), index.ts's alertedKey read/set in scheduled(), github/webhook.ts's stoppedWakeSkipKey set-once/clear-on-recovery, telegram/webhook.ts's "paused" set/clear/read. Characterization tests already exist for all four and MUST pass unchanged. Issue #447, sweep-6 finding F1, doc docs/maintainability/2026-10-12-deep-modules-sweep-6.md §F1, parent #415.

**Tech Stack:** TypeScript, D1 fleet_state, vitest (vitest-pool-workers). No Wrangler/DO changes.

**Spec:** https://github.com/rafarc21/fleetflare/issues/447 — the issue body IS the spec.

## Global Constraints
- GLM-OK tier: no auth, tokens, rescue, failover, admission, deploy, migrations, credentials.
- All repo content English.
- Wire values stay "1"/"0", keys unchanged; tests test/watchdog.test.ts, test/index.test.ts (rearm+alert cases), test/telegram.callback.test.ts (lines 59-71 pause/resume), test/github.webhook.test.ts (stopped-wake-skip cases) pass UNCHANGED (no test-file edits for existing cases).
- The rearm COUNTER at src/index.ts:203-204 (getFlag+setFlag increment) is NOT in scope — finding F6 owns it; leave it as-is. Same for `incrementCounter`.
- JSON-valued flag users (junior/authz.ts, studio/registry.ts, account stores, read-repos.ts) do NOT migrate — their values are not "1"/"0" episode markers.
- Two-way door: pure code, revert restores three local dances.
- Push discipline: push branch after first commit; never more than 15 min of unpushed work.
- One heavy gate at a time: full `bun run check` only under `flock /tmp/fleet-gate.lock`, never parallel with another gate.

## The three wrappers (Task 1 produces; exact code)

Add to apps/fleet/src/state.ts, after `deleteFlag` (before incrementCounter's doc comment):

```typescript
/**
 * #447 (sweep-6 F1): the "episode marker" reading of this table. An
 * episode flag is a fleet_state key whose value is "1" while an episode
 * (a stale task, a stopped studio, a pause tap) is running and "0" once
 * it has ended, so the NEXT episode on the same key acts again instead
 * of being muted forever. Three call-site families shared this rule as
 * hand-rolled getFlag/setFlag pairs, each re-deriving the "1"/"0"
 * vocabulary: watchdog.ts's clearRearm (rearmKey+alertedKey), the
 * stopped-wake skip flag (github/webhook.ts) and the Telegram "paused"
 * flag. These three wrappers are the one home for that vocabulary.
 * Thin by design: each IS its getFlag/setFlag call, no new SQL — the
 * counter and scan shapes stay getFlag/setFlag/incrementCounter's own.
 */
export async function flagIsSet(db: D1Database, key: string): Promise<boolean> {
  return (await getFlag(db, key)) === "1";
}

/** Marks an episode flag as set ("1") — the value every reader checks. */
export async function markEpisode(db: D1Database, key: string, now: number): Promise<void> {
  await setFlag(db, key, "1", now);
}

/**
 * Ends the episode ("0"). Redundant by design: callers clear
 * unconditionally on the recovery signal, so a clear of an already-clear
 * key is a free write — the posture that makes the NEXT episode act.
 */
export async function clearEpisode(db: D1Database, key: string, now: number): Promise<void> {
  await setFlag(db, key, "0", now);
}
```

## Steps

### Task 1: RED — pin the wrappers before they exist

**Files:** Modify: `apps/fleet/test/state.test.ts` (append one describe block).

- [ ] Step 1.1: Append to test/state.test.ts (after the scanStateTaskKeys describe block) and add `flagIsSet, markEpisode, clearEpisode` to the existing `import { ... } from "../src/state"` line:

```typescript
// #447 (sweep-6 F1): the three episode-marker wrappers. flagIsSet reads the
// exact "1" vocabulary every call site shares; markEpisode/clearEpisode
// write it. Absent key reads as not-set — the same null-handling getFlag's
// own contract already answers with.
describe("episode flags", () => {
  it("an absent key is not set, a \"1\" key is, a \"0\" key is not", async () => {
    expect(await flagIsSet(env.DB, "paused")).toBe(false);
    await markEpisode(env.DB, "paused", 1000);
    expect(await flagIsSet(env.DB, "paused")).toBe(true);
    await clearEpisode(env.DB, "paused", 2000);
    expect(await flagIsSet(env.DB, "paused")).toBe(false);
    expect(await getFlag(env.DB, "paused")).toBe("0");
  });

  it("markEpisode writes the literal wire value \"1\" clearEpisode resets to \"0\"", async () => {
    await markEpisode(env.DB, "k", 1000);
    expect(await getFlag(env.DB, "k")).toBe("1");
    await clearEpisode(env.DB, "k", 2000);
    expect(await getFlag(env.DB, "k")).toBe("0");
  });
});
```

- [ ] Step 1.2: Run `bun x vitest run test/state.test.ts` — expected FAIL (import error: no export named flagIsSet).
- [ ] Step 1.3: Commit: `git add test/state.test.ts && git commit -m "test(fleet): pin episode-flag wrappers before the fold (refs #447)"` then `LEFTHOOK=0 git push -u origin deepen-447-episode-flag`.

### Task 2: GREEN — add the wrappers, migrate the four sites

**Files:** Modify: `apps/fleet/src/state.ts` (three wrappers, verbatim above), `apps/fleet/src/tasks/watchdog.ts` (clearRearm body + import line), `apps/fleet/src/index.ts` (alertedKey read + set, lines ~220-227), `apps/fleet/src/github/webhook.ts` (skipKey block, lines ~195-205), `apps/fleet/src/telegram/webhook.ts` (paused flag, lines 93/102/149).

- [ ] Step 2.1: Add the three wrappers to src/state.ts exactly as written above.
- [ ] Step 2.2: src/tasks/watchdog.ts — change import to `import { clearEpisode } from "../state";` and clearRearm's body to:

```typescript
export async function clearRearm(db: D1Database, taskId: string, now: number): Promise<void> {
  await clearEpisode(db, rearmKey(taskId), now);
  await clearEpisode(db, alertedKey(taskId), now);
}
```

(clearRearm's long doc comment stays unchanged — it documents the gating logic, not the SQL.)

- [ ] Step 2.3: src/index.ts — import `flagIsSet, markEpisode` from "./state" (getFlag, setFlag stay imported for the rearm counter at 203-204). Line ~220 becomes:

```typescript
      if (shouldAlert(attempts, await flagIsSet(env.DB, alertedKey(task.taskId)))) {
```

and line ~227 becomes `await markEpisode(env.DB, alertedKey(task.taskId), now);`. NOTE: test/index.test.ts:349-365 spies `vi.spyOn(stateModule, "getFlag").mockRejectedValue(...)` to prove scheduled()'s rearm-counter read is the one unprotected line — the counter's getFlag stays, so that spy still lands on the first state read in scheduled(); verify that test still passes (it must, the counter read is untouched).
- [ ] Step 2.4: src/github/webhook.ts — import `flagIsSet, markEpisode, clearEpisode` (drop getFlag/setFlag from the import if no other use remains in the file — check). Lines ~195-205 become:

```typescript
      if (!(await flagIsSet(env.DB, skipKey))) {
        console.log(`maestro wake (${studioId}) skipped: studio is stopped`);
        await markEpisode(env.DB, skipKey, now);
      }
      return;
    }
    // Not stopped (running again, or never was) — clear the flag
    // unconditionally, same posture watchdog.ts's clearRearm takes for its
    // own pair of flags: a redundant write of "0" is free, and this is what
    // makes the NEXT stop episode log again instead of a permanent mute.
    await clearEpisode(env.DB, skipKey, now);
```

- [ ] Step 2.5: src/telegram/webhook.ts — import `flagIsSet, markEpisode, clearEpisode` (keep getFlag only if still used; setFlag drops if unused). Line 93: `await markEpisode(env.DB, "paused", Date.now());`. Line 102: `await clearEpisode(env.DB, "paused", Date.now());`. Line 149-150: `const paused = await flagIsSet(env.DB, "paused"); if (paused) {`.
- [ ] Step 2.6: Run `bun x vitest run test/state.test.ts test/watchdog.test.ts test/index.test.ts test/telegram.callback.test.ts test/github.webhook.test.ts` — ALL pass (113 characterization + 2 new).
- [ ] Step 2.7: Commit: `git add -A && git commit -m "refactor(fleet): one episode-flag vocabulary behind the four flag dances (refs #447)"` then `LEFTHOOK=0 git push`.

### Task 3: Verification gates

- [ ] Step 3.1: `flock /tmp/fleet-gate.lock bun run check` (all 5 tsconfig projects) — exit 0.
- [ ] Step 3.2: `bun run english-check` — exit 0, clean.
- [ ] Step 3.3: Record exact tails of both outputs for the done record.
- [ ] Step 3.4: Commit any fixups; `LEFTHOOK=0 git push`.

## Boundaries
- Heavy gates: `bun run check` once (flock), the 4-suite vitest run once more if needed. Never run check and vitest concurrently.
- No test-lies-check needed (no existing tests edited; new tests exercise the module's own exports via env.DB, same pattern as the file's existing describes).
- merge-danger: src/ only, two-way door, no ONE_WAY_GLOBS paths.
