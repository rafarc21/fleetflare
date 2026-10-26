# Gate-scoped secrets: staging-only secrets into named legs

Issue: https://github.com/rafarc21/fleetflare/issues/1346. Refs
https://github.com/rafarc21/fleetflare/issues/1134. Date 2026-10-26.
Status: proposal, design + first implementation slice in the same PR per the
task's own output format ("design doc FIRST in PR, then impl").

## Non-goals

- No Cloudflare Secrets Store binding. `grep -rn "secrets_store\|SecretsStore"`
  across this repo returns nothing, and plain Worker secrets (`wrangler
  secret put`, `scripts/deploy.sh secret put <NAME>`) already serve every
  existing credential this Worker holds (`apps/fleet/wrangler.example.jsonc:1-7`).
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

> A secret reaches a leg's container only when ALL of (a) the PR's head repo
> is the SAME repo as its base repo (never a fork), (b) the leg's name
> appears in the OPS repo's allowlist for this target repo, under a secret
> name this Worker's own registry recognizes, and (c) the value is a
> staging-only credential, never a production or deploy one.
> Any PR — including one that edits `fleet.json`, adds a leg, or edits the
> OPS repo's own file if it could — changes NOTHING under (a)-(c): (a) is
> read from GitHub's own head/base repo identity, which the PR cannot spoof
> (`head.repo.full_name` on the SAME `/pulls` GET this Worker already makes,
> §2 below); (b) lives in a repo the PR author has no write access to by
> construction (a different GitHub repo, `FLEET_OPS_REPO`); (c) is an
   operational discipline on what the operator ever puts in the registry/
   Worker secrets, not a thing this code can enforce by itself — called out
   explicitly in "Operator responsibility," below.

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

**Why same-repo-only, never forks?** A same-repo PR still runs attacker
code if the attacker has push access to a branch, but that is already a
much narrower population (collaborators) than "anyone who can open a PR"
(the general public, for a public repo like `rafarc21/fleetflare` itself).
Secrets are not for every contributor; they are for the repo's own
browser/AI test legs running the repo's own trusted branches. A fork PR
gets exactly the same leg run as today — no secret, ever — matching how
`legGitToken` already withholds the git-clone token from every PR whose
base repo is public (`leg-env.ts:58-65`: the one credential a public leg
gets today is none at all beyond its own PR ref).

