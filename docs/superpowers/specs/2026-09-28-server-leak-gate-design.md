# Server-side leak gate — design (issue #7)

Follow-up to #1/#2. Wrapper gate stays layer 1. This adds layer 2: server.

## 1. Problem

Wrapper gate (#2) lives in container. Container root owns it.
Studio holds a WRITE credential for its work repo:
- `/workspace/.git-credentials` (git), `~/.config/gh/hosts.yml` (gh).
- `/usr/bin/git`, `/usr/lib/git-core/git`, `/usr/bin/gh`, `curl` skip wrappers.
- Any of those + the token = unscanned public write.

Wrappers stop accidents. They cannot stop a bypass.

## 2. Goal (from issue)

1. Studio credential: NO write on public repos.
2. Pushes + gh writes: Worker endpoint. Worker scans (ops denylist, same
   parser as `src/leak-gate.ts`), then writes with its OWN token.
3. Fail closed. Errors name pattern index only.
4. Rescue stays on `FLEET_RESCUE_REMOTE` (private).

Non-goals:
- Default-branch guard server-side. Cheap follow-up (proxy sees every ref);
  kept out, surgical.
- Private work repos. Gate off there today (#2); unchanged. Studio keeps
  write token.
- Board writes. Already Worker-side and scanned (#2, `board/leak.ts`).

## 3. Write mode per studio

One decision, `writeModeFor(env, repo, isPrivate)` (`mode.ts`):
- `direct` — work repo NOT on `FLEET_WRITE_PROXY_REPOS`, OR (work repo CONFIRMED private AND
  App auth). App token = `repositories: [repo]` only.
- `proxy` — everything else. Visibility lookup error = public = `proxy`.
  PAT + private repo = `proxy` too: PAT writes every repo of its owner,
  public ones included (review finding). Scan skipped there (confirmed
  private), routing kept.

Default OFF (#13 review, rollout): `FLEET_WRITE_PROXY_REPOS` lists the work
repos to proxy; unset = deploy changes nothing. Was: default on, kill switch (logged per
provision). Same fail-closed read as #2's `applyLeakGate`.

Used by: credential mint (§4), container config (§7), both routes (§5, §6
skip scan only for confirmed private — reuse `leakGuard`).

## 4. Read-only studio credential

`runRefreshCredential` mints per mode. `direct` = today, unchanged.
`proxy`:

| Provider | Studio gets |
|---|---|
| App | installation token, `repositories: [repo]`, `permissions: {contents: read, pull_requests: read, issues: read}` |
| PAT | `GITHUB_READ_TOKEN_<OWNER>` else `GITHUB_READ_TOKEN` |
| PAT, no read token | nothing: credential files cleared, anonymous reads |

Why App narrowing works: GitHub `access_tokens` `permissions` narrows, never
widens (already used for blueprint + ops reads). Token stays repo-scoped.

Why PAT needs a second secret: fine-grained PAT scope fixed at issue time.
Worker cannot narrow it. Operator makes a read-only PAT ("Public
repositories (read-only)" is enough for a public work repo).

No read token = anonymous. Public repo clone/fetch needs no auth. gh reads
drop to unauthenticated limits. Row note says so. Never falls back to the
write PAT: that is the failure this issue closes.

Write token (App write mint / write PAT) now lives Worker-side only for
`proxy` studios.

Every OTHER container-bound token goes through `containerToken` (review
finding 1: PAT path ignores `permissions`, so each "read" mint was the write
PAT):
- blueprint clone file, memory clone env: App = narrowed mint; PAT = read
  PAT or none (row/log note; public blueprint clones anonymously).
- rescue token: App = contents:write mint scoped to the rescue repo; PAT =
  `FLEET_RESCUE_GITHUB_TOKEN` (rescue-repo-only PAT) or none → origin.
- proxy-mode mint failure = credential cleared, never stale.

## 5. Git push: receive-pack proxy

### 5.1 Options weighed

| | receive-pack proxy | bundle upload |
|---|---|---|
| Client | plain `git push`, via `pushInsteadOf` | custom `fleet push` client |
| Repo hooks, wrapper probe | run unchanged | need rework |
| Worker parses | packfile | bundle = header + packfile |
| Worker writes to GitHub | forwards SAME bytes | must speak receive-pack anyway |
| Scan = stored? | yes, byte-identical forward | yes |

Both need a pack parser. Bundle adds a client + a translation step and
still ends in receive-pack. Chosen: **receive-pack proxy**.

### 5.2 Routes

Base: `${WORKER_PUBLIC_URL}/fleet/git/github.com/<owner>/<repo>.git`

| Request | Worker does |
|---|---|
| `GET info/refs?service=git-upload-pack` | pass through to GitHub, Worker read token |
| `POST git-upload-pack` | pass through (`Git-Protocol` forwarded) |
| `GET info/refs?service=git-receive-pack` | fetch from GitHub with write token; rewrite capabilities |
| `POST git-receive-pack` | parse, scan, forward bytes, stream GitHub reply back |

Upload-pack exists for the wrapper: its probe prints the push URL, then
`ls-remote --symref <that url>` and `ls-remote` for already-pushed commits.
Without it the wrapper would scan full history every push.

### 5.3 Auth + scope

- Studio auth: spawn token. HTTP Basic password (git credential helper
  scoped to the Worker URL, reads `$FLEET_SPAWN_TOKEN` at run time — never
  in config or argv), or `X-Fleet-Spawn-Token` header. Missing = `401` +
  `WWW-Authenticate: Basic` so git asks its helper.
- `resolveSpawnParent` → studio row. Work repo = `row.repoSlug ?? AGENT_REPO`.
- Path repo must equal work repo (case-insensitive). Else `403`. Worker
  token never a confused deputy for another repo.

### 5.4 Capability rewrite (advertisement)

- Add `no-thin`. Client MUST NOT send thin pack (gitprotocol-capabilities).
  Pack becomes self-contained: every delta base in-pack.
- Drop `push-options`, `push-cert=*`. Client then refuses `-o`/signed push
  itself. Nothing unscanned rides along.
- Drop `report-status-v2`. One reply format to forge on refusal (§5.7).

### 5.5 Request parse (fail closed on anything odd)

Body = pkt-lines (`<old> <new> <ref>` [`\0caps` on first]) + flush + pack.
- `Content-Encoding: gzip` → decompress first. Any other encoding → refuse.
- Caps requested include `push-options`/`push-cert` → refuse.
- Pack required iff any command is not a delete.
- Pack: `PACK`, version 2 or 3 (same entry format), N objects, N entries, 20-byte SHA-1 trailer,
  nothing after. Trailer verified.
- Entry types: commit, tree, blob, tag, OFS_DELTA, REF_DELTA. REF_DELTA base
  must be in-pack (no-thin). Unknown base → refuse.
- Inflate: zlib (header, deflate, adler32). Own inflater: must report bytes
  consumed to find next entry; `DecompressionStream` cannot. Inflated size
  must equal header size.
- Caps: body 16 MiB, total inflated (delta output included) 24 MiB
  (Worker 128 MB: body + objects + decoded text). Over →
  `413` naming the cap. Rescue unaffected (private remote, own token).

### 5.6 What is scanned

Superset of wrapper's scan. Joined with `\n`, one `scanText` call:
- Ref names (every command).
- Commit objects: raw text (author, committer, message, extra headers).
- Tag objects: raw text (tagger, message).
- Blobs: full content, UTF-8 decode (non-fatal); BOM-marked UTF-16 also
  decoded as UTF-16 (GitHub renders it).
- Commit/tag with `encoding` header other than UTF-8 → refuse. Full, not added lines:
  a public repo must hold no denylisted term anyway; stricter side.
- Tree paths: full path from each in-pack commit root. Every tree on a
  changed path is new, so in-pack; walk stops at out-of-pack subtrees.
  Also every in-pack tree's entry names (covers trees reached no other way).

### 5.7 Verdict

Reuse `leakGuard` (board/leak.ts): confirmed-private skip, denylist fetch
once, `scanText`. Refusal:
- Hit → `422`-class. Denylist missing/unreadable → `503`-class.
- Git smart-HTTP shows HTTP errors badly. Refusals return `200` with a
  `report-status` body when client asked for it: `unpack ok` +
  `ng <ref> <msg>` per ref, message = `leakHitMessage` (index only).
  Client prints `! [remote rejected] ... (fleet: leak gate: ... #3 ...)`.
  Client asked `side-band-64k` → report wrapped in band 1, message also on
  band 2.
- Parse/size/protocol refusals: same shape, own fixed message.
- No report-status requested → plain HTTP `403`/`413` with message.
- Clean → forward exact bytes to GitHub `git-receive-pack`, write token,
  stream response back.

### 5.8 Container side

Provision/restart, `proxy` mode only, one exec (real git, like
`studioGitSafetyCmd`):
- `url.<base>/fleet/git/github.com/.pushInsteadOf https://github.com/`
- `credential.<base>/fleet/git/.helper` = reset + helper echoing
  `$FLEET_SPAWN_TOKEN`.
`direct` mode: same keys unset. Repeat-safe.

Fetch stays direct to GitHub (read token). Wrapper probe sees Worker URL,
`ls-remote --get-url` matches it, asks the Worker (upload-pack) for HEAD.

## 6. gh writes: op allowlist

### 6.1 Options weighed

| | op RPC (chosen) | REST passthrough allowlist | GHES/GraphQL proxy (`GH_HOST`) |
|---|---|---|---|
| gh transparency | wrapper translates common verbs | only `gh api` | full, in theory |
| Worker parses | fixed JSON ops | REST paths + bodies | GraphQL (mutation allowlist needs a parser) |
| Base64 blind spots | none | must exclude contents/blobs/assets | `createCommitOnBranch` etc. |
| Repo resolution | client resolves | client | gh breaks: remotes point at github.com |

GraphQL: `gh pr create`, `pr comment`, `issue comment` all use mutations;
allowlisting needs a real parser; aliases obfuscate. REST passthrough still
needs a client for gh verbs. Chosen: **op RPC**.

### 6.2 Route

`POST /fleet/gh` JSON `{op, ...}`. Spawn-token auth, repo = work repo (§5.3).
Optional `repo` on every op (client's `-R` or URL repo). ≠ work repo → 403,
never silently rewritten to the work repo.
Worker validates shape, scans every string field via `leakGuard`, then
calls GitHub with its write token.

| op | fields | GitHub call |
|---|---|---|
| `pr-create` | title, body, head, base, draft | `POST /repos/{r}/pulls` |
| `pr-edit` | number, title?, body?, base? | `PATCH /repos/{r}/pulls/{n}` |
| `pr-ready` | number | GraphQL `markPullRequestReadyForReview` (fixed text) |
| `comment` | number, body | `POST /repos/{r}/issues/{n}/comments` (issue or PR) |
| `issue-create` | title, body, labels[] | `POST /repos/{r}/issues` |
| `issue-edit` | number, title?, body? | `PATCH /repos/{r}/issues/{n}` |
| `pr-review` | number, event (COMMENT/APPROVE/REQUEST_CHANGES), body | `POST /repos/{r}/pulls/{n}/reviews` |

Unknown op / extra field / wrong type → `400`. Hit → `422`. List down →
`503`. Reply: GitHub's JSON (`number`, `html_url`) or its error, status kept.
Not offered: merge, contents, releases, gists, labels admin, `gh api`
writes. Those fail at GitHub (read token). Merges already go through the
Worker's approval gate.

### 6.3 Container client

`container/gh-proxy.ts` (bun, baked into image as `fleet-gh-proxy`).
gh wrapper, `proxy` mode (`/opt/fleet/write-proxy` marker), AFTER its own
scan: these verbs `exec fleet-gh-proxy "$@"`:
`pr create|edit|ready|comment|review`, `issue create|edit|comment`.
Everything else → real gh (reads work, writes 403 at GitHub).

Client translates flags: `-t/--title`, `-b/--body`, `-F/--body-file` (`-`
= stdin), `-B/--base`, `-H/--head`, `-d/--draft`, `-l/--label`,
`--approve/--comment/--request-changes`, positional number / URL / branch.
Unsupported flag (`--fill`, `--web`, `--editor`, ...) → refuse, name it.
Missing number → `gh pr view --json number` (read, real gh). Missing head
→ current branch. Missing base → `gh repo view --json defaultBranchRef`.
Prints the URL like gh does.

## 7. Provision wiring

`applyLeakGate` grows one step: write-mode config (§5.8) + marker. Same
fail-closed rules: step fails in `proxy` mode → row note; the token is
already read-only, so a failed config means writes FAIL, never leak.
Credential refresh (every 50 min) re-evaluates mode and applies its git
config FIRST; proxy config fails = credential not swapped (#13 review:
never a read-only credential without proxy routing).

## 8. Rescue

- `FLEET_RESCUE_REMOTE` set AND confirmed private AND a token (§4): real
  git, own token, not via proxy. The rescue push pins its URL
  (`-c url.<u>.pushInsteadOf=<u>`, longest match wins) so proxy mode's
  global `pushInsteadOf` cannot redirect it. Not private / no token →
  origin, loud log.
- Unset: rescue pushes plain `git` to origin → wrapper → pushInsteadOf →
  proxy → scanned. Hit = refused, logged loudly (same as #2).

## 9. Failure table

| Condition | Result |
|---|---|
| Visibility unknown | proxy mode (public) |
| Denylist missing/bad | push `ng`/503, gh op 503 |
| Scanner throws | refuse |
| Bad pack, bad checksum, junk after, unknown base, size mismatch | refuse |
| Over size cap | refuse, name cap |
| Worker cannot mint write token | 502, nothing written |
| Spawn token bad | 401 |
| Repo ≠ work repo | 403 |
| No read token (PAT) | anonymous, row note, never write PAT |

## 10. Operator actions

1. PAT fleets: create read-only fine-grained PAT, `wrangler secret put
   GITHUB_READ_TOKEN` (or `GITHUB_READ_TOKEN_<OWNER>`).
2. App fleets: none. App already has contents/pull_requests/issues write;
   narrowing needs nothing new.
3. `FLEET_OPS_REPO` + denylist: already required by #2.
4. Deploy rebuilds the studio image (new `fleet-gh-proxy`).
5. Enable per repo: `FLEET_WRITE_PROXY_REPOS=owner/name,...` (vars). Unlist = off.
6. Existing studios: restart to pick up read token + config.
7. **Rotate the write PAT** (PAT fleets): every pre-#7 studio held it.
8. PAT fleets: read PAT must also read private blueprint + ops repos
   (memory clone). Rescue to private remote: `FLEET_RESCUE_GITHUB_TOKEN`.

## 11. Testing

- vitest (workerd): pkt-line parse, capability rewrite, route auth/scope,
  gh op validation + scan, mode decision, credential mint per mode, caps.
- bun lane: inflate vs zlib; pack parse vs real `git pack-objects` (deltas,
  ofs + ref); end-to-end real `git push` → handler (Bun.serve) → real
  `git http-backend` on a bare repo: clean push lands, hit refused with
  index, `-o` refused, thin pack never sent. gh client flag translation.
- Fake terms only (acmeclient, 999999999).

## 12. Residual risk

- Container can still read via its read token. Reads leak nothing.
- Worker holds the write token. Compromise of Worker = same as today.
- Denylist quality bounds everything. Unchanged from #2.
- Text GitHub renders but scan cannot see as text: HTML entities in
  markdown, other encodings without BOM. Denylist can add entity forms.
- Hostile pack ordering can make delta resolution slow; Worker CPU limit
  kills it = refused (fail closed).
