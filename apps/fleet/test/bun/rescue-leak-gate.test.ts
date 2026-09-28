import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { studioGitSafetyCmd } from "../../src/studio/credentials";
import { denylistFileContent, leakScanScript } from "../../src/leak-gate";
import { withKillDeadline } from "../../src/studio/exec-deadline";
import { rescuePushCmd, rescueSnapshotCmd, RESCUE_FAILED_PREFIX, RESCUE_PUSHED_PREFIX } from "../../src/studio/rescue";

/**
 * Issue #1, maestro review blocker 2: with no private rescue remote
 * (FLEET_RESCUE_REMOTE unset, malformed, or its token mint failed) rescue
 * pushes go to ORIGIN, which can be public. That fallback must pass the leak
 * gate: plain `git` on PATH, i.e. the installed wrapper. Only a push to the
 * private remote (`remoteUrl` set) runs the real git past it.
 *
 * Same fixture shape as git-wrapper.test.ts: wrapper installed by the exact
 * studioGitSafetyCmd() string into a temp bin/ that is first on PATH, its own
 * HOME/gitconfig, its own scanner and gate file. The machine's git is never
 * touched.
 */
const REAL_GIT = Bun.which("git", { PATH: process.env.PATH });
const TIMEOUT_BIN = Bun.which("timeout") ?? Bun.which("gtimeout");
const LANE = REAL_GIT !== null && TIMEOUT_BIN !== null && !process.env.TMUX ? describe : describe.skip;

const TIMEOUT_SHIM_DIR = ((): string | null => {
  if (TIMEOUT_BIN === null || basename(TIMEOUT_BIN) === "timeout") return null;
  const d = mkdtempSync(join(tmpdir(), "fleet-timeout-shim-"));
  writeFileSync(join(d, "timeout"), `#!/bin/sh\nexec '${TIMEOUT_BIN}' "$@"\n`);
  chmodSync(join(d, "timeout"), 0o755);
  return d;
})();

const REPO = "fleetflare";
const STUDIO = "fleetflare--pilot";
const TERM = "acmeclient-secret-codename";

interface Fx { root: string; ws: string; clone: string; origin: string; priv: string; gate: string; env: Record<string, string> }
let fx: Fx | null = null;
afterEach(() => {
  if (fx) rmSync(fx.root, { recursive: true, force: true });
  fx = null;
});

