# Plan — fix #878: fleet-cockpit deploy.sh path citation

Doc-only one-line fix, finding S44-F1 of sweep 44
(docs/maintainability/2026-10-14-skills-drift-sweep-44.md). No code changes.

1. Edit skills/fleet-cockpit/SKILL.md:470: `scripts/deploy.sh` →
   `apps/fleet/scripts/deploy.sh`. That line is the only citation of the
   script inside skills/ and the bare repo-root path does not exist
   (repo-root scripts/ holds only junior-eval, public-export.sh, test;
   the real script lives at apps/fleet/scripts/deploy.sh, run via
   apps/fleet/package.json's `deploy` script from apps/fleet).
2. Commit on branch fix-878-cockpit-deploy-path off origin/main; push
   after the commit (single doc commit; nothing to RED-test — docs carry
   no executable behavior).
3. Verification: `bun run apps/fleet/scripts/english-check.ts` exit 0;
   grep confirms no remaining bare `scripts/deploy.sh` citation in
   skills/fleet-cockpit/SKILL.md; `git diff` shows exactly one line
   changed in skills/, plus the new plan file.
4. Review: one fresh-context Code Reviewer round (Spec: task says
   exactly this one line; Standards: CODING_STANDARDS.md +
   skills/deep-modules checklist — doc change, no module surface).
   Fix task: no brainstorm, no browser QA (no rendered surface).
5. PR: title `docs(fleet): #878 fix fleet-cockpit deploy.sh path citation (refs #856)`,
   body per .github/pull_request_template.md. Refs #856, never closing keywords.

Boundaries: no src/, container/ or CLI changes; skills/fleet-cockpit only.
