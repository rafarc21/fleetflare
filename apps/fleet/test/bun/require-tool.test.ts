import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTools } from "./require-tool";

/**
 * Issue #356 — `requireTools()` picks one of three behaviours (real suite /
 * silent skip / loud failure) depending on tool presence and `LOCALCI_IMAGE`.
 * The loud-failure branch is, by design, a test that FAILS — so it cannot be
 * exercised in-process without failing this very file's own `bun test` run.
 * Every case here instead spawns a real, throwaway `bun test` subprocess
 * against a tiny fixture file and reads its actual exit code and output,
 * proving runtime behaviour rather than just which function got returned.
 *
 * `FAKE_TOOL` is a name that will never exist on any real PATH, so the
 * "missing" cases never depend on what this container happens to have
 * installed. The "present" case gets its own tool by putting a throwaway
 * executable on PATH under that same name — so it, too, is independent of
 * this container's real toolset.
 */
const FAKE_TOOL = "definitely-not-a-real-binary-xyz";
const REQUIRE_TOOL_MODULE = join(import.meta.dir, "require-tool.ts");

function writeFixture(dir: string, tool: string): string {
  const file = join(dir, "fixture.test.ts");
  writeFileSync(
    file,
    [
      `import { test } from "bun:test";`,
      `import { requireTools } from ${JSON.stringify(REQUIRE_TOOL_MODULE)};`,
      `const LANE = requireTools(${JSON.stringify(tool)}, "fixture suite");`,
      `LANE("fixture describe", () => {`,
      `  test("inner test body", () => { console.log("INNER_TEST_RAN"); });`,
      `});`,
      "",
    ].join("\n"),
  );
  return file;
}

function runFixture(file: string, env: Record<string, string | undefined>) {
  const r = Bun.spawnSync({
    cmd: ["bun", "test", file],
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode ?? -1,
    out: r.stdout.toString() + r.stderr.toString(),
  };
}

describe("requireTools (issue #356)", () => {
  test("tool present: the real describe runs, its test executes and passes", () => {
    const dir = mktemp();
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, FAKE_TOOL), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, FAKE_TOOL), 0o755);
      const file = writeFixture(dir, FAKE_TOOL);
      const r = runFixture(file, { PATH: `${bin}:${process.env.PATH ?? ""}`, LOCALCI_IMAGE: undefined });
      expect(r.code).toBe(0);
      expect(r.out).toContain("INNER_TEST_RAN");
      expect(r.out).not.toContain("missing on PATH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool absent, LOCALCI_IMAGE unset: describe.skip — today's behaviour, unchanged", () => {
    const dir = mktemp();
    try {
      const file = writeFixture(dir, FAKE_TOOL);
      const r = runFixture(file, { LOCALCI_IMAGE: undefined });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("INNER_TEST_RAN");
      expect(r.out).not.toContain("missing on PATH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool absent, LOCALCI_IMAGE=1: one loud failing test naming the gap — never a quiet skip", () => {
    const dir = mktemp();
    try {
      const file = writeFixture(dir, FAKE_TOOL);
      const r = runFixture(file, { LOCALCI_IMAGE: "1" });
      expect(r.code).not.toBe(0);
      // The original fixture body must NOT have run — the loud-failure branch
      // replaces it outright rather than running it alongside a warning.
      expect(r.out).not.toContain("INNER_TEST_RAN");
      expect(r.out).toContain(FAKE_TOOL);
      expect(r.out).toContain("missing on PATH inside the pinned localci image");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multiple missing tools are ALL named in the one loud failure, not just the first", () => {
    const dir = mktemp();
    try {
      const other = "also-not-a-real-binary-abc";
      const file = join(dir, "fixture.test.ts");
      writeFileSync(
        file,
        [
          `import { test } from "bun:test";`,
          `import { requireTools } from ${JSON.stringify(REQUIRE_TOOL_MODULE)};`,
          `const LANE = requireTools([${JSON.stringify(FAKE_TOOL)}, ${JSON.stringify(other)}], "fixture suite");`,
          `LANE("fixture describe", () => { test("inner", () => {}); });`,
          "",
        ].join("\n"),
      );
      const r = runFixture(file, { LOCALCI_IMAGE: "1" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(FAKE_TOOL);
      expect(r.out).toContain(other);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "fleet-require-tool-"));
}

// Issue #369 round 2 (maestro review) — the tests above prove requireTools()
// itself behaves correctly against a FAKE tool name; none of them prove the
// REAL tools every requireTools() call site across this repo actually names
// are present inside the pinned localci image. Without this, removing zstd
// (or any of the others) from scripts/localci/Dockerfile's apt-get line
// regresses straight back to a silent describe.skip everywhere it's used —
// exactly the #356 bug this whole mechanism exists to prevent, just one
// layer removed. This is a REAL requireTools() call (not routed through a
// subprocess fixture like the tests above), so it participates in this
// file's own `bun test` run directly: inside the pinned image
// (LOCALCI_IMAGE=1), a missing tool fails this one test loudly; anywhere
// else it silently skips, same as every other requireTools() gate.
//
// List sourced from every requireTools()/tool-presence call site on main at
// the time of writing: zstd (install-cache-security.test.ts, #356),
// tmux (bringup-active-window.test.ts, studio-tmux-socket.test.ts),
// timeout (bringup-session-adopt.test.ts, exec-deadline.test.ts,
// worktree-session-adopt.test.ts, studio-adopt.test.ts), sha256sum + tar
// (bringup-session-adopt.test.ts), python3 + setsid
// (studio-tmux-socket.test.ts's PTY test), git (git-wrapper.test.ts and
// every fixture that shells out to a real git).
const IMAGE_CONTRACT_TOOLS = ["zstd", "tmux", "timeout", "sha256sum", "tar", "python3", "setsid", "git"];
const imageContract = requireTools(IMAGE_CONTRACT_TOOLS, "localci image contract");
imageContract("localci image contract — every tool this repo's requireTools() gates rely on", () => {
  test("trivial: exists only to prove the tool list above is fully present inside the pinned image", () => {
    expect(true).toBe(true);
  });
});
