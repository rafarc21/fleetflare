# CLI arg validation sweep 20 — apps/fleet (2026-10-12)

Ref #541. Analysis only, read-only, no code changed. Twentieth maintainability sweep: flags that silently accept bad input — a value-taking flag whose value is the NEXT flag's name, boolean flags given a value, extra tokens silently dropped, numeric args past safe integer range, env-tuned numbers parsed with no NaN check. Scope: `apps/fleet/src/studio/cli-args.ts` (the one argv parser, `parseCliArgs`/`parseTask`/`parseFlags`), `src/studio/ff.ts` (`parseFfArgs`), `cli/attach-liveness.ts` (env-number constants), and the cli/fleet.ts call sites that consume each parsed field. Line refs = physical lines at origin/main 1a00124, paths relative to repo root.

Sweeps 1-19 (docs/maintainability/*.md) and the issues they filed are NOT repeated here.

**Tier rule (from #539):** GLM-OK = none of auth, secrets, credentials, rescue, failover, accounts routing, deploy. CLAUDE-ONLY = touches any of those.

## Method

Both parsers read in full (cli-args.ts 1099 lines, ff.ts's parseFfArgs); every claim below verified by running the real parser on the exact argv (`bun -e` probes against src/studio/cli-args.ts and src/studio/ff.ts) — every "current result" line is observed output, not inferred. Test pins grepped from test/studio.cli-args.test.ts, test/studio.ff.test.ts, test/bun/attach-liveness.test.ts, test/cli.read-repos-args.test.ts.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | `src/studio/cli-args.ts:530-548` — parseFlags: a value-taking flag accepts the NEXT flag's name as its value | GLM-OK |
| 2 | `src/studio/cli-args.ts:787` — `ls`: boolean flags take `=value` silently; every stray token ignored | GLM-OK |
| 3 | `src/studio/cli-args.ts:568-574,619` — task show/verify/state/assign: `0` and past-2^53 digit strings accepted as issue numbers | GLM-OK |
| 4 | `cli/attach-liveness.ts:10,16` — FLEET_ATTACH_STALE_MS/CONNECT_TIMEOUT_MS: `Number()` no NaN guard, NaN silently disables both watchdogs | GLM-OK |
| 5 | `src/studio/cli-args.ts:821-828,913-918` — check/paste/attach/clear-session-guard/inspect: any flag-shaped or extra token accepted as the id | GLM-OK |
| 6 | `src/studio/cli-args.ts:1034-1037` — `memory compact`: extra tokens silently dropped | GLM-OK |
| 7 | `src/studio/ff.ts:176-207` — parseFfArgs: `--help`/`-h` after a role become the TASK text, not help | GLM-OK |

Verified-clean (recorded, nothing filed): `reap --idle` (parseIdleDuration refuses bare numbers, zero, unknown units, and the <5m floor is enforced — cli-args.ts:429-435); `task new` four required sections (blank values refused even with --template, cli-args.ts:722-730); `--continues` (`/^[1-9][0-9]*$/` — zero refused by grammar, cli-args.ts:741); `--template` (only "retro" accepted, :709); `task state` `to` validated against TASK_STATES at parse time (:614); `destroy`/`provision`/`recycle`/`spawn` bespoke parsers (unknown flag, duplicated flag, flag-in-id-slot all usage errors — destroy's `arg === "--force"` check documented and pinned); `accounts hold --until` (Date.parse finiteness refused, flag-as-value therefore refused too); `--read-repos` (empty-after-split refused); `junior --account ""` and `--since ""` (both refused by the `!== ""` checks, cli-args.ts:1048,1054); `tabs --repo ""`/`--repo=` (empty string reaches repoIdSegment, fails SEGMENT_RE, refused with the bad-segment message).

### F1. src/studio/cli-args.ts:530-548 — a value-taking flag accepts the NEXT flag's name as its value — GLM-OK

- **Site:** parseFlags takes `--k v` and `--k=v` but never looks at what `v` is; every caller passes the raw argv. Same shape in the bespoke parsers: `tabs --repo` (cli-args.ts:804), `task new`'s parseFlags call sites, `junior enable --account` (:1054).
- **Input:** `fleet task new --title t --objective o --output f --boundaries b --sprint --junior`
- **Current result:** parses OK; `brief.milestone = "--junior"` and the `--junior` authorization never lands. Observed probe: `{"cmd":"task-new","brief":{...,"milestone":"--junior"}}`. A caller who put `--junior` last just lost junior authorization silently; one who put `--sprint` before another flag put a flag NAME into a GitHub milestone field. Sibling probes, all accepted silently: `fleet task assign 5 web-studio --why --read-repos` (why = "--read-repos", read-repos grant silently dropped); `fleet junior enable --account --stats` (account = "--stats", written verbatim into ~/.config/fleet/junior.json); `ff web-studio --help` (task text = "--help").
- **Proposed:** in parseFlags (and the three bespoke value sites: tabs --repo, junior --account, ff task), refuse a value that starts with `--` unless the caller explicitly quoted an `=` form: `usage("--sprint needs a value (got flag --junior — put the value last or quote it)")`, exit 1. One-line shared helper `isFlagShaped(v)`.
- **Test pin:** test/studio.cli-args.test.ts pins flag/VALUE pairs but no case has a flag-shaped value; test/studio.ff.test.ts:103 pins "a task that merely CONTAINS --new stays the task" (the opposite direction). Nothing pins the refusal.

### F2. src/studio/cli-args.ts:787 — `ls`: boolean flags given a value, stray tokens, all silently ignored — GLM-OK

- **Site:** `case "ls": return { cmd: "ls", fresh: argv.slice(1).includes("--fresh"), ... }` — three exact-string membership tests; the rest of argv is never examined.
- **Input:** `fleet ls --json=false` / `fleet ls --fresh=1` / `fleet ls --prs=x` / `fleet ls extra-junk`
- **Current result:** all four parse to `{fresh:false,json:false,prs:false}`. Observed probe: `ls --json=false => {"cmd":"ls","fresh":false,"json":false,"prs":false}`. An operator who believes `--json=false` means "table mode" gets JSON-DEFAULT table silently (json:false) — correct result by accident, wrong reason, and `extra-junk` (a typo'd subcommand, an accidental paste) disappears entirely. The comment above the case says "a stray extra token is ignored" is deliberate for ls's long-standing grammar — but `--json=false` is NOT a stray token: it is a known flag spelled with a value, which reads as accepted-and-overridden.
- **Proposed:** keep stray positionals ignored (documented grammar), but refuse any token that starts with `--` and is not one of the three known flags or their exact spellings: `usage('unexpected "--json=false" — ls flags are --fresh --prs --json (no values)')`, exit 1.
- **Test pin:** test/studio.cli-args.test.ts:19-33,756-759 pins the three flags and composition; nothing pins `=value` or unknown-flag refusal for ls.

### F3. src/studio/cli-args.ts:568-574,619 — task show/verify/state/assign accept `0` and digit strings past 2^53 — GLM-OK

- **Site:** `if (raw === undefined || !/^\d+$/.test(raw)) return usage(...)` — `\d+` accepts `0`, leading zeros, and arbitrarily long strings; `Number(raw)` then applies.
- **Input:** `fleet task show 0` / `fleet task show 99999999999999999999` / `fleet task assign 0 web-studio` / `fleet task state 0 working`
- **Current result:** observed probes: `task show 0 => {"cmd":"task-show","number":0}`; `task show 99999999999999999999 => number: 100000000000000000000` (Number() rounds past 2^53 — the request then queries an issue that does not exist and cannot exist). `0` is GitHub's "no issue" (the API rejects it client-side, but the CLI's own `--continues` refuses `0` by grammar — cli-args.ts:741 — so this CLI's own vocabulary already says 0 is not an issue number). Wasted Worker round trip + a 404-shaped error where a usage error belongs. `rescue-gc --older-than 0` has the same grammar hole (:971) — see CLAUDE-ONLY note.
- **Proposed:** one shared `parseIssueNumber(raw)` used by show/verify/assign/state (and rescue-gc's days): `/^[1-9][0-9]*$/` plus `Number.isSafeInteger(n)`; refusal `usage("fleet task show needs an issue number (got \"0\")")`, exit 1.
- **Test pin:** test/studio.cli-args.test.ts:483,491,680,710 pin "refuses a non-numeric issue number" — but `0` is numeric, so no pin covers it; nothing covers >2^53.

### F4. cli/attach-liveness.ts:10,16 — env-tuned liveness numbers: `Number()` with no NaN guard silently disables both attach watchdogs — GLM-OK

- **Site:** `export const ATTACH_STALE_MS = Number(process.env.FLEET_ATTACH_STALE_MS ?? 90_000)` and the CONNECT_TIMEOUT sibling. A typo like `FLEET_ATTACH_STALE_MS=90s` (the unit suffix, the most natural mistake for a value documented as "90s silence means dead") yields NaN.
- **Input:** `FLEET_ATTACH_STALE_MS=90s fleet attach websites--pilot`
- **Current result:** NaN propagates: watchdog interval `Math.max(250, Math.min(5_000, NaN / 3))` = NaN (verified numerically); `setInterval(fn, NaN)` runs at the ~1ms default; the staleness test `now - lastFrameAt <= NaN` is false for every frame (verified: `0 <= NaN` is false), so the guard never returns and every frame reads as stale. Net effect: title flips to STALE immediately and the socket closes on the first watchdog tick after open; with CONNECT NaN, `setTimeout(fn, NaN)` fires immediately, printing "no answer to the upgrade" before any answer could arrive, closing, retrying — a fast close/reopen loop. All from a typo'd env value, with no message naming it.
- **Proposed:** a shared `envNumber(name, fallback)`: `const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : (n is NaN ? fail with `fleet: ${name} must be a number of ms, got ${JSON.stringify(raw)}` : fallback)`. Startup refusal (exit 1), never silent. Pure module, directly testable — attach-liveness is already split out for exactly this.
- **Test pin:** test/bun/attach-liveness.test.ts drives the real CLI with FLEET_ATTACH_STALE_MS="1500" (valid); nothing pins a bad env value's behavior.

### F5. src/studio/cli-args.ts:821-828,913-918 — check/paste/attach/clear-session-guard/inspect: any flag-shaped or extra token becomes the id, or is dropped — GLM-OK

- **Site:** `case "check": return arg ? { cmd: "check", id: arg } : usage` — `arg` is whatever token followed the verb; no flag check, and `argv.slice(2)` is never examined. Same one-liner shape for paste (:828), clear-session-guard (:916), inspect (:918); attach (:820-826) refuses `--print-handle` in the id slot but only after `!arg` — `attach x y` IS refused, the others are not.
- **Input:** `fleet check --json` / `fleet check x --json` / `fleet paste x junk` / `fleet clear-session-guard x y` / `fleet inspect x --foo=1`
- **Current result:** observed probes: `check --json => {"cmd":"check","id":"--json"}` (a flag-shaped token as the id → a Worker request for a studio named "--json"); `check x --json => id:"x"` (trailing tokens silently dropped — `check x --json` looks like it asked for JSON output and did a plain check); `onboard junk` same drop. Contrast `destroy`, whose own comment block (cli-args.ts:928-935) documents why a flag sliding into the id slot must be a usage error — and pays for it with an explicit check.
- **Proposed:** one shared `idArg(argv, verb)` helper: id must exist, must not start with `--`, and no token may follow it; refusal `usage("fleet check needs a studio id (got \"--json\")")`, exit 1. Apply to check/paste/clear-session-guard/inspect (attach already mostly conforms).
- **Test pin:** test/studio.cli-args.test.ts:43-60,131-132 pin the happy-path id only; nothing pins a flag-shaped id or trailing tokens for these verbs (destroy's equivalent case IS pinned).

### F6. src/studio/cli-args.ts:1034-1037 — `memory compact`: extra tokens silently dropped — GLM-OK

- **Site:** `if (arg === "compact") return { cmd: "memory-compact" };` — the rest of argv unexamined.
- **Input:** `fleet memory compact junk` / `fleet memory compact --json`
- **Current result:** observed probe: both parse to a plain `memory-compact`. compact OPENS A PR in the blueprint repo — the one memory verb with a durable, outward-facing artifact. A caller who typed `--json` (meaning to read the proposal rather than act) or pasted a stray token gets the full action with no warning. Same shape on `memory ls junk` (read-only, so harmless, but same grammar).
- **Proposed:** refuse any token after the subcommand: `usage('unexpected "junk" — fleet memory takes only ls | compact')`, exit 1. Two lines.
- **Test pin:** test/studio.cli-args.test.ts:996-997 pins `memory` and `memory ls`; nothing pins extra-token refusal.

### F7. src/studio/ff.ts:176-207 — parseFfArgs: `--help`/`-h` after a role becomes the TASK text — GLM-OK

- **Site:** help is checked only on the FIRST token (`if (first === "--help" || first === "-h")`); a second token is trimmed and, if non-empty, taken as the task.
- **Input:** `ff web-studio --help`
- **Current result:** observed probe: `{"cmd":"ff","role":"web-studio","task":{"kind":"new","text":"--help"}}` — files a board issue titled "--help" against web-studio AND spawns a studio for it. The user asked for help; the command interpreted the help flag as a one-word task. `--new` is filtered from every position (:177-178), so the precedent that position-independent flags exist is already in this parser; `--help` just missed it. `--` likewise becomes a task (probe: text "--").
- **Proposed:** treat `--help`/`-h` in ANY position as help (filter them from `rest` the way NEW_INSTANCE_FLAG is filtered, then if none remain proceed; `--` alone stays a usage error as an empty task). Refusal alternative if help-anywhere reads too clever: usage error naming it. Either way, never a filed issue.
- **Test pin:** test/studio.ff.test.ts:46 pins help only in first position; :103 pins a task CONTAINING --new — no pin for a flag-shaped task.

## CLAUDE-ONLY (read, nothing filed)

- `reap`/`rescue-all`/`rescue-gc` parsers: rescue lane. Verified defects exist there (flag-as-value: `reap --repo --dry-run` sets repo="--dry-run"; `rescue-gc --older-than 0` accepts 0 days; `rescue-all --repo=` empty accepted → "no running studios in scope", exit 0, versus `reap --repo=` which IS refused) but they are rescue-family parsers — CLAUDE-ONLY per the tier rule. The flag-as-value helper from F1 and the number grammar from F3 would fix them for free once those land.
- `accounts` family (accounts/hold/clear, cli-args.ts:1062-1095): accounts routing lane. Read in full; hold's `--reason ""` empty-value acceptance is the same class as F1 but belongs to this lane. Verified-clean noted above otherwise.
- Credentials/auth: no argv surface in this sweep's scope (loadCredentials is env/file, not flags).

## Proposed follow-ups

One issue per batch, `fix(GLM-OK): S20-Fn <short>`, refs #541, no closing keywords:

- **S20-F1** parseFlags + bespoke value sites: refuse a flag-shaped value (`--sprint --junior` today silently eats the flag) (finding 1)
- **S20-F2** ls: refuse `=value` spellings and unknown `--` tokens (finding 2)
- **S20-F3** task numbers + rescue-gc days: shared `^[1-9][0-9]*$` + safe-integer grammar (finding 3)
- **S20-F4** attach-liveness env numbers: envNumber() with startup refusal on NaN (finding 4)
- **S20-F5** id verbs: shared idArg() — no flag-shaped id, no trailing tokens (finding 5)
- **S20-F6** memory compact: refuse extra tokens (finding 6)
- **S20-F7** ff: --help/-h recognized in every position (finding 7)