function run(cmd: string[], cwd: string, env: Record<string, string>): { code: number; out: string; err: string } {
  const r = Bun.spawnSync({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function rg(f: Fx, args: string[], cwd = f.clone): string {
  const r = run([REAL_GIT as string, ...args], cwd, f.env);
  if (r.code !== 0) throw new Error(`fixture step \`git ${args.join(" ")}\` failed (${r.code}): ${r.err}`);
  return r.out;
}

function refs(f: Fx, repo: string): string[] {
  return rg(f, ["for-each-ref", "--format=%(refname)", "refs/heads/"], repo).split("\n").filter(Boolean);
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "fleet-rescue-leak-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const ws = join(root, "ws");
  for (const d of [home, bin, ws]) mkdirSync(d, { recursive: true });
  const f: Fx = {
    root, ws, clone: join(ws, REPO), origin: join(root, "origin.git"), priv: join(root, "private.git"),
    gate: join(root, "denylist"),
    env: {
      ...process.env as Record<string, string>,
      HOME: home,
      PATH: `${bin}:${TIMEOUT_SHIM_DIR ? `${TIMEOUT_SHIM_DIR}:` : ""}${process.env.PATH ?? ""}`,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "fleet-test", GIT_AUTHOR_EMAIL: "fleet-test@example.com",
      GIT_COMMITTER_NAME: "fleet-test", GIT_COMMITTER_EMAIL: "fleet-test@example.com",
    },
  };
  fx = f;
  const scan = join(root, "fleet-leak-scan");
  writeFileSync(scan, leakScanScript(f.gate));
  chmodSync(scan, 0o755);
  writeFileSync(f.gate, denylistFileContent({ patterns: [TERM] }));

  rg(f, ["init", "-q", "--bare", "-b", "main", f.origin], root);
  rg(f, ["init", "-q", "--bare", "-b", "main", f.priv], root);
  rg(f, ["clone", "-q", f.origin, f.clone], root);
  writeFileSync(join(f.clone, "README.md"), "seed\n");
  rg(f, ["add", "-A"]);
  rg(f, ["commit", "-q", "-m", "seed"]);
  rg(f, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  rg(f, ["remote", "set-head", "origin", "main"]);

  const install = studioGitSafetyCmd({ wrapperPath: join(bin, "git"), realGit: REAL_GIT as string, scanPath: scan });
  const r = run(["bash", "-c", withKillDeadline(install, 30_000)], f.clone, f.env);
  if (r.code !== 0) throw new Error(`wrapper install failed (${r.code}): ${r.err}${r.out}`);
  return f;
}

type Builder = typeof rescuePushCmd;
const BUILDERS: [string, Builder][] = [["rescuePushCmd", rescuePushCmd], ["rescueSnapshotCmd", rescueSnapshotCmd]];

function rescue(f: Fx, build: Builder, opts: { remoteUrl?: string; realGit?: string } = {}): string {
  const r = run(["bash", "-c", build(REPO, STUDIO, f.ws, undefined, undefined, undefined, undefined, undefined, opts)], f.root, f.env);
  return r.out;
}

LANE("issue #1 blocker 2 — rescue fallback to origin is leak-gated", () => {
  for (const [label, build] of BUILDERS) {
    test(`${label}, remote unset, dirty file holds a denylist term: RESCUE_FAILED, origin gets no rescue ref`, () => {
      const f = setup();
      writeFileSync(join(f.clone, "notes.md"), `work mentioning ${TERM}\n`);

      const out = rescue(f, build);

      expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
      expect(out).not.toContain(RESCUE_PUSHED_PREFIX);
      expect(refs(f, f.origin)).toEqual(["refs/heads/main"]);
    });

    test(`${label}, remote unset, gate file missing: refused, origin gets no rescue ref`, () => {
      const f = setup();
      rmSync(f.gate);
      writeFileSync(join(f.clone, "notes.md"), "harmless work\n");

      const out = rescue(f, build);

      expect(out).toMatch(new RegExp(`^${RESCUE_FAILED_PREFIX} checkout push$`, "m"));
      expect(refs(f, f.origin)).toEqual(["refs/heads/main"]);
    });

    test(`${label}, remote unset, clean content: lands on origin through the wrapper`, () => {
      const f = setup();
      writeFileSync(join(f.clone, "notes.md"), "harmless work\n");

      const out = rescue(f, build);

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
      expect(refs(f, f.origin).some((r) => r.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`))).toBe(true);
    });

    test(`${label}, remote unset: a realGit option is ignored — origin push still goes through the wrapper`, () => {
      const f = setup();
      writeFileSync(join(f.clone, "notes.md"), `work mentioning ${TERM}\n`);

      const out = rescue(f, build, { realGit: REAL_GIT as string });

      expect(out).toContain(`${RESCUE_FAILED_PREFIX} checkout push`);
      expect(refs(f, f.origin)).toEqual(["refs/heads/main"]);
    });

    test(`${label}, private remote set: term still lands there via real git (never lost)`, () => {
      const f = setup();
      writeFileSync(join(f.clone, "notes.md"), `work mentioning ${TERM}\n`);

      const out = rescue(f, build, { remoteUrl: f.priv, realGit: REAL_GIT as string });

      expect(out).not.toContain(RESCUE_FAILED_PREFIX);
      expect(out).toMatch(new RegExp(`^${RESCUE_PUSHED_PREFIX} fleet/rescue/${STUDIO}-\\d{14} 1 files$`, "m"));
      expect(refs(f, f.priv).some((r) => r.startsWith(`refs/heads/fleet/rescue/${STUDIO}-`))).toBe(true);
      expect(refs(f, f.origin)).toEqual(["refs/heads/main"]);
    });
  }
});
