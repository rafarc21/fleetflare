# Broken doc-links sweep 37 — docs/ + apps/fleet/docs/ + skills/ (2026-10-13)

Ref #740. Analysis only, read-only, no code changed. Thirty-seventh
maintainability sweep; scope docs/**, apps/fleet/docs/**, README.md,
skills/**/*.md. Line refs = physical lines at `origin/main` `0cd438f`.

Method: every relative markdown link (~54) resolved against its own file;
every file:line cite (~1660 unique tokens) extracted and resolved against
repo root, apps/fleet/, then basename search, then line-count vs EOF; every
backtick path cite resolved the same way; HTML href/src attributes checked.
Each candidate hand-verified against the working tree AND git history —
`git show` at the citing doc's own pinned commit when it names one, `git
log --all` for deleted/renamed targets, PR merge state for cited PRs.

**Ruled out (verified accurate, no finding):** all ~54 relative markdown
links resolve — the 8 raw misses are template placeholders inside
skills/qa/SKILL.md's example Evidence tables (`cdn-url`, `link`, lines
592-620) and one fenced code block in
docs/superpowers/specs/2026-08-27-fleet-guardrails-p5-design.md:284 whose
"target" carries a trailing ", +2 archived" prose suffix;
docs/fleet/firstmate-analysis.md's `bin/fm-*`, `tests/fm-*`,
`agents/skills/stow/`, `firstmate-coding-guidelines/` cites are
external-repo cites by its own declared method ("path:line in THEIR repo
or ours"); `~/.claude/`, `.fleet/done/*`, `/workspace/.fleet/*` cites are
operator-machine or fleet-ops paths outside this repo by design; dated
plan/sweep docs citing files as they stood when written (dead-code-sweep-9's
`burn.ts:1768`, correct at its pin c2cc15f; sweep-17's `operations.md:188-194`,
fixed by #551) count as history, not breakage; threat-model.md's wholesale
line drift is already on record as S17-F9 (CLAUDE-ONLY lane, sweep-17) and
is not repeated here; `wrangler.jsonc` is gitignored-but-real; no doc other
than F6's cites a never-committed file.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | sensor spec cites maestro/studio.md:104 and quotes text the file never had; real source is maestro-playbook SKILL.md:417 | GLM-OK |
| 2 | deep-modules-sweep-2 F13 cites cli/repair-failure.ts:161-173 — file 66 lines, never had those lines even at the doc's own pin | GLM-OK |
| 3 | deep-modules-sweep-2 F14 cites cli/repair-failure.ts:161 for destroyPath — lives at :45 (pin f0d178d) / :52 (today) | GLM-OK |
| 4 | dependencies-sweep-31 cites agents/do.test.ts:21 — path never existed; real file test/agents.do.test.ts, and :21 is a comment | GLM-OK |
| 5 | test-helpers-sweep-18:54 and orphan-tests-sweep-23:30 cite S26-split/deleted test files as living | GLM-OK |
| 6 | bringup-launch-already-fixed-6.md cites a plan doc that exists in no commit — PR #114 closed unmerged | GLM-OK |
| 7 | dead-code-sweep-9's burn.ts:1768 SessionFileStat drifted to session-stats.ts:348 by PR #533's split | GLM-OK |

### S37-F1. sensor spec — maestro/studio.md:104 cite + quoted text never existed — GLM-OK

- **File:** `docs/superpowers/specs/2026-10-01-sensor-task-control-loop-168-design.md:107`.
- **Evidence:** cites `fleet/blueprint/studios/maestro/studio.md:104` as already using the pinned-wave-log pattern, and quotes its text ("Comment the wave on the pinned board issue `fleet: maestro wave log`. That issue is the wave history; nothing else is."). That file is 31 lines in every commit it ever had (added d571954, never edited) — :104 cannot exist, and the quoted text was never in it. The sentence's real home is `skills/maestro-playbook/SKILL.md:417` ("Comment the wave on the pinned board issue `fleet: maestro wave log`. That").
- **Proposed corrected target:** `skills/maestro-playbook/SKILL.md:417` (or drop the studio.md path and name the skill section).

### S37-F2. deep-modules-sweep-2 F13 — repair-failure.ts:161-173 never existed — GLM-OK

- **File:** `docs/maintainability/2026-10-10-deep-modules-sweep-2.md:258`.
- **Evidence:** cites `cli/repair-failure.ts:161-173` as a "grab-bag". The doc pins `origin/main f0d178d`; at that commit the file is 57 lines (destroyPath at :45), today 66 (destroyPath at :52); 161-173 never existed at any commit (max ever 69 lines, at 74d4b2b).
- **Proposed corrected target:** drop the fragment, or `cli/repair-failure.ts:45` (the pin's destroyPath).

### S37-F3. deep-modules-sweep-2 F14 — destroyPath cited at :161, defined at :45 — GLM-OK

- **File:** `docs/maintainability/2026-10-10-deep-modules-sweep-2.md:267`.
- **Evidence:** same doc, cites `cli/repair-failure.ts:161` (`destroyPath(force, discardUnsynced, park)`). `git grep destroyPath f0d178d -- apps/fleet/cli/` shows it defined only at repair-failure.ts:45; never at :161.
- **Proposed corrected target:** `cli/repair-failure.ts:45`.

### S37-F4. dependencies-sweep-31 — agents/do.test.ts path never existed; :21 is a comment — GLM-OK

- **File:** `docs/maintainability/2026-10-13-dependencies-sweep-31.md:47` (finding 13 row).
- **Evidence:** cites `agents/do.test.ts:21` as home of a `from "human"` string-literal false positive. No `agents/do.test.ts` exists in the tree — the agents tests live as `test/agents.do.test.ts` (different path shape; `agents/` names src/agents/, which has no test). In the real file, :21 is a comment about the kind change "human"→"report"; the actual `"human"` string literals sit at :81 and :100 (`readSince(env.DB, "human", 0)`).
- **Proposed corrected target:** `test/agents.do.test.ts:81` (first real hit).

### S37-F5. S26 splits orphaned living-claim cites — class finding — GLM-OK

- **Files:** `docs/maintainability/2026-10-12-test-helpers-sweep-18.md:54` (cites `github.webhook.test.ts:15` as a living dedup observation); `docs/maintainability/2026-10-12-orphan-tests-sweep-23.md:30` (cites `test/bun/install-cache-security.test.ts` as a living file).
- **Evidence:** S26 split PRs replaced these — github.webhook.test.ts → github.webhook-core.test.ts + github.webhook-autoclose.test.ts (PR #720, 6fff51b); test/bun/install-cache-security.test.ts → install-cache-security-parse.test.ts + install-cache-security-disk.test.ts (PR #736, 0cd438f). Dated sweep docs citing them at their own pin are history; these two read as current-state claims with no pin note. Same class, history docs, listed so the fix batch can decide per-cite: docs/maintainability/2026-10-08-deep-modules-sweep.md and apps/fleet/docs/plans/2026-10-12-fix-416-carried-review-findings.md cite deleted `test/bun/cli-destroy-flags.test.ts` (PR #466) and `src/board/close-outcome.ts` (PR #342).
- **Proposed action:** one-line dated annotations at the two living-claim cites (e.g. "(split by #720 into core+autoclose)"), or pin notes naming the commit each cite was true at.

### S37-F6. bringup plan cites a plan doc that exists in no commit — GLM-OK

- **File:** `apps/fleet/docs/plans/2026-09-30-bringup-launch-already-fixed-6.md:51`.
- **Evidence:** names `docs/superpowers/plans/2026-09-30-done-awaiting-merge-state-110.md` as PR #114's shipped plan doc. PR #114 is CLOSED, mergedAt null — the file exists in no commit (git log --all on that path is empty; `gh pr view 114 --json files` shows it as the PR's only file, never landed). A reader following the path finds nothing.
- **Proposed corrected target:** cite the PR URL only (https://github.com/rafarc21/fleetflare/pull/114), drop the repo path.

### S37-F7. dead-code-sweep-9's SessionFileStat cite drifted with the burn split — GLM-OK

- **File:** `docs/maintainability/2026-10-12-dead-code-sweep-9.md:95`.
- **Evidence:** cites `src/studio/burn.ts:1768` `SessionFileStat`. After PR #533 split burn.ts's tar/gzip reader out (2026-10-12), the type lives at `src/studio/session-stats.ts:348`. The cite was correct at the doc's own pinned commit c2cc15f — drift, not error — but the doc's own header shows this repo's pattern for handling it (it re-verified against a later head and annotated the one moved ref, F5's readReposFailureComment).
- **Proposed corrected target:** `src/studio/session-stats.ts:348` (or annotate as moved by #533).

Corrections land as separate follow-up issues (one per batch), refs #740.
This PR ships only this analysis doc.
