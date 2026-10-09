Issue: https://github.com/rafarc21/fleetflare/issues/259

Spec: see the issue body directly (board issue #259) — not reproduced here.
A verbatim copy was attempted and refused by this repo's own leak gate
(denylist patterns #12, #30, terms never named by design). Flagging for the
operator/maestro to resolve (confirm a real necessary redaction, or tune the
private ops-repo denylist if this is a false positive) rather than
reverse-engineering the flagged text via trial pushes, which would defeat the
gate's own confidentiality design regardless of intent. See board issue #259's
own comment thread for the follow-up.

Summary (for readers who don't want to leave this repo): Part A ships 2 new
skills (deep-modules, pr-body) plus small cross-link/blueprint updates, all
implemented in this PR; Parts B/C/D (GLM-driven refactor lanes, safety
guardrails, measurement) are explicitly out of scope for this PR and tracked
on the parent epic (#258).
