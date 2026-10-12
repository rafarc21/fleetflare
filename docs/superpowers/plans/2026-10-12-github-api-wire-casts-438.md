# Plan — S10-F2 runtime-checked reads on github wire casts (task #438)

Parent: https://github.com/rafarc21/fleetflare/issues/438. Sweep: docs/maintainability/2026-10-12-type-safety-sweep-10.md (F2).
Branch `fix-438-github-api-runtime-casts` off origin/main b92043e. Pure code, two-way door, ~20 changed lines.

## Sites (all verified on this branch)

1. `apps/fleet/src/github/api.ts:100` — `mergePullRequest`: `(JSON.parse(text) as { sha: string }).sha` → typeof-check `sha === "string"`, else throw `` `merge failed (…): no sha in merge response` `` shape (site's own `what failed (status)` framing; ghRequest's `what` for this call is `"merge"`). Never returns `undefined`.
2. `api.ts:223` — `createRepoFile`: `body.content?.sha ?? ""` silently degrades → same typeof check, else throw `create ${path} failed: GitHub named no sha` (mirrors `getDefaultBranch`'s existing `read ${repo} failed: GitHub named no default branch` framing). Callers (do.ts harvest, doneRecordPutter) fire-and-forget the write; a throw beats a phantom `""` sha.
3. `api.ts:249` — `upsertRepoFile` GET: `sha = (JSON.parse(text) as { sha?: string }).sha` — shape lies leave `sha === undefined` → PUT without sha → 422 over an existing file, masking the real problem. Same typeof check, throw `upsert ${path}: sha lookup failed: GitHub named no sha`.
4. `api.ts:536` — `repoIsWritable`: acceptable fails-closed today (`=== true`). NO code change — the existing doc comment already documents the fail-closed contract; only the sweep-doc-noted risk. Skip (issue lists it as "acceptable today").
5. `apps/fleet/src/github/app.ts:199-203` — `mintInstallationTokenDetail`: `parsed.token` returned unchecked. Guard `typeof parsed.token === "string" && parsed.token !== ""` else `throw new MintTokenError(res.status, "installation token failed (${res.status}): response named no token")` — same MintTokenError/status shape the non-ok path already throws. Token value NEVER in the message. `mintRepoToken`/mint flow untouched — typeof guard on the parsed body only (GLM-OK bound).

## TDD

RED first (commit 1): one new case per guarded site in the EXISTING suites (no new test file — keeps envelope "existing test/github.api.test.ts suites green"):
- `test/github.api.test.ts` `mergePullRequest`: respond `Response.json({})` → rejects, never `undefined`.
- `createRepoFile`: respond `Response.json({})` → rejects with `no sha` (old code returned `sha: ""`).
- `upsertRepoFile`: GET responds `{}` (200) → rejects `named no sha`, `calls` length 1 (never a sha-less PUT).
- `test/github.app.test.ts` `mintInstallationToken`: respond `Response.json({})` → rejects MintTokenError `/named no token/`; plus one case: token `""` → also rejects.

GREEN (commit 2): the guards in api.ts + app.ts. All 4 suites' existing cases must stay green (no existing test relies on `sha: ""` or undefined token).

## Verify

Run per touched-suites only (heavy-gate rule: no full suite, no bundler build):
- `bun run vitest run test/github.api.test.ts test/github.app.test.ts` (from apps/fleet) — includes new RED cases now GREEN.
- `flock /tmp/fleet-gate.lock bun run check` (5 tsc projects).
- `bun run english-check`, `bun run test-lies-check`.

## Boundaries

- Never a new dependency. No change to minting, auth, token handling beyond the typeof read. `repoIsWritable` NOT changed.
- Comments 1-2 lines WHY only. English everywhere.
- Push after RED commit, after every commit. Branch never touches another studio's.
