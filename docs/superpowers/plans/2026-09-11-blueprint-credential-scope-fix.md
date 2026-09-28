# Blueprint Credential Scope Fix

**Problem (Fleet board task #149):** every studio except a `websites--*`
one silently fails to resolve any blueprint skill. `runProvision` writes
exactly one git credential, `credentialWriteCmd` (`do.ts`), scoped to the
studio's WORK repo owner (`mintRepoToken(env, workRepoSlug)`), registered
as a bare, unscoped `credential.helper`. `container/studio-bringup.sh`
then clones a SECOND, unrelated repo — the blueprint itself
(`acme-org/websites`, private) — relying entirely on that same
work-scoped credential, with none of its own. For a `websites--*` studio
the two repos happen to share an owner, which is the only reason that one
studio's blueprint clone has ever worked. For every other studio the
credential names the wrong owner, the clone fails silently
(`studio-bringup.sh`'s own already-shipped `|| echo ... >&2` tolerance),
and every declared skill resolves to nothing. Confirmed live, by direct
observation, on `sample--maestro` and `sample--web-studio` — both
degraded with skills-unresolvable.

**Fix, additive only:** a SECOND, separately-scoped git credential, minted
via the SAME `mintRepoToken(env, repo)` the work-repo credential already
uses, just pointed at the blueprint repo instead of `workRepoSlug`.

- `blueprintCredentialWriteCmd(blueprintRepo, token)` (`do.ts`, new)
  writes a SEPARATE file, `/workspace/.git-credentials-blueprint` — not a
  second line appended to the existing `/workspace/.git-credentials` file,
  since `git-credential-store(1)` documents no precedence among multiple
  stored lines that both match a request URL, so which one git would
  actually pick is unspecified, not merely untested. It registers that
  file via a URL-scoped `credential.https://github.com/<blueprintRepo>.helper`
  config section — not `useHttpPath`, which would have to be turned on
  globally to matter here (both credentials are bare `https://github.com/...`
  URLs with no path component of their own to distinguish) and would
  silently widen path-matching for every OTHER `github.com` URL the
  container touches, including its own work-repo git/`gh` traffic.
  `git-config(1)` resolves the more specific `credential.<url>.*` section
  in preference to the bare `credential.*` section `credentialWriteCmd`
  registers, so the blueprint clone picks up the new file and the
  work-repo credential is never even consulted for it. Being a distinct
  config KEY rather than a line in a shared file also means
  `credentialWriteCmd`'s own repeat-safe overwrite can never clobber this
  one by omission — there is no shared key to clobber. No token ever
  appears in a clone URL, matching `credentialWriteCmd`'s existing
  discipline.
- `ProvisionDeps.writeBlueprintCredential?: (blueprintRepo, id) =>
  Promise<{ok:true}|{ok:false,error}>` (`provision.ts`, new) is the
  optional port; absence means "behave exactly as today" (no blueprint
  credential write attempted), the same posture every other optional
  `ProvisionDeps` field (`resolveAssignedBrief`, `r2Get`, `writeFile`,
  `setKeepAlive`) already has, so every existing test fixture that never
  supplies it keeps working unchanged. `do.ts`'s real `deps()` wires it to
  `blueprintCredentialWriteCmd` + a fresh `mintRepoToken(this.env,
  blueprintRepo)` mint — never `workRepoSlug` — inside a try/catch that
  redacts and returns an error rather than throwing.
- `maybeWriteBlueprintCredential(deps, bringupEnv, id)` (`provision.ts`,
  new) is the caller-side wrapper: no-ops entirely on the ROLE path (a
  plain `RoleEnv` carries no `BLUEPRINT_REPO` field, so
  `studio-bringup.sh` never attempts a blueprint clone for it — nothing to
  authenticate). On the STUDIO path it calls the port and, on failure,
  only logs (`console.error`) — deliberately NOT folded into
  `runProvision`'s/`runRestart`'s outer try/catch, and no Telegram alert
  either, because a mint/write failure here must never degrade the studio
  any worse than the clone failure it precedes already is tolerated
  (empty skill list, already the shipped failure mode; alerting on the
  mint side while the clone side stays silent would draw a new,
  inconsistent severity line around one half of the same symptom).
- Wired at two call sites: `runProvision`, right after the resolved
  bring-up env is known and before the work-repo clone's own exec runs;
  and `runRestart`, for the same reason — the blueprint clone is
  idempotent and only retries when `/opt/blueprint/.git` is absent, so a
  studio whose credential mint failed or was never attempted at
  provision-time would otherwise retry-and-fail that clone forever, on
  every restart. Deliberately NOT wired into the periodic ~50-minute
  `refreshWithStorage` tick: the blueprint credential is consumed once,
  transiently, at bring-up — it is not held open for a live session the
  way the work-repo credential is, so there is nothing for a periodic
  refresh to keep current.

## What was checked and found NOT to be a bug

The task brief also named `fleet/blueprint/studios/maestro/studio.md`'s
`skills:` line as carrying a `cto` typo that should read `cto-liaison`.
Checked directly against `origin/main` — the file already declares
`cto-liaison`, not `cto`:

```
$ git diff origin/main -- fleet/blueprint/studios/maestro/studio.md
(empty)
$ grep skills fleet/blueprint/studios/maestro/studio.md
skills: [sprint-ritual, spec-driven-delivery, manager-comms, cto-liaison, agent-lifecycle]
```

No change made to that file. The brief's second claimed bug does not
exist on `main`.

## Files touched

- `apps/fleet/src/studio/do.ts` — new `blueprintCredentialWriteCmd`
  (exported function, own doc comment covering the two-file/URL-scoped-key
  design and the open verification item below); `deps().writeBlueprintCredential`
  wired to it + a fresh `mintRepoToken(this.env, blueprintRepo)` mint,
  inside its own try/catch returning a redacted error rather than
  throwing. `credentialWriteCmd`/`RefreshDeps`/`refreshDeps()`/every
  existing `refreshWithStorage` call site is untouched — pure addition.
- `apps/fleet/src/studio/provision.ts` — new optional
  `ProvisionDeps.writeBlueprintCredential` field on the existing
  interface; new `maybeWriteBlueprintCredential` helper; one new call
  each in `runProvision` (before the work-repo clone exec) and
  `runRestart` (before the bring-up exec). `runSessionRestore` and every
  other existing function in the file is untouched — pure addition.
- `apps/fleet/test/studio.provision.test.ts` — new coverage: the
  provision-path credential write happens before the work-repo clone
  exec; the write is never attempted on the ROLE path (no
  `BLUEPRINT_REPO`, so `writeBlueprintCredential` is never called);
  restart re-mints using the persisted `BLUEPRINT_REPO` for a
  studio-shaped env, never for a role-shaped one; a failed mint/write
  never degrades the studio (state stays `running`, `error` stays
  `null`) on BOTH the provision and restart paths; absence of the
  optional dependency is a genuine no-op on BOTH paths.

## Boundaries respected

`credentialWriteCmd`, `RefreshDeps`, `refreshDeps()`, and every
`refreshWithStorage` call site (provision, restart, the periodic
~50-minute token refresh) are byte-identical to `main` — confirmed by an
actual `git diff`, not just inspection, showing zero removed lines in
either touched file:

```
$ git diff origin/main -- apps/fleet/src/studio/do.ts apps/fleet/src/studio/provision.ts --stat
 apps/fleet/src/studio/do.ts       | 60 ++++++++++++++++++++++++++++++++++++
 apps/fleet/src/studio/provision.ts | 62 ++++++++++++++++++++++++++++++++++
 2 files changed, 122 insertions(+), 0 deletions(-)
```

Zero deletions in both files. `container/studio-bringup.sh`, any
Dockerfile, wrangler config, and `fleet/blueprint/studios/maestro/studio.md`
are all untouched by this PR — the diff is scoped to `do.ts`,
`provision.ts`, and the one test file.

## Two-round verification story

**Round 1 (code review):** approved, no blocking findings. One
non-blocking note: `blueprintCredentialWriteCmd`'s shell interpolation of
`blueprintRepo`/`token` into the `printf`/`git config` command string is
unquoted, matching the pre-existing, already-shipped pattern in
`guardedCloneCmd`'s own unquoted interpolation — reviewer confirmed this
is consistent with established precedent in this file, not a new risk
introduced by this change, and did not block on it.

**Round 2 (independent QA):** found a real gap between what the
implementation report claimed and what the test file actually contained
— the report claimed 7 new tests including two absence-is-a-no-op checks
(provision-path and restart-path), but only 6 existed and only the
provision-path absence-check was actually written; the restart-path
counterpart was missing entirely. Closed in a follow-up commit
(`fc46856`) that adds the missing `restartWithStorage` no-op test, so the
claim now matches what the suite actually covers. QA then passed,
including a standalone dry-run rendering the exact shell command
`blueprintCredentialWriteCmd` produces and checking it against
`guardedCloneCmd`'s precedent (the same unquoted-interpolation pattern
review round 1 flagged as non-blocking).

## Commits / PR

- `b003e1a` — `fix(fleet): mint a separate, URL-scoped credential for the blueprint clone (board task #149)`
- `fc46856` — `test(fleet): cover restart-path no-op for missing writeBlueprintCredential (board task #149)`
- PR #156: https://github.com/acme-org/websites/pull/156
- Board task: https://github.com/acme-org/websites/issues/149

## Verification

- `bun run check` — clean, exit 0 (5 tsconfig projects)
- `bun run test` — 1750/1750 tests passing across 72 files
- `git diff origin/main -- apps/fleet/src/studio/do.ts apps/fleet/src/studio/provision.ts` —
  additive only, zero removed lines, `credentialWriteCmd`/`RefreshDeps`/
  `refreshDeps()`/every `refreshWithStorage` call site untouched
- `git diff origin/main -- fleet/blueprint/studios/maestro/studio.md` — empty; the
  brief's second claimed bug (`cto` vs `cto-liaison`) does not exist on `main`

## CRITICAL — this fix is NOT proven end-to-end

Everything above is what could be checked from inside this studio's own
container: static review, the two automated test rounds, and diff-level
boundary checks. None of it proves the fix actually reaches a running,
previously-broken studio. This studio has no Cloudflare Access
credential, no `wrangler`, and no way to exec into any OTHER studio's
container — so the following are explicitly **not done**, and require an
operator with Cloudflare Access + fleet attach (or equivalent) after
merge + deploy + a real fleet recycle:

1. **Pre-fix baseline, not captured.** Confirm `/opt/blueprint/.git` is
   absent in a currently-failing studio (e.g. `sample--web-studio`
   before this ships) and capture the blueprint clone's real exit code,
   so there is an actual "before" to compare against.
2. **Post-fix resolution, not confirmed.** After merge, deploy, and a
   real recycle of `sample--web-studio`: `git config --global
   --get-urlmatch credential.helper https://github.com/acme-org/websites`
   should resolve to the new scoped helper; `git ls-remote
   https://github.com/acme-org/websites.git` should succeed; `git
   ls-remote https://github.com/rafarc21/sample.git` should ALSO still
   succeed, via the untouched top-level work-repo credential; `fleet ls`
   should show `sample--web-studio` at `READY=provisioned` with a
   fresh `CHECKED` timestamp.
3. **No-regression control, not confirmed.** The same two `git
   ls-remote` checks run inside `websites--web-studio` (the one studio
   that was already healthy) to prove this change does not break the
   case that happened to work before.
4. **The git-mechanics assumption itself is unverified.** The whole fix
   depends on git's URL matching for `credential.<url>.helper` stripping
   the trailing `.git` from `studio-bringup.sh`'s own clone URL
   (`https://github.com/${BLUEPRINT_REPO}.git`) before comparing it
   against the new config key, which carries no `.git` suffix. This is
   stated in `blueprintCredentialWriteCmd`'s own doc comment as
   *expected*, not as something checked. If it's wrong, the blueprint
   clone silently falls through to the untouched work-repo credential
   and this fix does not actually change anything for the non-`websites--*`
   studios it targets — the exact failure mode item 2's `--get-urlmatch`
   check above exists to catch.

Also note, per the PR body: `wrangler deploy` diffs the image DIGEST —
"no changes fleetflare-studiodo" means the image never rebuilt and this
fix never shipped. This PR is Worker-side TypeScript only (no
container/Dockerfile change), so the normal deploy path applies, but the
fix only reaches a RUNNING studio through a `fleet recycle`, and the
first recycle after a deploy often lands on the OLD image. The correct
signal is the actual git-config content inside a container, never a
route's HTTP verdict.

Rollback, if needed: revert both commits. No migration, no persisted
state to unwind — the new credential file/config section is only ever
written on a provision/restart call, never persisted outside the
container's own ephemeral filesystem.
