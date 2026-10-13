# Stale-comments sweep 28 — apps/fleet src+cli (2026-10-13)

Ref #643. Analysis only, read-only, no code changed. Twenty-eighth
maintainability sweep; scope `apps/fleet/src/**` and `apps/fleet/cli/**` minus
`container/`. Line refs = physical lines at `origin/main` `db50462`, paths
relative to `apps/fleet/` unless rooted.

Method: every comment-embedded reference — file paths, test paths, function
names, CLI flags, env vars, constants — was extracted from src+cli and
cross-checked against the tree. Absence was never trusted from one grep: each
candidate was hand-verified for name variants, sibling directories (root
`docs/` vs `apps/fleet/docs/`, nested SDK copies), frontmatter keys that look
like paths, operator-machine paths outside the repo, and git history
(`git log -S`, `git ls-tree` across all 184 commits).

**Ruled out (verified accurate, no finding):** ~60 backticked function/
constant citations (`module.ts's `fn```) all resolve; ~30 `test/` path
citations all exist; every CLI flag mentioned in cli-args.ts summaries exists
(`--allow-unrescued` lives in scripts/deploy.sh:128); SDK-internal names in
sandbox-api.ts comments (TIMEOUT_TO_GET_CONTAINER_MS/TIMEOUT_TO_GET_PORTS_MS,
syncPendingStoppedEvents, DEFAULT_CONTAINER_TIMEOUTS) are correct against the
pinned @cloudflare/sandbox@0.12.7's OWN nested containers copy
(sandbox/node_modules/.../container.js), which spells them exactly so;
`skills/gates` etc. are role-file frontmatter keys, not paths; `~/.fleet/probe/`
and `~/.claude/` cites are operator-machine paths outside the repo by design;
`wrangler.jsonc` is gitignored-but-real (deploy config). Explicitly-marked
history blocks ("was a fixed string (`APP_REMEDY`)", "(now-deleted)
INSTALL_CACHE_RESTORE_DIR_WORST_CASE_MS") are self-aware history, correct.

## Findings

| # | finding | lane |
|--:|---|---|
| 1 | src/studio/registry.ts:266 — cites `test/studio.burn-window-expiry.ts`; file is `test/studio.burn-window-expiry.test.ts` | GLM-OK |
| 2 | src/studio/do.ts:4653 — cites `docs/superpowers/OPERATOR-FINISH-LIST.md §9`; file never existed at that path in any commit | GLM-OK |
| 3 | src/studio/rescue.ts:2314 — cites `docs/plans/2026-10-03-feat-208-wip-sync.md`; file exists at `apps/fleet/docs/plans/…`, root `docs/plans/` never existed | GLM-OK |
| 4 | do.ts:2049 + studio-blueprint.ts:269 — cite `.superpowers/…` evidence files; dir is gitignored ephemeral scratch, reads as dangling on any other machine | GLM-OK |

### S28-F1. registry.ts — test-file citation missing the `.test` suffix — GLM-OK

- **File:** `src/studio/registry.ts:266` — "pinned by test/studio.burn-window-expiry.ts's 'nothing write storage from a read'".
- **Evidence:** `apps/fleet/test/` contains `studio.burn-window-expiry.test.ts`, no `studio.burn-window-expiry.ts`. The quoted test name exists at test/studio.burn-window-expiry.test.ts:190. A sibling comment (src/studio/transcript.ts:175 area) and test/helpers comments cite the same file WITH the suffix.
- **Proposed corrected comment:** `test/studio.burn-window-expiry.test.ts's "nothing write storage from a read"`.

### S28-F2. do.ts — OPERATOR-FINISH-LIST cited as a repo path that never existed — GLM-OK

- **File:** `src/studio/do.ts:4653` — "See docs/superpowers/OPERATOR-FINISH-LIST.md §9." (sibling without a path at src/studio/org.ts:109: "OPERATOR-FINISH-LIST §9").
- **Evidence:** no file matching `*OPERATOR-FINISH-LIST*` in the tree; `git ls-tree` across all 184 commits shows it was never committed anywhere; docs/superpowers/ holds only evidence/plans/specs. The §9 procedure itself (delete SPAWN_TOKEN_KEY from DO storage, recycle, provision) is fully spelled out in the same comment, so the pointer adds nothing a reader can follow.
- **Proposed corrected comment:** drop the "See docs/superpowers/OPERATOR-FINISH-LIST.md §9." sentence, or reword to "See the operator's own finish-list notes (kept outside this repo)." — org.ts's path-free spelling is already the right shape.

### S28-F3. rescue.ts — plan-doc cited at a repo path that never existed — GLM-OK

- **File:** `src/studio/rescue.ts:2314` — "(see this feature's own plan doc, docs/plans/2026-10-03-feat-208-wip-sync.md)".
- **Evidence:** the file exists at `apps/fleet/docs/plans/2026-10-03-feat-208-wip-sync.md` (115 files in that dir); the repo root has NO `docs/plans/` (only `docs/superpowers/plans/`), and `git log` shows `docs/plans/*` never existed at the root. Every other `docs/superpowers/specs|plans` citation in src resolves at the root — this is the one citing the other docs tree under a root-relative path.
- **Proposed corrected comment:** `apps/fleet/docs/plans/2026-10-03-feat-208-wip-sync.md`.

### S28-F4. .superpowers/ evidence-file citations — class finding — GLM-OK

- **Files:** `src/studio/do.ts:2049` — "see .superpowers/sdd/recycle-fix2-report.md"; `src/studio/studio-blueprint.ts:269` — "T0 spike, .superpowers/spike-lead-tools.md".
- **Evidence:** `.superpowers/` is a .gitignore'd local scratch dir; it is absent from this machine and from every other clone, so both cites dangle for every reader but the original author. The surrounding prose already carries the substance (do.ts: "not proven … which is the point of checking the container instead of trusting any one theory").
- **Proposed action:** no code change forced; if touched, point at the PR conversation instead of a local path. Recorded as a class: future comments should cite repo docs or PR URLs, never `.superpowers/` scratch paths.
