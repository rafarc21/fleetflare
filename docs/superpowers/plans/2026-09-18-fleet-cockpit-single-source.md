# Fleet Cockpit Single Source

**Problem (board issue #7):** `skills/fleet-cockpit/SKILL.md` exists only on
the operator's Mac (`~/.claude/skills/fleet-cockpit`), a real file, never vendored
into this repo. Two consequences:

1. No studio ever sees it — `container/studio-bringup.sh` resolves a
   declared skill from `/opt/blueprint/skills/<name>`, and `/opt/blueprint`
   IS this repo's checkout. A skill the Mac has and the fleet does not is a
   skill that only ever gets read locally, defeating the whole point of a
   skill that is ABOUT deciding fleet vs. local.
2. `.github/workflows/fleet-check.yml`'s `paths:` filter is scoped to
   `apps/fleet/**` only. A skills-only commit (`9d4f31c`) touched none of
   that path and triggered zero CI runs — `test/bun/vendored-skills.test.ts`
   silently un-tested on every skill-only change, the exact lane that would
   have caught problem 1 staying vendored-but-unverified.

Also measured, same workflow file: `push:` carries no branch filter, so a
push on a PR branch fires BOTH `push:` and `pull_request:` for the same
commit — the whole suite twice (`076fa86a`, `21d1fe28` each ran twice).

**Fix:**

1. Vendor the skill verbatim. Already done, on `seed/fleet-cockpit-skill`
   (`06f4dab`), branched from before this branch — `skills/fleet-cockpit/SKILL.md`,
   277 lines, byte-identical to the operator's Mac copy as of 2026-09-18, frontmatter
   `name: fleet-cockpit` confirmed present. This branch does not re-touch it.
2. Test it the same way `i-have-adhd` already is —
   `apps/fleet/test/bun/vendored-skills.test.ts` gets a sibling `describe`
   block: file exists at the path `studio-bringup.sh` resolves, frontmatter
   `name:` reads `fleet-cockpit`. `bun:test`, not vitest — same reason the
   existing block is: this reads a real file off a real filesystem, and the
   vitest lane runs under `vitest-pool-workers` (workerd, no `node:fs`).
3. Declare it on `maestro` only. `fleet/blueprint/studios/maestro/studio.md`'s
   `skills:` list gains `fleet-cockpit`. Checked every studio that exists in
   this repo (`fleet/blueprint/studios/*/studio.md` — only three: `maestro`,
   `release-studio`, `web-studio`; `pilot`/`scratch` are `roles/*.md`, not
   studios, out of this task's edit boundary, both already carry `skills: []`):

   | studio/role | add fleet-cockpit? | why |
   |---|---|---|
   | `maestro` | **yes** | the skill's own description is written for exactly maestro's job — "spawning or attaching a studio, filing board tasks, checking what the fleet is doing, adopting an existing issue, or deciding between the fleet and local Orca worktree agents." Maestro is the ONLY role in this repo's org chart that spawns peer studios (`org.json`: `maestro -> web-studio, release-studio`) and the interface the operator talks to about routing. |
   | `release-studio` | no | ephemeral, spawned per release train run BY maestro; org chart gives it no spawn edges of its own (`web-studio`/`release-studio`/`scratch` may spawn nothing). It runs a QA pass and reports — it never decides fleet-vs-local or files board tasks as part of its role. |
   | `web-studio` | no (per issue, decision already made) | ephemeral, single-purpose: executes ONE assigned board task and dies. Does not itself decide fleet-vs-local routing or spawn peer studios — that dispatch happens one level up, from maestro, before a web-studio task even exists. None of the skill's own subject matter (`ff`, `fleet spawn`, adopting issues) is called for inside a web-studio's normal workflow. |
   | `pilot` (role, not studio) | no | out of this task's edit boundary (`roles/*.md`, not `studios/*/studio.md`); already `skills: []`; single-repo persistent agent with its own separate approval-gate workflow, not a fleet router. |
   | `scratch` (role, not studio) | no | same boundary reason; throwaway one-off container, `skills: []`, no merge/deploy/spawn rights at all — nothing here ever needs fleet routing. |

4. Fix the CI filter, `.github/workflows/fleet-check.yml`:
   - `paths:` under both `pull_request:` and `push:` gains `skills/**` and
     `fleet/blueprint/**`, alongside the existing `apps/fleet/**` — so a
     skills-only or blueprint-only commit actually runs the suite that
     covers it.
   - `push:` gains `branches: [main]`. `pull_request:` is untouched — it
     still needs to fire on every PR branch. Only `push:` was firing
     unscoped and double-running the suite alongside `pull_request:` on the
     same commit.
5. One or two sentences in `fleet/blueprint/README.md` noting that once this
   merges, `~/.claude/skills/fleet-cockpit` on the operator's Mac becomes a symlink
   into this checkout — same single-source pattern the rest of the file
   already documents for roles/studios. Not created here — unreachable from
   this container, the coordinator does it post-merge.

**Boundary — only the 5 areas the issue names:** `skills/fleet-cockpit/`
(untouched, already vendored by the seed), `apps/fleet/test/bun/vendored-skills.test.ts`,
`fleet/blueprint/studios/*/studio.md`, `fleet/blueprint/README.md`,
`.github/workflows/fleet-check.yml`, plus this plan doc and `.fleet/done.json`.
Not touched: `apps/fleet/cli/`, `apps/fleet/container/`, `apps/fleet/src/` —
other in-flight board tasks' territory. `roles/pilot.md`, `roles/scratch.md`
not touched either — out of the studio-only scope item 3 above covers.

**Known open item, not resolved here:** the issue also flags a workflow-file
push-permission question (does the token pushing this branch have rights to
touch `.github/workflows/*.yml`). Not testable from inside this session —
this session does not push. Left for the lead to verify at push time and
report on verbatim if it fails.
