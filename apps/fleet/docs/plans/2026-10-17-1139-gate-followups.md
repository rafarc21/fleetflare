# 1139 — gate #1136 follow-ups

Follow-ups from the #1136 review (maestro 2026-10-16). Three fixes, all on the
gate runner. TDD: one failing test per item, then the minimal change.

## 1. Docs/comments say "no status"; behaviour is red

No gate block at a gated PR's base (or a malformed one) now fails the head
(#1132), never a silent skip. Only `GATE_RUNNER_REPOS` / `FLEET_GATE_RUNNER`
switch a repo off. Fix the drift in `docs/runbooks/gate-runner-enable.md`
(146-147, 159-160), the headers of `load-config.ts` / `fleet-json.ts` /
`auto-run-env.ts`, and add the #1125 "head moved" skip to `routes.ts`'s
success mapping. Test: `apps/fleet/test/gate-routes.test.ts`.

## 2. Failure text misleads

`config.ts` `noGateBlockFailure` says "no gate block at base" for every
`base === null` — a malformed block or `gates` entry reports the same text as
an absent block, so "merge gated base" cannot help. New text:
`no valid gate config at base <sha8>`. Test: `apps/fleet/test/bun/gate-config.test.ts`.

## 3. Shared head sha false red

Run ids are keyed (repo, head sha). A PR into an ungated base opens first and
fails; a later PR with the same head into a gated base collides and `reused`
inherits that red until `fleet gate run`. On the reuse path, when
`index.latest(repo, pr)` does not name this head, start a fresh `-r` run.
Test: `apps/fleet/test/bun/gate-auto-run.test.ts`.

## Verification

- `apps/fleet`: `bun test test/bun/gate-config.test.ts`
- `apps/fleet`: `bun test test/bun/gate-auto-run.test.ts`
- `apps/fleet`: `npx vitest run test/gate-routes.test.ts`
- `apps/fleet`: `npx tsc --noEmit`
- Root `check`: `bun run check` (green, recorded in the done record)

refs #1132, refs #715.