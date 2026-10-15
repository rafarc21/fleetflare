# Plan — sweep 46: unexplained magic numbers (refs #908)

Ref #908. Doc-only sweep: bare numeric literals used as timeouts, limits,
retry counts or sizes in apps/fleet/src/** with no named constant and no
explaining comment.

1. Grep apps/fleet/src/** for numeric literals in timeout/limit/retry/size
   positions (setTimeout, sleep, slice, length checks, retry loops).
2. Exclude auth, secrets, accounts, rescue, failover, deploy, migrations,
   write-proxy, leak-gate, approvals paths — findings there would be
   CLAUDE-ONLY; this sweep reports only GLM-OK findings.
3. Hand-verify each candidate: read surrounding code, confirm no constant
   and no comment explains the value.
4. Write findings doc docs/maintainability/2026-10-15-magic-numbers-sweep-46.md,
   max 15 findings, each with file:line, literal, what it controls, proposed
   constant name.
5. File one follow-up board issue for the batch. No code changes in this PR.

Out of scope: test/**, apps/fleet/scripts/**, apps/fleet/container/.
