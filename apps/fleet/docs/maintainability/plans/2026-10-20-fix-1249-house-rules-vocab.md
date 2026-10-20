---
# fix #1249: house rules — full suites run on gate; "local studio" vocabulary

## What

Two text-only changes, no code.

1. Studio house rules / blueprint (`fleet/blueprint`): studios run TARGETED
   tests only; the full suite is the gate's — push then `fleet gate run <pr>`
   (CF gate runner). Never the full suite or coverage in a container (memory
   ceiling, wedges). Removes "full test suite" from the in-container gate list
   so the two sentences never contradict.
2. Repo docs + skills: one concept, two hosts (cloud studio, local studio).
   Replace "worktree agent" / "local Orca agent" / "local agent" with "local
   studio". Grep whole repo; leave archival/dated docs quoting the old term.

## Fix

- `fleet/blueprint/studios/web-studio/studio.md` + both member blueprints:
  add the targeted-tests-only rule; drop "full test suite" from the gate list.
- `skills/fleet-cockpit/SKILL.md`, `skills/maestro-playbook/SKILL.md`: rename
  to "local studio"; fix the cockpit description's trailing "local agent";
  drop "full test suite" from the cockpit "Heavy gate budget" gate list.
- Archival docs (`docs/maintainability/…drift-sweep…`,
  `docs/superpowers/plans/…fleet-cockpit-single-source…`) stay as-is: they
  quote the old term as history.

## TDD / Verify

Text-only — no runtime behavior. Verification is grep: no "full test suite"
in `fleet/blueprint/studios/web-studio/`, and no "worktree agent" / "local
Orca agent" / "local agent" in `fleet/` or `skills/` outside the two archival
docs.

## Deploy note

Blueprint + skills ship via the Worker's blueprint/skills sync on
provision/restart — Worker/provision only, no image window.