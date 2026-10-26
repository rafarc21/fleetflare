# Gate-scoped secrets: staging-only secrets into named legs

Issue: https://github.com/rafarc21/fleetflare/issues/1346. Refs
https://github.com/rafarc21/fleetflare/issues/1134. Date 2026-10-26.
Status: proposal, design + first implementation slice in the same PR per the
task's own output format ("design doc FIRST in PR, then impl"). Revised after
two rounds of operator review on PR
https://github.com/rafarc21/fleetflare/pull/1354 — r1: the trust filter
(§2), fail-closed behavior on a missing secret or an unreadable allowlist
(§4a), and field-scoped (not whole-blob) redaction (§6); r2: do.ts's
unresolved-secret guard and result redaction moved into `runLegWithSecrets`
(§4a/§6, since do.ts itself can never be loaded under `bun test`), and
redaction now also catches a secret split by `gate-server.ts`'s own 32k tail
cut (§6). Extended by https://github.com/rafarc21/fleetflare/issues/1367
(§4, registered labels table) to register three consumer-maestro-owned
labels in `SECRET_REGISTRY` — no mechanism change, registry entries only.
Extended by https://github.com/rafarc21/fleetflare/issues/1376 (§1/§3a) to
let an OPS entry opt a leg's own `@head`/`@head-<n>` union-plan copy into
sharing its grant — the one way a PR that ADDS a secret-needing leg to its
own `fleet.json` can ever reach a green gate, still under the exact same
trust filter. Every section below describes the FINAL design, not an
intermediate one.

## Non-goals

- No Cloudflare Secrets Store binding. `grep -rn "secrets_store\|SecretsStore"`
  across this repo returns nothing, and plain Worker secrets
  (`apps/fleet/scripts/deploy.sh secret put <NAME>`, never a bare `wrangler
  secret put`) already serve every existing credential this Worker holds
  (`apps/fleet/wrangler.example.jsonc:1-7`).
  Adding a second secret-storage primitive for one more credential class is
  not justified by this task; the design below stores every gate-scoped
  secret as a plain Worker secret, same as `GITHUB_TOKEN` or
  `CLAUDE_CODE_OAUTH_TOKEN` today.
- No change to the existing git-proxy or R2 outbound allow-list
  (`apps/fleet/src/gate/outbound-handler.ts`). Those stay exactly as they
  are; this feature adds new, narrower surface next to them.
- No change to which legs a repo can configure in its own `fleet.json` gate
  block (`apps/fleet/src/gate/config.ts`). A leg's NAME still comes from
  there. What's new is a second, separate map — outside the PR author's
  reach — from (repo, leg name) to which named secrets that leg gets.
- Not a general secrets-management product. One registry, hand-maintained
  in this Worker's own source, of the small number of named secrets this
  fleet actually needs for gate legs. Adding a new one is a code change +
  deploy, same cost as adding a new Worker secret today.

## Threat model

