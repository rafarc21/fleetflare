import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARVEST_NO_RECORD, doneRecordsListCmd, harvestRecordCmd } from "../../src/studio/harvest-record";

/**
 * Issue #361: the completion record lives OUTSIDE the product checkout, at
 * /workspace/.fleet/done/<task>.json -- the dir gates/completion-gate.sh
 * reads. Executed for real (bash) against a fixture workspace; the command's
 * /workspace is pointed at it. A record left in the product tree
 * (/workspace/<repo>/.fleet/done/, the pre-#361 shape) is never read.
 */
let ws: string;

function rec(path: string, body: unknown) {
  const p = join(ws, path);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
}
function run(cmd: string): string {
  return execFileSync("bash", ["-c", cmd.replaceAll("/workspace", ws)], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "harvest-ws-"));
  mkdirSync(join(ws, "r"), { recursive: true });
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("harvestRecordCmd reads the delivered task's record from the workspace record dir (#361)", () => {
  test("task 316's own record is read", () => {
    rec(".fleet/done/316.json", { learnings: ["from 316"] });
    rec(".fleet/done/250.json", { learnings: ["from 250"] });
    expect(run(harvestRecordCmd("r", 316))).toContain("from 316");
  });

  // Must catch: a harvest that still reads the product tree.
  test("a record left in the product checkout is never read", () => {
    rec("r/.fleet/done/316.json", { learnings: ["in tree"] });
    rec("r/.fleet/done.json", { learnings: ["legacy in tree"] });
    expect(run(harvestRecordCmd("r", 316))).toBe(HARVEST_NO_RECORD);
  });

  test("task 400 wrote no record → no record, never a sibling's", () => {
    rec(".fleet/done/250.json", { learnings: ["from 250"] });
    expect(run(harvestRecordCmd("r", 400))).toBe(HARVEST_NO_RECORD);
  });

  test("unknown task → no record, never a guess", () => {
    rec(".fleet/done/250.json", { learnings: ["from 250"] });
    expect(run(harvestRecordCmd("r", null))).toBe(HARVEST_NO_RECORD);
  });
});

describe("doneRecordsListCmd lists every workspace record for the teardown archive (#361)", () => {
  function parse(out: string): Record<string, string> {
    const seen: Record<string, string> = {};
    for (const line of out.split("\n").filter(Boolean)) {
      const [task, b64] = line.split("\t");
      seen[task!] = Buffer.from(b64!, "base64").toString("utf8");
    }
    return seen;
  }

  test("one line per <task>.json: the task, a tab, the file base64'd on one line", () => {
    rec(".fleet/done/316.json", { plan: "p", note: "multi\nline" });
    rec(".fleet/done/250.json", "{\"plan\": \"q\"}\n");
    expect(parse(run(doneRecordsListCmd()))).toEqual({
      "316": JSON.stringify({ plan: "p", note: "multi\nline" }),
      "250": "{\"plan\": \"q\"}\n",
    });
  });

  test("names that are not <number>.json are skipped", () => {
    rec(".fleet/done/316.json", { plan: "p" });
    rec(".fleet/done/notes.json", { plan: "x" });
    rec(".fleet/done/12a.json", { plan: "x" });
    rec(".fleet/done/7.json.bak", { plan: "x" });
    expect(Object.keys(parse(run(doneRecordsListCmd())))).toEqual(["316"]);
  });

  test("the product checkout's in-tree records are never listed", () => {
    rec("r/.fleet/done/316.json", { plan: "p" });
    expect(run(doneRecordsListCmd())).toBe("");
  });

  test("no record dir at all: empty output, exit 0", () => {
    expect(run(doneRecordsListCmd())).toBe("");
  });
});
