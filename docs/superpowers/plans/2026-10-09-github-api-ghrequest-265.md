# Deepen: GitHub REST access in `github/api.ts` behind one `ghRequest` + `exists` (board issue #265)

Issue: https://github.com/rafarc21/fleetflare/issues/265. Tier **GLM-OK**:
behavior-preserving, characterization tests at the interface first, one
module per PR. Refs #259, never closes.

## Source

Board issue #265, filed from the deep-modules sweep (#259 Part B1) —
`docs/maintainability/2026-10-08-deep-modules-sweep.md`, finding F5
(lines 265-274), Strength: Strong. Skill step: ICA §1 (shallow module,
interface ≈ implementation) + CD deletion test (six fns vanish into one).
Dependency: true external (GitHub) — tests mock `fetch` already.

Two line references in the sweep doc have drifted against current HEAD,
re-traced for this plan: `upstreamFailure` is at `src/board/routes.ts:877-885`
(the sweep says 824-832) and the `closeIssue` forwarder sits at
`routes.ts:97` (the sweep says :94). Everything else in F5's own file list
checks out verbatim against `apps/fleet/src/github/api.ts` today.

## Problem

**Two GitHub HTTP clients with different error types.** `src/github/api.ts`
throws plain `Error`; `src/board/api.ts` throws `GitHubError` (`:58-63`).
`upstreamFailure` (`src/board/routes.ts:877-885`) maps only
`GitHubError` 404 → 404:

```ts
function upstreamFailure(err: unknown, method: string, pathname: string): Response {
  ...
  const status = err instanceof GitHubError && err.status === 404 ? 404 : 502;
```

Board methods backed by `github/api.ts` (e.g. `closeIssue`, the forwarder at
`routes.ts:97`) throw plain `Error` → the route answers **502 on a real 404**.
**This PR does NOT fix that** — observation only; see the
behavior-preserving rule below for why.

**Inside `github/api.ts` itself, the shallow shape.** Six copy-pasted
existence checks:

- `pullRequestExists` `:514-522`
- `branchExists` `:583-591`
- `commitExists` `:601-609`
- `issueExists` `:624-632`
- `pathExists` `:642-650`
- `compareExists` `:659-668`

each repeat the same dance — fetch, `res.status === 404 → false`,
`!res.ok → throw`, else `true` — e.g. `branchExists` (`:583-591`):

```ts
const res = await fetch(`https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`, {
  method: "GET", headers: GH_HEADERS(token),
});
const text = await res.text();
if (res.status === 404) return false;
if (!res.ok) throw new Error(`read ${repo}@${branch} failed (${res.status}): ${text.slice(0, 300)}`);
return true;
```

Six more sites hand-inline the header object instead of using the helper:
`:28-33` (`mergePullRequest`), `:96` (`fetchRepoFile`), `:177`
(`createRepoFile`), `:199` (`upsertRepoFile`), `:247`
(`listInstallationRepos`), `:1027` (`listAllBranchNames`). The file already
has `GH_HEADERS` (`:281-286`) used by the later half — the first half never
adopted it:

```ts
const GH_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": USER_AGENT,
  "content-type": "application/json",
});
```

Each of the six existence fns is ~9 lines of which 8 are boilerplate —
interface ≈ implementation, the textbook shallow module: a caller learns
nothing from reading the signature it didn't already know, and a change to
the fleet's GitHub-request convention (headers, 404 policy) must be edited
six-plus times to hold.

## Solution (this PR)

Inside `src/github/api.ts` ONLY:

1. **One private request function `ghRequest`** — minimal shape
   `(token, path-or-full-url, init, what)` or similar: sets the standard
   headers (authorization bearer, accept `application/vnd.github+json`,
   user-agent `USER_AGENT`, content-type `application/json`), runs the
   fetch, returns the `Response`. It hides the header convention, nothing
   else — no status parsing, no body reading; those stay with each caller
   because the six callers differ there (404→false vs. throw vs.
   parse-and-return).
