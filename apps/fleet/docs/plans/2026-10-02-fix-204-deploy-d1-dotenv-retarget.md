# A stray `.env` var can retarget a D1 migration to the wrong Cloudflare account (board issue #204)

## The bug as reported

`bash scripts/deploy.sh d1 migrations apply fleet --remote` (with
`CLOUDFLARE_ACCOUNT_ID` exported on the command line) failed with a
Cloudflare API error: `[code: 7403] account not authorized`. Running the
identical command directly — `bunx wrangler d1 migrations apply fleet
--remote -c wrangler.local.jsonc` — with the same exported account id,
worked.

## Root cause

`scripts/deploy.sh` does `cd "$FLEET_DIR"` (i.e. `apps/fleet/`) before
`exec`-ing wrangler. Wrangler auto-loads `.env`/`.env.local` (and, when
`-e`/`--env`/`CLOUDFLARE_ENV` is set, also `.env.<env>`/`.env.<env>.local`)
from its OWN cwd into `process.env` BEFORE it reads the config or
authenticates. `.env`/`.env.local` are gitignored in this repo specifically
because local dev is expected to have one (see the root `.gitignore`). If
`apps/fleet/.env` holds a stray `CLOUDFLARE_ACCOUNT_ID` — left over, for
example, from local `wrangler dev` against a sandbox account — it silently
overrides whatever the operator exported on the command line, sending the
real D1 migration to the wrong, unauthorized account. A plain `bunx
wrangler ...` run from a different cwd never loads that file, so it "just
works" — exactly the confusing symptom reported.

## Why `deploy-target.ts`'s existing guard does not cover this

`scripts/deploy-target.ts` (lines 98-112, issue #36/#48's target check)
already implements a scan for exactly this hazard, with this comment:
"Wrangler loads .env files from its cwd (deploy.sh cds into this app dir)
into process.env BEFORE reading the config: .env, .env.local, and with an
env also .env.<env>, .env.<env>.local. A CLOUDFLARE_* or WRANGLER_* var
there ... can retarget the deploy behind this check's back: refused." But
`deploy-target.ts` only runs for the subset of commands
`replaces_containers()` matches in `deploy.sh` (plain `deploy`, `versions
deploy`, `rollback`, `delete`, `containers delete` — see `is_read_only`/
`replaces_containers` in `deploy.sh`). `d1 migrations apply --remote` is
not in that set — confirmed by this repo's own
`test/bun/deploy-rescue-gate.test.ts` test: `"d1 migrations apply fleet
--remote" replaces no container: rescue-all never runs`. So `d1 migrations
apply --remote` (and `secret put`, `kv`, `r2`, and every other
non-read-only wrangler subcommand that is not a container-replacing one)
never gets this protection: the gap this issue closes.

## The fix

1. `scripts/deploy-env-guard.ts` (new): a pure function
   `findDotenvVar(appDir, envName?)` — the exact scan logic that used to be
   inline in `deploy-target.ts` — plus a thin CLI (`if (import.meta.main)`)
   that refuses loudly (stderr, naming the file and the key, referencing
   this issue's own symptom so a future reader understands why the check
   exists) and exits 1 on a hit, or exits 0 otherwise.
2. `scripts/deploy-target.ts`: the inline scan block is replaced by a call
   to `findDotenvVar`, de-duplicating the logic with no behavior change.
3. `scripts/deploy.sh`: inside the `if ! is_read_only ...; then` block —
   i.e. for EVERY non-read-only wrangler command, not just the
   container-replacing subset — call the new guard script at the very top
   of that block, before the ops-checkout git-dirty logic, so
   `--allow-dirty-ops` (a different concern entirely) cannot skip it. A
   best-effort scan of `$ARGS` for `-e`/`--env`/`--env=` supplies the
   optional env name (a miss there only means an env-specific dotenv file
   is not also checked; the universal `.env`/`.env.local` check — the one
   that matches this bug's own repro — always runs). If `bun` is not on
   PATH, this warns loudly and continues (matching how the rest of the
   script already treats a missing `bun`), rather than refusing. Read-only
   commands (`whoami`, `secret list`, `versions list`, any `d1 ...
   --local`, ...) are untouched: those never touch a real Cloudflare
   account, and `--local` is exactly where a legitimate dev `.env` is
   expected to live.

## Test plan (TDD)

All in `test/bun/deploy-rescue-gate.test.ts`, extending its existing
hermetic fake-Cloudflare-API + stub-wrangler harness (no real credentials
ever touched):

1. RED: a new test reproducing the reported bug — write a `.env` in the
   temp fleet dir containing `CLOUDFLARE_ACCOUNT_ID=acct-wrong`, then run
   `d1 migrations apply fleet --remote` and assert it is refused (exit
   non-zero, stderr names the file and `CLOUDFLARE_ACCOUNT_ID`) and that
   wrangler never ran. Confirmed failing before any guard exists (`d1`
   currently sails straight through).
2. The same `.env` but with only an unrelated var — must NOT refuse,
   wrangler runs (the guard is scoped to `CLOUDFLARE_*`/`WRANGLER_*`, not
   "any `.env` is bad").
3. `d1 migrations apply fleet --local` with the same stray
   `CLOUDFLARE_ACCOUNT_ID` — must NOT refuse (read-only/local path is out
   of scope; no regression to normal local dev).
4. A non-d1 example (`secret put X`) with the same stray `.env` — must
   refuse, proving the fix covers every non-read-only wrangler command, not
   only `d1`.
5. GREEN: implement the design above; re-run all four plus every
   pre-existing test in this file.

## Other harnesses that copy `deploy.sh` into a temp tree

- `test/bun/deploy-ops-guard.test.ts` stubs `deploy-target.ts` with a
  trivial `process.exit(0);` passthrough so its ops-checkout-dirty tests
  are unaffected by the (unrelated) target check; the new
  `deploy-env-guard.ts` gets the same trivial passthrough stub there.
- `test/bun/deploy-config-placeholder.test.ts`: its one test case that
  reaches the non-read-only branch with a filled-in config needs the same
  passthrough stub for `deploy-env-guard.ts` (its other two cases are
  refused earlier, at the placeholder check, before `is_read_only` is even
  consulted).
- No other test in the tree copies `scripts/deploy.sh` and exercises a
  non-read-only command.

## Out of scope

Real `migrate:local`/`migrate:remote`/`deploy`, and `test:integration`/
`test:acceptance`, need live wrangler/GitHub App credentials this
container does not and must not have — not exercised here. Verification is
entirely through the existing hermetic test harness.
