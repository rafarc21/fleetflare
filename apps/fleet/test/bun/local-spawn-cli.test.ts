// `fleet spawn --local` / `ff --local` must NOT report success when the local
// lead's Orca worktree never materialized — fleet task #1248 (finding T1b).
// ensureLocalStudioWorktree is best-effort (never throws), so spawnLocalStudio
// used to ignore its outcome and proceed to a "success" handoff even when the
// worktree was skipped (no orca binary) or failed. A local studio IS its Orca
// worktree — a row registered with no lead running is exactly the false "up"
// the row exists to prevent.
//
// bun:test lane: a real subprocess of cli/fleet.ts / cli/ff.ts against a stub
// Worker, in an environment with NO orca binary and TERM_PROGRAM=not-orca, so
// ensureLocalStudioWorktree returns { kind: "skipped" } (no binary). The stub
// records every request, so "exits non-zero after the spawn" is asserted on
// traffic, not on the absence of output.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FLEET = join(import.meta.dir, "../../cli/fleet.ts");
const FF = join(import.meta.dir, "../../cli/ff.ts");

const traffic: { method: string; path: string; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;
let repo: string;
// The local row the stub answers POST /studio/websites--release/provision
// with. `localPath` is swapped by the gitlab-origin test before it runs.
let provisionLocalPath: string | undefined;

// The spawn row the stub answers POST /studio/local/spawn with — the three
// fields parseStudioStatus demands (id/state/error) plus repoSlug, and the
// bring-up env (prompt/allowedTools) spawnLocalStudio requires to proceed.
const SPAWNED = {
  id: "faux--pilot", state: "running", error: null, repoSlug: "acme/faux",
  tailscaleHost: null, lastRefresh: null,
  prompt: "You are pilot. Work carefully.", allowedTools: "Bash(git *)",
  effort: "",
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      traffic.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/studio/local/spawn" && req.method === "POST") {
        return Response.json(SPAWNED);
      }
      if (url.pathname === "/studio/websites--release/provision" && req.method === "POST") {
        return Response.json({
          id: "websites--release", state: "running", error: null, repoSlug: "acme/faux",
          tailscaleHost: null, lastRefresh: null,
          host: "local", localPath: provisionLocalPath ?? repo,
          prompt: "You are release. Merge carefully.", allowedTools: "Bash(git *) Edit",
          effort: "",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  home = mkdtempSync(join(tmpdir(), "local-spawn-home-"));
  mkdirSync(join(home, ".fleet"));
  writeCredentials(join(home, ".fleet", "credentials"), `http://127.0.0.1:${server.port}`);
  repo = mkdtempSync(join(tmpdir(), "local-spawn-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/faux.git"], { cwd: repo });
  // resolveDefaultBranch's symbolic-ref path: a clone with origin/HEAD set, so
  // the command reaches ensureLocalStudioWorktree instead of refusing earlier.
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: repo });
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
});

function writeCredentials(path: string, workerUrl: string) {
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "id", accessClientSecret: "s" }));
  chmodSync(path, 0o600);
}

async function runFleetLocal(args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    cwd: repo,
    env: { PATH: process.env.PATH!, HOME: home, TERM_PROGRAM: "not-orca", ...extraEnv },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { out, err, code };
}

async function runFfLocal(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FF, ...args],
    cwd: repo,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_"))),
      HOME: home, TERM_PROGRAM: "not-orca",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(killer);
  return { out, err, code };
}

