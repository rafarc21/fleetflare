# README rewrite for newcomers (board issue #123)

## Problem

The current root `README.md` (953 lines) is an excellent, exhaustively-verified
OPERATOR runbook — every command and env var cross-checked against
`apps/fleet/src/env.ts`, `apps/fleet/cli/fleet.ts`, and `apps/fleet/scripts/deploy.sh`.
But it is not a newcomer's front door: there is no hero pitch a stranger can
read in 30 seconds, no diagram, no badges, no FAQ, and the real quickstart is
buried after ~700 lines of secret-by-secret walkthrough. Board issue #123 (CTO
request, 2026-09-30) asks for a rewrite that a newcomer understands in 30
seconds and can run a studio from in 10 minutes — fun, good-looking, tasteful
emojis — while losing zero of the existing operator detail.

## Approach

Split, don't delete. The exhaustive operator walkthrough is too valuable to
cut — it moves to `docs/`, verbatim in substance, and the root `README.md`
becomes a short, welcoming front door that links to it.

### New root `README.md` (target: ~150-220 lines)

In order:
1. **Hero** — project name, one-line pitch, badges (license, runtime, CLI —
   static/honest badges only; no live CI badge since GitHub Actions is
   disabled on this repo per the CI section further down)
2. **Why this exists** — condensed to 3 bullets (from the existing "Why this
   exists" prose)
3. **How it fits together** — the existing Worker/StudioDO/Container/Board/
   Blueprint table, PLUS a new Mermaid diagram showing the same shape
   (Board → Worker → StudioDO → Container, Blueprint → Container)
4. **60-second pitch of "Leads never implement"** (one paragraph, kept — it's
   a genuine differentiator)
5. **Quickstart** — condensed to the real minimum path to a first studio
   (clone, bun install, copy wrangler.example.jsonc, the handful of
   essential secrets, deploy, `fleet ls`), explicitly linking to
   `docs/setup.md` for the full step-by-step walkthrough (Cloudflare D1/R2,
   GitHub auth options, Access, all secrets, Claude accounts, first deploy).
   Every command kept inline must be copy-pasted verbatim from the current
   README (already verified against code) — do not invent or paraphrase a
   command.
6. **Daily use** — the existing `ff` / `fleet ls|check|task|provision|
   recycle|destroy` table, kept as-is (already verified against
   `apps/fleet/src/studio/cli-args.ts`'s `renderHelp()`)
7. **Key concepts** — a short glossary table: studio, lead, maestro, board,
   rescue, junior/GLM, account failover, leak gate — one line each, linking
   into docs/ where the concept is covered in depth
8. **Safety features** — bullets: leak gate (always on), write proxy
   (opt-in), no Cloudflare deploy credential ever in a studio, Cloudflare
   Access in front of the terminal endpoint, rescue-before-destroy/recycle
9. **FAQ** — 5-8 Q&A pairs anticipating a newcomer's first questions (e.g.
   "Why GitHub Issues instead of a dashboard?", "What happens if my laptop
   dies mid-task?", "Does this cost money when idle?", "Can I use it with
   any AI coding tool or just Claude Code?", "What stops it going rogue on
   my repo?") — answers grounded in what's already documented, not invented
10. **Repository layout** — keep as-is (short, already good)
11. **Development / CI** — condensed: the `bun run check|test|bun-test`
    block and a one-line pointer to `docs/operations.md` for the local-ci
    daemon details
12. **Status, Security and license** — keep as-is, links to
    `docs/threat-model.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`

Emojis: tasteful, sparse — section headers or the hero line only, never
mid-sentence decoration, never in code blocks or command output.

### `docs/setup.md` (new)

Everything from the current README's "Requirements" (full detail),
"Optional, operator-specific features" table, and the full "Quickstart from
zero" section (steps 0-8, all secrets, Claude accounts, first-deploy
mechanics, rescue-gate mechanics) — moved verbatim, only re-headed to stand
alone as a doc (no content rewritten, no detail dropped). README links to it
from the Quickstart section.

### `docs/operations.md` (new)

Everything from "Things that will bite you" and the "CI" section (local-ci
daemon, lanes, `known-flaky.txt`, etc.) — moved verbatim. README links to it
from Development/CI.

### Unchanged files

`docs/threat-model.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`,
`NOTICE` — no changes needed; README already links to all of them and
keeps doing so.

### Content-loss check

Before merging: diff the old README against (new README + docs/setup.md +
docs/operations.md) section by section and confirm every fact, command, env
var name, and caveat in the original survives somewhere in the new set. No
content lost, only relocated and the front door shortened.

### Zero private names

No client names, customer names, company names, internal hostnames or
account ids anywhere in the new files — the existing README already uses
only generic examples (`acme-org`/`acme-corp`/`acme-fleet`,
`example.workers.dev`, `<you>/fleetflare`); keep that convention throughout,
including in any new FAQ/example text.

## Verification

This is a docs-only change (no `apps/fleet/src/**`, `cli/**`, or
`container/**` edits). Run, in this order (one heavy gate at a time — do not
parallelize `bun run test` with `bun run bun-test`):

```bash
cd apps/fleet
bun run check         # tsc, all projects — should be a no-op re: docs but must still pass
bun run english-check  # this repo's own English-content gate
bun run test           # vitest-pool-workers
bun run bun-test        # needs tmux + chromium (both present in this container); needs no docker
bun run build:page     # unrelated build script, but declared in package.json — must still exit 0
```

`bun run test:integration` and `bun run test:acceptance` are excluded: both
need `docker` (not installed in this container — confirmed via
`command -v docker` exit 1) and `test:acceptance` additionally needs a Max
OAuth token this environment does not have (documented in the test file's
own header comment). This matches how those two lanes are already excluded
from the default `bun run test` / CI fast lane by design.

## Boundaries

- No code changes outside `README.md`, new `docs/setup.md`, new
  `docs/operations.md`, and this plan doc.
- No content deletion — relocation only.
- No private names (see Zero private names above).
- One PR, "Closes #123".
</content>
