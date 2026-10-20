---
# fix #1229: `fleet spawn` refuses a cwd with no git remote (refs #1229)

## What

Measured 2026-10-19 16:55Z: `cd <scratchpad> && fleet spawn pilot --new --lead deepseek`
run 3x. Scratchpad = no git repo → CLI printed "using the fleet's default repo"
and spawned 3 pilots on the default repo. Two idled ~2h, billing, no task.

## Fix (CLI-only; no Worker / container change)

Studio-CREATING verbs refuse when the cwd names no repo and no `--repo` was
given. Studio-READING verbs keep the default-repo fallback untouched.

1. **`--repo` flag on the two creating verbs** (`cli-args.ts`): `spawn` and
   `provision` each gain `repo?: string`, value-taking, `--repo <v>` /
   `--repo=<v>`, optional. Parse shape reuses the `tabs` walk. `repo` key
   absent when the flag was not given — existing parse tests stay green.
2. **Refusal on the creating path** (`cli/fleet.ts`): a new pure helper
   `requireRepoForCreate(cmd, --repo, detected) -> {ok:true; slug} | {ok:false}`
   returns `{ok:false}` when `--repo` was given and is not a valid
   `owner/name` (reuses `parseRepoSlug`), or when `--repo` was NOT given and
   `detected.slug === null`. Refusal message names the fix:
   `fleet spawn: no git remote here; pass --repo owner/name` (provision:
   `fleet provision`). `cmdSpawn` / `cmdProvision` print it and exit 1 BEFORE
   any fetch — zero Worker calls on the refusal path.
   - `--repo` wins over detection (same precedence `tabs` / `task new` use).
   - With a detected repo, or with a valid `--repo`, the request body is
     byte-identical to today (repo omitted only in the no-repo case, which no
     longer reaches the body at all).
3. **Provision's address-by-id guard is preserved**: `cmdProvision` still sends
   the repo only when its segment matches the id's (`matchesId`), unchanged. A
   bodyless provision (id not from cwd) never needs a repo, so the refusal
   never fires there. Only the `matchesId` path, where the cwd IS the source,
   refuses on no-repo.
4. **`ff` gets the same refusal** (`cli/ff.ts`, `src/studio/ff.ts`): bare
   `ff <role>` in a non-repo cwd refuses instead of spawning on the default
   repo. `ffDecision`'s no-repo branch (the `repoSegment === null` path) now
   returns `kind: "error"` with `no git remote here; cd into the repo you
   mean, or run: fleet spawn <role> --repo owner/name`. The
   `one-studio`/`more-than-one` no-repo branches and the `--new` no-repo
   refusal keep their wording. (`ff <role> "<task>"` already refused via its
   "task needs a studio" guard.) `cli/ff.ts` `main()` moves its no-repo
   `say(...)` to a hard `fail(...)`.
5. **Spawn line names the studio** (`cli/fleet.ts`): after a successful spawn,
   print one stderr line `fleet spawn: repo <slug> → <id>`. Provision keeps
   its existing row print (it already names the id via `formatTable`).
6. **Help text** (`cli-args.ts` VERBS, `ff.ts` FF_HELP): `spawn`/`provision`
   `args` gain `[--repo owner/name]`; summaries state the refusal. `ff` help
   drops "falls back to the fleet's default repo" in favour of the refusal.

## TDD

- **cli-args (vitest)** — `studio.cli-args-parse.test.ts` /
  `studio.cli-args-verbs.test.ts`: `spawn --repo` / `--repo=` parses into
  `repo`; bare spawn still has no `repo` key; bad `--repo` is a usage error;
  `provision --repo` parses; args lines + summaries updated.
- **repo helper (vitest)** — `studio.repo.test.ts` already covers
  `parseRepoSlug`; the new helper is exercised through the bun subprocess
  tests below (it is thin wiring over `parseRepoSlug` + `detectRepo`).
- **ff decision (vitest)** — `studio.ff.test.ts`: `ffDecision([], null,
  "release-studio", null)` now returns `kind: "error"` (was `spawn, id:null`);
  the one-studio/multi-repo/no-repo refusal branches keep their messages.
- **spawn subprocess (bun)** — new `test/bun/cli.spawn-no-remote.test.ts`
  (harness of `cli.task-verify.test.ts` / `ff-no-tty.test.ts`): a real
  `Bun.spawn` of `cli/fleet.ts` in a non-git cwd against a stub Worker:
  (a) `fleet spawn pilot` → exits 1, stderr has `no git remote here`, and the
  stub saw ZERO requests; (b) `fleet spawn pilot --repo acme/faux` → spawns,
  stub saw one `/studio/spawn` POST with `repo: "acme/faux"`, stderr has
  `fleet spawn: repo acme/faux → <id>`; (c) `fleet provision faux--pilot`
  from a non-git cwd still posts `{}` (bodyless — address-by-id, no refusal).
- **ff subprocess (bun)** — `ff-no-tty.test.ts` already covers tty; add one
  `ff release-studio` non-git-cwd case (or assert in the new spawn suite) that
  exits 1 with `no git remote here`, stub saw zero requests.

## Boundaries

`apps/fleet/cli/**` (`cli-args.ts`, `fleet.ts`, `ff.ts`) + `src/studio/ff.ts`
(ff decision) + tests. No Worker route change, no `src/studio/repo.ts` change
(its Worker-side fallback stays — the Worker is the single fallback source for
read verbs and for any non-CLI caller). No container change, no deploy. OSS
lead OK.

## Verify

`cd apps/fleet && bun test test/bun/cli.spawn-no-remote.test.ts
test/bun/ff-no-tty.test.ts` then `bunx vitest run test/studio.cli-args-parse.test.ts
test/studio.cli-args-verbs.test.ts test/studio.ff.test.ts test/studio.repo.test.ts`
(one at a time, flock heavy gates), then `bun run check` last.