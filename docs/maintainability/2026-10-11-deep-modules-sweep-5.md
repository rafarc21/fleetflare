# Deep-modules design sweep 5 — apps/fleet cli + scripts (2026-10-11)

Ref #394. Read-only analysis, no code changed. Scope: `apps/fleet/cli/**`
and `apps/fleet/scripts/**` at `origin/main` `8367c19`. Sweeps 1-4
(docs/maintainability/2026-10-08-deep-modules-sweep.md, 2026-10-10-…-2.md,
2026-10-11-test-sweep-3.md, 2026-10-11-deep-modules-sweep-4.md) and the
open deepen(*) issues they filed are NOT repeated here; skip-list checked
against both docs and `gh issue list` before each finding was ranked.

Tier rule (#394): GLM-OK = none of auth, tokens, credentials, rescue,
failover, deploy, migrations. CLAUDE-ONLY = touches any of those.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | column-table builder → one `formatColumns(headers, rows)` | GLM-OK |
| 2 | CLI error decode (`errText` ×30, `<title>`/JSON/slice ×3) → one `cli/diag.ts` | GLM-OK |
| 3 | `ageSeconds` fold → export from readiness-format | GLM-OK |
| 4 | repo-segment refusal 4 sites → one `refuseBadSegment(prefix, slug)` | GLM-OK |
| 5 | lead-state precedence (formatActivity vs lsJsonRows) → one shared gate | GLM-OK |
| 6 | bounded poll loops (ff ticker/poll vs accounts watch) → one `poll` util | GLM-OK (slice) |
| 7 | accounts-format slot grammar vs src/studio/accounts.ts → one shared parser | GLM-OK |
| 8 | loadCredentials trio (exiting / null / tagged) → one `readCredentialsFile` | CLAUDE-ONLY (credentials) |
| 9 | buildGridPage 3-line pass-through → inline (sweep-2 D12) | GLM-OK |
| 10 | WATCH_INTERVAL_MS export test-only → drop export | GLM-OK |

### F1. Four hand-rolled column-table builders → one `formatColumns(headers, rows)` — GLM-OK

`cli/fleet.ts:439-445`, `cli/accounts-format.ts:251-254`,
`cli/task-format.ts:91-96`, `cli/junior.ts:159-161`: same
`widths.map(Math.max) → padEnd → join("  ")` dance, drifted (junior's
`trimEnd()` vs the other three's never-padded-last-column rule, which
exists because of #205's 87 KB regression). One pure `formatColumns` in a
new tiny module (kept Bun/node-free, root-test-importable) with an explicit
last-column-unpadded rule; four callers become 2-liners. ~60 L.

### F2. CLI error decode → one `cli/diag.ts` — GLM-OK

`errText` inline ×30 across 10 cli files (orca 9, fleet 8, reap 6, +7 more);
the same "HTML `<title>` else JSON `.error` else slice" body-decode written
3× (`cli/repair-failure.ts:19-41`, `cli/inspect-request.ts:46-48`,
`cli/destroy-outcome.ts:137-140` timeout-name triage beside it). One
`diag.ts` exporting `errText(err)`, `decodeBody(status, text)` (returning
the SAME strings today's three decoders print); callers keep their own
label/exit policy. Wire-format-preserving; ~90 L. Rescue/destroy verbs
migrate in the Claude lane — this issue covers fleet.ts's read verbs +
accounts/format files only.

### F3. `ageSeconds` → one exported core in readiness-format — GLM-OK

`cli/readiness-format.ts:154-157` (private) vs the same
`Math.max(0, Math.floor((now - Date.parse(iso))/1000))` re-written inline
4× in the same file's `formatCheckedAt` (:145) and `cli/wip-format.ts:161,
170, 226, 241`. Export the existing private helper (it is already the
shared body); wip-format's four inline folds call it. ~15 L. Keeps the
"NaN → 0/absent" convention in one named place.

### F4. Repo-segment refusal → one `refuseBadSegment(prefix, slug)` — GLM-OK

The same "repo cannot name a studio — not a valid id segment (lowercase
alphanumerics joined by single hyphens; dots and underscores fold to
hyphens)" wording at `src/studio/repo.ts:158-165` and `:313-320`, plus two
CLI pre-flight twins (`cli/ff.ts:471-483`, `cli/fleet.ts:780-805` tabs) that
split the slug and call `repoIdSegment` themselves. One exported
`refuseBadSegment` in repo.ts returning the refusal; CLI sites stop
re-typing the parenthetical rule. Wordings differ slightly today (tabs
omits the quoted `"${short}"`) — fold to repo.ts's canonical string;
~25 L. Two-way door (error text only).

### F5. Lead-state precedence → one shared gate — GLM-OK

`cli/readiness-format.ts:375-410` (`formatActivity`) vs `:432-458`
(`lsJsonRows`): the same rl.dead → select-modal → live-until →
replacedAt(#192) → stored-activity precedence chain, written twice with
different renderings and a real drift risk — the #192 replaced-studio gate
had to be added to BOTH (:388-396 and :451). One private
`leadGate(status, now, budget) → {kind: "stopped"|"dead"|"modal"|"limit"
|"replaced"|"activity", activity?}`; both renderers switch on it. ~80 L.
Output byte-identical (characterization: existing cli.fleet.test.ts
formatActivity/lsJsonRows blocks pass unchanged).

### F6. Bounded poll loops → one `poll` util (GLM-OK slice) — GLM-OK (slice)

`cli/ff.ts:61-98, 351-371` (ticker + waitProvisioned) and
`cli/accounts.ts:344-399` (WATCH_INTERVAL_MS loop) each hand-roll "bounded
`for(;;)`, one stderr line per iteration, Bun.sleep between" — the shape
accounts.ts:350-360's own comment says it copied from ff.ts. GLM-OK slice:
one `cli/poll.ts` `poll({ attempt, sleepMs, shouldContinue, tick })` +
`ticker(what)` for the two READ-ONLY loops (ff's attach-pre-provision wait
and accounts --watch). The rescue-all/deploy poll wiring stays sweep-2
F1/D4's Claude lane. ~70 L. Edge wording unchanged.

### F7. Slot-name grammar → one shared parser — GLM-OK

`cli/accounts-format.ts:277-289` (`slotNumber`/`labelVarName`) re-implements
src/studio/accounts.ts's `CLAUDE_CODE_OAUTH_TOKEN[_n]` grammar (accounts.ts
:72-74) as a parse-back "deliberately not imported" (that file's own comment
cites the Env-adjacent import graph). claude-swap.ts's 2026-11 #366-adjacent
cleanup made the join pure; move the grammar (both directions) into a
tiny `src/studio/account-slot.ts` importing nothing; accounts-format and
src/studio/accounts.ts both import it. ~30 L. Byte-identical output.

### F8. Credentials trio → one `readCredentialsFile()` — CLAUDE-ONLY (credentials)

`cli/fleet.ts:86-214`: `loadCredentials` (exits), `loadCredentialsIfPresent`
(null), `tryLoadCredentials` (tagged) — three near-copies of the same
file-exists/mode-warning/JSON/field-checks sequence, each header comment
justifying the duplication by the OTHER two. One private
`readCredentialsFile(): Credentials | {error}` + three thin wrappers keeps
every contract; deletes ~60 duplicated lines. CLAUDE-ONLY: it is the
credentials path (~/.fleet/credentials, mode warnings).

### F9. `buildGridPage` pass-through → inline — GLM-OK (sweep-2 D12)

`scripts/build-page.ts:103-105`: a 3-line function (readFile) called once
(main:117), named in sweep-2's D12 as "too small for its own issue; bundle
into any GLM PR touching scripts/". This is that PR's ride-along: inline the
read into main's grid half; the sourceMappingURL guard that consumes it
stays. ~6 L. Bundle with F1's PR (both are trivially behavior-preserving).

### F10. `WATCH_INTERVAL_MS` test-only export → drop the export — GLM-OK

`cli/accounts.ts:348` exports the constant so test/bun/accounts-cli.test.ts
can read it; the value (60_000) is also asserted by a literal in the same
test. Sweep-1's "export dies, no pass-through" culture (#357): drop the
export keyword, keep the const module-private; the test's literal already
pins the number. ~2 L. Bundle with F7's PR.

## Not filed (deferred / noted)

- `cli/fleet.ts` 2738 lines — split candidates (reap wiring :2027-2245,
  rescue-all :1689-2020) are CLAUDE-ONLY territory (rescue, failover) and
  already named by sweep-2 D2/D3/D4; nothing new this sweep.
- `scripts/test-lies-check.ts` (566) / `localci/summarize.ts` — scanCalls
  already landed (#343); remaining parsers are distinct protocols, not
  duplicates; D9's lane-model question still owns the rest.
- `scripts/deploy-target.ts` / `deploy-containers-changed.ts` arg-models —
  both refuse-closed by design, hot files for wrangler-version pinning;
  a shared argv model is sweep-2 F15's lane (CLAUDE-ONLY).
- `cli/orca-workspace.ts` 1368 lines — sweep-2 F7 (row lifecycle) landed
  (#345); lock/registry helpers have real fan-in (tests + fleet.ts);
  nothing above the 2-round-capped findings survived re-review.
- `scripts/sensors/measure.sh` — superseded for its two sensors by run.ts
  (its own header says so), but it still measures english-check.yml, which
  run.ts does not; deleting it is an operator decision, not a refactor.

## Counts

8 GLM-OK findings (F1-F7, F9, F10) → one deepen issue each. F6 carries the
slice rule in its title/body. 1 CLAUDE-ONLY (F8) recorded here for the
Claude lane, no issue filed by this sweep. F9/F10 ride along in other
issues' PRs per their own text.
