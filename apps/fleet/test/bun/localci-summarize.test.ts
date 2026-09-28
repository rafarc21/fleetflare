import { describe, expect, test } from "bun:test";
import { computeResult, type LaneCounts, parseBunTest, parseFlakyList, parseVitestJson, rerunPlan } from "../../scripts/localci/summarize";

/**
 * Issue #267 — the local CI runner that replaces GitHub Actions. These pin
 * the pure half: reading each lane's output into counts + failing names,
 * the known-flaky rerun decision, and the two commit statuses a run posts.
 * The shell half (localci.sh) is driven end to end in localci-run.test.ts.
 */

// Shape copied from a real Linux-lane log (bun 1.3, 2026-09-25): a file
// header, per-test lines, then bun's own "N tests failed:" recap that
// repeats every failure WITHOUT its file header.
const BUN_LOG = `bun test v1.3.11
test/bun/incarnation-newline.test.ts:
(pass) incarnation file round-trip > a token survives [1024.31ms]

test/bun/session-memory.test.ts:
(fail) #176 — gunzip slices > sessionStats [5061.64ms]
  ^ this test timed out after 5000ms.
(pass) #176 — burn increment > first tick [231.36ms]

1 tests skipped:
(skip) memguard in docker --memory=1g > kills the hog


1 tests failed:
(fail) #176 — gunzip slices > sessionStats [5061.64ms]

 759 pass
 1 skip
 1 fail
 2122 expect() calls
Ran 761 tests across 58 files. [225.15s]
error: script "bun-test" exited with code 1
`;

describe("parseBunTest", () => {
  test("reads bun's summary counts", () => {
    const r = parseBunTest(BUN_LOG);
    expect([r.pass, r.fail, r.skip]).toEqual([759, 1, 1]);
  });

  test("names each failure once, under the file it ran in (the recap repeats it without a file)", () => {
    expect(parseBunTest(BUN_LOG).failing).toEqual([
      { file: "test/bun/session-memory.test.ts", name: "#176 — gunzip slices > sessionStats" },
    ]);
  });

  test("a log with no summary (lane died before bun printed one) reads as zero, never as green", () => {
    const r = parseBunTest("docker: Cannot connect to the Docker daemon\n");
    expect(r.pass).toBe(0);
    expect(r.parsed).toBe(false);
  });
});

describe("parseVitestJson", () => {
  test("counts assertions and names failures with their file relative to apps/fleet", () => {
    const json = JSON.stringify({
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          name: "/w/apps/fleet/test/a.test.ts",
          assertionResults: [
            { status: "passed", fullName: "a ok" },
            { status: "failed", fullName: "a broken" },
          ],
        },
        { name: "/w/apps/fleet/test/b.test.ts", assertionResults: [{ status: "passed", fullName: "b ok" }] },
      ],
    });
    const r = parseVitestJson(json);
    expect([r.pass, r.fail, r.parsed]).toEqual([2, 1, true]);
    expect(r.failing).toEqual([{ file: "test/a.test.ts", name: "a broken" }]);
  });

  test("unreadable JSON reads as unparsed, zero counts", () => {
    expect(parseVitestJson("").parsed).toBe(false);
  });
});