2. **One private `exists` helper** — runs the fetch through `ghRequest`,
   maps 404 → `false`, 2xx → `true`, everything else throws the SAME
   message text the six fns throw today:
   `` `${what} failed (${res.status}): ${text.slice(0, 300)}` `` with each
   fn's own `what` (e.g. `read ${repo}#${number}` for `pullRequestExists` /
   `issueExists`, `read ${repo}@${branch}` for `branchExists`,
   `read ${repo}:${path}@${ref}` for `pathExists`, `read ${repo} compare
   ${base}...${head}` for `compareExists`).
3. **The six existence functions become one-liners** delegating to `exists`
   with their url + their current error-message `what` string. Exported
   signatures, urls, and JSDoc contracts stay untouched — only the bodies
   shrink. CD deletion test: after this, six 9-line bodies collapse into
   one `exists` plus six one-line calls; the duplication is deleted, not
   re-expressed.
4. **The six inline header sites route through the standard header set
   where the swap is exact; four keep their own literals**, preserving
   each call's exact method/body/headers — the deliberate deviations must
   survive verbatim. The first is a genuinely different
   header value; the other three are the same shape — bodyless GETs whose
   headers carry NO content-type today, which a naive `GH_HEADERS` swap
   would ADD one to. If `ghRequest` is used at any of those three, its
   header set must allow that shape (e.g. content-type only when a
   body/init says so), or the site keeps a narrow override. Adding a
   content-type header to a GitHub GET is harmless in practice, but this
   PR's own rule is exact header preservation — no header added or dropped
   anywhere. (Correction, review round 1: this list originally enumerated
   only `fetchRepoFile` and `listAllBranchNames`; the source has FOUR
   no-content-type GET sites, and the implementation correctly kept all
   four explicit rather than swapping any of them for `GH_HEADERS`.)
   - `fetchRepoFile`'s raw accept media type `application/vnd.github.raw+json`
     (`:95`) — different from the standard one; it OVERRIDES, it is not
     dropped. `github.api.test.ts:78` pins this header today and keeps
     passing, unmodified.
   - `upsertRepoFile`'s sha-lookup GET (`:199`) — no content-type today.
   - `listInstallationRepos`'s paged GETs (`:247`) — no content-type today.
   - `listAllBranchNames`'s paged GETs (`:1027`) — no content-type today.

**Do NOT delete or merge `ghJson` (`:290-295`) / `ghGraphQL` (`:753-769`)** —
those are already-deep helpers for the JSON/GraphQL halves; this PR only
removes the six duplicated existence-check bodies and the six inline header
literals. If `ghRequest` naturally replaces the raw `fetch` inside those
helpers without changing behavior, allowed — but the thrown message format
`` `${what} failed (${res.status}): ${text.slice(0, 300)}` `` must not change
anywhere. Note what this PR deliberately does NOT deepen: `repoIsWritable`
(`:489-502`) and `commitReachableFromBranch` (`:944-960`) share the 404
ambiguity but differ (repoIsWritable also maps 403→false; both parse bodies)
— they already use `GH_HEADERS` and are outside the six; leave them.

## Characterization tests FIRST

Per the sweep doc: per existence fn, 200→true, 404→false, 500→throws the
same message. `github.api.test.ts` covers most exported fns but has ZERO
tests for these six — a grep for their names across `test/` finds them only
as `vi.fn()` mocks in board-level tests (`board.verify.test.ts:34-35`,
`:232-233`, …), never exercised against the real module. Add to
`apps/fleet/test/github.api.test.ts`, following its existing mock-fetch
harness (the `beforeEach` at `:19-32` swaps `globalThis.fetch` for a
recorder that pushes `{url, method, headers, body}` into `calls`, with
`respond` as the per-test Response factory — same pattern, no new harness):

- For each of `pullRequestExists`, `branchExists`, `commitExists`,
  `issueExists`, `pathExists`, `compareExists`:
  - a **200 test**: returns `true`, asserts the exact URL including
    `encodeURIComponent` segments — e.g. `branchExists("tok", "o/r",
    "release/1.0")` must request
    `.../branches/release%2F1.0`; `pathExists` asserts the `?ref=` query
    (`.../contents/fleet.json?ref=v1%2Fx` shape); `compareExists` asserts
    `.../compare/base...head` with each side encoded;
  - a **404 test**: returns `false`;
  - a **500 test**: rejects with the exact current message text — assert
    with the literal string the current code throws, e.g.
    `read o/r#4242 failed (500)`, not a loose regex.
