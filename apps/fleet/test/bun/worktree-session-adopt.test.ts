import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { requireTools } from "./require-tool";
import { adoptWorktreeSessionCmd, parseSessionAdoption } from "../../src/studio/provision";

// Issue #116, measured 2026-09-24 on fleetflare--web-studio: the lead had
// entered a Claude Code worktree, so claude keyed its whole transcript to
// ~/.claude/projects/-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1/.
// Bring-up's claude_has_conversation only looks under -workspace-fleetflare/,
// found nothing, and the healed lead came back blank.
//
// Measured locally with claude 2.1.281 against that real transcript: a
// SYMLINK in the root key is NOT resumed ("No conversation found to
// continue"); a COPY is — same session id, and claude then appends to the
// root-key copy, leaving the worktree original untouched. `claude -p`
// (entrypoint sdk-cli) sessions are never resumed by --continue at all.
//
// These tests run the real command in a real shell against a temp HOME.

const REPO = "fleetflare";
const ROOT_KEY = "-workspace-fleetflare";
const WT_KEY = "-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1";
const WT_ID = "b1c006ac-dd42-48a7-a063-90400c353858";
const ROOT_ID = "0f0f0f0f-1111-4222-8333-444444444444";
const OTHER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLI = '{"type":"user","entrypoint":"cli","sessionId":"x"}\n';
const SDK = '{"type":"user","entrypoint":"sdk-cli","sessionId":"x"}\n';
const TEAMMATE = '{"type":"user","entrypoint":"cli","teamName":"crew","sessionId":"x"}\n';

// macOS has no coreutils `timeout`; the container does. Where it is absent a
// pass-through shim stands in (drops `-k N SECS`), so every behaviour test
// still runs here. The kill itself is tested only against the real binary.
const HAS_TIMEOUT = Bun.spawnSync({ cmd: ["sh", "-c", "command -v timeout"] }).exitCode === 0;

let home: string;
let log: string;
let pathEnv: string;

function projects(key: string): string {
  return join(home, ".claude", "projects", key);
}

function session(key: string, id: string, body: string, ageSeconds: number): string {
  mkdirSync(projects(key), { recursive: true });
  const path = join(projects(key), `${id}.jsonl`);
  writeFileSync(path, body);
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(path, t, t);
  return path;
}

// The Worker's inline command (containers on an old image). A scriptPath
// that cannot exist forces its inline branch.
function runInline(shell: "sh" | "dash" = "sh", killAfterSeconds?: number) {
  return runSnippet({
    script: adoptWorktreeSessionCmd(REPO, log, killAfterSeconds, join(home, "no-such-adopt.sh")),
    sourced: true,
    shell,
    env: { HOME: home, PATH: pathEnv },
    timeout: 30_000,
  });
}

// #185 review: the image's container/studio-adopt.sh runs this WHOLE suite
// too — its own mutants (`ls -tr`, first key wins, any file name, `head -n
// 1`, newest file only) survived a suite that only ever ran the inline copy.
const SCRIPT = join(import.meta.dir, "../../container/studio-adopt.sh");
function runScript(shell: "sh" | "dash" = "sh") {
  const r = Bun.spawnSync({
    cmd: [shell, SCRIPT, REPO, log],
    env: { HOME: home, PATH: pathEnv },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), parentAlive: true };
}

