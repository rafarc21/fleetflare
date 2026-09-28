# Blueprint

`org.json` (who may spawn whom) and `roles/*.md` (one file per role) for the
fleet provisioned out of this repo. `../../fleet.json` (repo root) picks
which of these roles are actually enabled, and at which ref.

## Coherence rule

**Declared roles are the roles with files.** A role only becomes
provisionable once BOTH are true: a `roles/<name>.md` file exists here, AND
`fleet.json`'s `roles` array names it. Either alone is not enough —
`assertRoleInFleet` (provision) and `runSpawn`'s fleet-declared check (spawn)
both refuse a role missing from `fleet.json`, even one with a file right
here.

**A studio's file is `studios/<name>/studio.md`, not `roles/<name>.md`.**
Same rule, different path: provision resolves a studio name studio-first and
falls back to the role path (`src/studio/provision.ts`), but `fleet.json`'s
`roles` array still gates both. So a studio needs its `studios/<name>/`
directory here AND its name in `fleet.json`'s `roles`.

**`org.json`'s `edges` may lead future work.** An edge naming a role with no
file yet (or one not yet added to `fleet.json`) is not an error — it is
intent, recorded ahead of the role existing. Spawning it fails cleanly (403
if no edge, 400 if edged-but-undeclared) instead of starting a container that
can never work. Add the file, then the `fleet.json` entry, to make an edge
real.

## Skills are vendored here too

`../../skills/<name>/SKILL.md` (repo root, alongside `container/`) is the
same single-source pattern as the roles and studios above: `studio-bringup.sh`
resolves a declared skill from `/opt/blueprint/skills/<name>` inside a
container, and `/opt/blueprint` IS this repo's checkout. Once a skill lands
here, `~/.claude/skills/<name>` on the operator's Mac becomes a symlink into this same
checkout — local and cloud both reading the one file, never two copies
drifting apart.
