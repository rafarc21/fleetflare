# TODO/FIXME/XXX/HACK audit — sweep 16 (2026-10-12)

Ref #488. Sixteenth maintainability sweep: in-code markers. Scope: apps/fleet (src, cli, test, test-integration, scripts, page, docs), skills/, fleet/blueprint. container/ skipped per scope. Line refs = origin/main `71f0c96`. GLM-OK lane.

**Verdict: zero genuine markers in scope.** Nothing to delete, nothing to update, nothing to file (zero `S16-Fn` issues). The CLAUDE-ONLY skip list is empty: no marker was found inside auth, secrets, credentials, rescue, failover, accounts routing, deploy, migrations, write-proxy, or leak-gate either. The PR carrying this doc therefore has a doc-only diff — the task's "delete or update stale/done markers" step has an empty worklist.

## Method

`grep -rniE "\b(todo|fixme|xxx|hack)\b"` per tree, minus mktemp(1) `XXXXXX` templates; every surviving hit then read in context and classified (genuine marker vs prose vs fixture vs identifier vs vendored third-party). Zero-hit trees: apps/fleet/cli/**, apps/fleet/test-integration/**, apps/fleet/scripts/**, skills/**, fleet/blueprint/**.

## Every hit, classified

| file:line | hit | cited issue + state | verdict |
|---|---|---|---|
| apps/fleet/page/terminal.html:102 | `/* TODO: Composition position got messed up somewhere */` | none — third-party | vendored xterm CSS, out of scope |
| apps/fleet/src/ratelimit.ts:65 | "…run rather than gate behind a TODO." | #9 MERGED | prose, not a marker |
| apps/fleet/src/github/promote-close.ts:176-179 | `const todo = …` | none | identifier, not a marker |
| apps/fleet/test/junior.ratelimit.test.ts:154 | "not just be a TODO comment" | #9 MERGED | prose, not a marker |
| apps/fleet/test/bun/bringup-hooks.test.ts:230 | `{ pattern: "TODO" }` | none | fixture, not a marker |
| apps/fleet/test/bun/bringup-hooks.test.ts:244 | "todo bookkeeping" | none | prose, not a marker |
| apps/fleet/test/llm.anthropic-route.test.ts:804 | `"api_error: xxx"` | none | fixture, not a marker |
| apps/fleet/scripts/image-repro-check.sh:83 | `mktemp -d … image-repro.XXXXXX` | none | mktemp template, not a marker |
| apps/fleet/src/studio/install-cache.ts:941, 1254 | `mktemp … XXXXXX` (mirrors: test/install-cache.test.ts:582; test/bun/install-cache-security.test.ts:166, 1297, 1931, 2024) | none | mktemp template, not a marker |
| apps/fleet/container/studio-bringup.sh:191 | `mktemp … XXXXXX` | none | mktemp template — container/, out of scope, listed for completeness |
| apps/fleet/docs/plans/2026-09-30-maestro-wake-filter.md:73 | "no TODO, no dead scaffolding" | none | prose, not a marker |
| apps/fleet/docs/plans/2026-10-03-feat-210-parked-studio-auto-resume.md:460, 493, 496, 499, 532 | `TODO (#210 review, finding 4)` | #210 CLOSED | plan-doc history, not a marker |

## Notes per finding

- **terminal.html:102 — the only literal TODO in any shipped file.** Byte-identical to upstream `node_modules/@xterm/xterm/css/xterm.css:80`. It sits inside the `XTERM_CSS_START/END` span that `scripts/build-page.ts` regenerates on every `bun run build:page`; the file's own header forbids hand-edits inside the span, and a hand-fix would be clobbered on the next build. Fixing it means patching upstream xterm, not this repo. Kept as-is.
- **ratelimit.ts:65 / junior.ratelimit.test.ts:154 — #9 item (c), resolved as code.** The comments say pruning runs inline "rather than gate behind a TODO" — they document the absence of a marker and the reason (no cron wired; the DELETE is cheap). `pruneStaleCounters` (apps/fleet/src/ratelimit.ts:71) is the implemented answer; nothing stale.
- **feat-210 plan doc — historical record, accurate.** Those lines describe a `TODO (#210 review, finding 4)` that that PR deleted; #210 is CLOSED and no `TODO (#210` survives anywhere in src, cli, or test. Plan docs are immutable history; no edit.
- **promote-close.ts `todo`** — local variable holding the not-yet-batched SHA queue. Renaming it to dodge a grep word would be churn with no reader benefit.
- **bringup-hooks.test.ts:230** — the fixture string "TODO" is the point of the test: the lead gate must permit a Grep whose pattern is any string.
- **mktemp templates** — `XXXXXX` is mktemp(1)'s required placeholder, not a marker.

## Cross-check

No prior sweep doc left a cited marker behind. The one marker family this repo's code ever carried (rate-limit table growth, #9 item (c)) was resolved as code (`pruneStaleCounters`), not left as a marker — consistent with this sweep's zero.
