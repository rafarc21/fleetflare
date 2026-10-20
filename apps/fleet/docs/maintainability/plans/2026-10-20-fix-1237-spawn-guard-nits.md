---
# fix #1237: spawn guard nits after #1236 (refs #1229)

## What

Three review nits on the #1229/#1236 spawn guard, all CLI-only.

1. `cli/fleet.ts` cmdProvision: `provision <id> --repo X` where X's folded repo
   segment does not match the id's segment silently ignores the flag and sends
   a bodyless provision. Fix: refuse, exit 1, before any fetch.
2. `cli/ff.ts` spawnStudio (~148): the header comment still describes the
   pre-#1229 default-repo fallback ("omitted entirely when this folder names
   none, so the Worker's own default is the single source of that fallback").
   Fix: describe the refusal.
3. `cli/ff.ts` main (~563): prints "refusing to use the default repo" then still
   attaches when exactly one studio of that role exists. Fix the message to
   match the behavior (it does not refuse; it resolves to the one existing
   studio, or refuses to guess between several).

## Fix

- cmdProvision: after `requireRepoForCreate` succeeds and `repoFlag` was given,
  compute the `--repo` slug's folded segment; when the id's `parseStudioId`
  segment differs, `console.error` a refusal naming both and `process.exit(1)`
  before any fetch. When the flag was NOT given, keep today's address-by-id
  bodyless behavior (a cwd-detected repo that disagrees is already silently
  bodyless — that is the existing contract; only an EXPLICIT --repo is a
  stated intent and must refuse).
- cli/ff.ts spawnStudio header: rewrite the stale sentence to "the detected
  repo is required; a folder that names none refuses before this is called (see
  main/ffDecision, #1229)".
- cli/ff.ts main: change the no-repo `say(...)` to name the real outcomes —
  "no git remote here; resolving by the one existing <role> studio, or
  refusing if several" — never the word "refusing" when it may attach.

## TDD

- `test/bun/cli.spawn-no-remote.test.ts` (or a new
  `test/bun/cli.spawn-guard-nits.test.ts`): `fleet provision faux--pilot
  --repo acme/other` (segment mismatch) exits 1 with a refusal naming both,
  zero Worker calls; `--repo acme/faux` (segment match) still sends the repo.
- A unit test on the new ff no-repo message string (pure) where feasible.

## Boundaries

apps/fleet/cli/** + tests. CLI-only, no Worker/container change. OSS lead OK.

## Verify

`cd apps/fleet && bun test test/bun/cli.spawn-no-remote.test.ts
test/bun/ff-no-tty.test.ts test/bun/cli-gate.test.ts` then
`bun run check` last.
---