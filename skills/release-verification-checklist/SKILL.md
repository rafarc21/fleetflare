---
name: release-verification-checklist
description: Render a release-verification checklist a human ticks in a browser, then read their verdicts back as JSON. Use when a batch of merged PRs needs manual verification before promotion — "run a verification pass", "build a checklist for this release", "fetch the review", "what did the reviewer say". Backed by a shared Cloudflare Worker; release ids are namespaced <repo>--<release>.
---

# Release-verification checklist

Turn a batch of merged PRs into a page a human ticks. Read their verdicts back
as JSON. Replaces copy-paste review threads.

The reviewer opens one URL. Per item they set a state (Approve / Pass-w-issues /
Reject / N/A), type notes, paste screenshots. Everything writes through to a
Durable Object + R2 as they go. You then fetch one endpoint and triage.

## When to use

- A release batch needs manual verification before promotion.
- Someone asks to "fetch the review" / "what did the reviewer flag".
- Any time you would otherwise paste a checklist into chat and ask for replies.

Not for: automated gates. If a test can prove it, write the test instead. See
[`reference/audit-rule.md`](reference/audit-rule.md).

## The shared worker

**BASE = `https://review-worker.demosite.workers.dev`** (CF account: demosite).
One deployment serves every repo. No per-repo deploy.

## Namespacing — read this before picking a release id

Release ids are **`<repo>--<release>`**. Example: `acme--2026-08-04-staging`.

- Separator is **`--`**, never `/`. The worker splits `url.pathname` on `/` and
  `GET /r/:release` asserts `parts.length === 2`. A slash breaks routing.
- The DO room is `idFromName(release)`, so a bare release id would collide
  across repos. The prefix makes repos disjoint.
- R2 page key follows: `pages/acme--2026-08-04-staging.html`.
- Media keys already prefix with the release, so they are namespaced free.
- Legacy unprefixed ids (`2026-07-29-fixround`) still resolve. No migration.

## Workflow

1. **Decide which PRs earn an item.** Go PR-by-PR.
   [`reference/audit-rule.md`](reference/audit-rule.md) has the rule. The
   consuming repo states its gate list once.
2. **Write the data file** — `<release>.json`, one item per check.
   Shape: [`reference/data-schema.md`](reference/data-schema.md).
   **Keep it in the consuming repo, not here** — batches are repo-specific, and a
   committed batch is how the checklist's exact contents stay inspectable later.
   Acme uses `scripts/checklist/data/`. This skill directory holds code only;
   a batch left here is invisible to the repo it describes, and its history lands
   in the skills repo rather than next to the release it verifies.
3. **Render + upload.** One command set, in
   [`reference/operate.md`](reference/operate.md). `wrangler r2 object put` needs
   **`--remote`** or the write lands in the local simulation and `/c/` 404s.
4. **Give the reviewer `$BASE/c/<repo>--<release>`.** NOT a claude.ai artifact —
   an artifact's CSP blocks the page's write-through fetches, so the ticks never
   leave the browser.
5. **Reviewer works in the browser.** Autosaves. They can close the tab and return.
6. **Fetch the verdicts** — `GET $BASE/r/<repo>--<release>` with the READ token.
   Screenshots: `GET $BASE/m/<key>`, same token. Look at them; don't just count them.
7. **Triage** every flagged item and every section the reviewer added themselves
   into **facts-only** issues — role, route, exact error, repro. No fix orders, so
   a separate agent triages unbiased.

Status meanings: `approved`=ship · `issues`=ship + follow-up · `rejected`=blocks
promotion · `na`=skip · `""`=unreviewed. Absent from `items` = untouched.

## The read-back is the point

A `200` on `/c/` proves the page serves. It does **not** prove a tick persists.
The round-trip — human clicks, `GET /r/` returns it — is the only real check.
Verify a new deployment that way once, in a real browser.

Two traps that have actually bitten:
- `wrangler r2 object put` without `--remote` writes to the local simulation.
  The page 404s and looks like a worker bug.
- Reading `render.ts` in a stale worktree and reasoning about the *deployed*
  page. When a claim is about a deployed artefact, fetch the artefact.

## Files

| Path | What |
|---|---|
| `render.ts` | data JSON → self-contained HTML page. `bun run render.ts <data.json> [out.html]` |
| `worker/` | the Cloudflare Worker + Durable Object + R2 backing it |
| `reference/audit-rule.md` | which PRs earn an item (template — repo fills in its gates) |
| `reference/data-schema.md` | the data JSON shape |
| `reference/operate.md` | endpoints, tokens, add-a-page, deploy, rotate, kill switch |

## This directory IS version-controlled (since 2026-08-04)

`~/.claude/skills/` is a git repo as of `37a9381`. Changes here have history and
a diff. `node_modules/`, `.venv/` and the three third-party skills carrying their
own upstream remotes are gitignored — source is 4.7 MB of the 464 MB on disk.

There is still **no review trail** — commits land directly, with no PR. So before
editing `worker/` or `render.ts`, consider whether the change should be reviewed
somewhere first, and always re-run `worker/` tests
(`cd worker && npm ci && npx vitest run`) plus a render diff against a known
batch before trusting it.

Committing is now the cheap part. Do it per change, so a wrong claim in a skill
is visibly corrected rather than silently replaced.
