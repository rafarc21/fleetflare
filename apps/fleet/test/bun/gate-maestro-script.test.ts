// #715 Phase 1: scripts/gate/maestro-gate.sh maps `fleet gate start` +
// `fleet gate watch` onto one exit code: 0 green, 1 red, 2 error or gate off.
// The real `fleet` CLI is replaced by a stub on FLEET_BIN, so this runs the
// script's own branching and nothing else.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../scripts/gate/maestro-gate.sh", import.meta.url).pathname;

let dir: string;
let stub: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maestro-gate-"));
  stub = join(dir, "fleet");
  writeFileSync(stub, [
    "#!/usr/bin/env bash",
    `echo "$*" >> "${join(dir, "calls")}"`,
    'case "$1 $2" in',
    '  "gate start") echo "gate-start: run run-1 started for PR #$3"; exit "${START_RC:-0}" ;;',
    '  "gate watch") exit "${WATCH_RC:-0}" ;;',
    "esac",
    "exit 9",
    "",
  ].join("\n"));
  chmodSync(stub, 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(pr: string, env: Record<string, string>) {
  const proc = Bun.spawn(["bash", SCRIPT, pr], {
    env: { ...process.env, FLEET_BIN: stub, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const code = await proc.exited;
  const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
  return { code, calls };
}

describe("maestro-gate.sh", () => {
  it("rejects a non-numeric PR with exit 2 and runs nothing", async () => {
    expect(await run("abc", {})).toEqual({ code: 2, calls: "" });
  });

  it("start then watch, exit 0 when the verdict is success", async () => {
    expect(await run("7", { START_RC: "0", WATCH_RC: "0" })).toEqual({
      code: 0, calls: "gate start 7\ngate watch 7 run-1\n",
    });
  });

  it("exit 1 when the verdict is failure", async () => {
    expect((await run("7", { WATCH_RC: "1" })).code).toBe(1);
  });

  it("exit 2 when the verdict is error", async () => {
    expect((await run("7", { WATCH_RC: "2" })).code).toBe(2);
  });

  it("exit 2 when a status POST failed (watch exit 3)", async () => {
    expect((await run("7", { WATCH_RC: "3" })).code).toBe(2);
  });

  it("exit 2 without watching when start prints no run id", async () => {
    writeFileSync(stub, readFileSync(stub, "utf8").replace('echo "gate-start: run run-1 started for PR #$3"', "true"));
    expect(await run("7", {})).toEqual({ code: 2, calls: "gate start 7\n" });
  });

  it("exit 2 without watching when start fails (gate off, no-op route)", async () => {
    expect(await run("7", { START_RC: "2" })).toEqual({ code: 2, calls: "gate start 7\n" });
  });
});
