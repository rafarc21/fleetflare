// skills/junior/test/usage.test.ts
// Issue #218: local usage recording for junior calls that never reach the
// fleet Worker (laptop/direct transport). Real tmp dirs, real fs — no mocks.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUsageLocal } from "../src/usage";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "junior-usage-home-"));
}

describe("recordUsageLocal", () => {
  test("writes one correctly-shaped JSON line to ~/.local/share/fleet/junior-usage.jsonl", () => {
    const home = tmpHome();
    const row = { ts: 1700000000000, mode: "edit", model: "glm-5.3", inputTokens: 10, outputTokens: 20, ok: true };
    recordUsageLocal({ HOME: home }, row);
    const path = join(home, ".local", "share", "fleet", "junior-usage.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      ts: 1700000000000, mode: "edit", model: "glm-5.3", input_tokens: 10, output_tokens: 20, ok: true,
    });
    expect(typeof parsed.id).toBe("string");
    expect(parsed.id.length).toBeGreaterThan(0);
  });

  test("appends on a second call rather than overwriting", () => {
    const home = tmpHome();
    const row = { ts: 1, mode: "text", model: "m", inputTokens: 1, outputTokens: 1, ok: true };
    recordUsageLocal({ HOME: home }, row);
    recordUsageLocal({ HOME: home }, { ...row, ts: 2 });
    const path = join(home, ".local", "share", "fleet", "junior-usage.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).ts).toBe(1);
    expect(JSON.parse(lines[1]).ts).toBe(2);
  });

  test("swallows a write failure (unwritable parent dir) and never throws", () => {
    const home = tmpHome();
    // Put a FILE where recordUsageLocal needs to mkdir a directory, so
    // mkdirSync throws ENOTDIR.
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "fleet"), "not a directory");
    const origError = console.error;
    let errLine = "";
    console.error = (msg: string) => { errLine = msg; };
    try {
      expect(() => recordUsageLocal({ HOME: home }, {
        ts: 1, mode: "edit", model: "m", inputTokens: 1, outputTokens: 1, ok: false,
      })).not.toThrow();
    } finally {
      console.error = origError;
    }
    expect(errLine).toContain("junior: usage log write failed");
  });
});
