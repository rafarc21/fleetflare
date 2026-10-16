import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  glmBringupEnv, glmCredentialPurgeCmd, glmSettingsEnvCmd, glmBringupCmd, planBringupExec,
} from "../../src/studio/glm-lead";
import { BRINGUP_CMD } from "../../src/studio/provision";

// Issue #1153 (B2/B3/B4). A glm-led studio's lead is the only Claude process
// the fleet should ever start, and its nested member `claude -p` calls must
// route through the fleet's translation route. These tests execute the REAL
// shell the Worker sends, against a temp HOME and a fake `tmux` on PATH, so
// what is asserted is the shipped command, not a re-typed copy.

const FAKE_TOKEN = "fleet-spawn-token-example";
const BASE_URL = "https://fleet.example.test/api";

function sandbox(): { home: string; bin: string; log: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "glm-lead-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const log = join(root, "tmux.log");
  // Records every argv it gets; exits 0 unless FAKE_TMUX_FAIL is set.
  writeFileSync(
    join(bin, "tmux"),
    `#!/bin/sh\necho "$@" >> "${log}"\n[ -n "$FAKE_TMUX_FAIL" ] && exit 1\nexit 0\n`,
  );
  chmodSync(join(bin, "tmux"), 0o755);
  return { home, bin, log, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(cmd: string, env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bash", "-c", cmd], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("glmSettingsEnvCmd (B2): nested claude inherits the route from settings.json", () => {
  test("writes ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into the env block", () => {
    const s = sandbox();
    try {
      const r = run(glmSettingsEnvCmd(), { HOME: s.home, FLEET_TOKEN: FAKE_TOKEN, FLEET_GLM_BASE_URL: BASE_URL });
      expect(r.code).toBe(0);
      const settings = JSON.parse(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"));
      expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN });
    } finally { s.cleanup(); }
  });

  test("merges: keeps the hooks block and unrelated env keys already on disk", () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.home, ".claude", "settings.json"), JSON.stringify({
        skipDangerousModePermissionPrompt: true,
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
        env: { KEEP_ME: "yes", ANTHROPIC_BASE_URL: "https://stale.example.test" },
      }));
      const r = run(glmSettingsEnvCmd(), { HOME: s.home, FLEET_TOKEN: FAKE_TOKEN, FLEET_GLM_BASE_URL: BASE_URL });
      expect(r.code).toBe(0);
      const settings = JSON.parse(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"));
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.env).toEqual({ KEEP_ME: "yes", ANTHROPIC_BASE_URL: BASE_URL, ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN });
    } finally { s.cleanup(); }
  });

  test("settings.json is owner-only: it now holds the spawn token", () => {
    const s = sandbox();
    try {
      run(glmSettingsEnvCmd(), { HOME: s.home, FLEET_TOKEN: FAKE_TOKEN, FLEET_GLM_BASE_URL: BASE_URL });
      const mode = statSync(join(s.home, ".claude", "settings.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally { s.cleanup(); }
  });

  test("fails closed without the token: nothing is written", () => {
    const s = sandbox();
    try {
      const r = run(glmSettingsEnvCmd(), { HOME: s.home, FLEET_GLM_BASE_URL: BASE_URL });
      expect(r.code).not.toBe(0);
      expect(existsSync(join(s.home, ".claude", "settings.json"))).toBe(false);
    } finally { s.cleanup(); }
  });
});

describe("glmCredentialPurgeCmd (B3): no OAuth token or credentials file survives on a glm studio", () => {
  test("removes ~/.claude/.credentials.json", () => {
    const s = sandbox();
    try {
      const creds = join(s.home, ".claude", ".credentials.json");
      writeFileSync(creds, "{}");
      const r = run(glmCredentialPurgeCmd(), { HOME: s.home, PATH: `${s.bin}:${process.env.PATH ?? ""}` });
      expect(r.code).toBe(0);
      expect(existsSync(creds)).toBe(false);
    } finally { s.cleanup(); }
  });

  test("unsets CLAUDE_CODE_OAUTH_TOKEN in the global AND studio tmux environments", () => {
    const s = sandbox();
    try {
      run(glmCredentialPurgeCmd(), { HOME: s.home, PATH: `${s.bin}:${process.env.PATH ?? ""}` });
      const calls = readFileSync(s.log, "utf8");
      expect(calls).toContain("set-environment -gu CLAUDE_CODE_OAUTH_TOKEN");
      expect(calls).toContain("set-environment -t studio -u CLAUDE_CODE_OAUTH_TOKEN");
    } finally { s.cleanup(); }
  });

  test("a tmux server that is not running does not abort the purge", () => {
    const s = sandbox();
    try {
      const creds = join(s.home, ".claude", ".credentials.json");
      writeFileSync(creds, "{}");
      const r = run(glmCredentialPurgeCmd(), { HOME: s.home, PATH: `${s.bin}:${process.env.PATH ?? ""}`, FAKE_TMUX_FAIL: "1" });
      expect(r.code).toBe(0);
      expect(existsSync(creds)).toBe(false);
    } finally { s.cleanup(); }
  });
});

describe("glmBringupCmd + planBringupExec (B2/B3 wiring): the Worker's one bring-up exec", () => {
  test("the settings write and purge run BEFORE bring-up, and bring-up still runs", () => {
    const s = sandbox();
    try {
      const marker = join(s.home, "bringup-ran");
      const fakeBringup = join(s.home, "fake-bringup.sh");
      writeFileSync(fakeBringup, `#!/bin/sh\ntest -f "$HOME/.claude/settings.json" && grep -q ANTHROPIC_AUTH_TOKEN "$HOME/.claude/settings.json" && touch "${marker}"\n`);
      chmodSync(fakeBringup, 0o755);
      const r = run(glmBringupCmd(fakeBringup), {
        HOME: s.home, PATH: `${s.bin}:${process.env.PATH ?? ""}`, FLEET_TOKEN: FAKE_TOKEN, FLEET_GLM_BASE_URL: BASE_URL,
      });
      expect(r.code).toBe(0);
      // Marker exists only if bring-up ran AFTER settings.json already carried the token.
      expect(existsSync(marker)).toBe(true);
    } finally { s.cleanup(); }
  });

  test("a failed settings write stops bring-up: no unrouted lead can launch", () => {
    const s = sandbox();
    try {
      const marker = join(s.home, "bringup-ran");
      const fakeBringup = join(s.home, "fake-bringup.sh");
      writeFileSync(fakeBringup, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(fakeBringup, 0o755);
      // No FLEET_TOKEN: the settings step fails, so the bring-up must not run.
      const r = run(glmBringupCmd(fakeBringup), { HOME: s.home, PATH: `${s.bin}:${process.env.PATH ?? ""}`, FLEET_GLM_BASE_URL: BASE_URL });
      expect(r.code).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally { s.cleanup(); }
  });

  test("glmBringupEnv carries the spawn token and route, never an OAuth token", () => {
    const env = glmBringupEnv(FAKE_TOKEN, BASE_URL);
    expect(env).toEqual({ FLEET_TOKEN: FAKE_TOKEN, FLEET_GLM_BASE_URL: BASE_URL });
    expect(Object.keys(env).some((k) => k.includes("OAUTH"))).toBe(false);
  });

  test("claude-led studio: bring-up exec passes through untouched", () => {
    const env = { FLEET_SPAWN_TOKEN: "x" };
    expect(planBringupExec({ cmd: BRINGUP_CMD, leadType: "claude", env, spawnToken: FAKE_TOKEN, baseUrl: BASE_URL }))
      .toEqual({ kind: "run", cmd: BRINGUP_CMD, env });
  });

  test("non-bring-up command on a glm studio passes through untouched", () => {
    const env = { X: "1" };
    expect(planBringupExec({ cmd: "tmux ls", leadType: "glm", env, spawnToken: FAKE_TOKEN, baseUrl: BASE_URL }))
      .toEqual({ kind: "run", cmd: "tmux ls", env });
  });

  test("glm studio bring-up is wrapped and carries the token in env, not argv", () => {
    const plan = planBringupExec({ cmd: BRINGUP_CMD, leadType: "glm", env: {}, spawnToken: FAKE_TOKEN, baseUrl: BASE_URL });
    expect(plan.kind).toBe("run");
    if (plan.kind !== "run") return;
    expect(plan.cmd).toContain(BRINGUP_CMD);
    expect(plan.cmd).not.toContain(FAKE_TOKEN);
    expect(plan.env).toMatchObject({ FLEET_TOKEN: FAKE_TOKEN, FLEET_GLM_BASE_URL: BASE_URL });
  });

  test("glm studio with no spawn token refuses bring-up (fail closed)", () => {
    const plan = planBringupExec({ cmd: BRINGUP_CMD, leadType: "glm", env: {}, spawnToken: null, baseUrl: BASE_URL });
    expect(plan.kind).toBe("refuse");
  });
});
