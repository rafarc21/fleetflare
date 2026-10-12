# One `scanStateTaskKeys` behind the two fleet_state keyed scans (#365)

Source: sweep-4 F5 (docs/maintainability/2026-10-11-deep-modules-sweep-4.md);
refs #361, never closes. GLM-OK: behavior-preserving, characterization at
the callers' interfaces first. Paths apps/fleet/-relative.

## Findings
"A fleet_state key is `<prefix><repo>:<number>`" is hand-rolled twice, at
different grammar depths. junior/authz.ts:116-123 embeds the repo IN the
prefix (`junior-auth:acme-org/websites:`): LIKE `%` scan, startsWith
re-check (its comment names LIKE's `_`-wildcard trap), /^\d+$/ on the
whole rest, numeric sort — key only. github/read-repos.ts:158-179 scans
the BARE namespace (`read-repos:`): same startsWith, `lastIndexOf(":")`
split, /^\d+$/ on the suffix, `colon <= 0` skip, then JSON.parse + shape
checks, fail closed — key AND value. A malformed-key rule change must
land in both. (The finding also named leak-gate and events; re-grepped
at main, neither holds a fleet_state LIKE scan — scope narrowed.)

## Design
state.ts is already the fleet_state module, so the scan lives there:
`scanStateTaskKeys(db, prefix): Promise<{repo, number, value}[]>` (an
exported `StateTaskKey`). One `SELECT key, value FROM fleet_state WHERE
key LIKE ?` bind `${prefix}%`, then in memory: exact startsWith(prefix)
re-check — LIKE's `_` wildcard and its ASCII case-fold get one home, the
comment moving in from authz; rest = key.slice(prefix.length); colon =
rest.lastIndexOf(":"); repo = colon < 0 ? "" : rest.slice(0, colon);
num = colon < 0 ? rest : rest.slice(colon + 1); keep iff /^\d+$/ on num
and colon !== 0. UNSORTED — callers own order. Value always fetched: authz
ignores it, grants needs it. (`read-repos-err:` keys sit outside the
LIKE literal.)

Grants' verbatim `colon <= 0` cannot be the shared rule: the same suffix
bytes `42` are a TRUE row in authz's grammar (the prefix already named
the repo) and a hand-edit in grants' — which is which depends on the
caller's prefix depth, knowledge the scan does not have. The scan keeps
the union; each caller keeps ONE depth filter — prefix the caller's,
parse rule shared. authz: `.filter(r => r.repo === "")` then map to
number + numeric sort, the #41 cursor pagination untouched. grants:
`.filter(r => r.repo !== "")` then today's JSON.parse/studioId/repos
checks + sort, the fail-closed comment covering the empty-repo drop.
Both kept/dropped sets byte-identical to today's.

## Tests first (RED in test/state.test.ts; existing describes untouched)
env.DB, raw INSERTs, the file's beforeEach DELETE cleaning up. Describe
"scanStateTaskKeys":
1. `_` trap, authz depth: prefix `ns:acme-org/we_bsite:`, true row
   `ns:acme-org/we_bsite:5` reads {repo: "", number: 5, value}; the
   same-length decoy `ns:acme-org/we-bsite:9` IS handed back by D1 —
   LIKE's `_` matches exactly ONE char — and startsWith must reject it.
   A shorter decoy (`website:9`) never matches the LIKE at all — the
   decoy must be same-length; SQLite-checked before writing this.
2. Colonless numeric rest kept: `ns:42` under bare `ns:` reads {repo: "",
   number: 42} — grants drops it by filter, never by the scan itself.
3. Rejected: `ns:acme-org/repo:notanumber`, `ns:acme-org/repo:` (trailing
   empty), `ns:abc` (bare), `ns::7` (empty repo, colon at 0).
4. Multi-colon repo intact: `ns:acme-org/we:ird:5` splits at the LAST
   colon — repo "acme-org/we:ird", number 5.
5. Value passthrough: each returned row carries its row's value string.
6. UNSORTED: output equals the raw LIKE query's results element-for-element,
   order included — assert against the engine's return, never a guessed
   insertion order; callers own sorting.

GREEN: implement in state.ts (authz's LIKE comment moves there), rewire
both callers per Design — no signature, sort order, or failure-mode
change. Characterization: junior.authz.test.ts (sweep + pagination) and
github.read-repos.test.ts (grant record incl. malformed-value
fail-closed) pass UNCHANGED — no edit to either file.

## Verification
From apps/fleet/: `bun run vitest run test/state.test.ts
test/junior.authz.test.ts test/github.read-repos.test.ts`; heavy once,
alone, gated: `flock /tmp/fleet-gate.lock bun run check`; then `bun run
apps/fleet/scripts/english-check.ts` (this doc is prose).

## Files touched
docs/superpowers/plans/2026-10-11-state-key-scan-365.md (this file);
apps/fleet/src/state.ts, src/junior/authz.ts, src/github/read-repos.ts,
test/state.test.ts.

## Out of scope
registry.ts listStudios (whole-value rows, different grammar), ratelimit
pruneStaleCounters (DELETEs, not reads), any write path,
board.read-repos.test.ts + studio.read-repos-refresh.test.ts (the same
fns through higher layers — CI's, not this targeted set), leak-gate and
events (no fleet_state LIKE scan there at main).