**Blast radius if a grant is misused anyway** (a malicious same-repo
branch, or a compromised collaborator account): the value is staging-only
by the operator's own discipline (§"Operator responsibility"), so the worst
case is staging-data tampering, never a production credential or a deploy
credential — this fleet's existing invariant that no studio or gate
container ever holds a Cloudflare deploy credential
(`apps/fleet/CLAUDE.md`'s house rule, same shape) extends naturally to gate
secrets: no gate secret is ever a deploy credential either, enforced the
same way — by never putting one in the registry.

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
    "ai-smoke": ["workers-ai"]
  }
}
```

Top-level keys are `owner/repo` (case-insensitive, matched the same way
`gateMapEntry` already matches fleet.json's `gates` map,
`apps/fleet/src/gate/config.ts:201-207`). Each value is a map from leg name
(the same string a repo's own `fleet.json` names in its `legs` array,
`GateLeg.name`, `LEG_NAME_PATTERN`) to the list of secret NAMES that leg may
receive. A secret NAME here is an opaque label — never a value, never an env
var name, never a Worker secret binding name. Malformed JSON, a non-object
top level, or an entry whose value isn't `Record<string, string[]>` parses
to an empty allowlist (fail closed — same rule `parseDenylist` already
follows for the leak-scan file, `leak-gate.ts`): a run never crashes over a
bad ops file, it just grants nothing.

### 2. Same-repo (non-fork) detection (new): `github/api.ts`

`getPullRequest` already reads `base.repo.private` on its one `/pulls` GET
(`apps/fleet/src/github/api.ts:1163-1187`, `baseRepoPrivate`). The same
response carries `head.repo.full_name` — read it too, no second API call,
same pattern the existing `#1276 headSha` comment already documents for
"one GET instead of two." A PR from a deleted fork has `head.repo: null`
(GitHub's own documented shape); treated as NOT same-repo — fail closed,
never upgrade a vanished identity into a grant. New field:

```ts
export interface PullRequestInfo {
  // existing fields unchanged ...
  /** #1346: whether the PR's head repo is the SAME repo as its base repo —
   *  false for every fork PR, and for a fork whose source repo is gone
   *  (head.repo: null). Case-insensitive, GitHub's own naming is. */
  sameRepo: boolean;
}
```

### 3. The granted-secrets guard (new, pure): `gate/secrets-scope.ts`

```ts
export function grantedSecretNames(
  allowlist: GateSecretsAllowlist, repo: string, leg: string, sameRepo: boolean,
): string[] {
  if (!sameRepo) return [];                        // guard 1: fork PRs get nothing, ever
  const forRepo = lookupRepo(allowlist, repo);      // case-insensitive, like gateMapEntry
  if (forRepo === undefined) return [];             // guard 2: repo not in the OPS allowlist
  const names = forRepo[leg];
  if (names === undefined) return [];               // guard 3: leg not named for this repo
  return names.filter((name) => name in SECRET_REGISTRY); // guard 4: unknown name, never passed through
}
```

Four independent guards, in the order a reviewer should read them: fork
first (cheapest, most load-bearing), then OPS-allowlist repo/leg lookups,
then the registry membership check (defense in depth: even an OPS typo
naming a secret this Worker never defined grants nothing, rather than
leaking `undefined` through to an env var). Pure — no fetch, no binding — so
`bun test` exercises it directly, and so it is the one function every
mutation below targets (§"Mutation testing," below).

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
  /** The Worker secret (Env key) holding this name's real value. Absent
   *  for a name whose value is minted per-run instead of stored (workers-ai). */
  envVar?: string;
}

export const SECRET_REGISTRY: Readonly<Record<string, SecretDef>> = {
  // Example: operator adds one line + one `wrangler secret put` per staging
  // credential a browser/AI leg needs. Name is a label, never the value.
  "staging-login": { envVar: "GATE_SECRET_STAGING_LOGIN" },
  // #1346 Workers AI proxy route (floor mode, T4): no stored value at all —
  // see "AI route" below.
  "workers-ai": {},
};
```

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
identically in the Worker and in `bun test`). The container gets the token
as `GATE_SECRET_WORKERS_AI` and presents it as a bearer header to a new,
narrow Worker route; the route verifies the signature, the leg name, and
`exp`, then — and only then — calls `env.AI.run(...)` itself and returns
the result. The container never holds an AI Gateway key, a Worker secret,
or anything usable outside this one run: `exp` is the run's own start time
plus its hard leg-timeout ceiling (`MAX_LEG_TIMEOUT_MIN`,
`gate/config.ts:46`, plus the container-start margin `run-leg.ts` already
budgets for an infra retry) — the token is already worthless by the time a
human could read it out of a leaked log, let alone reuse it against a
future run. "Floor mode, T4" is the specific model-routing choice the AI
route makes server-side (same shape as `LEAD_MODEL_POOL` today,
`wrangler.example.jsonc:135-150`) — the container names no model, it can't,
the token carries no such claim.

### 6. Redaction before persistence: `gate/secrets-redact.ts`

A granted secret's value can end up in a leg's own `stdout`/`stderr` (a
failing test that echoes its env, a debug print) — the same risk this
Worker already fully owns for GitHub/Tailscale/Anthropic/spawn tokens
(`apps/fleet/src/studio/redact.ts`'s own header: "unlike... scrub() (which
redacts specific token strings the container process already holds), this
Worker never separately holds the studio's GitHub token." For a gate
secret, the inversion is deliberate: THIS Worker DOES hold every value it
just granted (it minted the env var), so exact-value redaction is possible
and is what's used, not shape-based regexes — no public shape exists for an
operator-chosen staging credential the way `ghs_`/`tskey-auth-`/`sk-ant-`
have fixed prefixes.

```ts
export function redactKnownSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v !== "") out = out.split(v).join("«redacted»");
  return out;
}
```

Wired into `outbound-handler.ts`'s existing leg-result PUT path
(`handleGateOutbound`, the `RUN_RESULT_RE` branch that already writes a
leg's JSON result to R2, `outbound-handler.ts:399-420`): before the
`bucket.put`, the raw body bytes are decoded as UTF-8 and redacted against
`props.secretValues` (the plain list of values THIS leg was granted — never
names, never the registry, just the values needed to scrub). A leg with no
grants (`secretValues` absent/empty) pays the cost of nothing extra — the
redaction loop is skipped entirely. This is the one place a secret value
can leak into something every later `fleet gate log` call reads back
(`gate/log.ts`'s own `LegOutput.stdout`/`stderr`), so it is the one place
redaction is mandatory, not best-effort.

### 7. Wiring summary (call chain, same shape the git-proxy token already uses)

```
workflow.ts (resolve-pr step)
  reads sameRepo from getPullRequest           (new: §2)
  reads allowlist from OPS repo gate-secrets.json  (new: §1, fetched like the denylist)
      |
      v
