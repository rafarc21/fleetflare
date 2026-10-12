# S14-F6: one name for the 300-char error-snippet cap — board #510

**Spec:** https://github.com/rafarc21/fleetflare/issues/510 (sweep 14, finding S14-F6, parent #485).
**Tier:** GLM-OK — mechanical interpolation, no behavior change.

**Change:** add `export const ERROR_SNIPPET_MAX_CHARS = 300` to `cli/diag.ts` (the
module that already owns body-decoding — `decodeBody` sits right under it and
takes the cap as its `maxChars` parameter), then replace the raw number at all
16 sites the issue names:

- `cli/fleet.ts` — 9 sites: lines 889, 1150, 1187, 1199, 1339, 2347, 2370, 2449, 2557
  (`(await res.text()).slice(0, 300)` → `.slice(0, ERROR_SNIPPET_MAX_CHARS)`)
- `cli/accounts.ts` — 3 sites: lines 100, 319, 455 (same shape)
- `cli/ff.ts` — 3 sites: lines 94, 199, 313 (line 199 is `body.slice(0, 300)`)
- `cli/inspect-request.ts:47` — `decodeBody(res.status, text, 300)` →
  `decodeBody(res.status, text, ERROR_SNIPPET_MAX_CHARS)`

Import updates: fleet.ts:51 and accounts.ts:23 extend their existing
`import { errText } from "./diag"` to include `ERROR_SNIPPET_MAX_CHARS`;
ff.ts:55 same; inspect-request.ts:6 extends `import { errText, decodeBody }`.

Doc comment on the const: 2-3 lines of WHY (the CLI's one readability budget
for an error body; before this the number was re-typed per call site), per the
repo's comment-earns-its-place rule. No other comment changes — repair-failure.ts:10's
history note ("Before #96 every verb printed text.slice(0, 300)") stays: it
describes git history, not the current tree, and is a test-comment anchor too
(test/cli.repair-failure.test.ts:21).

## Out of scope (deliberate)

- `boardRequest`'s `slice(0, 500)` (fleet.ts:1603) — a DIFFERENT, deliberate
  budget, pinned by test/bun/cli.task-verify.test.ts:145's "up to 500 chars"
  comment. Not one of the issue's 16 sites; not touched.
- All `src/`-side copies (wake.ts, board/api.ts, github/api.ts, do.ts, session-sync.ts,
  provision.ts, telegram/*, directus/*, deploy/do.ts, agents/runtime.ts) — the
  issue scopes this sweep to the CLI; src/ files are Worker graph, cli/ is not,
  and the sweep doc reserved no src/ finding here.
- `container/fleet-cli.ts:18` — inside the container image (ONE_WAY_GLOBS
  `apps/fleet/container/**`), out of CLI scope.
- test-integration + scripts/sensors copies — not in the issue's file list.

## RED / GREEN

RED (before the sweep, on this branch): `grep -c "slice(0, 300)"` over the four
CLI files returns 15, and `grep -n "text, 300)"` over inspect-request.ts returns
site :47 — 16 raw copies, none named.

GREEN (after): `grep -rn "slice(0, 300)\|slice(0,300)\|, 300)"` over
`cli/fleet.ts cli/accounts.ts cli/ff.ts cli/inspect-request.ts` returns ZERO
hits (repair-failure.ts untouched, history comment only); every site reads
`ERROR_SNIPPET_MAX_CHARS`. No new tests: a `toBe(300)` value-pin would trip
scripts/test-lies-check.ts's tautological detector by construction, and #469
(the previous mechanical sweep) set the grep-is-the-proof precedent. Behavior
tests that already cover the touched lines run unchanged: cli.diag.test.ts
(decodeBody cap 300 golden cases), cli.inspect-request.test.ts (non-2xx →
"HTTP 500" line), cli.repair-failure.test.ts, accounts-cli.test.ts (bad
status → exit 1 paths), cli.task-verify.test.ts (pins the 500 budget it
asserts — must stay green to prove we didn't touch it).

## Gates (one at a time, flock'd)

1. `cd apps/fleet && flock /tmp/fleet-gate.lock bun run check` — exit 0.
2. `cd apps/fleet && flock /tmp/fleet-gate.lock bun run test-lies-check` — exit 0.
3. `cd apps/fleet && flock /tmp/fleet-gate.lock bun run english-check` — exit 0.
4. `cd apps/fleet && bun run vitest run test/cli.diag.test.ts
   test/cli.inspect-request.test.ts test/cli.repair-failure.test.ts` — all pass
   (vitest lane; NOT alongside a bundler build).
5. `cd apps/fleet && bun test test/bun/accounts-cli.test.ts
   test/bun/cli.task-verify.test.ts test/bun/ff-file-task-retry.test.ts` —
   bun lane; runs the real CLI against a local Worker stand-in, so the edited
   failure paths execute for real.

Commit: `refactor(fleet): one ERROR_SNIPPET_MAX_CHARS name for the 16 hand-copied
slice(0,300) caps (refs #510)`. Push `LEFTHOOK=0`. Two-way door: no ONE_WAY_GLOBS
path matches (cli/** is not one-way), behavior identical, revert restores the
raw numbers. Done record: /workspace/.fleet/done/510.json with real tails.
