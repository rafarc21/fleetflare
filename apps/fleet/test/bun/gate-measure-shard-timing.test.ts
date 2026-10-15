import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVitestTimings, parseBunJunitTimings } from "../../scripts/gate/measure-shard-timing";

const SCRIPT = new URL("../../scripts/gate/measure-shard-timing.ts", import.meta.url).pathname;

describe("parseVitestTimings", () => {
  it("one entry per test file, duration from endTime - startTime", () => {
    const json = JSON.stringify({
      testResults: [
        { name: "/repo/apps/fleet/test/a.test.ts", startTime: 1000, endTime: 1500 },
        { name: "/repo/apps/fleet/test/b.test.ts", startTime: 2000, endTime: 2300 },
      ],
    });
    expect(parseVitestTimings(json)).toEqual([
      { file: "test/a.test.ts", ms: 500 },
      { file: "test/b.test.ts", ms: 300 },
    ]);
  });

  it("malformed JSON -> empty, never a throw", () => {
    expect(parseVitestTimings("not json")).toEqual([]);
  });

  it("missing startTime/endTime -> 0ms, not NaN or a throw", () => {
    const json = JSON.stringify({ testResults: [{ name: "/repo/apps/fleet/test/c.test.ts" }] });
    expect(parseVitestTimings(json)).toEqual([{ file: "test/c.test.ts", ms: 0 }]);
  });

  it("multiple testResults entries, names not under apps/fleet keep their tail", () => {
    const json = JSON.stringify({
      testResults: [{ name: "/other/place/src/d.test.ts", startTime: 0, endTime: 100 }],
    });
    expect(parseVitestTimings(json)).toEqual([{ file: "src/d.test.ts", ms: 100 }]);
  });
});

describe("parseBunJunitTimings", () => {
  const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="14" failures="0" skipped="0" time="0.182">
  <testsuite name="test/bun/a.test.ts" file="test/bun/a.test.ts" tests="12" failures="0" skipped="0" time="0">
    <testsuite name="group one" file="test/bun/a.test.ts" tests="6" failures="0" skipped="0" time="0.068">
      <testcase name="t1" classname="group one" time="0.000262" file="test/bun/a.test.ts" />
      <testcase name="t2" classname="group one" time="0.001853" file="test/bun/a.test.ts" />
    </testsuite>
  </testsuite>
  <testsuite name="test/bun/b.test.ts" file="test/bun/b.test.ts" tests="2" failures="0" skipped="0" time="0">
    <testcase name="slow" classname="slow" time="2.5" file="test/bun/b.test.ts" />
  </testsuite>
</testsuites>`;

  it("sums per-file ms from testcase time attrs, skips zero-time suites and nested suites", () => {
    const out = parseBunJunitTimings(junit);
    expect(out).toEqual([
      { file: "test/bun/a.test.ts", ms: 2 }, // 0.000262 + 0.001853 = 0.002115s -> 2ms
      { file: "test/bun/b.test.ts", ms: 2500 },
    ]);
  });

  it("malformed XML -> empty, never a throw", () => {
    expect(parseBunJunitTimings("not xml <")).toEqual([]);
  });

  it("no testcases -> empty result", () => {
    const empty = `<?xml version="1.0"?><testsuites><testsuite name="test/bun/c.test.ts" file="test/bun/c.test.ts" tests="0" failures="0" time="0"></testsuite></testsuites>`;
    expect(parseBunJunitTimings(empty)).toEqual([]);
  });

  it("testcase missing time attr -> contributes 0", () => {
    const noTime = `<?xml version="1.0"?><testsuites><testsuite name="test/bun/d.test.ts" file="test/bun/d.test.ts" tests="1" failures="0" time="0"><testcase name="t" classname="t" file="test/bun/d.test.ts" /></testsuite></testsuites>`;
    expect(parseBunJunitTimings(noTime)).toEqual([{ file: "test/bun/d.test.ts", ms: 0 }]);
  });
});

describe("measure-shard-timing CLI", () => {
  // The checked-in bun timing snapshot is produced by this CLI from a
  // `bun test --reporter=junit` file, so the .xml path is the one that matters.
  it("an .xml argument is read as bun junit and printed as {file, ms}[] JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shard-timing-"));
    try {
      const xml = join(dir, "lane.xml");
      writeFileSync(xml, `<?xml version="1.0"?><testsuites><testsuite name="test/bun/a.test.ts" file="test/bun/a.test.ts" time="0"><testcase name="t" classname="t" time="1.5" file="test/bun/a.test.ts" /></testsuite></testsuites>`);
      const proc = Bun.spawn(["bun", "run", SCRIPT, xml], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(out)).toEqual([{ file: "test/bun/a.test.ts", ms: 1500 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