const run = runInline;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fleet-adopt-"));
  log = join(home, "bringup.log");
  pathEnv = process.env.PATH ?? "";
  if (!HAS_TIMEOUT) {
    const bin = join(home, "shim-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift 3\nexec "$@"\n');
    chmodSync(join(bin, "timeout"), 0o755);
    pathEnv = `${bin}:${pathEnv}`;
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe.each(["inline", "script"] as const)("%s implementation", (impl) => {
  const run = (shell: "sh" | "dash" = "sh") => (impl === "inline" ? runInline(shell) : runScript(shell));

  describe("adoptWorktreeSessionCmd — a worktree-keyed session becomes resumable from the root key (issue #116)", () => {
    test("worktree-only session is COPIED into the root key, original untouched", () => {
      const original = session(WT_KEY, WT_ID, CLI, 60);

      const r = run();

      const copy = join(projects(ROOT_KEY), `${WT_ID}.jsonl`);
      expect(r.parentAlive).toBe(true);
      expect(existsSync(copy)).toBe(true);
      // A copy, never a symlink: claude does not resume a symlinked transcript.
      expect(lstatSync(copy).isSymbolicLink()).toBe(false);
      expect(readFileSync(copy, "utf8")).toBe(CLI);
      expect(readFileSync(original, "utf8")).toBe(CLI);
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({
        outcome: "adopted", sessionId: WT_ID, fromKey: WT_KEY, at: "T",
      });
    });

    test("same under dash, the container's /bin/sh", () => {
      session(WT_KEY, WT_ID, CLI, 60);
      const r = run("dash");
      expect(r.parentAlive).toBe(true);
      expect(existsSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`))).toBe(true);
      expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("adopted");
    });

    test("a NEWER root session is never clobbered and nothing is copied", () => {
      session(WT_KEY, WT_ID, CLI, 600);
      const root = session(ROOT_KEY, ROOT_ID, CLI, 5);

      const r = run();

      expect(readdirSync(projects(ROOT_KEY))).toEqual([`${ROOT_ID}.jsonl`]);
      expect(readFileSync(root, "utf8")).toBe(CLI);
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "root" });
    });

    test("no session anywhere: nothing created, launch stays fresh", () => {
      const r = run();
      expect(existsSync(projects(ROOT_KEY))).toBe(false);
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
    });

    test("a subagent transcript is never adopted — only top-level sessions count", () => {
      const sub = join(projects(WT_KEY), WT_ID, "subagents");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "agent-1.jsonl"), CLI);

      const r = run();

      expect(existsSync(projects(ROOT_KEY))).toBe(false);
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
    });

    test("idempotent: the heal after an adoption sees the root copy as newest and copies nothing again", () => {
      session(WT_KEY, WT_ID, CLI, 60);
      run();
      const second = run();
      expect(parseSessionAdoption(second.stdout, "T")).toEqual({ outcome: "root" });
      expect(readdirSync(projects(ROOT_KEY))).toEqual([`${WT_ID}.jsonl`]);
    });

    test("an OLDER same-id root copy is kept as a backup before it is replaced — never lost", () => {
      session(ROOT_KEY, WT_ID, '{"entrypoint":"cli","n":"stale"}\n', 600);
      // An extension of the root copy: #155 replaces only those.
      session(WT_KEY, WT_ID, '{"entrypoint":"cli","n":"stale"}\n' + CLI, 5);

      const r = run();

      expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("adopted");
      const files = readdirSync(projects(ROOT_KEY));
      expect(readFileSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`), "utf8")).toBe('{"entrypoint":"cli","n":"stale"}\n' + CLI);
      const backup = files.find((f) => f.startsWith(`${WT_ID}.jsonl.pre-adopt-`));
      expect(backup).toBeDefined();
      expect(readFileSync(join(projects(ROOT_KEY), backup!), "utf8")).toBe('{"entrypoint":"cli","n":"stale"}\n');
      // The backup must not end in .jsonl, or claude_has_conversation / --continue could pick it.
      expect(backup!.endsWith(".jsonl")).toBe(false);
    });

    test("the adoption is written to the bring-up log", () => {
      session(WT_KEY, WT_ID, CLI, 60);
      run();
      const text = readFileSync(log, "utf8");
      expect(text).toContain(WT_ID);
      expect(text).toContain(WT_KEY);
    });
  });

  describe("adoptWorktreeSessionCmd — worktree keys ONLY (PR #120 review)", () => {
    test("newer sibling-repo and checkout-subfolder sessions are never adopted; the lead's worktree session is, beside them", () => {
      session(WT_KEY, WT_ID, CLI, 120);
      session("-workspace-fleetflare-web", OTHER_ID, CLI, 10); // /workspace/fleetflare-web
      session("-workspace-fleetflare-apps-fleet", ROOT_ID, CLI, 5); // /workspace/fleetflare/apps/fleet

      const r = run();

      expect(parseSessionAdoption(r.stdout, "T")).toEqual({
        outcome: "adopted", sessionId: WT_ID, fromKey: WT_KEY, at: "T",
      });
      expect(readdirSync(projects(ROOT_KEY))).toEqual([`${WT_ID}.jsonl`]);
    });

    test("a sibling-repo session alone is never adopted", () => {
      session("-workspace-fleetflare-web", OTHER_ID, CLI, 10);
      session("-workspace-fleetflare-apps-fleet", ROOT_ID, CLI, 5);
      const r = run();
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
      expect(existsSync(projects(ROOT_KEY))).toBe(false);
    });
  });

  describe("adoptWorktreeSessionCmd — resumable sessions ONLY (PR #120 review)", () => {
    // claude --continue skips `claude -p` (sdk-cli) and teammate sessions.
    // Adopting one makes --continue print "No conversation found to continue"
    // and exit, and the copy stays newest, so every later heal fails too.
    test("newer sdk-cli worktree session + older cli one: the cli one is adopted", () => {
      session(WT_KEY, WT_ID, CLI, 300);
      session(WT_KEY, OTHER_ID, SDK, 10);

      const r = run();

      expect(parseSessionAdoption(r.stdout, "T")).toEqual({
        outcome: "adopted", sessionId: WT_ID, fromKey: WT_KEY, at: "T",
      });
      expect(readdirSync(projects(ROOT_KEY))).toEqual([`${WT_ID}.jsonl`]);
    });

    test("only an sdk-cli worktree session: none, nothing created", () => {
      session(WT_KEY, OTHER_ID, SDK, 10);
      const r = run();
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
      expect(existsSync(projects(ROOT_KEY))).toBe(false);
    });

    test("a teammate session (teamName) is never adopted", () => {
      session(WT_KEY, OTHER_ID, TEAMMATE, 10);
      const r = run();
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
      expect(existsSync(projects(ROOT_KEY))).toBe(false);
    });

    test("a non-UUID file name is never adopted", () => {
      session(WT_KEY, "notes", CLI, 10);
      const r = run();
      expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
    });

    test("root's newest being sdk-cli does not block: compared against root's newest RESUMABLE session", () => {
      session(ROOT_KEY, ROOT_ID, CLI, 900);
      session(ROOT_KEY, OTHER_ID, SDK, 5);
      session(WT_KEY, WT_ID, CLI, 60);

      const r = run();

      expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("adopted");
      expect(existsSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`))).toBe(true);
    });
  });

  // Verifier pins (PR #120 final pass). Each one kills a named mutant that the
  // suite above let survive: `ls -tr`, first-dir-wins, `head -n 1`, an `-ot`
  // tie, and a parser accepting any fromKey.
  describe("adoptWorktreeSessionCmd — ordering and header pins (PR #120 verifier)", () => {
    const WT2 = "-workspace-fleetflare--claude-worktrees-zeta"; // sorts AFTER WT_KEY: glob order != age order
    // claude 2.1.224's real header (production R2 tar): 3 lines with no
    // entrypoint, the first entrypoint on line 4.
    const REAL_HEAD = '{"type":"last-prompt"}\n{"type":"mode"}\n{"type":"permission-mode"}\n' + CLI;

    test("root: compared against root's NEWEST resumable session, not its oldest", () => {
      session(ROOT_KEY, ROOT_ID, CLI, 900);
      session(ROOT_KEY, OTHER_ID, CLI, 5);
      session(WT_KEY, WT_ID, CLI, 60);
      expect(parseSessionAdoption(run().stdout, "T")).toEqual({ outcome: "root" });
      expect(existsSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`))).toBe(false);
    });

    test("worktree: the NEWEST resumable session of a key is the candidate", () => {
      session(WT_KEY, ROOT_ID, CLI, 300);
      session(WT_KEY, WT_ID, CLI, 10);
      expect(parseSessionAdoption(run().stdout, "T")).toMatchObject({ outcome: "adopted", sessionId: WT_ID });
    });

    test("several worktree keys: the newest candidate across keys wins, even when its key sorts later", () => {
      session(WT_KEY, ROOT_ID, CLI, 300);
      session(WT2, WT_ID, CLI, 10);
      expect(parseSessionAdoption(run().stdout, "T")).toMatchObject({ outcome: "adopted", sessionId: WT_ID, fromKey: WT2 });
    });

    test("real claude header: entrypoint first on line 4 is still resumable", () => {
      session(WT_KEY, WT_ID, REAL_HEAD, 60);
      expect(parseSessionAdoption(run().stdout, "T")).toMatchObject({ outcome: "adopted", sessionId: WT_ID });
    });

    test("same-second tie keeps root", () => {
      const now = Math.floor(Date.now() / 1000);
      for (const [key, id] of [[ROOT_KEY, ROOT_ID], [WT_KEY, WT_ID]] as const) {
        const p = session(key, id, CLI, 0);
        utimesSync(p, now - 30, now - 30);
      }
      expect(parseSessionAdoption(run().stdout, "T")).toEqual({ outcome: "root" });
      expect(readdirSync(projects(ROOT_KEY))).toEqual([`${ROOT_ID}.jsonl`]);
    });

    test("parser: an adopted line naming a NON-worktree key is not an adoption", () => {
      const line = `FLEET_SESSION_ADOPT adopted ${WT_ID} -workspace-fleetflare-web\n`;
      expect(parseSessionAdoption(line, "T").outcome).toBe("unknown");
    });
  });

  // Issue #131: every adoption over an older same-id root file keeps a
  // `.pre-adopt-<epoch>` copy, and each is a full transcript inside the session
  // tar (64 MiB cap in archive.ts; oversize makes sync SKIP). Keep only the
  // newest per session id; never touch a `.jsonl`.
  describe("adoptWorktreeSessionCmd — pre-adopt backups are bounded (issue #131)", () => {
    test("keeps only the newest pre-adopt copy per session id; transcripts and other ids untouched", () => {
      const root = projects(ROOT_KEY);
      session(ROOT_KEY, WT_ID, '{"entrypoint":"cli","n":"stale"}\n', 600);
      writeFileSync(join(root, `${WT_ID}.jsonl.pre-adopt-1500000000`), "older backup\n");
      writeFileSync(join(root, `${WT_ID}.jsonl.pre-adopt-1600000000`), "old backup\n");
      writeFileSync(join(root, `${OTHER_ID}.jsonl.pre-adopt-1700000000`), "other session backup\n");
      session(ROOT_KEY, OTHER_ID, CLI, 900);
      session(WT_KEY, WT_ID, '{"entrypoint":"cli","n":"stale"}\n' + CLI, 5); // extends the root copy (#155)

      const r = run();

      expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("adopted");
      const files = readdirSync(root).sort();
      const mine = files.filter((f) => f.startsWith(`${WT_ID}.jsonl.pre-adopt-`));
      expect(mine).toHaveLength(1);
      // The survivor is THIS adoption's backup — the stale root copy it replaced.
      expect(readFileSync(join(root, mine[0]), "utf8")).toBe('{"entrypoint":"cli","n":"stale"}\n');
      expect(files).toContain(`${OTHER_ID}.jsonl.pre-adopt-1700000000`);
      expect(files).toContain(`${WT_ID}.jsonl`);
      expect(files).toContain(`${OTHER_ID}.jsonl`);
    });
  });
});

