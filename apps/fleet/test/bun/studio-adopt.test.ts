import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { adoptWorktreeSessionCmd, parseSessionAdoption } from "../../src/studio/provision";

/**
 * Issue #146: the worktree-session adopt moves INTO bring-up, as
 * container/studio-adopt.sh, so it runs AFTER the session-restore untar on a
 * fresh container (the Worker's pre-bring-up adopt saw nothing there).
 *
 * Every rule below runs against BOTH implementations — the Worker's inline
 * command (old images, during the rollout) and the new script — so the two
 * cannot drift. One test per #165 verifier mutation, each named for it:
 * tie adopts; a non-resumable root counts as newest; a `startsWith(rootKey)`
 * sibling adopts; the copy keeps the old mtime; two backups kept.
 */
const SCRIPT = join(import.meta.dir, "../../container/studio-adopt.sh");
const REPO = "fleetflare";
const ROOT_KEY = "-workspace-fleetflare";
const WT_KEY = "-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1";
const SIBLING_KEY = "-workspace-fleetflare-web";
const WT_ID = "b1c006ac-dd42-48a7-a063-90400c353858";
const ROOT_ID = "0f0f0f0f-1111-4222-8333-444444444444";
const CLI = '{"type":"user","entrypoint":"cli","sessionId":"x"}\n';
const SDK = '{"type":"user","entrypoint":"sdk-cli","sessionId":"x"}\n';
const TEAMMATE = '{"type":"user","entrypoint":"cli","teamName":"crew","sessionId":"x"}\n';

// macOS has no coreutils `timeout`; a pass-through shim stands in for the
// inline command's wrapper (drops `-k N SECS`).
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
  const t = Math.floor(Date.now() / 1000) - ageSeconds;
  utimesSync(path, t, t);
  return path;
}

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

const IMPLS: { name: string; run: () => { stdout: string; stderr: string } }[] = [
  {
    // A scriptPath that cannot exist forces the inline fallback.
    name: "Worker inline command (old image)",
    run: () =>
      runSnippet({
        script: adoptWorktreeSessionCmd(REPO, log, undefined, join(home, "no-such-adopt.sh")),
        sourced: true,
        shell: "sh",
        env: { HOME: home, PATH: pathEnv },
        timeout: 30_000,
      }),
  },
  {
    name: "container/studio-adopt.sh",
    run: () => {
      const r = Bun.spawnSync({
        cmd: ["sh", SCRIPT, REPO, log],
        env: { HOME: home, PATH: pathEnv },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      });
      return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
  },
];

describe.each(IMPLS)("#146 adopt rules — $name", ({ run }) => {
  test("a worktree-only session is copied into the root key; the original is untouched", () => {
    const original = session(WT_KEY, WT_ID, CLI, 60);
    const before = statSync(original).mtimeMs;

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "adopted", sessionId: WT_ID, fromKey: WT_KEY, at: "T" });
    expect(readFileSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`), "utf8")).toBe(CLI);
    expect(readFileSync(original, "utf8")).toBe(CLI);
    expect(statSync(original).mtimeMs).toBe(before);
  });

  test("MUTATION tie-adopts: a same-second tie keeps root", () => {
    session(WT_KEY, WT_ID, CLI, 100);
    session(ROOT_KEY, ROOT_ID, CLI, 100);

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "root" });
    expect(readdirSync(projects(ROOT_KEY))).toEqual([`${ROOT_ID}.jsonl`]);
  });

  test("MUTATION non-resumable-root-counts: a NEWER sdk-cli root session does not block an older resumable worktree one", () => {
    session(WT_KEY, WT_ID, CLI, 600);
    session(ROOT_KEY, ROOT_ID, SDK, 5);

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("adopted");
    expect(existsSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`))).toBe(true);
  });

  test("MUTATION startsWith-sibling: a sibling repo's key (`<rootKey>-web`) is never adopted", () => {
    session(SIBLING_KEY, WT_ID, CLI, 5);

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "none" });
    expect(existsSync(projects(ROOT_KEY))).toBe(false);
  });

  test("MUTATION copy-keeps-mtime: the copy gets a FRESH mtime, so it is root's newest and the next run does not re-adopt", () => {
    const original = session(WT_KEY, WT_ID, CLI, 3600);

    run();
    const copy = join(projects(ROOT_KEY), `${WT_ID}.jsonl`);

    expect(statSync(copy).mtimeMs).toBeGreaterThan(statSync(original).mtimeMs + 1000);
    expect(parseSessionAdoption(run().stdout, "T")).toEqual({ outcome: "root" });
  });

  test("MUTATION two-backups: same-id collisions keep only the NEWEST .pre-adopt backup", () => {
    // An extension of the root copy (#155), so the collision is adopted.
    const wt = session(WT_KEY, WT_ID, CLI + CLI, 10);
    session(ROOT_KEY, WT_ID, CLI, 500);
    mkdirSync(projects(ROOT_KEY), { recursive: true });
    writeFileSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl.pre-adopt-1000000000`), "older backup\n");

    run();

    const backups = readdirSync(projects(ROOT_KEY)).filter((f) => f.includes(".pre-adopt-"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).not.toBe(`${WT_ID}.jsonl.pre-adopt-1000000000`);
    expect(readFileSync(join(projects(ROOT_KEY), backups[0]!), "utf8")).toBe(CLI);
    expect(readFileSync(wt, "utf8")).toBe(CLI + CLI);
  });

  test("#155 extend-only: a same-id candidate that EXTENDS the root copy is adopted", () => {
    session(ROOT_KEY, WT_ID, CLI, 500);
    session(WT_KEY, WT_ID, CLI + CLI, 10);

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T").outcome).toBe("adopted");
    expect(readFileSync(join(projects(ROOT_KEY), `${WT_ID}.jsonl`), "utf8")).toBe(CLI + CLI);
  });

  test("#155 extend-only: a stale SHORTER original is skipped — root byte-identical, one log line", () => {
    const root = session(ROOT_KEY, WT_ID, CLI + CLI, 500);
    session(WT_KEY, WT_ID, CLI, 10);

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "root" });
    expect(readFileSync(root, "utf8")).toBe(CLI + CLI);
    expect(readdirSync(projects(ROOT_KEY))).toEqual([`${WT_ID}.jsonl`]);
    expect(`${r.stdout}${r.stderr}`.match(/not a byte-extension/g)).toHaveLength(1);
    expect(readFileSync(log, "utf8")).toContain(`${WT_ID}`);
  });

  test("#155 extend-only: a DIVERGENT same-length candidate is skipped — root byte-identical, one log line", () => {
    const other = CLI.replace('"x"', '"y"');
    expect(other.length).toBe(CLI.length);
    const root = session(ROOT_KEY, WT_ID, CLI, 500);
    session(WT_KEY, WT_ID, other, 10);

    const r = run();

    expect(parseSessionAdoption(r.stdout, "T")).toEqual({ outcome: "root" });
    expect(readFileSync(root, "utf8")).toBe(CLI);
    expect(`${r.stdout}${r.stderr}`.match(/not a byte-extension/g)).toHaveLength(1);
  });

  test("a teammate session (teamName) is never adopted", () => {
    session(WT_KEY, WT_ID, TEAMMATE, 5);

    expect(parseSessionAdoption(run().stdout, "T")).toEqual({ outcome: "none" });
  });
});
