# Round 2: one request path in `github/api.ts` (board issue #309, from #308 review)

Source: #308 merged (review 4/5); operator follow-up #309. Refs #265, never
closes. Behavior-preserving, characterization tests first. Scope:
`apps/fleet/src/github/api.ts` + `apps/fleet/test/github.api.test.ts` only.
Lean: no docs/superpowers/evidence file — the PR body carries the evidence
(finding 5; the #308 evidence file stays merged on main as history — this
task drops the PATTERN, writes no new one).

## Findings (verbatim substance from #309)

1. MAJOR: `ghRequest` (api.ts:34) is a one-line fetch wrapper, fails the
   deletion test — 3 sites use it, ~20 call fetch/ghJson with GH_HEADERS
   directly. Fold the status check in; route `ghJson` (:315) and the raw
   fetch sites through it: one request path. Verified at HEAD: 3 ghRequest
   users (:47, :70, :210), 10 raw `await fetch(` sites, 18 ghJson calls,
   4 ghGraphQL calls.
2. MAJOR test gap: PUT sites (mergePullRequest, createRepoFile) have no
   full-header test; stripping to auth-only still passes all 110 tests.
   Pin the full header set.
3. MINOR: `{...init, headers}` (api.ts:35) silently drops caller headers.
   Merge them instead, or reject.
4. MINOR: pin the 300-char error cut with a long body.
5. MINOR: drop the docs/superpowers/evidence/ file pattern; the PR body
   carries the evidence.

## Design (decided, traced against main @ d571954)

New ghRequest shape — the module's ONE request path:

```ts
async function ghRequest(token, url, init, what, okStatuses = [])
  : Promise<{ res: Response; text: string }>
```

**Headers: MERGE, per finding 3** — `{ ...GH_HEADERS(token), ...init.headers }`,
caller keys override standard keys (an accept override wins). The hazard:
the three bodyless-GET sites send NO content-type, and a merge over the
4-key GH_HEADERS base cannot drop a key. `{"content-type": undefined}`
deletes the key under JSON.stringify, but this is a RequestInit headers
object handed to fetch — an undefined-valued key may render literally
(`content-type: undefined`) under real workerd fetch even where the vitest
mock harness (which records `init.headers` as-is, and `toEqual` ignoring
undefined keys) says otherwise. Implementer MUST verify undefined-header
behavior under both the mock harness and real fetch semantics; if it does
not hold, use a module-internal `GH_HEADERS_GET` (authorization, accept,
user-agent — the same three fields, no content-type) and the bodyless sites
pass that set explicitly. The plan mandates only: (a) caller-provided
headers merge over the standard set, (b) the exact per-site header sets at
main are preserved bit-for-bit, (c) the pinned tests are the arbiter —
whatever shape passes both the pinned tests and real-fetch semantics wins.

**Status check folded in, per finding 1** — ghRequest returns `{res, text}`
where text is ALWAYS read; on `!res.ok` UNLESS `res.status` is in
okStatuses it throws `` `${what} failed (${res.status}): ${text.slice(0, 300)}` ``.
The 404→false fns pass `okStatuses=[404]` and check `res.status===404`
themselves. Always-reading text is a superset of every routed site's
current behavior — each reads text before the status branch except
deleteBranch (error path only, :1115) and upsertRepoFile's ok path
(`res.json()`, :235); GitHub's DELETE-ref 200 is 204 No Content (empty
body), and upsertRepoFile parses the RETURNED text instead — a Response
body reads once, so `res.json()` after an internal `res.text()` would
throw; `JSON.parse(text)` is observably identical. The one size-critical
site (fetchRepoFile) does NOT route through — below.

**Callers routed through it** (line refs at HEAD):

- `exists` (:46) — already ghRequest; passes what + okStatuses=[404]; the
  six *Exists one-liners unchanged.
- `mergePullRequest` (:70) — what = `merge` → `merge failed (...)` (:79).
- `createRepoFile` (:210) — what = `create ${path}` (:216).
- `upsertRepoFile` (:230 raw) — okStatuses=[404] (404 = new file, fine);
  what = `upsert ${path}: sha lookup` → `upsert ${path}: sha lookup failed
  (500): ...` (:237) — a DIFFERENT message shape than the plain `${what}
  failed` family, produced exactly by that what string; verify the
  composition matches bit-for-bit.
