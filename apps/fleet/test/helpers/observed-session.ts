import {
  OBSERVED_KEY, emptyObserved,
  type Observed, type ObservedSession, type ObservedStorage,
} from "../../src/studio/observed";

// Sweep-33 F9 (#733 census, issue #753): the ObservedSession builder that
// test/studio.survival-retry.test.ts and test/studio.survival-input.test.ts
// carried as byte-identical local copies — a S26-F10 (#697) split pair kept
// in sync BY HAND until this helper ended that. Defaults are that pair's own
// values; the literal `at` below equals both files' NOW constant
// ("2026-09-25T12:00:00.000Z") exactly, so their behavior is unchanged.
// test/cli.recycle-outcome.test.ts keeps a local one-line wrapper (aliased
// import) folding its divergent defaults (at: START.toISOString(),
// snapshotAgeS: 5, turnsBefore: 3) once, so its 15 call sites stay untouched.
// Same override discipline as helpers/studio-row.ts: pass what differs.
export function session(over: Partial<ObservedSession> = {}): ObservedSession {
  return {
    verdict: "resumed", at: "2026-09-25T12:00:00.000Z", via: "recycle", restore: "restored",
    snapshotAgeS: 600, turnsBefore: 12, reason: null, ...over,
  };
}

/** The narrow ObservedStorage port over a plain Map — a #697 split pair
 *  (studio.survival-retry / studio.survival-input) carried byte-identical
 *  local copies of it, in the same shape test/studio.observed.test.ts and
 *  test/studio.wake-gate.test.ts use. Lives here because `session()` above
 *  already serves that pair, for the same hand-sync reason. */
export function fakeObserved(seed?: Partial<Observed>) {
  const map = new Map<string, Observed>();
  if (seed) map.set(OBSERVED_KEY, { ...emptyObserved(), ...seed });
  const storage: ObservedStorage = {
    get: async () => map.get(OBSERVED_KEY),
    put: async (_key, value) => { map.set(OBSERVED_KEY, value); },
  };
  return { map, storage, stored: () => map.get(OBSERVED_KEY) };
}
