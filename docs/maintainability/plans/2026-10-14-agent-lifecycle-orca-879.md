# S44-F3 plan — rewrite agent-lifecycle's dead `dev`/`cc` commands to Orca/fleet

Task: https://github.com/rafarc21/fleetflare/issues/879 (sweep 44, finding 3 of 3).
Ref skill: `skills/agent-lifecycle/SKILL.md`. Dead CLI: `dev` (2026-09-07, per
fleet-cockpit/SKILL.md:15) and `cc` — no such binary exists.

## Problem

The skill's command sequences all fail today: `dev agent create` (:29),
`dev send` (:33, :39), `cc --continue` (:65), `dev remove` (:87, :94).
Still load-bearing — maestro-playbook/SKILL.md:247 and sprint-ritual/SKILL.md:39
send readers here. Tool-independent rules (kill criteria, four pre-teardown
checks, reap-on-every-sweep) are correct and stay verbatim.

## Change (rewrite in place, not historical-mark)

Fleet-cockpit's teardown section covers destroy, not agent creation or the
hibernate/kill framing both inbound links cite it for. Rewrite chosen.

Map, verified against `apps/fleet/cli/orca-workspace.ts`:

- `dev agent create` → `orca worktree create --repo id:<repo> --name <name>
  --no-parent --setup skip` (orca-workspace.ts:689-693) + briefing via
  `.context/BRIEFING.md` (gitignored, .gitignore:30).
- `dev send <id>` → `orca terminal send --terminal <handle> --text ...`
  (fleet-cockpit/SKILL.md:206, maestro-playbook/SKILL.md:255). Keep the
  "types, does not submit" rule — fleet-cockpit:410 confirms sends report
  `accepted`/`observation: "unsupported"` and can hang as a `draft`
  (fleet-cockpit:411-412); check `orca terminal read --screen --json`
  → `result.terminal.draft`.
- Terminal handles go stale, like the old IDs did — same rule, new noun.
- `cc --continue` resurrect → `fleet provision <id>` (existing container,
  fleet-cockpit:246) — or, for a session that exits on `--continue`,
  `fleet provision|recycle <id> --fresh-session` (fleet-cockpit:227).
- `dev remove` teardown → the container-side verb is `fleet destroy <id>`
  (stops container AND tears down Orca worktree + attach terminal,
  fleet-cockpit:269-272); local-only fallback, when destroy's Orca cleanup
  degrades: `orca terminal close --terminal <handle>` then
  `orca worktree rm --worktree "path:<abs>"` (fleet-cockpit:297-299).
- Hibernation framing maps to `fleet destroy --park` (resumable; resume =
  `fleet provision <id>`) — maestro-playbook:247-249 already cites this
  skill for exactly that mapping.

Unchanged sections: naming convention, kill rule, four pre-teardown checks,
reap-on-every-sweep. `.context/` paragraph stays.

No inbound-link edits needed: maestro-playbook:247 and sprint-ritual:39 link to
the skill for framing (kill-vs-hibernate, extract value) — rewriting the
commands preserves both links' meaning.

## Verification

Doc-only diff (skills/ + this plan). No test asserts on agent-lifecycle
(vendored-skills.test.ts covers i-have-adhd + fleet-cockpit only). Run:
`cd apps/fleet && bun run english-check` (gate). Manual re-grep: zero
`dev agent|dev send|dev remove|cc --continue` matches in skills/.

## Notes

- skills/ not in merge-danger ONE_WAY_GLOBS → two-way door.
- All repo content English (house rule); task carries no `junior` label —
  no junior dispatch.