- `listInstallationRepos` (:272 raw) — what = `installation repositories`
  (:285).
- `repoIsWritable` (:515 raw) — 403 OR 404 → false, so okStatuses=[403,404];
  what = `read ${repo}` (:523) — same prefix as getDefaultBranch's ghJson
  call; fine, prefixes unchanged.
- `commitReachableFromBranch` (:943 raw) — okStatuses=[404]; what =
  `compare ${repo} ${branch}...${sha}` (:950).
- `listAllBranchNames` (:1021 raw) — what = `list branches for ${repo}`
  (:1026); reads `res.headers` AFTER for the Link header (:1028) —
  ghRequest returning res preserves that.
- `compareAhead` (:1087 raw) — okStatuses=[404], 404→null stays local;
  what = `compare ${repo} ${base}...${head}` (:1094).
- `deleteBranch` (:1111 raw) — DELETE, no body; what = `delete ${repo}
  branch ${branch}` (:1115).
- `ghJson` (:315) — its fetch becomes ghRequest, what already threaded;
  keeps its own JSON.parse. ghJson is module-private, so threading token
  to it (a param, editing its in-module call sites) is allowed — exported
  signatures are the frozen surface.
- `ghGraphQL` (:749) — its fetch becomes ghRequest too; same standard
  4-header set, POST; GraphQL's 200-with-errors[] check stays in ghGraphQL.

**NOT routed: `fetchRepoFile` (:128).** Its Content-Length guard must reject
an oversized DECLARED response WITHOUT buffering the body — the size-cap
tests pin that (test :104-118, "before ever reading the body"). ghRequest
always reads text, which would defeat the guard. fetchRepoFile keeps its
raw fetch + 3-header literal. Document this exception in its comment.

**Every routed site's thrown message must come out BIT-IDENTICAL** — the
characterization tests pin them.

## Tests first (extend test/github.api.test.ts, same harness — the
beforeEach fetch recorder at :20-33)

- **PUT sites' full 4-header set (finding 2)**: new tests for
  mergePullRequest + createRepoFile 200 paths asserting `calls[0].headers`
  toEqual the exact 4-key object (the GH_STD_HEADERS shape the existence-fn
  tests already use, :689-694). Today stripping to auth-only passes —
  after this, it must not.
- **300-char cut (finding 4)**: one test — a 500 with a 1000-char body
  (e.g. pullRequestExists) asserting the thrown message carries exactly
  the first 300 chars and nothing more (endsWith the slice, or a length
  check).
- **Deviant header sets survive the merge**: full toEqual pins for
  fetchRepoFile's raw-accept 3-key set (existing test :78-79 pins
  authorization + accept; add the full-object pin), upsertRepoFile's GET
  3-key set (:231), listInstallationRepos' (:276-280), listAllBranchNames'
  (:1023).
- **Error paths**: listPullsForCommit's non-2xx test exists (:526-528) —
  keep. NEW: repoIsWritable 500 → the exact literal
  `read o/r failed (500): boom`; deleteBranch 500 → the exact literal
  `delete o/r branch <branch> failed (500): boom` (neither site has any
  test today — 0 hits in the file).
- **All existing 110 tests pass UNMODIFIED** (a pinned assertion may
  EXTEND an existing test without changing its old asserts; prefer new
  tests over edits).
- **Mutation checks**: (1) flip exists' 404 branch → RED (same as #308);
  (2) NEW — strip createRepoFile's headers to auth-only → the new
  header-pin test goes RED. Both recorded in the PR body only.
- RED/GREEN order: new tests written first, run against CURRENT code →
  green (characterization). Mutation → RED, revert. Refactor → same tests
  green, zero test edits.

## Verification

- Targeted: `bun run vitest run test/github.api.test.ts` from `apps/fleet`
  — single file, sequential runs (the mutation check runs it twice;
  acceptable; never alongside another gate).
- Heavy: `flock /tmp/fleet-gate.lock bun run check` — once, alone, at the
  end.
- `bun run english-check` — this plan doc is prose.
- Full suite → CI.

## Out of scope

GitHubError migration, board/api.ts + app.ts twins, token mint/auth,
USER_AGENT unification, any message/URL/signature change.