describe("known-flaky rerun policy", () => {
  const flaky = parseFlakyList("# comment\ntest/bun/session-memory.test.ts  # #256\n\n");
  const SM = "test/bun/session-memory.test.ts";
  /** Consistent counts: every failure bun counted has a (fail) line, no errors. */
  const lane = (failing: { file: string; name: string }[], extra: Partial<LaneCounts> = {}): LaneCounts => ({
    parsed: true,
    pass: 5,
    fail: failing.length,
    skip: 0,
    errors: 0,
    failing,
    ...extra,
  });

  test("the list file ignores comments and blank lines", () => {
    expect(flaky).toEqual([SM]);
  });

  test("failures only in listed files → rerun exactly those files", () => {
    const failing = [
      { file: SM, name: "x" },
      { file: SM, name: "y" },
    ];
    expect(rerunPlan(lane(failing), flaky)).toEqual([SM]);
  });

  test("any failure outside the list → no rerun (a real red stays red)", () => {
    const failing = [
      { file: SM, name: "x" },
      { file: "test/bun/wake-cmd.test.ts", name: "y" },
    ];
    expect(rerunPlan(lane(failing), flaky)).toEqual([]);
  });

  // 2026-09-25: entries written as a bare file name never matched bun's
  // test/bun/<file> — a native run stayed red on two listed ego-browser flakes.
  // An entry names a file at a path-segment boundary, in any of the forms.
  test("an entry matches in any form: bare name, test/bun/…, apps/fleet/test/bun/…", () => {
    const f = "test/bun/ego-browser-idle-shutdown-container.test.ts";
    const failing = [{ file: f, name: "x" }];
    for (const entry of ["ego-browser-idle-shutdown-container.test.ts", f, `apps/fleet/${f}`]) {
      expect(rerunPlan(lane(failing), [entry])).toEqual([f]);
    }
  });

  test("a bare-name entry never matches a longer file name ending the same way", () => {
    const failing = [{ file: "test/bun/other-session-memory.test.ts", name: "x" }];
    expect(rerunPlan(lane(failing), ["session-memory.test.ts"])).toEqual([]);
  });

  test("no failures → no rerun", () => {
    expect(rerunPlan(lane([]), flaky)).toEqual([]);
  });

  // PR #272 review, HIGH: a file that fails to LOAD prints no (fail) line —
  // only "# Unhandled error between tests" and " N error" in the summary. A
  // flaky (fail) elsewhere must never launder it into "flaky rerun ok".
  test("a load error hiding behind a flaky failure → no rerun", () => {
    expect(rerunPlan(lane([{ file: SM, name: "x" }], { errors: 1 }), flaky)).toEqual([]);
  });

  test("bun counted more failures than it named → no rerun", () => {
    expect(rerunPlan(lane([{ file: SM, name: "x" }], { fail: 2 }), flaky)).toEqual([]);
  });

  test("unparsed output → no rerun", () => {
    expect(rerunPlan(lane([{ file: SM, name: "x" }], { parsed: false }), flaky)).toEqual([]);
  });
});

// Real bun 1.3.11 output (2026-09-25): b fails, c throws at load. Bun counts
// c's load error as a fail AND an error, but prints no (fail) line for it.
const LOAD_ERROR_LOG = `test/bun/a.test.ts:
(pass) ok [0.10ms]

test/bun/session-memory.test.ts:
(fail) red [1.81ms]

test/bun/c.test.ts:

# Unhandled error between tests
-------------------------------
1 | throw new Error("load boom");
error: load boom
-------------------------------


 1 pass
 2 fail
 1 error
 2 expect() calls
Ran 3 tests across 3 files. [12.00ms]
`;

describe("load errors — the case the review reproduced", () => {
  test("parseBunTest reads bun's error count", () => {
    const r = parseBunTest(LOAD_ERROR_LOG);
    expect([r.pass, r.fail, r.errors, r.failing.length]).toEqual([1, 2, 1, 1]);
  });

  test("rerunPlan on the real output: no rerun", () => {
    expect(rerunPlan(parseBunTest(LOAD_ERROR_LOG), ["test/bun/session-memory.test.ts"])).toEqual([]);
  });

  test("even with a green rerun on disk, the lane stays red: never 'flaky rerun ok'", () => {
    const r = computeResult({
      meta: "sha=abc\n",
      "install.exit": "0",
      "check.exit": "0",
      "vitest.exit": "0",
      "vitest.json": JSON.stringify({ numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [] }),
      "linux.exit": "1",
      "linux.log": LOAD_ERROR_LOG,
      "linux-rerun.exit": "0",
      "linux-rerun.log": " 1 pass\n 0 fail\n",
      "english.exit": "0",
    });
    const fleet = r.statuses.find((s) => s.context === "local-ci/fleet-check")!;
    expect(fleet.state).toBe("failure");
    expect(fleet.description).not.toContain("flaky rerun ok");
  });
});