// The Worker command's own kill wrapper: inline only (the script is bounded by its callers).
//
// Issue #369 round 2 (maestro review): `test.skipIf(!HAS_TIMEOUT)` looked
// identical whether a dev machine lacked `timeout` or the pinned localci
// image itself regressed. This test needs the REAL binary's kill-at-deadline
// semantics specifically (unlike beforeEach's pass-through shim, used
// elsewhere in this file just so inline command construction can run at
// all), so it gates on `requireTools` rather than the shared `HAS_TIMEOUT`.
const HUNG_STEP_KILL = requireTools("timeout", "adopt hung-step kill (needs a real timeout binary, not the beforeEach shim)");
HUNG_STEP_KILL("adoptWorktreeSessionCmd — a hung step is killed in the container (PR #120 review)", () => {
  test("a candidate that blocks forever is killed at the deadline and reports no adoption", () => {
    mkdirSync(projects(WT_KEY), { recursive: true });
    // A FIFO with no writer: `head` on it blocks forever.
    Bun.spawnSync({ cmd: ["mkfifo", join(projects(WT_KEY), `${WT_ID}.jsonl`)] });

    const started = Date.now();
    const r = run("sh", 1);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(8_000);
    expect(r.parentAlive).toBe(true);
    expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("unknown");
    expect(existsSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`))).toBe(false);
  });
});

test("the command is wrapped in a real in-container kill: timeout -k 2 15 (image script, or sh -c inline)", () => {
  expect(adoptWorktreeSessionCmd(REPO)).toContain("then timeout -k 2 15 /opt/fleet/studio-adopt.sh ");
  expect(adoptWorktreeSessionCmd(REPO)).toContain("; else timeout -k 2 15 sh -c ");
});

