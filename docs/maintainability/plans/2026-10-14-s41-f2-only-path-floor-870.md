# #870 plan — S41-F2 pin the "ONLY path" claim with an exact count

Refs #845 (sweep 41: overclaiming test titles — doc not on main at time of
writing). Test-only fix, no behavior change, one assertion in one file.

Finding (S41-F2): apps/fleet/test/studio.session.test.ts:2285 (the
untar-atomic `it`) ends with the claim "this mv is the ONLY path a restore
takes into the real location", but the assertion backing it is a FLOOR —
`bringupSrc().match(/~\/\.claude\/projects/g)?.length` pinned with
`.toBeGreaterThanOrEqual(1)`. One, two, or ten occurrences of the path all
pass; a future edit adding a second direct write site keeps the claim's
test green. The comment says ONLY, the count must say exactly one.

The raw path string `~/.claude/projects` occurs 12 times in
container/studio-bringup.sh, but only ONE is write-shaped — the atomic
placement `mv "$TMP_RESTORE/.claude/projects" ~/.claude/projects || placement_ok=0`
(line 644). The other 11 are read/guard/echo contexts (guard
`[ ! -d ~/.claude/projects ]`, comment text, an echo, and the
`claude_project_dir()` printf). So the "ONLY path" claim is true today, and
the right fix is the task's first option: count only write-shaped
occurrences and pin them at exactly 1 — not a bare `.toBe(1)` on the raw
path string, which would break on any future comment mentioning the path.

## Steps

1. Branch fix-870-s41-f2-only-path-floor off origin/main (done).
2. This plan doc committed and pushed.
3. RED: mutate apps/fleet/container/studio-bringup.sh locally — duplicate
   the mv line so a write-shaped count of 2 exists — and confirm the NEW
   assertion fails against it (the OLD floor assertion demonstrably does
   not). Restore the script byte-identical afterwards (git checkout).
4. GREEN: fix the assertion in apps/fleet/test/studio.session.test.ts —
   replace the floor line with a write-shaped regex
   (/(?:^|\n)[^\n#]*(?:mv|cp|mkdir|ln|tee|>>?)\S*[^|;#]*~\/\.claude\/projects[^\n]*/g
   shape, refined to what actually matches line 644 and only line 644) and
   `.toBe(1)`, reword the comment above it to state exactly what is
   counted. Run the studio.session.test.ts suite. Commit, push.
5. Verification record + PR.

## Why write-shaped regex, not exact toBe(1) on the raw string

The task body itself offers both. A raw `toBe(1)` over
`/~\/\.claude\/projects/g` would pin the current 12 raw occurrences and
force every future comment/guard edit touching that path to update the
test — a lie in the other direction (brittleness masking as precision).
The claim under test is about WRITE sites only, so the assertion must
count write-shaped occurrences: `mv|cp|mkdir|ln|rm|rmdir|tee|tar|install`
or a `>`/`>>` redirect whose line also contains the path.

## Verification

- RED run: vitest on studio.session.test.ts with the mutated script shows
  the new assertion failing (mutated count 2 ≠ 1), old floor line shown
  passing where it should fail.
- GREEN run: `npx vitest run test/studio.session.test.ts` in apps/fleet —
  whole file passes, script restored byte-identical (git status clean on
  the script).
- `bun run english-check` and `bun run test-lies-check` (both light).
- NO heavy gates: no full test suite, no repo-wide tsc, no vite build, no
  e2e.