describe("computeResult — the two statuses a run posts", () => {
  const green = {
    meta: "sha=abc\npr=12\ntree=t1\nbase=b1\n",
    "install.exit": "0",
    "check.exit": "0",
    "vitest.exit": "0",
    "vitest.json": JSON.stringify({ numPassedTests: 3499, numFailedTests: 0, numPendingTests: 0, testResults: [] }),
    "linux.exit": "0",
    "linux.log": " 645 pass\n 0 fail\nRan 645 tests across 58 files.\n",
    "english.exit": "0",
  };

  const byContext = (files: Record<string, string>) =>
    Object.fromEntries(computeResult(files).statuses.map((s) => [s.context, s]));

  test("all lanes green → success on both contexts, counts in the description", () => {
    const s = byContext(green);
    expect(s["local-ci/fleet-check"].state).toBe("success");
    expect(s["local-ci/fleet-check"].description).toContain("vitest 3499/3499");
    expect(s["local-ci/fleet-check"].description).toContain("bun 645/645");
    expect(s["local-ci/english"].state).toBe("success");
  });

  test("a red bun lane → failure naming the failing file", () => {
    const s = byContext({ ...green, "linux.exit": "1", "linux.log": BUN_LOG });
    expect(s["local-ci/fleet-check"].state).toBe("failure");
    expect(s["local-ci/fleet-check"].description).toContain("session-memory");
  });

  test("red only in a known-flaky file whose rerun passes → success, and says it reran", () => {
    const s = byContext({
      ...green,
      "linux.exit": "1",
      "linux.log": BUN_LOG,
      "linux-rerun.exit": "0",
      "linux-rerun.log": " 3 pass\n 0 fail\n",
    });
    expect(s["local-ci/fleet-check"].state).toBe("success");
    expect(s["local-ci/fleet-check"].description).toContain("flaky rerun ok");
  });

  test("flaky rerun fails again → failure", () => {
    const s = byContext({
      ...green,
      "linux.exit": "1",
      "linux.log": BUN_LOG,
      "linux-rerun.exit": "1",
      "linux-rerun.log": " 2 pass\n 1 fail\n",
    });
    expect(s["local-ci/fleet-check"].state).toBe("failure");
    expect(s["local-ci/fleet-check"].description).toContain("flaky rerun failed");
  });

  test("a lane that exits non-zero with nothing parsed is never success (it ran 0 tests: error)", () => {
    const s = byContext({ ...green, "linux.exit": "125", "linux.log": "docker: error\n" });
    expect(s["local-ci/fleet-check"].state).toBe("error");
  });

  test("tsc red → failure", () => {
    expect(byContext({ ...green, "check.exit": "2" })["local-ci/fleet-check"].state).toBe("failure");
  });

  test("english red → english failure, fleet-check unaffected", () => {
    const s = byContext({ ...green, "english.exit": "1" });
    expect(s["local-ci/english"].state).toBe("failure");
    expect(s["local-ci/fleet-check"].state).toBe("success");
  });

  test("conflict with main → failure on BOTH contexts, never omitted", () => {
    const s = byContext({ meta: "sha=abc\nconflict=1\n" });
    expect(s["local-ci/fleet-check"]).toMatchObject({ state: "failure", description: "conflicts with main" });
    expect(s["local-ci/english"]).toMatchObject({ state: "failure", description: "conflicts with main" });
  });

  test("fleet-check skipped (no fleet paths touched) still posts success saying skipped", () => {
    const s = byContext({ meta: "sha=abc\nskip_fleet=no apps/fleet, skills, fleet/blueprint change\n", "english.exit": "0" });
    expect(s["local-ci/fleet-check"].state).toBe("success");
    expect(s["local-ci/fleet-check"].description).toStartWith("skipped");
    expect(s["local-ci/english"].state).toBe("success");
  });

  test("an infra error (meta error=) → error state on both contexts", () => {
    const s = byContext({ meta: "sha=abc\nerror=docker daemon unreachable\n" });
    expect(s["local-ci/fleet-check"].state).toBe("error");
    expect(s["local-ci/english"].state).toBe("error");
  });

  // #267 follow-ups (the 2026-09-25 reboot proved each): a lane that hangs is
  // killed by its timeout, a lane that dies by a signal is not a test verdict.
  test("a lane that timed out → error 'lane <x> timed out after Nm', never failure", () => {
    const s = byContext({ ...green, "linux.exit": "143", "linux.timeout": "1800", "linux.log": "" });
    expect(s["local-ci/fleet-check"]).toMatchObject({ state: "error", description: "lane linux timed out after 30m" });
  });

  test("a sub-minute timeout reads in seconds", () => {
    const s = byContext({ ...green, "vitest.exit": "143", "vitest.timeout": "2" });
    expect(s["local-ci/fleet-check"].description).toBe("lane vitest timed out after 2s");
  });

  test("english lane timed out → english error", () => {
    const s = byContext({ ...green, "english.exit": "143", "english.timeout": "1800" });
    expect(s["local-ci/english"]).toMatchObject({ state: "error", description: "lane english timed out after 30m" });
  });

  test("a lane killed by a signal (exit >= 128) → error naming the signal, never failure or success", () => {
    const s = byContext({ ...green, "linux.exit": "137", "linux.log": "" });
    expect(s["local-ci/fleet-check"].state).toBe("error");
    expect(s["local-ci/fleet-check"].description).toContain("lane linux killed (signal 9)");
  });

  test("a killed flaky rerun is an error too", () => {
    const s = byContext({
      ...green,
      "linux.exit": "1",
      "linux.log": BUN_LOG,
      "linux-rerun.exit": "137",
      "linux-rerun.log": "",
    });
    expect(s["local-ci/fleet-check"].state).toBe("error");
    expect(s["local-ci/fleet-check"].description).toContain("lane linux-rerun killed (signal 9)");
  });

  // 2026-09-25 first live daemon run: vitest ran on Bun (no node on launchd's
  // PATH), its config failed to load, NO tests ran. That is a broken runner,
  // not a verdict: never success, never a generic failure — say it.
  test("vitest ran 0 tests (config failed to load, no json) → error 'vitest ran 0 tests'", () => {
    const { "vitest.json": _, ...noJson } = green;
    const s = byContext({ ...noJson, "vitest.exit": "1" });
    expect(s["local-ci/fleet-check"]).toMatchObject({ state: "error", description: "vitest ran 0 tests (see vitest.log)" });
  });

  test("vitest exit 0 with 0 tests → still error, never success", () => {
    const zero = JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, testResults: [] });
    const s = byContext({ ...green, "vitest.json": zero });
    expect(s["local-ci/fleet-check"].state).toBe("error");
    expect(s["local-ci/fleet-check"].description).toContain("vitest ran 0 tests");
  });

  test("bun lane ran 0 tests → error 'bun ran 0 tests'", () => {
    const s = byContext({ ...green, "linux.exit": "1", "linux.log": "error: script not found\n" });
    expect(s["local-ci/fleet-check"]).toMatchObject({ state: "error", description: "bun ran 0 tests (see linux.log)" });
  });

  // #279: which machine ran the lanes, on every final status; never clipped away.
  test("meta runner= lands on both final descriptions", () => {
    const s = byContext({ ...green, meta: green.meta + "runner=studio\n" });
    expect(s["local-ci/fleet-check"].description).toEndWith(" · runner=studio");
    expect(s["local-ci/english"].description).toEndWith(" · runner=studio");
  });

  test("a long description is clipped BEFORE the runner suffix, which survives", () => {
    const many = Array.from({ length: 30 }, (_, i) => `test/bun/f${i}.test.ts:\n(fail) t${i} [1ms]\n`).join("");
    const s = byContext({ ...green, meta: green.meta + "runner=mac\n", "linux.exit": "1", "linux.log": many + " 0 pass\n 30 fail\n" });
    const d = s["local-ci/fleet-check"].description;
    expect(d.length).toBeLessThanOrEqual(140);
    expect(d).toEndWith(" · runner=mac");
  });

  test("descriptions fit GitHub's 140-character limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => `test/bun/f${i}.test.ts:\n(fail) t${i} [1ms]\n`).join("");
    const s = byContext({ ...green, "linux.exit": "1", "linux.log": many + " 0 pass\n 30 fail\n" });
    expect(s["local-ci/fleet-check"].description.length).toBeLessThanOrEqual(140);
  });

  test("result carries the tested tree hash and every failing name", () => {
    const r = computeResult({ ...green, "linux.exit": "1", "linux.log": BUN_LOG });
    expect(r.tree).toBe("t1");
    expect(r.lanes.bun?.failing).toHaveLength(1);
  });
});
