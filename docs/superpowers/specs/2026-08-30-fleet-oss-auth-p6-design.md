# Fleet P6 — Auth Seams, Toward OSS

Date: 2026-08-30. Status: brainstormed with the operator, approved, pending spec review.
Extends P4/P5. Does not supersede them.

## 1. Problem

The fleet is welded to the operator's accounts. Target is a public OSS release: someone
clones it, brings their own accounts, runs it on their repos.

Motivating failure, measured 2026-08-29. `ff` in a personal repo:

```
ff: repo rafarc21/sample (from git remote origin)
ff: spawn failed: 403 repo "rafarc21/sample" is not reachable by this
    fleet's GitHub App installation
```

Not a bug — the security check working. But the cause is structural: the Worker
pins ONE installation (`GITHUB_INSTALLATION_ID: "2222222"`, hardcoded in
`wrangler.jsonc`). GitHub Apps install per ACCOUNT. `acme-org` is an org,
`rafarc21` is a user, so the org installation cannot cover the personal repo,
and a second installation would have a different id the Worker never reads.

Installing the App on the personal account does NOT fix it. That is the finding.

## 2. Two auth axes — different problems, different answers

| axis | question | today | P6 |
|---|---|---|---|
| **operator auth** | may this human drive the fleet? | Cloudflare Access service tokens | **Directus** |
| **repo auth** | how does the fleet touch git? | App installation token, one pinned id | **provider seam**: token (default) or App |

Conflating them is why this looked like one problem.

## 3. Operator auth — Directus replaces Cloudflare Access

Access is paid Cloudflare Zero Trust tied to the operator's account. Hard blocker for
anyone cloning this. "Bring a Directus instance" is portable, and the agency
already runs one.

**RULING (the operator, option A): auth fails CLOSED and that is accepted.** Directus
unreachable = no fleet controls. Studios keep running; attach, spawn, recycle
and the board verbs stop.

This is a deliberate departure from P5c §7's fail-open rule, and the two must
not be confused:

| Directus role | availability | why |
|---|---|---|
| **data** (project card, contract, requirements) | fail-OPEN — studio boots without it | a fifth store that blocks provisioning is a fifth way to have no fleet |
| **auth** (operator identity) | fail-CLOSED | auth that fails open is not auth |

Rejected, recorded so it is not revisited by accident:
- **cached session with TTL** — survives a short outage, more moving parts. Revisit only if an outage actually bites.
- **break-glass static token** — a permanent secret that bypasses auth. The thing that is always regretted. Argued against; not built.

## 4. Repo auth — a provider seam

One interface, two implementations:

```
UserToken        fine-grained PAT. One secret. Any repo the token can reach.
                 DEFAULT for OSS.
AppInstallation  current behaviour. Org-scoped, bot identity, higher rate
                 limits. Better for teams.
```

Everything the App does today has a token equivalent: clone/push via the
credential helper, board issues/labels/comments, blueprint fetch, memory
commits, PR merges at the gate.

The one real change is the reachability check. `listInstallationRepos` becomes
"can this credential GET this repo" — simpler, and it works for any owner,
which is exactly what `sample` needed.

Honest cost of the token path: it acts as the USER, not a bot. Commits carry a
human name. Scope is whatever was granted rather than per-repo installation.
Lower rate limits. Fine for a solo operator; the App stays the better answer
for a team. Hence both, not a replacement.

Kills `GITHUB_INSTALLATION_ID` as a required pin.

## 5. What else ties this to one account

The App was the smallest of it. An outsider adopting this today also needs:

| coupling | verdict |
|---|---|
| Cloudflare Workers + Containers | **hard dependency**, the runtime itself. Not abstractable without a rewrite. Document it as a requirement. |
| Cloudflare Access | removed by §3 |
| `acme-org` pins, account id in wrangler.jsonc, `@fleetflare/fleet` package name | config extraction |
| blueprint content IS the operator's studios | an outsider needs EXAMPLE studios, not the Web Designer |
| Tailscale | already optional; keep it optional and say so |

## 6. Staging

- **P6a — auth seams.** Repo-auth provider + Directus operator auth. Unblocks
  personal repos immediately; `sample` works the day it lands.
- **P6b — OSS packaging.** Config extraction, example blueprint content, setup
  doc, a public-repo story. Depends on P6a.

## 7. Open

- Directus auth mechanism unchosen: static token per operator, Directus user
  login, or a Directus role check. Decide in P6a's plan with the Worker's
  existing auth middleware in view.
- Rate limits on the token path are unmeasured against a real sprint's traffic.
- The board is GitHub Issues. For OSS that is a reasonable requirement, not a
  further abstraction. Do not build a board-provider seam on speculation.
