# Documentation accuracy sweep 7 — skills/ + blueprint (2026-10-12)

Ref #421. Read-only analysis. No code changed, no doc fixed here — this
doc records findings; fixes land as separate tasks it spawns.

Scope: `skills/**/SKILL.md` (21 files), `fleet/blueprint/**/*.md` (12
files), `apps/fleet/README*` (none exists at any depth under apps/fleet
— verified with find; the task's scope line names a file the repo has
never had, no finding attaches to it).

Method: every doc claim naming a command, flag, path, file, string, or
behavior was greped against code on origin/main ec85d08. Most claims
checked out (spot list: maySpawn edges vs org.json, provision.ts
studio-first resolution, recycle/destroy/provision flag sets, tabs
--repo/--all/--yes, ROW verdict strings, aside/superseded session keys,
destroy 6x10s poll, UNMAPPED string, junior exit codes, retro-template
--template flag, container studio-fleet task-new surface, test-lies
three shapes, wake-cmd fix narrative). Findings below are the ones that
did not.

Tiers: all findings are GLM-OK — every fix is a doc-only edit, no code
touch, no security surface.

### S7-F1. fleet-cockpit claims org.json "still lists a cto role" — it does not — GLM-OK

`skills/fleet-cockpit/SKILL.md:61-63` says "`org.json` still lists a
`cto` role and an `operator` node from before this; those are being
reconciled in the blueprint (board task)." `fleet/blueprint/org.json:2-5`
has no `cto` key anywhere — edges are keyed `operator`, `pilot`,
`maestro` only. The reconciliation already happened; the sentence reads
as pending work. Fix: delete the stale sentence (lines 61-63, keep the
Vocabulary ruling itself).

### S7-F2. fleet-cockpit cites nonexistent org.json edges "cto -> release, qa, dev" — GLM-OK

`skills/fleet-cockpit/SKILL.md:104-105` says "(`org.json` also lists
`cto -> release, qa, dev`; none of those four roles has a definition
file, so those edges resolve to nothing." No such edges exist in
`fleet/blueprint/org.json:2-5`. Same stale-past as S7-F1. Fix: delete
the parenthetical.

### S7-F3. fleet-cockpit's "fleet-dispatch-grouping-rule" pointer resolves to nothing — GLM-OK

`skills/fleet-cockpit/SKILL.md:76` says "see
`fleet-dispatch-grouping-rule`." Repo-wide grep finds no file, skill,
section, or heading by that name (only this one mention). Dead pointer.
Fix: either drop the "see ..." clause or point at the real text
(`fleet/blueprint/studios/web-studio/studio.md` line 13's collision-free
grouping rule is the rule being invoked).

### S7-F4. blueprint README says skills sit "alongside container/" — container/ is not at repo root — GLM-OK

`fleet/blueprint/README.md:31` says "`../../skills/<name>/SKILL.md`
(repo root, alongside `container/`)". Repo root has no `container/`
directory — it lives at `apps/fleet/container/` (paths verified: repo
root listing vs `apps/fleet/container/Dockerfile.studio`). Fix: change
to "alongside `apps/fleet/container/`".

### S7-F5. CODING_STANDARDS says developer member files "only cite it" — neither cites it — GLM-OK

`fleet/blueprint/CODING_STANDARDS.md:7-9` says the developer blueprints
"`members/frontend-developer.md`, `members/backend-developer.md`) only
cite it." Neither file mentions CODING_STANDARDS or any coding-standard
pointer (grep: zero hits; both files read in full). The code-reviewer
member file does cite it (`members/code-reviewer.md:22`). Fix: either
make the two developer files cite CODING_STANDARDS (one pointer line
each) or reword the sentence to name only the reviewer path.

### S7-F6. skills/qa is written around agent-browser, which no studio image installs — GLM-OK

`skills/qa/SKILL.md:24` says "agent-browser installed: `bun install -g
agent-browser && agent-browser install`" and 38 later command lines
drive `agent-browser ...` (lines 49-51, 62-77, 105-110, 125-138, 199-202,
...). The studio image installs `ego-browser` instead
(`apps/fleet/container/Dockerfile.studio:272-273`), and its own comment
(line 242) says briefs instruct "NOT agent-browser"; `skills/ego-browser/SKILL.md:3`
states agent-browser is NOT installed in studio containers. A worker
following skills/qa's prerequisite step installs a tool the fleet has
ruled out. Fix: rewrite skills/qa's tool layer to ego-browser
(`ego-browser nodejs` with taskSpace/page) or state plainly that
agent-browser lines are for non-studio machines and studios use the
ego-browser skill.

### S7-F7. skills/qa references two files that do not exist next to it — GLM-OK

`skills/qa/SKILL.md:699-701` (Reference section) lists
`playbooks/tracking-validation.md` and `configs/zaraz-base.json`.
Neither path exists under `skills/qa/` (only SKILL.md is there) nor
anywhere else in this repo. Fix: drop the two dead Reference entries or
move the referenced material into the repo where the skill can reach it.

### S7-F8. skills/qa cites docs/platform-spec.md without scoping it to the client repo that has it — GLM-OK

`skills/qa/SKILL.md:70` and `:699` point at `docs/platform-spec.md` as
the canonical event-table source. That file does not exist in this repo
(it lives in client repos, e.g. the fleet docs repo's README references
it for its own tree). A reader standing in the wrong repo reads a broken
path. Fix: say "the client repo's `docs/platform-spec.md`" both places,
matching how the skill already scopes `client.json` to the project under
test.

### S7-F9. release-verification-checklist describes ~/.claude/skills as its own git repo — contradicts the vendored single-source model — GLM-OK

`skills/release-verification-checklist/SKILL.md:91-104` says
"`~/.claude/skills/` is a git repo as of `37a9381`" and "commits land
directly, with no PR" in that repo. `fleet/blueprint/README.md:31-37`
says skills are vendored in THIS repo and `~/.claude/skills/<name>` on
the Mac is a symlink into this checkout — and in studio containers the
symlinks resolve to `/opt/blueprint/skills/<name>`, this checkout
(bring-up: `apps/fleet/container/studio-bringup.sh:866-867`). The two
models of where a skill edit lands disagree; the section's workflow
("commit here, no PR") bypasses this repo's review rules. Fix: rewrite
the section to the vendored model — edits land as PRs in the blueprint
repo (this one), the 37a9381 history note stays as history.
