# Plan — sweep 33: duplicated test setup (#733)

Doc-only sweep, no code changes. Findings from a scripted helper-body census (every function/const-arrow definition in apps/fleet/test/**/*.test.ts, bodies brace-matched, whitespace-normalized, md5-grouped; same-name divergent groups listed by hand) plus hand re-verification of every copy by reading the file. Sweep 18 (#537) already extracted the helpers it found — this sweep finds NEW clusters only; sweep-18 leftovers F5/F10/F12 (captured/fakeStorage-clone/timeouts shim) are re-filed here only if still live.

## Steps

1. Branch sweep-733-dup-test-setup off origin/main f7fdeaf (done).
2. Scripted census + hand verification (done — findings below).
3. Write docs/maintainability/2026-10-13-duplicated-test-setup-sweep-33.md, max 15 findings, each: snippet location list, proposed shared helper name + home (existing helpers first), estimated lines removed.
4. Commit both docs, push branch.
5. File follow-up issues per batch, `test(GLM-OK): S33-Fn <short>` or `test(CLAUDE-ONLY): S33-Fn <short>` per lane rule, refs #733, never closing keywords.
6. Open doc-only PR referencing #733, no closing keywords.

## Verification

- Doc-only diff: `git diff origin/main --stat` shows only new .md files.
- `bun run english-check` clean (repo CI gate).
- Every file:line ref re-checked against the working tree before commit.
