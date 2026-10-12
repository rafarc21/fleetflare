# CLI text sweep 12 — help + usage + error text accuracy (2026-10-12)

Ref #481. Analysis only, read-only, no code changed. Twelfth maintainability sweep; scope `apps/fleet/cli/**` help/usage/error strings, `apps/fleet/src/studio/cli-args.ts` (the VERBS table and CLI_USAGE), `apps/fleet/container/studio-fleet` (in-container binary HELP), and `apps/fleet/src/studio/ff.ts`/`cli/ff.ts` help text, compared against the parsers and behavior they describe. Line refs = physical lines at `origin/main` `d060ab5`, paths relative to `apps/fleet/`.

**Lane rule (from #481):** skip auth/secrets/credentials/rescue/failover/accounts-routing/deploy text — those are CLAUDE-ONLY, listed in "Not filed", nothing filed for them.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | container HELP task-report example omits REQUIRED `verification` block — a result envelope without it is refused | GLM-OK |
| 2 | container HELP says "The Worker stamps ... sender" — sender is stamped by the board POST route for studio callers, msg_id/schema_version by envelope.ts; task_id is caller-checked, not stamped | GLM-OK |
| 3 | destroy help points at `fleet resume`, a verb the Mac CLI does not have (it is the in-container binary's verb) | GLM-OK |
| 4 | `ls --json` help lists lead vocabulary missing `dead`; omits `lastLine` and `openPrs` fields the row actually carries | GLM-OK |
| 5 | spawn help hardcodes a role list "(maestro, web-studio, release-studio, pilot, scratch)" that fleet.json/org.json own, and implies `fleet spawn maestro` is normal — ff refuses the same role outright | GLM-OK |
| 6 | `task assign` usage-error strings (both) say "fleet task assign <n> <role>" — the parser also accepts `role--k` and full studio ids | GLM-OK |
| 7 | `accounts hold` parser only accepts flags in fixed pairs from index 2, stepping 2 — `--reason` after a value-taking `--until` misorders into usage error; help says `[--until <ISO>] [--reason <text>]` with no order constraint | GLM-OK |
| 8 | destroy help: "unless --discard-unsynced (or --force)" for the cannot-answer refusal — --force does pass the guard server-side (do.ts:8118), but the two rescue-push refusal messages themselves only ever suggest --discard-unsynced; help and error text disagree on which flag to reach for | GLM-OK |
| 9 | inspect help says "the last ~60 pane lines" as if fixed — the route accepts a `lines` query param (routes.ts:1104) and the CLI never sends it; the number is a default the CLI cannot name or change | GLM-OK |
| 10 | ff FF_USAGE/FF_HELP describe `ff <role> <n>` adopt as "issue #n" but never mention the `#` prefix is optional; more materially, FF_HELP's headline line "spawn-or-attach the studio for the repo you are standing in" is accurate but the top-of-file comment block claims ff refuses only maestro while the parser refuses any non-id-segment role silently via FF_USAGE — minor, one-line fix | GLM-OK |
| 11 | `junior stats` help says rows are "per studio/id" — the merged table prints one row per local log id PLUS one row per remote studio, with NO dedup: a studio that appears in both (local laptop calls for a cloud studio id) prints two rows; "merges it with" overstates | GLM-OK |

### F1. container task-report example omits the required `verification` block — GLM-OK

- **File:** `container/studio-fleet:104-114` (the `fleet task report` example JSON).
- **Says:** the example result envelope carries intent, status, artifacts, evidence, open_questions, context_digest, notes — and the field list below it explains intent/status only. The word "verification" appears nowhere in the HELP.
- **Code does:** `src/board/envelope.ts:205-212` — every `intent: "result"` envelope REQUIRES a `verification` block `{ url, steps: ["..."], expected }`; without it the Worker refuses the post with `a "result" envelope needs "verification"`. The verbatim example, run as shown, is REFUSED by the Worker. A lead inside a container, whose only documentation is `fleet --help`, hits the refusal on its first result report and must guess the shape from the error message.
- **Proposed text:** add `"verification": {"url": "https://github.com/<owner>/<repo>/pull/84", "steps": ["open the PR", "check CI green"], "expected": "PR 84 open, checks passing"}` to the example and one line under the field list: `verification: REQUIRED for intent "result" — {url, steps, expected}, where a human checks this landed`.

### F2. "The Worker stamps ... sender" is half wrong — GLM-OK

- **File:** `container/studio-fleet:117-118` — "The Worker stamps msg_id, task_id, schema_version and sender — you cannot set them, and you do not need to."
- **Code does:** `src/board/envelope.ts:11-15` stamps `msg_id` and `schema_version` only. `sender` is stamped by the posting route for a studio caller (`src/board/board.ts:1192` — `{ ...body, sender: studioId }`), so "you cannot set them" is true, but the in-envelope role of the four fields is conflated. `task_id` is NOT stamped at all — it is optional-in and REFUSED if it disagrees with the issue being posted to (`envelope.ts:162-166`); a lead who believes the Worker stamps task_id may omit it (fine) or, worse, conclude any value is ignored (a wrong value is a refusal).
- **Proposed text:** `The Worker stamps msg_id, schema_version and sender — you cannot set them, and you do not need to. task_id is optional: if you set it, it must name this task, or the Worker refuses the envelope.`

### F3. destroy help names `fleet resume` — a verb the Mac CLI does not have — GLM-OK

- **File:** `src/studio/cli-args.ts:355` (VERBS.destroy summary) — "a studio whose org-chart edges reach it may `fleet resume` it from its container (after a cooldown)".
- **Code does:** `fleet resume` exists only in the in-container binary (`container/studio-fleet:74,227`, parseArgs kind "resume") — the Mac CLI this help text renders from has no `resume` verb (parseCliArgs has no case for it; typing `fleet resume` on the Mac prints CLI_USAGE with the verb missing). An operator reading `fleet destroy --help` output is told to run a command that does not exist on the machine they are on; the actual Mac-side way to restart a parked studio is `fleet provision <id>`.
- **Proposed text:** name the actor: "a studio whose org-chart edges reach it may resume it FROM ITS CONTAINER (`fleet resume`, the in-container binary) after a cooldown — the Mac CLI's own way to start it again is `fleet provision <id>`."

### F4. `ls --json` lead vocabulary omits `dead`; row fields omit `lastLine`/`openPrs` — GLM-OK

- **File:** `src/studio/cli-args.ts:311` (VERBS.ls summary) — "lead (working/idle/waiting-members/waiting-question/limit/modal/unknown/stopped)".
- **Code does:** `cli/readiness-format.ts:461` — the union also includes `dead` (org disabled subscription access, issue #141, permanent), and the JSON row carries `lastLine` (issue #108) and `openPrs` (issue #332, with --prs) which the help's field list ("id, state, repo, lead, leadSince, limitResetsAt and the ACTIVITY text") does not mention. A consumer parsing `fleet ls --json` against the help will treat `dead` as impossible and miss two fields.
- **Proposed text:** lead list `working/idle/waiting-members/waiting-question/limit/modal/unknown/stopped/dead`, and append `lastLine (the lead's last visible message line) and openPrs (only with --prs; absent means no data)`.

### F5. spawn help hardcodes a role list the config owns, and contradicts ff on maestro — GLM-OK

- **File:** `src/studio/cli-args.ts:331` — "Create a studio for <role> in the repo you are standing in (maestro, web-studio, release-studio, pilot, scratch)."
- **Code does:** the list is fleet.json's `roles` (today `[pilot, scratch, maestro, web-studio, release-studio]`) plus org.json edges — changing either config changes what `fleet spawn` accepts, and this parenthetical silently goes stale the day a role is added. Also, listing maestro unqualified sits oddly against ff's own help (`src/studio/ff.ts:44-46`), which REFUSES maestro outright citing board issue #250 (maestro is always local); `fleet spawn maestro` from the Mac is legal (operator edge allows it, only `--new` is refused as singleton at `src/studio/spawn.ts:562-563`), so the two CLIs genuinely disagree about the same role with no text saying so.
- **Proposed text:** drop the literal list — "Create a studio for <role> (the roles this fleet declares in fleet.json) in the repo you are standing in" — and one clause on maestro: "maestro is spawnable from the Mac (the operator edge); ff refuses it (always local, issue #250), and `--new` never applies to it (singleton)."

### F6. `task assign` usage errors name only the role form — GLM-OK

- **File:** `src/studio/cli-args.ts:582,589` — both usage() strings end "fleet task assign <n> <role>".
- **Code does:** the target also accepts `<role>--<k>` and a full studio id (issue #269; VERBS.task-assign args at :382 spell all three). The usage error shown on a MISSING or flag-looking target names the one form that cannot cross repos and cannot name an instance — the caller retries with the weakest form instead of the one that works.
- **Proposed text:** `fleet task assign <n> <role | role--k | studio-id>` in both strings (matches the VERBS args line verbatim).

### F7. `accounts hold` fixed-stride flag loop rejects help's own flag order edge — GLM-OK

- **File:** `src/studio/cli-args.ts:1074-1079` (the hold parser loop), help at :418 `hold <slot> [--until <ISO>] [--reason <text>]`.
- **Code does:** the loop starts at index 2 and steps i += 2, so flag/value pairs must be perfectly contiguous and paired. `fleet accounts hold slot --until 2026-10-13 --reason` (trailing flag, missing value) yields value undefined → usage error (correct). But `fleet accounts hold slot --reason R --until 2026-10-13` — the exact order the help line itself prints them in — parses: the loop reads `--reason`/`R` then `--until`/date, fine. The real gap: a value that is not a date with `--until` (e.g. a typo) does not fall into the `--reason` branch, it falls through BOTH ifs to the usage error naming no flag — the operator cannot tell whether `--until` or `--reason` was the problem. And `--reason` accepts anything, including a token starting with `--`, so `--until --reason` (both values omitted) parses as until=NaN-rejected → generic usage. One error message, no flag named, no value echoed.
- **Proposed text:** per-pair errors: `--until needs a parseable ISO date (got "<value>")` and `--reason needs a text value` — and state in help that both flags may come in any order after the slot (they can, but only as intact pairs).

### F8. destroy help and the rescue-refusal messages recommend different flags — GLM-OK

- **File:** `src/studio/cli-args.ts:355` (help: "unless --discard-unsynced (or --force)") vs `src/studio/destroy.ts:105,117` (both refusal messages offer ONLY `fleet destroy <id> --discard-unsynced`).
- **Code does:** server-side, --force does satisfy the discard guard (`src/studio/do.ts:8117-8118`: `discardUnsynced: discardUnsynced || force`), and destroy.ts:298's comment explicitly says --force is "never the suggested way past" because it also skips the open-board-task check. So the HELP tells the operator --force works (true), while the ERROR TEXT they actually see at the moment of refusal never mentions it (deliberate, per the comment). A doc-sweep finding, not a behavior bug: the two surfaces disagree and neither says why. help should say "--force also passes this refusal but ALSO skips the open-task check — prefer --discard-unsynced when only the rescue is in the way".
- **Proposed text:** in VERBS.destroy: "unless --discard-unsynced (--force passes it too, but also skips the open-task check — the refusal lines only ever suggest --discard-unsynced on purpose)".

### F9. inspect "~60 pane lines" is a default the CLI cannot name or change — GLM-OK

- **File:** `src/studio/cli-args.ts:347` — "the last ~60 pane lines via `tmux capture-pane -p`".
- **Code does:** the ROUTE accepts a `lines` query param (`src/studio/routes.ts:1103-1104`, `?lines=N`, any positive integer) that `cmdInspect` never sends (`cli/fleet.ts:770` builds `/inspect` with no params), so the ~60 (`INSPECT_DEFAULT_TAIL_LINES`, `src/studio/inspect.ts:78`) is fixed for the Mac CLI caller — but `fleet reap` uses the same route WITH a param via a different builder, and any script hitting the route can change it. The help reads as if 60 were a property of the verb rather than a default overridable one query-string away.
- **Proposed text:** "the last ~60 pane lines (the route's default; `GET /inspect?lines=N` overrides — the Mac CLI always sends the default)".

### F10. ff help: adopt form undersold, one stale comment claim — GLM-OK

- **File:** `src/studio/ff.ts:53` — "ff <role> <n>   ADOPT existing issue #n"; header comment `cli/ff.ts:15-18` lists the four forms.
- **Code does:** `parseFfArgs` (`src/studio/ff.ts:199-201`) accepts `#`-prefixed numbers too (`/^#?(\d+)$/`), and FF_HELP's adopt line never says the `#` is optional. Minor, one word. The header comment at `cli/ff.ts:15-18` also still documents the OLD three-form surface (bare ff resolves maestro) that FF_HELP itself now refuses — the comment block and the rendered help have drifted since issue #250; an agent reading the file's comment reaches for bare `ff` which the binary refuses.
- **Proposed text:** adopt line: "ADOPT existing issue #n (the # is optional)"; update cli/ff.ts's header form list to the four forms FF_HELP actually serves, with bare `ff` marked refused.

### F11. `junior stats` "merges" local + remote with no dedup — GLM-OK

- **File:** `src/studio/cli-args.ts:411` — "merges it with this machine's own local usage log ... printing one row per studio/id plus a TOTAL".
- **Code does:** `cli/junior.ts:247` — `formatJuniorStats([...remoteRows, ...localRows])`: remote rows are keyed by studioId, local rows by free-form local id, and NOTHING dedups or sums across the two halves. A studio id present in both (laptop-side direct calls naming a cloud studio) prints TWO rows with the same ID; "merges" reads as one combined row. The TOTAL is the sum of both halves, which is right, but "one row per studio/id" is wrong whenever an id exists on both sides.
- **Proposed text:** "prints one row per remote studio plus one per local log id — the same id can appear twice (its cloud calls and its laptop-side calls); TOTAL sums both halves".

## Not filed (deferred / CLAUDE-ONLY)

- `src/studio/cli-args.ts:351` recycle summary's FLEET_AUTO_FAILOVER / `--account mapped` passage, and the destroy/rescue-all passages naming deploy gates — accounts-routing/rescue/deploy lane per #481: CLAUDE-ONLY, listed for the Claude lane, nothing filed.
- `container/studio-fleet` creds-get HELP block — credentials text, CLAUDE-ONLY lane.
- `cli/fleet.ts:95-115,147-174` credentials-load error strings — credentials lane, CLAUDE-ONLY.
- `VERBS.accounts`/:415 summary and accounts-hold/clear text — accounts-routing lane, CLAUDE-ONLY (the F7 parser quirk itself is pure flag-grammar, which is why F7 is filed: the finding is the usage-error wording, not the routing).
- `VERBS.rescue-gc`, `rescue-all` summaries — rescue lane, CLAUDE-ONLY.
- `parseTarget`'s "instance named twice" and `--instance` messages (container:276-281) — accurate on read; counted, nothing to fix.
- `LEAD_TASK_STATES` list in container HELP matches `src/board/board.ts` byte-for-byte today — the source-pin test holds it; counted, nothing to fix.

## Counts

11 GLM-OK findings (F1-F11) → proposed as one batched issue (CLI help-text accuracy fixes, all doc-adjacent string edits in help/usage surfaces). CLAUDE-ONLY items listed above for the Claude lane, no issue filed by this sweep.
