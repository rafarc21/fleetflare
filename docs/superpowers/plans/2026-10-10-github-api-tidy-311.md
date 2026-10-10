# Tidy: `github/api.ts` — redundant GH_HEADERS args, comment trim, merge-order pin (board issue #311)

Source: #310 merged (review 4.5/5); operator follow-up #311. Refs #309,
never closes. Behavior-preserving — no thrown message, URL, or header set
changes. Scope: `apps/fleet/src/github/api.ts` + its test file only.

## Findings (from #311)

1. ~20 callers still pass `headers: GH_HEADERS(token)` — redundant since
   ghRequest merges the defaults under caller keys. Delete them.
2. Comments heavy: 7 `#309` references and ~20-line docblocks on
   ghRequest/GH_HEADERS_GET. Trim to the why, one or two lines each
   ("keep the constraint, drop the history").
3. A mutant survives: flipping the merge so the standard header beats the
   caller's passes all 130 tests. Pin the caller-wins order with a test.

## Design (traced against main @ f0d178d)

### a. Which args drop

All 20 plain `headers: GH_HEADERS(token)` pass-throughs are redundant —
ghRequest merges the identical defaults, so the recorded header sets are
bit-identical without them: lines 385 (getDefaultBranch), 400
(repoIsPrivate), 501 (listRepoTree), 526 (openPullRequest), 582
(repoIsWritable), 621 (listOpenPullNumbers), 649 (listOpenPullFiles), 758
(listPullsForCommit), 776 (listPullCommits), 799 (closeIssue), 824
(ghGraphQL), 965 (getPullRequest), 1018 (commitReachableFromBranch), 1034
(listMatchingBranches), 1112 (commitDate), 1125 (compareFiles), 1169
(compareAhead), 1195 (deleteBranch), plus commitFilesOnNewBranch's local
`const headers = GH_HEADERS(token)` (line 437) — it and the `headers`
props in its 5 ghJson calls all go; those calls pass only method/body.

STAY: the 3 `GH_HEADERS_GET(token)` args (upsertRepoFile :289,
listInstallationRepos :334, listAllBranchNames :1098) — they carry the
`content-type: undefined` deletion marker that keeps the bodyless 3-key
sets. STAY: `GH_HEADERS` itself — ghRequest's merge base uses it. STAY:
fetchRepoFile's raw fetch (not routed through ghRequest).

### b. Comment-trim policy

Keep the standing why, drop the narrative history (#309 refs and friends).
ghRequest's docblock shrinks to ~5 lines: caller keys win over the
standard set, an `undefined` value deletes that key (never handed to
fetch), text is always read once, `!res.ok` throws unless the status is in
okStatuses, `res` comes back so callers read status/headers themselves.
GH_HEADERS_GET's to ~2 lines: the 3-key bodyless set; `content-type:
undefined` marks the key for deletion (a literal undefined would go on the
wire). fetchRepoFile's exception comment to ~2 lines: the Content-Length
guard must reject before the body is buffered, so it cannot route through
an always-read-text helper. exists() keeps its standing why (404 false /
2xx true / else throw via ghRequest; `what` is the caller's error prefix),
minus the #265/#309 narrative. Per-fn JSDoc that documents CALLER
contracts stays untouched (repoIsWritable's 403/404 ambiguity reasoning,
listInstallationRepos' pagination rationale, fetchRepoFile's size-cap
contract) — this pass trims REQUEST-PATH machinery comments only.

### c. Finding 3 — pinning merge order

Export `ghRequest` (module-private today) as the documented test seam and
drive it directly with a header whose value genuinely differs from the
standard set (`accept: "application/vnd.github.raw+json"` plus a custom
`x-test` key). No production caller sends a differing value — the
GH_HEADERS_GET sites pass value-identical keys (only the undefined
deletion marker differs) — which is exactly why the flip mutant survives.
Plainly: exporting one private helper is widening the module's EXTERNAL
seam by one; the alternative (testing through a production caller) was
rejected because no production path legitimately sends a differing header
(fetchRepoFile does not route through ghRequest), so a direct-seam test is
the honest pin. Mutant check: re-spread GH_HEADERS over the merged result
(base wins) → the new pin and the three `toStrictEqual` bodyless-set pins
all go RED (content-type comes back); revert.

### d. Tests first

New test block in test/github.api.test.ts pins CURRENT merge order — green
immediately on real code; the mutation run confirms it bites. All 130
existing tests pass unmodified.

### e. Verification

Targeted: `bun run vitest run test/github.api.test.ts
test/board.leak.test.ts` (sibling import) — sequential, never alongside
another gate. Heavy: `flock /tmp/fleet-gate.lock bun run check` — once,
alone, at the end. Then `bun run english-check` (this doc is prose).
Full suite → CI.

## Files touched

- `docs/superpowers/plans/2026-10-10-github-api-tidy-311.md` (this file)
- `apps/fleet/src/github/api.ts`
- `apps/fleet/test/github.api.test.ts`

## Out of scope

GitHubError migration, board/api.ts twins, any message/URL/signature
change, the per-fn caller-contract JSDoc (kept).