- These are **characterization tests of EXISTING behavior**: they must pass
  against current code immediately — written first, run first, green first.
- **Prove they bite (mutation check)**: temporarily change one existence
  fn's 404 branch to return `true` (or comment the throw), confirm at least
  one test goes RED, revert. That mutation check is recorded in the PR
  evidence. Pinning the message with the literal string (not a regex) is
  what makes the 500 test half of that bite detectable.
- **After the refactor, the SAME tests must pass unmodified** — that is the
  behavior-preserving proof. The interface is the test surface: tests
  describe behavior, not implementation. If the refactor "requires" editing
  a test, the refactor changed behavior and stops.

## Behavior-preserving rule

- **Keep plain `Error` and the exact thrown message texts.** Switching to
  `GitHubError` changes 502→404 at `/board` — explicitly out of scope,
  separate issue, needs its own decision + test. This PR is refactor-only;
  a single thrown-message edit is a behavior change and a review blocker.
- **`USER_AGENT` stays where it is** — untouched in all three files:
  `github/api.ts:8` (module-private const, comment at `:3-7`) and
  `board/api.ts:26` (module-private) are exactly that today, and
  `github/app.ts:71` is the one exported copy. Do not touch the
  `board/api.ts` or `github/app.ts` copies — twin-client absorption is out
  of scope.
- **No change to any exported signature, url, header, or message.** The
  exported surface of `github/api.ts` is identical before and after; the
  only diff inside the module is private-machinery consolidation.

## Out of scope (CLAUDE-ONLY follow-up, never this PR)

- Repo-bound client absorbing token mint (`board/routes.ts:82-100`
  forwarders — the sweep says `:78-96`, drifted; `githubBoardApi`'s
  method map spans `:82-100` at HEAD — `memory/routes.ts:88-105`,
  `write-proxy/gh-route.ts:170-189`) — auth/secrets, CLAUDE-ONLY
  territory.
- Unifying `USER_AGENT` across the three files.
- Any error-type change (plain `Error` → `GitHubError`), and with it the
  `/board` 502-on-404 observation above.

## Verification (heavy-gate aware)

- Targeted tests only: `bun run vitest run test/github.api.test.ts` from
  `apps/fleet` — the repo's vitest-pool-workers suite (`vitest.config.ts`
  mounts `@cloudflare/vitest-pool-workers` over `wrangler.test.jsonc`).
  NEVER the full suite in this container — memory ceiling.
- `bun run check` (tsc --noEmit multi-project) is a heavy gate: run once,
  alone, via `flock /tmp/fleet-gate.lock bun run check` at the end, never
  in parallel with anything.
- RED/GREEN story, in order:
  1. New tests written first, run against CURRENT code → all green
     (characterization pins behavior).
  2. Mutation check → RED on at least one test; revert the mutation.
  3. Refactor → same tests green, zero test edits.
  The mutation check runs only the one test file, twice — two runs of a
  single-file suite, acceptable; run them sequentially, never alongside
  another gate.

## Files touched

- `apps/fleet/src/github/api.ts` — refactor only, zero behavior change.
- `apps/fleet/test/github.api.test.ts` — six new existence-fn test blocks
  (characterization).
- `docs/superpowers/evidence/2026-10-09-github-api-mutation-check-265.md` —
  the mutation check's RED/GREEN record, which Verification requires.
- This plan doc.

## Review plan

Fresh-context Code Reviewer — Spec axis and Standards axis separately;
the Standards axis reads `skills/deep-modules/SKILL.md`'s detection
checklist plus `fleet/blueprint/CODING_STANDARDS.md`. QA: targeted test run
+ tsc gate evidence. PR refs #265, never closes. Door: **two-way** (pure
refactor; revert = `git revert`). Blast radius: every GitHub call the
Worker makes; a wrong header or url change breaks studio provision and
board verifies fleet-wide — which is exactly what the
characterization-first test blocks exist to make impossible to miss.