leg-run.ts legRequest(...)
  carries { sameRepo, grantedSecrets: string[] } per planned leg  (new field on GateLegRequest)
      |
      v
do.ts  (GateRunnerDO.fetch, where legGitToken already mints per leg)
  for each granted name: resolve value (registry envVar -> this.env[envVar],
    or mint a run-scoped AI token)              (new: secrets-registry.ts / secrets-ai-token.ts)
  buildLegEnvVars(...) gains GATE_SECRET_* entries
  gateOutboundProps(...) gains `secretValues: string[]` (values only, for redaction)
      |
      v
outbound-handler.ts handleGateOutbound PUT path
  redacts props.secretValues out of the leg's own result body before R2 put  (new: §6)
```

Every box above already exists for the git-clone token
(`legGitToken`/`gateOutboundProps`, `leg-env.ts:58-77`) or the OPS denylist
fetch (`workflow.ts:164-179`); this feature reuses both call shapes rather
than inventing a third.

## Operator responsibility (explicitly out of this code's control)

- **Staging-only, by discipline.** Nothing in `SECRET_REGISTRY` can verify a
  value is a staging credential rather than a production one — that is
  decided the moment the operator runs `wrangler secret put
  GATE_SECRET_STAGING_LOGIN` with a particular value. The registry's own doc
  comment says so; this is a process control, not a code control, same as
  "no Cloudflare deploy credential in a studio container" is a process rule
  this repo's own CLAUDE.md states rather than something enforceable from
  inside a container.
- **`FLEET_OPS_REPO` must itself stay private**, same precondition
  `leak-gate.ts`'s denylist already depends on — a public ops repo would
  make the allowlist attacker-readable (not attacker-writable, which is the
  actual guard here, but readable is still a minor information leak: which
  legs get which secret names).

## Testing (this PR)

1. **Fork PR gets no secret.** `grantedSecretNames(allowlist, repo, leg,
   /* sameRepo */ false)` returns `[]` regardless of how permissive
   `allowlist` is — the fork guard is checked first and unconditionally.
2. **Leg outside the allowlist gets none.** Same repo granted for leg A
   grants nothing for leg B; a repo absent from the allowlist entirely
   grants nothing for any leg.
3. **Secret value redacted from logs.** A leg result body containing a
   granted value, run through `redactKnownSecretValues`, no longer contains
   that value; an UNgranted value (not in `props.secretValues`) is left
   alone, proving this is exact-value scrubbing, not a blanket wipe.
4. **Run token expires with run.** `verifyRunToken` accepts a token minted
   at `now` for `exp = now + ttl` when checked at `now + ttl - 1`, and
   rejects the identical token checked at `now + ttl + 1` — and rejects a
   token minted for a different `runId`/`leg` even before expiry.

Per the task's own mutation-testing instruction, every guard this PR adds
(the four in `grantedSecretNames`, plus the AI token's signature/expiry/
identity checks) is hand-mutated (condition flip, off-by-one on the expiry
boundary, operator swap) and the full set of new tests is re-run against
each mutant; the result envelope on the board issue reports "N guards, N
mutants, N killed."
