---
# fix #1187: blueprint credential shadows work-repo push credential (refs #1177)

## What

When work repo == blueprint repo, `blueprintCredentialWriteCmd` (credentials.ts:285)
writes `credential.https://github.com/<work>.git.helper` pointing at
`/workspace/.git-credentials-blueprint` — read-only 1 h token, never refreshed.
Pushes then use it, never the main token. 403 (hour 1) then 401 then "could not
read Username".

## Fix (Worker-only, no container change)

1. **Provision skip** (do.ts writeBlueprintCredential port ~6254): if
   `blueprintRepo` == `workRepoSlug` (case-insensitive), skip mint+write. Run a
   drop instead: unset both blueprint helper keys, rm the blueprint file.
   Returns ok.
2. **Refresh heal** (credentials.ts refreshCredentialExec:196): add optional
   `workRepo` param. Token-present branch appends a loop that unsets the two
   work-URL helper keys whose value names `git-credentials-blueprint` (use
   `case` pattern, never `grep -q`), rm the file only when a shadow was found.
   Heals live studios next tick.
3. **read-repos guard** (github/read-repos.ts studioReadReposCredential): drop
   the task's own repo from the final repo list (case-insensitive).
4. **Harden** (write-proxy/mode.ts studioCredential:118): rethrow a proxy mint
   error, never return null (which null-wipes the credential). A failed refresh
   re-arms at 30 s, 2 m, 5 m backoff (pure fn `refreshBackoffDelaySeconds`).
   `REFRESH_SECONDS` 3000 -> 2400.
5. **Verify** (do.ts runRefreshCredential): after the write, `git credential
   fill` for `https://github.com/<work>.git` must return the fresh token, else
   ok:false (degraded in fleet ls). Token compared in TS, never in shell.

## TDD (real git in bun tests)

- fill(work URL) = main token after the shadow drop.
- fill(blueprint URL, other repo) = blueprint token (untouched by refresh drop).
- drop idempotent (run twice, no error).

## Boundaries

apps/fleet/src/studio/credentials.ts, provision.ts (no change to
maybeWriteBlueprintCredential signature), do.ts refresh path, write-proxy/mode.ts,
github/read-repos.ts; tests. No container/, no image, no deploy.

## Verify

`bun test test/bun/blueprint-shadow.test.ts test/bun/blueprint-credential.test.ts
test/bun/read-repos-credential.test.ts` then `bun test test/studio.refresh.test.ts
test/studio.read-repos-refresh.test.ts test/write-proxy.mode.test.ts` (vitest,
one at a time, flock heavy gates), then `bun run check` last.
---