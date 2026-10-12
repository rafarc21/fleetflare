# Plan — #568: `fleet memory compact` refuses extra tokens

## Context

Finding 6 of docs/maintainability/2026-10-12-cli-args-sweep-20.md. apps/fleet/src/studio/cli-args.ts:1034-1037 parses `memory compact` without examining the rest of argv, so `fleet memory compact --json` or any stray token silently runs the full compact — and compact is the one memory verb that opens a PR in the blueprint repo.

## Change (apps/fleet/src/studio/cli-args.ts, `case "memory"`)

- TDD: first add failing tests in apps/fleet/test/studio.cli-args.test.ts, in the existing `describe("fleet memory")` block:
  - `["memory", "compact", "junk"]` and `["memory", "compact", "--json"]` both parse to `{ cmd: "usage", message: ... }` matching /unexpected/ and mentioning `memory takes only ls | compact`.
  - Existing pins at :996-1007 stay green: bare `memory`, `memory ls`, `memory compact`, `memory delete` → unknown-command error.
- Fix: reject any token after the subcommand. `if (arg === "compact")` becomes a check that argv.length <= 2, else `return usage(\`unexpected ${JSON.stringify(argv[2])} — fleet memory takes only ls | compact\`)`. Same guard for `ls` with extra tokens: `["memory", "ls", "x"]` → usage error.
- No behavior change for `memory` bare / `memory ls` / `memory compact` / `memory <unknown>`.

## Verification

- `bun test apps/fleet/test/studio.cli-args.test.ts` — targeted file only; never the full suite (memory ceiling).
- `bunx tsc --noEmit -p apps/fleet` only if repo scripts demand it — check package.json, run only what this diff demands.

## Boundaries

- No other files. No help-text change (help already documents both subcommands).
