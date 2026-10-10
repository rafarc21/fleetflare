# Docs #334: safe Esc into a limit modal via orca (`--text $'\033'`, never `--enter`)

**Goal:** Document the safe way to dismiss a usage-limit modal in an agent terminal — raw Esc byte via `orca terminal send --text $'\033'`, never `--enter` (Enter can confirm "Upgrade your plan").

**Spec:** https://github.com/rafarc21/fleetflare/issues/334 (from the maestro, 2026-10-10). Docs only, GLM-OK.

## Why

`orca terminal send` has no `--key` flag, so a keypress must be sent as text. The limit modal offers spend options ("Upgrade", "Add funds"); an Enter aimed at "dismiss" can instead confirm a purchase. Esc dismisses the modal with no purchase risk. The `$'\033'` bash ANSI-C quoting yields the single Esc byte; `--enter` appends a newline, which is exactly the confirm key this procedure must never send.

## Task 1 — edits (one commit)

- `skills/fleet-cockpit/SKILL.md` ~line 201-203, the `limit modal open` bullet: replace "Dismiss by hand: `ff <id>`, press Esc, detach, re-assign." with the orca remote procedure (attach check, status-bar window check, Esc byte send, screen re-read), keeping the "Nothing unattended types into it" rule intact.
- `skills/maestro-playbook/SKILL.md` ~line 251-252, the modal warning: replace "Never type into a spend-limit or upgrade modal in an agent terminal — Enter there can mean 'buy the upgrade'." with the same rule plus the safe dismissal command.

## Verification

- `bun run english-check` — clean (both files are in its scan).
- Read-back: `grep -n "033" skills/fleet-cockpit/SKILL.md skills/maestro-playbook/SKILL.md` shows both edits.
