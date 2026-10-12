# Issue #564: fleet ls arg refusal — plan (S20-F2)

Ref #564, finding 2 of sweep 20 (docs/maintainability/2026-10-12-cli-args-sweep-20.md). `ls` parses its three flags (`--fresh`, `--json`, `--prs`) by exact-string membership over the rest of argv and never examines any other token: `fleet ls --json=false` silently parses as `json:false` (a known flag spelled with a value reads as accepted-and-overridden), and an unknown `--` token disappears entirely. Stray positionals (`fleet ls extra`) stay ignored — that is ls's documented long-standing grammar.

## Steps
1. RED: pin the refusals in apps/fleet/test/studio.cli-args.test.ts — `--json=false`, `--fresh=1`, `--prs=x`, and an unknown `--no-such` token each parse to `{ cmd: "usage" }` with a message matching /unexpected "--json=false"/ (or the matching token), while `fleet ls extra` still parses `{ cmd: "ls", fresh: false, json: false, prs: false }`.
2. GREEN: in apps/fleet/src/studio/cli-args.ts `case "ls":`, scan argv.slice(1): any token starting with `--` that is not exactly `--fresh`/`--json`/`--prs` returns `usage(\`unexpected ${JSON.stringify(token)} — ls flags are --fresh --prs --json (no values)\`)`. Positionals still ignored.
3. Verification: `cd apps/fleet && npx vitest run test/studio.cli-args.test.ts` (the one test file touched — full suite belongs to CI), then `bun run english-check`.
4. Code Reviewer fresh-context review, QA, PR refs #564.

## Boundaries
- Only the `ls` case in parseCliArgs + its tests. No other verb, no parseFlags, no shared helper (the other S20 findings are separate issues #563/#565-567 — do NOT fix them here).
- No new deps, no new files besides the plan doc.
- Message must name the offending token (JSON.stringify) and list the three flags.

## Verification
- `cd apps/fleet && npx vitest run test/studio.cli-args.test.ts` — all pass, including the new refusal pins.
- `cd apps/fleet && bun run english-check` — clean.