describe("fleet spawn --local — no orca binary (T1b)", () => {
  test("exits non-zero and names the failure instead of reporting the row as up", async () => {
    // --path names the REAL clone now (B4 reads the default branch and origin
    // from it), so the dummy /abs/clone path of the pre-B4 test is gone.
    const r = await runFleetLocal(["spawn", "pilot", "--local", "--path", repo]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet destroy faux--pilot");
  }, 40_000);
});

describe("fleet spawn --local — orca binary present, non-Orca terminal (T1.1)", () => {
  test("exits non-zero even though the orca binary resolves (the worktree is still skipped)", async () => {
    // A real `orca` binary on PATH in a plain terminal (iTerm/SSH) is exactly
    // the false-"running" case T1.1 closes: ensureLocalStudioWorktree returns
    // { kind: "skipped" } because TERM_PROGRAM is not Orca, and the old fatal
    // condition only treated a skip as fatal when hasBinary() was null. Fake
    // the binary with an absolute path — Bun.which resolves an absolute path
    // that names an executable file, so the old code saw `hasBinary() !==
    // null` and let the skipped outcome through as a success.
    const fakeOrca = join(home, "orca");
    writeFileSync(fakeOrca, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeOrca, 0o755);

    const r = await runFleetLocal(
      ["spawn", "pilot", "--local", "--path", repo],
      { ORCA_CLI_COMMAND: fakeOrca },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet destroy faux--pilot");
  }, 40_000);
});

describe("ff --local — no orca binary (T1b)", () => {
  test("exits non-zero and never claims the lead runs in an Orca terminal", async () => {
    const r = await runFfLocal(["pilot", "--local"]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("lead runs in the Orca terminal");
  }, 40_000);
});

describe("fleet spawn --local — clone with no GitHub origin refuses (item 4)", () => {
  test("exits non-zero and never posts /studio/local/spawn when the clone origin is gitlab", async () => {
    const gitlabRepo = mkdtempSync(join(tmpdir(), "local-spawn-gitlab-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: gitlabRepo });
      execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/acme/faux.git"], { cwd: gitlabRepo });
      // A resolvable default branch, so the command reaches the ORIGIN check
      // rather than refusing earlier on an unresolved default branch.
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: gitlabRepo });

      const before = traffic.filter((t) => t.path === "/studio/local/spawn").length;
      const proc = Bun.spawn({
        cmd: [process.execPath, FLEET, "spawn", "pilot", "--local", "--path", gitlabRepo],
        cwd: repo,
        env: { PATH: process.env.PATH!, HOME: home, TERM_PROGRAM: "not-orca" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const killer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      clearTimeout(killer);

      expect(code).toBe(1);
      expect(err).toContain("no GitHub origin");
      expect(traffic.filter((t) => t.path === "/studio/local/spawn").length).toBe(before);
      expect(out).toBe("");
    } finally {
      rmSync(gitlabRepo, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("fleet provision — stopped local row re-materializes (item 7)", () => {
  test("detects the local row and re-materializes instead of treating it as a cloud row", async () => {
    // Bodyless provision: the cwd repo (acme/faux) disagrees with the id's
    // repo segment (websites), so cmdProvision sends {} and the stub answers a
    // local-shaped bring-up response. No orca binary + TERM_PROGRAM=not-orca
    // means ensureLocalStudioWorktree returns skipped, so the local branch must
    // exit non-zero naming fleet destroy — proving it fired (the cloud path
    // would have printed the row and exited 0).
    const r = await runFleetLocal(["provision", "websites--release"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("fleet destroy websites--release");
  }, 40_000);

  test("a local row whose clone has a non-GitHub origin refuses before any worktree materialization (item 7)", async () => {
    // The stub's local response points localPath at a gitlab clone. The local
    // branch must refuse (exit 1, "no GitHub origin") BEFORE ensureLocalStudioWorktree
    // runs — with a fake orca binary present, a bug that skipped the origin
    // check would reach the worktree materialization instead.
    const gitlabRepo = mkdtempSync(join(tmpdir(), "local-provision-gitlab-"));
    const fakeOrca = join(home, "orca-provision");
    writeFileSync(fakeOrca, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeOrca, 0o755);
    provisionLocalPath = gitlabRepo;
    try {
      execFileSync("git", ["init", "-q"], { cwd: gitlabRepo });
      execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/acme/faux.git"], { cwd: gitlabRepo });
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: gitlabRepo });

      const r = await runFleetLocal(["provision", "websites--release"], { ORCA_CLI_COMMAND: fakeOrca });
      expect(r.code).toBe(1);
      expect(r.err).toContain("no GitHub origin");
    } finally {
      provisionLocalPath = undefined;
      rmSync(gitlabRepo, { recursive: true, force: true });
    }
  }, 40_000);
});