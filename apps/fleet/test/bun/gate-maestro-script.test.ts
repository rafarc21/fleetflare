// #715 Phase 1: scripts/gate/maestro-gate.sh is one `fleet gate run <pr>` call,
// mapped onto one exit code: 0 green, 1 red, 2 error or gate off.
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
    '  "gate run") exit "${RUN_RC:-0}" ;;',
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

  it("delegates to one `fleet gate run <pr>` call, exit 0 when green", async () => {
    expect(await run("7", { RUN_RC: "0" })).toEqual({ code: 0, calls: "gate run 7\n" });
  });

  it("exit 1 when the verdict is red", async () => {
    expect((await run("7", { RUN_RC: "1" })).code).toBe(1);
  });

  it("exit 2 when the verdict is error", async () => {
    expect((await run("7", { RUN_RC: "2" })).code).toBe(2);
  });

  it("any other exit from gate run is an error, never a green", async () => {
    expect((await run("7", { RUN_RC: "3" })).code).toBe(2);
    expect((await run("7", { RUN_RC: "9" })).code).toBe(2);
  });
});
