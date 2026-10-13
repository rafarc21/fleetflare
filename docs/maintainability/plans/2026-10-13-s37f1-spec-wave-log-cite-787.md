# Plan — S37-F1 sensor spec wave-log cite fix (refs #787)

Sweep 37 finding 1: docs/superpowers/specs/2026-10-01-sensor-
task-control-loop-168-design.md:107 cites `fleet/blueprint/studios/
maestro/studio.md:104` as the pinned-wave-log precedent and quotes its
text. Verified: that file is 31 lines in every commit it ever had
(added 1db884ba, never edited), and the quoted sentence was never in
it. Real home of the quote: `skills/maestro-playbook/SKILL.md:417-418`.

Change: that spec file only, line 107. Replace the wrong path cite
`fleet/blueprint/studios/maestro/studio.md:104` with
`skills/maestro-playbook/SKILL.md:417`. Quote text stays verbatim — it
matches SKILL.md:417-418 exactly. Nothing else in the file.

Verify: english-check (the gate that scans docs), zero exit.
Docs-only diff — no code, no tests affected.
