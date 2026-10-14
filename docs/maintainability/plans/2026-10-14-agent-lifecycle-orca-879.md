# S44-F3 plan — rewrite agent-lifecycle's dead `dev`/`cc` commands to Orca/fleet

Task: https://github.com/rafarc21/fleetflare/issues/879 (sweep 44, finding 3 of 3).
Skill: `skills/agent-lifecycle/SKILL.md`. Dead CLI: `dev` (since 2026-09-07) and `cc` — no binary exists.

## Problem

All command sequences in the skill fail today (`dev agent create` :29, `dev send` :33/:39, `cc --continue` :65, `dev remove` :87/:94). Still load-bearing: maestro-playbook/SKILL.md:247 and sprint-ritual/SKILL.md:39 link here. Tool-independent rules (kill rule, four pre-teardown checks, reap-on-every-sweep) stay verbatim.

## Change — rewrite in place

Fleet-cockpit covers destroy only, not creation or the kill-vs-hibernate framing the inbound links cite. Map, verified against apps/fleet/cli/orca-workspace.ts and fleet-cockpit/SKILL.md:

- `dev agent create` → `orca worktree create --repo id:<repo> --name <name> --no-parent --setup skip` + `.context/BRIEFING.md` + `orca terminal create`/`send`.
- `dev send` → `orca terminal send --terminal <handle> --text …` — keep "typed, not submitted" rule; draft check via `orca terminal read --screen --json`.
- Stale terminal IDs → stale handles, same rule, new noun.
- `cc --continue` → `fleet provision <id>`; unresumable session → `fleet provision|recycle <id> --fresh-session` (fleet-cockpit:227,246).
- `dev remove` → `fleet destroy <id>` (stops container AND tears down Orca worktree + attach terminal, board #57); degraded fallback: `orca terminal close --terminal <handle>`, then `orca worktree rm --worktree "path:<abs>"` (fleet-cockpit:297-299).
- Hibernate framing → `fleet destroy --park`; resume = `fleet provision <id>`.

Inbound links keep their meaning (framing, not commands) — no edits to maestro-playbook:247 or sprint-ritual:39.

## Verification

Doc-only. No test asserts on agent-lifecycle (vendored-skills.test.ts: i-have-adhd + fleet-cockpit only). Gates: `bun run english-check`; re-grep zero `dev agent|dev send|dev remove|cc --continue` in skills/; `bun test test/bun/vendored-skills.test.ts`. skills/ not in ONE_WAY_GLOBS → two-way door.