**Attacker:** the author of a pull request against a gated repo. Their code
runs inside a `GateRunnerDO` leg container (`apps/fleet/src/gate/do.ts`),
under the `install` + `legCmd` their repo's own `fleet.json` names
(`apps/fleet/src/gate/config.ts`'s `GateConfig.install`/`GateLeg.cmd`).
Everything that container can read or do, the PR's own code can read or do —
that is the gate's whole job: run the PR's code.

**What the attacker controls:** the PR's diff, including, when the PR
targets this repo's own gate config, `fleet.json` itself
(`apps/fleet/src/gate/load-config.ts`'s own header: "a PR must not be able
to edit its own gate" is already the rule for leg *commands* — this design
extends the same rule to secret *grants*). The attacker does **not**
control: the OPS repo named by `FLEET_OPS_REPO`
(`apps/fleet/src/ops-repo.ts`) — a second, private GitHub repo the operator
alone writes to, already the home of the leak-scan denylist
(`apps/fleet/src/leak-gate.ts`'s `OPS_DENYLIST_PATH`) — nor this Worker's
own deployed source, nor its Worker secrets.

**Core rule, stated once so every guard below can be checked against it:**

> A secret reaches a leg's container only when ALL of (a) the PR is
> **trusted** — its head repo is the SAME repo as its base (never a fork),
> its author's `author_association` is OWNER/MEMBER/COLLABORATOR, its author
> is not a bot account, AND its base ref is the repo's own actual default
> branch (never one the PR author could have created themselves); (b) the
> leg's name appears in the OPS repo's allowlist for this target repo, under
> a secret name this Worker's own registry recognizes; and (c) the value is a
> staging-only credential, never a production or deploy one.
> Any PR — including one that edits `fleet.json`, adds a leg, or edits the
> OPS repo's own file if it could — changes NOTHING under (a)-(c): (a) is
> read from GitHub's own PR identity and the repo's own setting, none of
> which the PR can spoof (`head.repo.full_name`, `author_association`,
> `user.type`, all on the SAME `/pulls` GET this Worker already makes; the
> default branch from a `GET /repos/{repo}` this Worker already has a
> function for, §2 below); (b) lives in a repo the PR author has no write
> access to by construction (a different GitHub repo, `FLEET_OPS_REPO`); (c)
> is an operational discipline on what the operator ever puts in the
> registry/Worker secrets, not a thing this code can enforce by itself —
> called out explicitly in "Operator responsibility," below.
>
> (a) widened after security review r1: an earlier revision of this design
> gated only on same-repo, which let ANY same-repo pusher through, including
> one who opened a PR against a base branch they created themselves —
> fully self-controlled on both ends. See "Residual risk," below, for what
> the widened (a) does and does not still leave open.

**Why not just gate on `fleet.json`'s own leg list, the way legs are
defined today?** Because `fleet.json` lives in the PR's own repo and a PR
can edit it (`load-config.ts` already special-cases this: a PR that changes
`fleet.json` is gated on its OWN head config, #1091). If the allowlist also
lived there, a PR could add itself to it: "PR author edits fleet.json,
would choose exfil target" is the task's own framing, and it is exactly the
mistake `load-config.ts` already avoids for leg commands (a PR's legs run
at its BASE sha's config, never its head, except when the PR is the one
changing the config — and even then, no secret grant can ever come from
that path here, because the allowlist is never read from the PR's own
repo at all, base or head).

**Why trusted-same-repo-only, never forks?** A trusted same-repo PR still
runs attacker code if the trusted author's account is compromised, or if the
author simply chooses to, but that is already a much narrower population
(collaborators GitHub itself already calls OWNER/MEMBER/COLLABORATOR) than
"anyone who can open a PR" (the general public, for a public repo like
`rafarc21/fleetflare` itself) or even "anyone who can push a same-repo
branch" (the pre-r1 gate). Secrets are not for every contributor; they are
for the repo's own browser/AI test legs running the repo's own trusted
branches, against the repo's own actual default branch. A fork PR, a
same-repo PR from a non-collaborator or a bot, or a same-repo PR against a
non-default base, all get exactly the same leg run as today — no secret,
ever — matching how `legGitToken` already withholds the git-clone token from
every PR whose base repo is public (`leg-env.ts:58-65`: the one credential a
public leg gets today is none at all beyond its own PR ref).

**Residual risk (security review r1, stated in plain words, not softened):**
redaction (§6) covers **accidental echo only** — a test that happens to dump
its env, a debug print. It does **not contain a hostile PR**: a trusted
collaborator (or an account/session with that collaborator's write access)
who deliberately wants to exfiltrate a granted secret can still do so —
nothing in this design stops their own leg's test command from, say, making
an HTTPS POST of the secret value to an attacker-controlled host (leg
containers have open internet egress today, `run-leg.ts`'s
`enableInternet: true`, and this feature adds no egress allowlist). The
mitigation this design relies on is entirely the one stated in the task
itself: **every gate-scoped secret is a staging-only, rotatable credential**
— the worst case is staging-data tampering or a staging credential needing
rotation, never a production or deploy credential, by the registry's own
construction (§4, "Operator responsibility"). An egress allowlist scoped to
secret-bearing legs (so a leg holding `GATE_SECRET_*` can reach only the
staging hosts that credential is actually for) would close this gap further
and is explicitly **not built here** — it is a real follow-up, tracked as
backlog for the maestro to file, not a promise this PR makes.

**Blast radius if a grant is misused anyway** (a malicious same-repo
branch, or a compromised collaborator account): the value is staging-only
by the operator's own discipline (§"Operator responsibility"), so the worst
case is staging-data tampering, never a production credential or a deploy
credential. This fleet's operator already runs a separate, stricter
invariant for Cloudflare deploy credentials specifically — no studio or
gate container ever holds one, deploys run Worker-side only — and the same
shape applies here by the operator's own discipline: no gate secret is ever
a deploy credential either, enforced the same way — by never putting one in
the registry (repo-verifiable: `grep -rn "secrets_store\|SecretsStore"`
across this repo returns nothing, and `wrangler.example.jsonc` shows no such
binding on `GateRunnerDO`'s container).

## Design

### 1. OPS-side allowlist (new): `gate-secrets.json` in `FLEET_OPS_REPO`

One more file in the operator's existing private ops repo, read the same
way `leak-gate.ts`'s denylist already is — `fetchRepoFile` +
`mintRepoToken(..., { permissions: { contents: "read" } })`
(`apps/fleet/src/gate/workflow.ts:171`). Shape (validated by
`apps/fleet/src/gate/secrets-config.ts`, schema documented in
`apps/fleet/src/gate/secrets-config.schema.json`):

```json
{
  "rafarc21/fleetflare": {
    "browser-e2e": ["staging-login"],
    "ai-smoke": { "secrets": ["workers-ai"], "head": true }
  }
}
```

Top-level keys are `owner/repo` (case-insensitive, matched the same way
`gateMapEntry` already matches fleet.json's `gates` map,
`apps/fleet/src/gate/config.ts:201-207`). Each value is a map from leg name
(the same string a repo's own `fleet.json` names in its `legs` array,
`GateLeg.name`, `LEG_NAME_PATTERN`) to that leg's grant, in EITHER of two
shapes (#1376): a plain array of secret NAMES (back-compat — every entry
written before #1376 parses exactly as before, with no head opt-in), or an
object `{secrets, head?}` — `secrets` the same array, `head` an explicit,
OPS-only opt-in (§3a) for the leg's own `@head`/`@head-<n>` union-plan copy
to share the same grant. `parseGateSecretsAllowlist` normalizes BOTH shapes
into the same internal `GateSecretsLegEntry` (`{secrets, head?}`), so nothing
downstream (`secrets-scope.ts`) ever branches on which shape the file used.
A secret NAME here is an opaque label — never a value, never an env var
name, never a Worker secret binding name. Malformed JSON, a non-object top
level, a per-repo or per-leg entry in neither shape, a non-string-array
`secrets`, or a non-boolean `head` each drop just that one entry (fail closed
— same rule `parseDenylist` already follows for the leak-scan file,
`leak-gate.ts`): a run never crashes over a bad ops file, it just grants
nothing for the broken entry, logged (names only, never values) so a typo is
visible rather than silently eaten.

### 2. Trust detection (new): `github/api.ts` + `gate/secrets-scope.ts`

`getPullRequest` already reads `base.repo.private` on its one `/pulls` GET
(`apps/fleet/src/github/api.ts:1163-1187`, `baseRepoPrivate`). The same
response carries `head.repo.full_name`, `author_association` and
`user.type` — read all three on that one GET, no second API call, same
pattern the existing `#1276 headSha` comment already documents for "one GET
instead of two." A PR from a deleted fork has `head.repo: null` (GitHub's
own documented shape); treated as NOT same-repo — fail closed, never
upgrade a vanished identity into a grant. New fields:

```ts
export interface PullRequestInfo {
  // existing fields unchanged ...
  /** whether the PR's head repo is the SAME repo as its base repo — false
   *  for every fork PR, and for a fork whose source repo is gone
   *  (head.repo: null). Case-insensitive, GitHub's own naming is. */
  sameRepo: boolean;
  /** GitHub's own author_association ("OWNER"/"MEMBER"/"COLLABORATOR"/
   *  "CONTRIBUTOR"/"FIRST_TIME_CONTRIBUTOR"/"NONE"/...). "NONE" when absent. */
  authorAssociation: string;
  /** The PR author's GitHub account type is "Bot" (dependabot[bot] etc). */
  authorIsBot: boolean;
}
```

The repo's own actual default branch is a separate call,
`getDefaultBranch(token, repo)` (`github/api.ts`, already existed for an
unrelated feature — a compaction PR's own base), made once per run, only
when `sameRepo` is true (a fork PR is never trusted regardless, so the call
would be pure waste on the by-far most common case).

**security review r1**: `sameRepo` alone was the pre-review gate, and it let
any same-repo pusher through, including one who opened a PR against a base
branch they created themselves. `trustedForSecrets` (`gate/secrets-scope.ts`)
is the real gate now — see §3 for its four conditions.

### 3. The trust + granted-secrets guards (new, pure): `gate/secrets-scope.ts`

```ts
export function trustedForSecrets(input: SecretsTrustInput): boolean {
  if (!input.sameRepo) return false;                             // guard 1: never a fork
  if (!TRUSTED_ASSOCIATIONS.has(input.authorAssociation)) return false; // guard 2: OWNER/MEMBER/COLLABORATOR only
  if (input.authorIsBot) return false;                            // guard 3: never an automated account
  if (input.baseRef !== input.defaultBranch) return false;        // guard 4: never a self-created base branch
  return true;
}

export function grantedSecretNames(
  allowlist: GateSecretsAllowlist, repo: string, leg: string, trusted: boolean,
): string[] {
  if (!trusted) return [];                          // guard 1: an untrusted PR gets nothing, ever
  const forRepo = gateSecretsRepoEntry(allowlist, repo);  // case-insensitive, like gateMapEntry
  if (forRepo === undefined) return [];             // guard 2: repo not in the OPS allowlist
  const direct = ownLegEntry(forRepo, leg);          // prototype-safe lookup (Object.hasOwn + shape check)
  if (direct !== undefined) return direct.secrets.filter(isKnownSecretName); // guard 3: unknown name, never passed through (warns)
  // #1376: no direct entry for `leg` itself -- if it's a @head/@head-<n>
  // union-plan copy (fanout.ts's headLegName) of a leg the OPS file opted
  // into sharing its grant (`head: true`), fall back to THAT leg's entry.
  const headMatch = /^(.+)@head(?:-\d+)?$/.exec(leg);
  if (headMatch === null) return [];                // guard 4: leg isn't a @head copy of anything
  const base = ownLegEntry(forRepo, headMatch[1]);
  if (base === undefined || base.head !== true) return []; // guard 5: no opt-in on the base leg
  return base.secrets.filter(isKnownSecretName);
}
```

Nine independent guards across the two functions, in the order a reviewer
should read them: trust first (cheapest, most load-bearing, and the one a
same-repo PR from a non-collaborator or against a self-created base branch
never clears — identical for a leg's base name and its `@head` copy, #1376
adds no second, looser trust check), then OPS-allowlist repo/leg lookups
(prototype-safe — `Object.hasOwn` plus a shape check, never a bare
`forRepo[leg]`, so a leg literally named `constructor` or `__proto__`, OR its
`@head` copy, cannot resolve through the object's own prototype chain
instead of "nothing granted"), then the `@head` opt-in fallback (#1376,
below), then the registry membership check (defense in depth: even an OPS
typo naming a secret this Worker never defined grants nothing, rather than
leaking `undefined` through to an env var — logged, name only, never a
value, so the typo is visible to the operator). Pure — no fetch, no binding
— so `bun test` exercises both directly, and they are the functions every
mutation below targets (§"Mutation testing," below).

### 3a. `@head` opt-in (new, #1376): a PR's own new leg must still be able to go green

**Problem.** A PR that ADDS a secret-needing leg to its own `fleet.json`
changes the gate config, so `load-config.ts`'s union-plan path runs it under
a DIFFERENT name — `<leg>@head` (or `<lane>@head-<n>` for a sharded lane,
`fanout.ts`'s `headLegName`) — never the plain `<leg>` name the OPS file's
allowlist names. Before this change, an `@head` leg NEVER matched any OPS
entry (guard 3's `ownLegEntry` lookup is exact-name), so it got nothing,
always ran `DID-NOT-RUN`, and the PR that introduced it could never reach a
green gate — a real usability dead end, not a security property: the trust
filter was never the thing refusing it, the NAME MISMATCH was.

**Fix.** The OPS file's per-leg entry gains an explicit, opt-in `head: true`
field (`secrets-config.ts`'s `GateSecretsLegEntry`, below) — absent or
`false` keeps today's behavior (no head grants) exactly, the pre-#1376
default, unchanged. When set, `<leg>@head` and `<leg>@head-<n>` receive the
SAME grant as `<leg>` itself, resolved by stripping the suffix and looking
up the base leg's own entry (guard 4/5, above) — still gated by guard 1
(`trusted`) FIRST, exactly the same trust filter, never a separate or looser
one for the `@head` path.

**Threat model note.** The PR fully controls the `@head` leg's own command —
it's the PR's own `fleet.json` that named it. This is **not a new risk**:
it is the EXACT SAME risk this design's own threat model already states for
every base leg ("Everything that container can read or do, the PR's own
code can read or do — that is the gate's whole job"). `head: true` does not
broaden WHO can ever reach a grant (guard 1 is identical either way) or
loosen WHAT code runs in the leg that receives one (PR-controlled code
already runs in every leg, named-and-OPS-granted or not) — it only lets an
ALREADY-authorized leg's union-plan name variant share a grant its base name
already had. The egress-allowlist gap named in "Residual risk," above
(https://github.com/rafarc21/fleetflare/issues/1355, filed from that
residual-risk note, still open) is unchanged by this PR either way: an
`@head` leg with a granted secret has exactly the same open HTTPS egress a
base leg with one already does.

### 4. The registry (new, static): `gate/secrets-registry.ts`

The map from a secret NAME (OPS-config-facing, opaque) to where its real
value lives (Worker-facing, never OPS-config-facing). This indirection is
the second half of the threat model's core rule: the OPS repo can grant a
NAME to a leg, but only this Worker's own deployed source decides what that
name resolves to. An OPS-repo compromise (a weaker trust boundary than this
Worker's own deploy pipeline) can at most grant names that already exist in
a running deploy — it can never invent a new credential to exfiltrate.

```ts
export interface SecretDef {
  /** The Worker secret (Env key) holding this name's real value. Mutually
   *  exclusive with `minted`. */
  envVar?: string;
  /** True for a name whose value is minted per-run instead of stored
   *  (workers-ai). Mutually exclusive with `envVar`. */
  minted?: true;
}

export const SECRET_REGISTRY: Readonly<Record<string, SecretDef>> = {
  // Example: operator adds one line + one
  // `apps/fleet/scripts/deploy.sh secret put <envVar>` (never a bare
  // `wrangler secret put`) per staging credential a browser/AI leg needs.
  // Name is a label, never the value.
  "staging-login": { envVar: "GATE_SECRET_STAGING_LOGIN" },
  // #1346 Workers AI proxy route (floor mode, T4): no stored value at all —
  // see "AI route" below.
  "workers-ai": { minted: true },
  // #1367: consumer AI legs' own labels (values stored by the consumer
  // maestro's own deploy, never by this repo).
  "appcheck-debug-token": { envVar: "GATE_SECRET_APPCHECK_DEBUG_TOKEN" },
  "staging-minter-sa": { envVar: "GATE_SECRET_STAGING_MINTER_SA" },
  "gemini-gate-key": { envVar: "GATE_SECRET_GEMINI_GATE_KEY" },
};
```

**Registered labels (operator reference, kept current as entries are added):**

| Name (OPS-file-facing) | Env var (Worker secret) | Set with | Owner |
|---|---|---|---|
| `staging-login` | `GATE_SECRET_STAGING_LOGIN` | `apps/fleet/scripts/deploy.sh secret put GATE_SECRET_STAGING_LOGIN` | this repo (example) |
| `workers-ai` | *(none — minted per run)* | `apps/fleet/scripts/deploy.sh secret put GATE_SECRET_SIGNING_KEY` (signs the minted token, not the secret itself) | this repo |
| `appcheck-debug-token` | `GATE_SECRET_APPCHECK_DEBUG_TOKEN` | `apps/fleet/scripts/deploy.sh secret put GATE_SECRET_APPCHECK_DEBUG_TOKEN` | consumer maestro (#1367) |
| `staging-minter-sa` | `GATE_SECRET_STAGING_MINTER_SA` | `apps/fleet/scripts/deploy.sh secret put GATE_SECRET_STAGING_MINTER_SA` | consumer maestro (#1367) |
| `gemini-gate-key` | `GATE_SECRET_GEMINI_GATE_KEY` | `apps/fleet/scripts/deploy.sh secret put GATE_SECRET_GEMINI_GATE_KEY` | consumer maestro (#1367) |

"Owner" names who actually stores the value (which maestro/operator runs the
`secret put`) — this repo's `SECRET_REGISTRY` entry and `env.ts` typing are
the same regardless of owner; only who holds the credential differs. A label
with no row here is not registered and `grantedSecretNames` drops it
(secrets-scope.ts's registry guard), logged as an unknown name.

### 4a. Fail-closed, never silently degraded (new, security review r1 item 3)

Two distinct "we promised a secret and it didn't show up" cases, both wired
so the failure is loud rather than a leg quietly running without what it
needed:

- **A granted name that fails to resolve** (an OPS allowlist entry naming a
  Worker secret that was never `deploy.sh secret put`, a `GATE_SECRET_SIGNING_KEY`
  absent so the `workers-ai` token cannot mint, a registry entry quietly
  removed after the OPS file still lists it): checked against
  `resolveGrantedSecrets`' own output (`secrets-registry.ts`'s
  `firstUnresolvedSecret`) BEFORE the container ever starts. The first
  unresolved name turns into an immediate RED leg,
  `{ state: "error", description: "DID-NOT-RUN: secret \"<name>\" unresolved" }`
  — the container never starts, the PR's test command never runs "as if"
  nothing had been granted. **security review r2:** this check (and the
  result redaction in §6) originally lived as plain code inside `do.ts`'s
  `fetch` handler — but `do.ts` imports `cloudflare:workers`, so `bun test`
  can never load it, meaning a silent revert of either guard would have
  passed every existing test. Both now live in one injectable function,
  `run-leg.ts`'s `runLegWithSecrets(secretNames, secretValues, run)` — `run`
  stands in for `runLegInContainer`, so a test fakes it and asserts on the
  `LegOutcome` this function hands back, exactly as if `do.ts` had called
  it. `do.ts`'s own `fetch` handler is now just: resolve secrets, call
  `runLegWithSecrets`, call `legResponse` on the result.
- **The OPS allowlist itself is unreadable** on a trusted PR (the file is
  missing in a way that isn't "intentionally absent," a network error, JSON
  that doesn't parse): `workflow.ts`'s fetch step returns `null`, distinct
  from the `{}` a genuinely empty/absent file parses to
  (`secrets-config.ts`'s own `parseGateSecretsAllowlist`, which still
  returns `{}` for that case — "the operator never turned this on" is not a
  failure). A trusted PR whose allowlist read comes back `null` fails the
  **whole run**, posted the same way an invalid gate config already does
  (`decideGateRun`'s own "fail" path, `config.ts`) — never a silent
  fall-through to "grant nothing," which would be indistinguishable from the
  operator's own deliberate off-switch.

### 5. Delivery to the container: env vars, not a proxy — except the AI route

For an ordinary named secret (`envVar` set), the value is injected as a
container env var, `GATE_SECRET_<UPPER_SNAKE_NAME>`, exactly once, only for
a leg `grantedSecretNames` actually named. This mirrors
`buildLegEnvVars`'s existing shape (`leg-env.ts:39-54`) rather than adding a
new outbound-proxy host: the threat model already accepts that the leg's
OWN PR code sees the value (the task's own line: "Threat model: PR code
runs with secret") — the point of the allowlist is WHICH repo/leg sees
WHICH secret, not hiding it from the one process it's granted to. A
same-process env var is the simplest thing that satisfies that, and it is
exactly as reversible as any other Worker secret (rotate it, redeploy).

The **Workers AI proxy route** is different in kind, not degree: a leg
doesn't need a static staging credential, it needs to make bounded calls
through THIS Worker's own `env.AI` binding (already used by
`apps/fleet/src/llm/anthropic-route.ts:7-8,1144`, AI Gateway option
`LEAD_AI_GATEWAY_ID`). So instead of a stored value, `workers-ai` mints a
**run-scoped bearer token** at leg start (`gate/secrets-ai-token.ts`,
HMAC-SHA256 over `{runId, leg, exp}`, Web Crypto `crypto.subtle`, available
identically in the Worker and in `bun test`), signed with a new Worker
secret this feature introduces, **`GATE_SECRET_SIGNING_KEY`**
(`apps/fleet/scripts/deploy.sh secret put GATE_SECRET_SIGNING_KEY`) — a key
no leg container ever holds. The container gets the minted token as
`GATE_SECRET_WORKERS_AI` and presents it as a bearer header to a new,
narrow Worker route (not yet built — see "Scope note" in the PR); the route
verifies the signature, the leg name, and `exp`, then — and only then —
calls `env.AI.run(...)` itself and returns the result. The container never
holds an AI Gateway key, a Worker secret, or anything usable outside this
one run: `exp` is the run's own start time plus its hard leg-timeout
ceiling (`config.ts`'s `legTimeoutMin`, which clamps to
`MAX_LEG_TIMEOUT_MIN`) plus a container-start margin — the token is already
worthless by the time a human could read it out of a leaked log, let alone
reuse it against a future run. If `GATE_SECRET_SIGNING_KEY` is unset, the
token simply cannot mint — handled as any other unresolved secret (§4a),
never a leg silently running with no token at all. "Floor mode, T4" is the
specific model-routing choice the AI route makes server-side (same shape as
`LEAD_MODEL_POOL` today, `wrangler.example.jsonc:135-150`) — the container
names no model, it can't, the token carries no such claim.

### 6. Redaction, field-scoped, at BOTH result paths: `gate/secrets-redact.ts`

A granted secret's value can end up in a leg's own `stdout`/`stderr` (a
failing test that echoes its env, a debug print) — the same risk this
Worker already fully owns for GitHub/Tailscale/Anthropic/spawn tokens
(`apps/fleet/src/studio/redact.ts`'s own header: "unlike... scrub() (which
redacts specific token strings the container process already holds), this
Worker never separately holds the studio's GitHub token." For a gate
secret, the inversion is deliberate: THIS Worker DOES hold every value it
just granted (it minted the env var, or read it from its own Env), so
exact-value redaction is possible and is what's used, not shape-based
regexes — no public shape exists for an operator-chosen staging credential
the way `ghs_`/`tskey-auth-`/`sk-ant-` have fixed prefixes. It also redacts
the value's common encodings (JSON-escaped, base64/base64url,
percent/URL-encoded — security review r1 item 4), since a test or script
may well print the secret already encoded rather than raw.

**Leading-partial redaction for a mid-secret tail cut (security review r2):**
`container/gate-server.ts` keeps only the last `OUTPUT_TAIL_CHARS` (32k) of
stdout/stderr before any of this ever reaches the Worker — a cut that can
land in the MIDDLE of a granted secret, leaving just its TRAILING fragment
sitting at the very START of the kept text. A full-value match (above) never
finds a fragment shorter than the whole value, so that leading fragment
would otherwise leak untouched. `redactKnownSecretValues` now also checks,
per granted value, whether the text's own prefix equals some SUFFIX of that
value at least 8 characters long (the longest such suffix wins), and redacts
that leading fragment too — a Worker-side-only fix, no container/image
change, since the cut itself happens before this code ever sees the bytes.
The 8-character floor exists so a short, coincidental overlap (two or three
characters any real text could share with any secret) never triggers a
redaction that would read like a bug rather than a fix.

**Field-scoped, never a whole-blob string replace (correctness review r1
item 3):** a short or common granted value — literally the word "success",
"ok" — run as a blind text replace over a WHOLE JSON document can corrupt a
structural token instead of an actual leak: `"state":"success"` becoming
`"state":"«redacted»"` would break the verdict itself, not just scrub
something. `redactLegResultFields` only ever touches four named free-text
fields (`description`, `summary`, `stdout`, `stderr`) — never `state`, never
any other key:

```ts
export function redactLegResultFields<T extends RedactableLegFields>(result: T, values: readonly string[]): T {
  if (values.length === 0) return result;
  return {
    ...result,
    ...(result.description === undefined ? {} : { description: redactKnownSecretValues(result.description, values) }),
    ...(result.summary === undefined ? {} : { summary: redactKnownSecretValues(result.summary, values) }),
    ...(result.stdout === undefined ? {} : { stdout: redactKnownSecretValues(result.stdout, values) }),
    ...(result.stderr === undefined ? {} : { stderr: redactKnownSecretValues(result.stderr, values) }),
  };
}
```

**Two separate result paths, both redacted (security review r1 item 2):** a
leg's result reaches the outside world through two genuinely different
channels, and the pre-r1 revision of this design only redacted one of them.

- **The R2-persisted result.** `outbound-handler.ts`'s existing leg-result
  PUT path (`handleGateOutbound`, the `RUN_RESULT_RE` branch,
  `outbound-handler.ts:399-420`): the body is parsed as JSON,
  `redactLegResultFields` runs against `props.secretValues` (the plain list
  of values THIS leg was granted — never names, never the registry, just
  the values needed to scrub), and the result is re-serialized before
  `bucket.put`. A body that somehow isn't valid JSON at all (should never
  happen via `gate-server.ts`'s own `putResult`, but this container's
  outbound traffic is otherwise untrusted) falls back to the blunter
  whole-text `redactKnownSecretValues` — still safe, just without the
  field-structure guarantee a non-JSON body has none of anyway. A leg with
  no grants (`secretValues` absent/empty) pays the cost of nothing extra.
- **The container's direct HTTP response.** `run-leg.ts`'s `runOnServer`
  reads the container's own `/run` and `/result` TCP responses directly —
  a SEPARATE path from the R2 PUT above, one the pre-r1 redaction never
  touched at all. That response becomes the Workflow step's own return
  value, which `fleet gate log`/`fleet gate watch` and the step's persisted
  output both read. `do.ts` now redacts this too, right before
  `legResponse`, using the same granted values.

This is the one place a secret value can leak into something every later
`fleet gate log` call reads back (`gate/log.ts`'s own
`LegOutput.stdout`/`stderr`), so redaction at both paths is mandatory, not
best-effort.

### 7. Wiring summary (call chain, same shape the git-proxy token already uses)

```
workflow.ts (resolve-pr step)
  reads sameRepo/authorAssociation/authorIsBot from getPullRequest,
    defaultBranch from getDefaultBranch (sameRepo PRs only)   (new: §2)
  computes trusted = trustedForSecrets(...)                   (new: §2/§3)
  reads allowlist from OPS repo gate-secrets.json, trusted PRs only;
    null (not {}) on a fetch/parse failure                    (new: §1, §4a)
  trusted && allowlist === null -> whole run fails RED         (new: §4a)
      |
      v
leg-run.ts legRequestContext(...) -> legRequest(...)
  (legRequestContext: the trust computation + context-building, pulled into a
   bun-testable file so workflow.ts's own untested glue does as little as
   possible -- correctness review r1 item 1)
  carries { trusted, secretNames: string[] } per planned leg   (new field on GateLegRequest)
      |
      v
do.ts  (GateRunnerDO.fetch, where legGitToken already mints per leg)
  for each granted name: resolve value (registry envVar -> this.env[envVar],
    or mint a run-scoped AI token)              (new: secrets-registry.ts / secrets-ai-token.ts)
  buildLegEnvVars(...) gains GATE_SECRET_* entries
  gateOutboundProps(...) gains `secretValues: string[]` (values only, for redaction)
      |
      v
run-leg.ts runLegWithSecrets(secretNames, secretValues, run)  (new: §4a/§6,
    security review r2 -- do.ts itself can never be loaded under bun test,
    so both of the following moved OUT of its fetch handler and into this
    one injectable, tested function)
  a granted name with no resolved value -> immediate RED leg,
    `run` (runLegInContainer) is NEVER called                 (§4a)
  else: run(), then redactLegResultFields on the result's description +
    summary -- the container's own /run, /result response, a path separate
    from the R2 PUT below                                     (§6, security review r1 item 2)
      |
      v
outbound-handler.ts handleGateOutbound PUT path
  parses the leg's result JSON, redactLegResultFields on description/
    summary/stdout/stderr, re-serializes before R2 put   (new: §6)
```

Every box above already exists for the git-clone token
(`legGitToken`/`gateOutboundProps`, `leg-env.ts:58-77`) or the OPS denylist
fetch (`workflow.ts:164-179`); this feature reuses both call shapes rather
than inventing a third.

## Operator responsibility (explicitly out of this code's control)

- **Staging-only, by discipline.** Nothing in `SECRET_REGISTRY` can verify a
  value is a staging credential rather than a production one — that is
  decided the moment the operator runs `apps/fleet/scripts/deploy.sh secret
  put GATE_SECRET_STAGING_LOGIN` with a particular value. The registry's own doc
  comment says so; this is a process control, not a code control, the same
  kind of operator discipline that already keeps Cloudflare deploy
  credentials out of every container this fleet runs — a rule enforced by
  what the operator chooses never to put in a container's env, not by
  anything this code could check.
- **`FLEET_OPS_REPO` must itself stay private**, same precondition
  `leak-gate.ts`'s denylist already depends on — a public ops repo would
  make the allowlist attacker-readable (not attacker-writable, which is the
  actual guard here, but readable is still a minor information leak: which
  legs get which secret names).

## Testing (this PR)

1. **An untrusted PR gets no secret.** `grantedSecretNames(allowlist, repo,
   leg, /* trusted */ false)` returns `[]` regardless of how permissive
   `allowlist` is — the trust guard is checked first and unconditionally.
   `trustedForSecrets` itself is tested for each of its four conditions: a
   fork, a non-collaborator association, a bot account, and a non-default
   base, each alone enough to refuse.
2. **Leg outside the allowlist gets none.** Same repo granted for leg A
   grants nothing for leg B; a repo absent from the allowlist entirely
   grants nothing for any leg.
3. **Secret value redacted from logs.** A leg result, run through
   `redactLegResultFields`, no longer contains a granted value in its
   `description`/`summary`/`stdout`/`stderr` fields, including its common
   encodings AND a leading fragment left behind by `gate-server.ts`'s own
   32k tail cut landing mid-secret; an UNgranted value is left alone
   (exact-value scrubbing, not a blanket wipe); a granted value equal to the
   literal word "success" never corrupts the result's own `state` field
   (field-scoped, not a whole-blob replace); both the R2-PUT path and the
   container's direct HTTP-response path (`run-leg.ts`'s `runLegWithSecrets`)
   are redacted, each with its own test using a fake `run`/bucket so a
   silent revert of either path fails a real test — `do.ts` itself can never
   be loaded under `bun test`.
4. **Run token expires with run.** `verifyRunToken` accepts a token minted
   at `now` for `exp = now + ttl` when checked at `now + ttl - 1`, and
   rejects the identical token checked at `now + ttl + 1` — and rejects a
   token minted for a different `runId`/`leg` even before expiry.
5. **Fail closed, never silently degraded.** A granted name with no
   resolved value turns into an immediate RED leg before the container
   starts; a trusted PR whose OPS allowlist read failed fails the whole run,
   never falling through to "grant nothing."
6. **`@head` opt-in (#1376).** `head: true` on a leg's OPS entry grants its
   `@head` and `@head-<n>` union-plan copies the same secrets as the base
   leg; `head` absent, `false`, or the plain array form all deny the `@head`
   copy exactly as before #1376 (back-compat); an untrusted PR (fork, bot,
   non-default-base — all collapsed to `trusted: false`) gets nothing from an
   opted-in leg's `@head` copy either, the same trust filter applying
   unchanged; a leg named `constructor@head`/`__proto__@head` resolves
   safely, never through `Object.prototype`, for the base-leg lookup the
   same way the direct lookup already does.

Per the task's own mutation-testing instruction, every guard this PR adds is
hand-mutated (condition flip, off-by-one on the expiry boundary, operator
swap) and the full set of new tests is re-run against each mutant; the
result envelope on the board issue reports "N guards, N mutants, N killed."
