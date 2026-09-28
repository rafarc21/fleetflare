# P6c — App installation id, per owner

bug. GITHUB_INSTALLATION_ID global, ONE id for whole fleet. github app
installs per ACCOUNT (org/user), not per fleet. so global id only ever
covers ONE org. measured 2026-09-16, the operator admins 4 orgs:

  acme-org   -> covered (2222222, the deployed default)
  demositeltda   -> NOT covered, no installation path at all
  acme-hq     -> NOT covered (P6b already gave it a token path, not an
                   app path)
  demositellc    -> NOT covered, no installation path at all

same shape bug P6b fixed for tokens (one PAT, one owner). now the app
side.

second bug, remedy naming. `appRemedy` (was `APP_REMEDY`, a fixed
string) never said which var to touch. operator reading the 403 has no
idea GITHUB_INSTALLATION_ID_<OWNER> is even a thing.

investigated in place before writing anything: `tokenRemedy` (auth.ts)
already takes `varName` and is already called with `tokenVarName(env,
owner)` at the reachRepo call site. this was ALREADY correct — P6b
shipped it right. issue text's "second defect" framing describes the
OLD pre-P6b shape, kept as rationale for why the app side needs the
same treatment, not a live bug on the token side. proved this with a
new test (brand-new owner, no per-owner token, no per-owner install id
— falls to shared GITHUB_TOKEN, and the remedy names GITHUB_TOKEN,
correctly, because that IS what answered). no code change to
tokenRemedy.

fix. mirror P6b exactly, for installation ids instead of tokens.

1. `installationEnvName(owner)` (app.ts) — literal mirror of
   `tokenEnvName`. `GITHUB_INSTALLATION_ID_<OWNER>`, uppercased,
   non-alphanumeric -> `_`.
2. `mintInstallationToken(env, owner)` — owner required now. resolves
   the id: owner's own var (DynamicEnv cast, same trick as
   `repoToken`) if set and non-empty, else `env.GITHUB_INSTALLATION_ID`.
3. every call site passes owner: `mintRepoToken` (already has it in
   scope), `reachRepo` (already has it in scope, moved up one line so
   both branches share it). grepped the whole repo for other callers —
   none outside these two + the test files.
4. `hasApp` per-owner aware: true if owner's own install-id var is set
   OR the global is set. threaded through `assertConfigured` (owner
   param added) and `resolveRepoAuthKind` (owner already in scope).
   `assertConfigured`'s missing-var message for app stays GENERIC
   ("GITHUB_INSTALLATION_ID"), same as the token side's fixed
   "GITHUB_TOKEN is not set" — mirroring token parity, not
   per-owner-naming the refusal.
   no precedence-aware "which var answered" helper on the app side —
   see point 5.
5. `appRemedy` — replaces the fixed `APP_REMEDY` string. appends a
   clause naming the PER-OWNER var directly (`installationEnvName(owner)`).
   reasoning, worked out while implementing: `tokenRemedy` names
   "whichever credential answered" (via `tokenVarName`) because the fix
   for a token is ALWAYS "widen that same credential's grant" — same
   var, more scope. the app's added clause is a structurally different
   kind of advice: "this owner might need its OWN, separate
   installation" — a var to CREATE, not a var to widen. that suggestion
   is the per-owner format unconditionally, whether or not the owner
   already has one set (if it does, the message still names it — same
   var, an operator checking it is not wrong even though it is already
   set). so the clause is always `installationEnvName(owner)`, never the
   shared name, in both the brand-new-owner case and the
   owner-already-has-one case. this is a deliberate deviation from the
   literal mirror-of-tokenVarName shape this plan originally carried —
   no separate precedence-aware helper was needed on the app side at
   all, because wiring one into `appRemedy` would have put the SHARED
   var name in the brand-new-owner remedy, which is exactly the wrong
   answer for an owner whose org has no installation at all. (an earlier
   draft of this work added such a helper, `installationVarName`,
   unused by `appRemedy` for the reason above — and, having no caller
   anywhere, no test either; removed as dead code in review rather than
   shipped.)

boundaries. only `apps/fleet/src/github/app.ts`,
`apps/fleet/src/github/auth.ts`, and their two test files. no
wrangler.jsonc (per-owner installation ids don't exist yet — the operator
installs the app on the other 3 orgs first, separately). no
GITHUB_REPO_AUTH map/wildcard/fallback ORDERING change — only what
`hasApp` checks internally. no deploy. no token/installation-id VALUE
in any log, assertion, or comment — var names only.

tdd. failing test first for every behavior above, watch it fail for
the right reason, then minimal code.
