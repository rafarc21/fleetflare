# BSD-stat false red: gnuLane guard for incarnation-newline (issue #349)

Issue: https://github.com/rafarc21/fleetflare/issues/349. GLM-OK (test-side
only). Refs #348 review, never closes.

## Root cause (reproduced)

Tests 1 and 3 of test/bun/incarnation-newline.test.ts execute the real
shipTickCmd in a real shell. Its size probe `stat -c %s ... || echo -1` is
GNU-only; on a BSD-stat host (operator's Mac) the probe fails, FLEET_SIZE
becomes -1, the `if [ "$FLEET_SIZE" -ge 0 ]` guard never runs, and the
CHUNK/TAIL sections never emit — `indexOf(SECTION_CHUNK)` returns -1.
Simulated on Linux with a shimmed stat: 1 pass / 2 fail, the exact two
tests the issue names. Test 2 uses only printf/cat, no stat, cannot fail
this way. CI is green because every bun-test lane (Actions ubuntu, localci
docker, --native studio container) is GNU-stat Linux — the file runs
unskipped there, nothing excludes it.

## Fix

Same guard as test/bun/session-tar-budget.test.ts:50 (gnuLane): probe
`stat -c %s /` at setup, skip the whole suite on non-GNU stat. The
stat-dependent tests keep their CI coverage; the host run stops being a
false red. No production change — shipTickCmd is correct for its Linux
container target.

## Verify

Shimmed-stat rerun flips 2-fail to skip; normal run unchanged 3 pass.
