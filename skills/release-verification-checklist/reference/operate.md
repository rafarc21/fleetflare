# Operate — render, serve, read back

`$SKILL` = `~/.claude/skills/release-verification-checklist`
`$BASE`  = `https://review-worker.demosite.workers.dev` (CF account: demosite)

Worker `review-worker`, DO class `ReviewRoom` (one instance per release id),
R2 bucket `review-media`.

## Who opens what

- **Human** opens **`$BASE/c/<repo>--<release>`**. The worker serves the page
  from R2. Reviews write through to the DO/R2.
  ⚠️ Give the human THIS URL, never a claude.ai artifact — an artifact's CSP
  blocks external fetch, so the page cannot talk to the worker and the ticks are
  silently lost. A same-origin worker-served page is required.
- **Agent** fetches **`$BASE/r/<repo>--<release>`** with the READ token → JSON of
  every status + note + media ref. Screenshots: `$BASE/m/<key>`, READ token.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /c/:release` | public | serve the UI (write token injected server-side) |
| `GET /r/:release` | READ | full review JSON — the agent fetches this |
| `PUT /r/:release/item/:id` | WRITE | upsert `{status,note}` (page autosave) |
| `PUT /r/:release/meta` | WRITE | reviewer-added sections/items |
| `POST /r/:release/media?id=:id` | WRITE | upload screenshot/video → R2 |
| `GET /m/:key` | READ | stream media |
| `DELETE /r/:release/media/:key` | WRITE | remove media |

`/c/` is public by design: the release id is the secret. Do not put a client
name or anything sensitive in a release id.

## Tokens

Two secrets, split so a leaked page cannot dump the review.

- **`REVIEW_WRITE_TOKEN`** — baked into served pages at serve time. Writes only;
  CANNOT `GET /r` or `/m`. A leaked page can only APPEND.
- **`REVIEW_READ_TOKEN`** — agent only, never in a page. Reads (and writes).

Both live in Infisical (Acme: projectId `00000000-0000-4000-8000-000000000000`,
path `/review`, env `staging`) and as wrangler secrets on the worker. Never
inline a value into a file, a commit, or a PR body.

### Scoped read tokens (namespace isolation)

One `REVIEW_READ_TOKEN` unlocks **every** release in the worker. With repos
sharing one deployment, that means any repo's agent can read any other repo's
review. `REVIEW_READ_TOKENS` fixes it:

```
REVIEW_READ_TOKENS = {"<token-for-repo-a>":"repo-a","<token-for-repo-b>":"repo-b"}
```

A scoped token reaches `<prefix>--*` and **nothing else** — not another
namespace, not a legacy unprefixed id. The match requires the `--` separator, so
a token scoped to `acme` does not reach `acme-evil--x`. A malformed JSON
value is ignored (fails closed) and the unscoped token keeps working.

The single `REVIEW_READ_TOKEN` stays honoured as an unscoped fallback, so
adopting this breaks nothing.

Set it like any other secret:

```bash
cd $SKILL/worker
npx wrangler secret put REVIEW_READ_TOKENS      # paste the JSON map
```

## Add a release page

```bash
REVIEW_BASE=$BASE REVIEW_WRITE_TOKEN=__WRITE_TOKEN__ \
  bun run $SKILL/render.ts <path>/<release>.json /tmp/page.html

cd $SKILL/worker
# NOTE: no --remote here — correct for the wrangler 3.x installed on this
# machine, where remote is already the default. On wrangler 4.x you MUST add
# --remote. See the version note below before copying this line anywhere.
CLOUDFLARE_ACCOUNT_ID=0000000000000000000000000000ac \
  npx wrangler r2 object put review-media/pages/<repo>--<release>.html \
  --file /tmp/page.html --content-type text/html
```

- `__WRITE_TOKEN__` is a **placeholder**. `GET /c/:release` swaps in the real
  token from the secret at serve time, so the token never sits in R2 or git.
- **The `--remote` flag is version-dependent — check yours before copying the
  command.** On wrangler **4.x** `--remote` is required; without it the object
  goes to the local simulation and `GET /c/…` returns 404, which reads exactly
  like a worker bug. On wrangler **3.x** remote is the *default* and there is no
  `--remote` flag at all — passing it fails with
  `✘ [ERROR] Unknown argument: remote`. Verified 2026-08-04 on 3.114.17, where
  `--local` is the only storage flag.
  **Either way, do not trust `Upload complete.`** — a local write prints the same
  line. Confirm by fetching the served page (below).
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` must be set. If they are not
  in the environment, an app's `.dev.vars` on the same CF account works:
  `set -a; . <app>/.dev.vars; set +a`.
  **Select the account explicitly whenever the machine has more than one** — with
  several accounts and no `CLOUDFLARE_ACCOUNT_ID`, wrangler exits listing them and
  does nothing. This worker lives on the **demosite** account,
  `0000000000000000000000000000ac`. (Acme's own account,
  `0000000000000000000000000000fb`, is a different one — LMS video R2.)

Confirm the served page before handing it over:

```bash
curl -s "$BASE/c/<repo>--<release>" > /tmp/served.html
grep -c "__WRITE_TOKEN__" /tmp/served.html      # 0 — placeholder was substituted
grep -c "nothing is uploaded" /tmp/served.html  # 0 — worker-bound page must not claim local-only
```

## Read the review back

```bash
curl -s -H "authorization: Bearer $REVIEW_READ_TOKEN" "$BASE/r/<repo>--<release>" | jq .
```

Read per-item `status` + `note`. Fetch `$BASE/m/<key>` and **look at** each
screenshot. Then triage `addedRoles` / `addedItems` too.

## Verify live

```bash
curl -s -o /dev/null -w "%{http_code}\n" $BASE/r/smoke                                    # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $READ"  $BASE/r/smoke  # 200
curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer $WRITE" $BASE/r/smoke  # 401 (write can't read)
```

## Tests

```bash
cd $SKILL/worker && npm ci && npx vitest run
```

15 tests (miniflare, `@cloudflare/vitest-pool-workers`). Plus
`test/integration.mjs` — browser write-through against `wrangler dev`.

⚠️ A test that opens a **new DO room** must fully drain every response body
(`await r.arrayBuffer()`), even when only asserting `.status`. Otherwise
isolated-storage teardown cannot confirm the DO's storage transaction closed and
the whole file fails with "Isolated storage failed". `test/worker.test.ts` has
an `st()` helper that does this; `src/index.ts` has `relay()` for the same
reason on the worker side. Do not "simplify" either away.

## Deploy / redeploy

```bash
cd $SKILL/worker && npx wrangler deploy
```

Bindings (DO `REVIEW_ROOM`, R2 `MEDIA`=review-media) + the DO migration live in
`wrangler.toml`. `CLOUDFLARE_API_TOKEN` in env authenticates wrangler (no login).

⚠️ One deployment serves every repo. A deploy affects **in-flight reviews in
other repos**. Deploy when no review is mid-flight, and treat it as a shared
resource.

## Rotate tokens

```bash
openssl rand -hex 24 | tee /dev/tty | npx wrangler secret put REVIEW_READ_TOKEN
openssl rand -hex 24 | npx wrangler secret put REVIEW_WRITE_TOKEN
```

Update the secret store to match. Served pages auto-pick the new write token
(injected at serve time); no re-upload needed.

## Kill switch

```bash
cd $SKILL/worker && npx wrangler delete        # remove the worker
npx wrangler r2 bucket delete review-media     # remove media (destructive)
```
