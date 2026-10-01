// Board issue #160: a REAL comment body already posted to the live board
// (fleetflare#163, comment id 5930494303, posted 2026-10-01T11:36:08Z --
// `gh api repos/rafarc21/fleetflare/issues/comments/5930494303 --jq '.body'`)
// BEFORE `merge_danger` existed. Verbatim, not reconstructed: proves a
// comment already on the board -- with a real msg_id stamped by the
// Worker's own envelope route -- still parses cleanly through
// parseEnvelopeComment with `payload.merge_danger` absent, so the new
// optional field cannot retroactively break anything already stored.
export const ENVELOPE_COMMENT_ISSUE_163 = `**result** from \`fleetflare--web-studio--26\` — status **ok**

PR #183 open. standards doc done, prompts slimmed, CI doc fixed. review passed after 1 fix round. 3/4 verification green, 4th (bun-test) hit known pre-existing host-load flake unrelated to diff, documented honestly not faked. awaiting merge decision.

**Artifacts**

- PR #183 — pr

**Evidence**

- bun run english-check -> exit 0, clean
- bun run check -> exit 0, 5/5 tsconfig projects clean
- bun run test -> exit 0, 155 files / 5448 tests passed
- bun run bun-test -> did not reach exit 0 in this container; failures confined to repo's own documented known-flaky file test/bun/localci-run.test.ts (issue #382, host-load /proc timing), reproduced both full-lane and isolated-rerun under 60+ concurrent sibling sessions on this host; diff touches zero test/app code (docs-only); real merge gate is GitHub Actions check/english, unaffected
- code-reviewer: blocked once (pointer line smuggled a paraphrased style directive), fixed in commit 3ae23fd, re-verified clean
- byte counts: frontend-developer.md 2098->2138, backend-developer.md 2219->2259, code-reviewer.md 1031->1084, CODING_STANDARDS.md (new) 3826

**Verification**

- URL: https://github.com/rafarc21/fleetflare/pull/183
- Steps:
  - Open the PR diff: fleet/blueprint/CODING_STANDARDS.md (new) should read as a generic reviewer rubric with no client/operator-identifying info
  - Check frontend-developer.md / backend-developer.md: judgement clause replaced by a one-line pointer only, push-discipline/gate-lock/TDD paragraphs unchanged
  - Check code-reviewer.md checklist line points at the new file
  - Check CONTRIBUTING.md CI section now matches docs/operations.md (GitHub Actions check/english gate merges)
  - Check PR checks tab once GitHub Actions posts check/english status
- Expected: Diff touches only the 6 files named in the PR body, CI (check/english) goes green, no judgement content left in the two developer prompts

**Open questions**

- bun-test lane could not be forced green in this contended container (pre-existing #382 flake, unrelated to this diff) — flag for operator awareness, not blocking

**Context digest**

- Judgement/style rules moved out of frontend-developer.md/backend-developer.md into new reviewer-only fleet/blueprint/CODING_STANDARDS.md; kept push-discipline/gate-lock/TDD paragraphs in implementer files untouched since those are process/safety rules, not judgement calls
- code-reviewer.md points at the new file, keeps its own compact inline checklist too
- CONTRIBUTING.md CI section rewritten to match docs/operations.md + live gh api check-runs evidence (native GitHub Actions check/english gate merges, not local-ci/*, which is superseded)
- Skipped QA Engineer dispatch: no browser/UI surface on a pure prompt/docs change

<details>
<summary>envelope (machine-readable)</summary>

\`\`\`json
{
  "envelope": {
    "msg_id": "ad6b7ac7-d961-4e40-a0e7-2061357898f9",
    "task_id": 163,
    "sender": "fleetflare--web-studio--26",
    "intent": "result",
    "schema_version": "1"
  },
  "payload": {
    "status": "ok",
    "artifacts": [
      {
        "kind": "pr",
        "pr": "183"
      }
    ],
    "evidence": [
      "bun run english-check -> exit 0, clean",
      "bun run check -> exit 0, 5/5 tsconfig projects clean",
      "bun run test -> exit 0, 155 files / 5448 tests passed",
      "bun run bun-test -> did not reach exit 0 in this container; failures confined to repo's own documented known-flaky file test/bun/localci-run.test.ts (issue #382, host-load /proc timing), reproduced both full-lane and isolated-rerun under 60+ concurrent sibling sessions on this host; diff touches zero test/app code (docs-only); real merge gate is GitHub Actions check/english, unaffected",
      "code-reviewer: blocked once (pointer line smuggled a paraphrased style directive), fixed in commit 3ae23fd, re-verified clean",
      "byte counts: frontend-developer.md 2098->2138, backend-developer.md 2219->2259, code-reviewer.md 1031->1084, CODING_STANDARDS.md (new) 3826"
    ],
    "verification": {
      "url": "https://github.com/rafarc21/fleetflare/pull/183",
      "steps": [
        "Open the PR diff: fleet/blueprint/CODING_STANDARDS.md (new) should read as a generic reviewer rubric with no client/operator-identifying info",
        "Check frontend-developer.md / backend-developer.md: judgement clause replaced by a one-line pointer only, push-discipline/gate-lock/TDD paragraphs unchanged",
        "Check code-reviewer.md checklist line points at the new file",
        "Check CONTRIBUTING.md CI section now matches docs/operations.md (GitHub Actions check/english gate merges)",
        "Check PR checks tab once GitHub Actions posts check/english status"
      ],
      "expected": "Diff touches only the 6 files named in the PR body, CI (check/english) goes green, no judgement content left in the two developer prompts"
    },
    "open_questions": [
      "bun-test lane could not be forced green in this contended container (pre-existing #382 flake, unrelated to this diff) — flag for operator awareness, not blocking"
    ],
    "context_digest": [
      "Judgement/style rules moved out of frontend-developer.md/backend-developer.md into new reviewer-only fleet/blueprint/CODING_STANDARDS.md; kept push-discipline/gate-lock/TDD paragraphs in implementer files untouched since those are process/safety rules, not judgement calls",
      "code-reviewer.md points at the new file, keeps its own compact inline checklist too",
      "CONTRIBUTING.md CI section rewritten to match docs/operations.md + live gh api check-runs evidence (native GitHub Actions check/english gate merges, not local-ci/*, which is superseded)",
      "Skipped QA Engineer dispatch: no browser/UI surface on a pure prompt/docs change"
    ],
    "learnings": []
  },
  "notes": "PR #183 open. standards doc done, prompts slimmed, CI doc fixed. review passed after 1 fix round. 3/4 verification green, 4th (bun-test) hit known pre-existing host-load flake unrelated to diff, documented honestly not faked. awaiting merge decision."
}
\`\`\`

</details>

`;
