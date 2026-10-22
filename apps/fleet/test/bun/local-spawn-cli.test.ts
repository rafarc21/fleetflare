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
// #1259 round 4 fix 4: overrides the stub's default 200-ok answer for the
// flip-back-to-stopped POST a refused local resume makes — undefined means
// the default success response below (every ordinary refusal test's flip-
// back succeeds silently, unchanged from before this override existed); set
// by the one test that needs the flip-back itself to FAIL.
let destroyAnswer: (() => Response) | undefined;
// #1259 round 4 fix 4: overrides for the /provision stub's prompt and
// allowedTools fields — undefined means the normal non-empty values below,
// so every existing test is unaffected; set by the tests proving the
// "no prompt/allowedTools" refusal flips the row back too.
let provisionPromptOverride: string | undefined;
let provisionAllowedToolsOverride: string | undefined;
// #1259 round 5 minor fix: when set, the /provision stub answers a body that
// fails `parseStudioStatus` (an invalid `state`) while still carrying
// `host: "local"` -- the exact shape the "answered 200 but not a studio row"
// exit's own new host-aware flip-back targets.
let provisionMalformedHostLocal = false;

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
        if (provisionMalformedHostLocal) {
          // Invalid `state` -> parseStudioStatus returns null -> the "not a
          // studio row" exit -- but `host: "local"` is still right there.
          return Response.json({ id: "websites--release", state: "not-a-real-state", error: null, host: "local" });
        }
        return Response.json({
          id: "websites--release", state: "running", error: null, repoSlug: "acme/faux",
          tailscaleHost: null, lastRefresh: null,
          host: "local", localPath: provisionLocalPath ?? repo,
          prompt: provisionPromptOverride ?? "You are release. Merge carefully.",
          allowedTools: provisionAllowedToolsOverride ?? "Bash(git *) Edit",
          effort: "",
        });
      }
      if (url.pathname === "/studio/websites--release/destroy" && req.method === "POST") {
        return destroyAnswer ? destroyAnswer() : Response.json({ id: "websites--release", state: "stopped" });
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

/** `traffic` accumulates for the whole file's lifetime (never reset between
 *  tests), so every flip-back-assertion below diffs a BEFORE/AFTER count
 *  rather than asserting an absolute one — the same delta discipline the
 *  `/studio/local/spawn` assertions above already use. */
function countDestroyCalls(): number {
  return traffic.filter((t) => t.method === "POST" && t.path === "/studio/websites--release/destroy").length;
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
    // exit non-zero — proving it fired (the cloud path would have printed the
    // row and exited 0).
    const destroyBefore = countDestroyCalls();
    const r = await runFleetLocal(["provision", "websites--release"]);
    expect(r.code).toBe(1);
    // #1259 round 5 minor fix: "skipped" (not under Orca) is nothing the row
    // itself needs TORN DOWN for — the flip-back right below already returns
    // it to stopped, so the real remedy is running under Orca and retrying.
    expect(r.err).toContain("run under Orca, then re-run: fleet provision websites--release");
    expect(r.err).not.toContain("fleet destroy websites--release");
    // #1259 round 4 fix 4: the "no local lead" exit (ensureLocalStudioWorktree
    // skipped/failed) must flip the row it just POSTed "running" back to
    // stopped too, same as the origin-mismatch exit already did — else a
    // resume attempt that hits "no orca" leaves the row stuck "running"
    // with no lead process behind it, forever (routes.ts's own `/provision`
    // refuses a non-stopped local row with a 409, so the operator's very
    // next retry would be blocked).
    expect(countDestroyCalls() - destroyBefore).toBe(1);
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
    const destroyBefore = countDestroyCalls();
    try {
      execFileSync("git", ["init", "-q"], { cwd: gitlabRepo });
      execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/acme/faux.git"], { cwd: gitlabRepo });
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: gitlabRepo });

      const r = await runFleetLocal(["provision", "websites--release"], { ORCA_CLI_COMMAND: fakeOrca });
      expect(r.code).toBe(1);
      expect(r.err).toContain("no GitHub origin");
      // Fix 3 (#1259 round 3): `fleet provision` takes no `--path` flag — the
      // old message's hint was bogus.
      expect(r.err).not.toContain("pass --path");
      // #1259 round 4 fix 4: the old hint chained "destroy this row and
      // fleet spawn --local" — but `fleet destroy`'s default KEEPS the row
      // (round 3's own finding), so a respawn with the SAME id would 409
      // "studio exists" (src/studio/spawn.ts). The real remedy is simply
      // fixing the clone's origin and re-running `fleet provision`, which
      // the flip-back below makes possible again (routes.ts's `/provision`
      // only resumes a `stopped` local row).
      expect(r.err).not.toContain("fleet spawn --local");
      expect(r.err).toContain("fleet provision websites--release");
      // The POST already flipped this row to "running" before this refusal
      // could run (the bound repoSlug it needs only arrives IN that POST's
      // response) — the refusal must flip it back with the SAME /destroy
      // route a local row's own teardown uses, or the row sits stuck
      // "running" with no lead process behind it.
      expect(countDestroyCalls() - destroyBefore).toBe(1);
    } finally {
      provisionLocalPath = undefined;
      rmSync(gitlabRepo, { recursive: true, force: true });
    }
  }, 40_000);

  // Fix 4 mutant 1 (#1259 round 3): a mutant that weakens the origin check to
  // `cloneSlug === null` alone (dropping the slug-equality half) would accept
  // ANY valid GitHub origin, not just the repo the studio is bound to. The
  // gitlab test above only proves the null-origin half; this proves the
  // other half — a clone with a VALID, but WRONG, GitHub origin must still
  // refuse.
  test("a local row whose clone has a VALID but WRONG GitHub origin still refuses (item 7)", async () => {
    const wrongRepo = mkdtempSync(join(tmpdir(), "local-provision-wrong-origin-"));
    const fakeOrca = join(home, "orca-provision-wrong");
    writeFileSync(fakeOrca, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeOrca, 0o755);
    provisionLocalPath = wrongRepo;
    try {
      execFileSync("git", ["init", "-q"], { cwd: wrongRepo });
      // A real, resolvable GitHub origin — just not acme/faux, the repo
      // the stub binds "websites--release" to.
      execFileSync("git", ["remote", "add", "origin", "https://github.com/other-org/other-repo.git"], { cwd: wrongRepo });
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: wrongRepo });

      const r = await runFleetLocal(["provision", "websites--release"], { ORCA_CLI_COMMAND: fakeOrca });
      expect(r.code).toBe(1);
      expect(r.err).toContain("other-org/other-repo");
      expect(r.err).toContain("not acme/faux");
      expect(r.err).not.toContain("no GitHub origin");
    } finally {
      provisionLocalPath = undefined;
      rmSync(wrongRepo, { recursive: true, force: true });
    }
  }, 40_000);

  // #1259 round 4 fix 4: the 3 other refusal exits in this SAME local-resume
  // branch — "no localPath", "no prompt/allowedTools", "could not resolve
  // the default branch" — run on the exact same already-flipped-to-running
  // row the origin check above does, and must flip it back too.
  test("a local row answering without a localPath flips the row back to stopped (#1259 round 4 fix 4)", async () => {
    provisionLocalPath = ""; // typeof check passes ("" is a string); the === "" guard is what this test is for
    const destroyBefore = countDestroyCalls();
    try {
      const r = await runFleetLocal(["provision", "websites--release"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("without a localPath");
      expect(countDestroyCalls() - destroyBefore).toBe(1);
    } finally {
      provisionLocalPath = undefined;
    }
  }, 40_000);

  test("a local row answering without prompt/allowedTools flips the row back to stopped (#1259 round 4 fix 4)", async () => {
    provisionPromptOverride = "";
    const destroyBefore = countDestroyCalls();
    try {
      const r = await runFleetLocal(["provision", "websites--release"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("without prompt/allowedTools");
      expect(countDestroyCalls() - destroyBefore).toBe(1);
    } finally {
      provisionPromptOverride = undefined;
    }
  }, 40_000);

  test("a local row whose clone's default branch cannot be resolved flips the row back to stopped (#1259 round 4 fix 4)", async () => {
    // A real git repo with no `origin/HEAD` symbolic-ref at all (unlike every
    // other test's clone fixtures above) — resolveDefaultBranch has nothing
    // to resolve.
    const noBranchRepo = mkdtempSync(join(tmpdir(), "local-provision-no-branch-"));
    execFileSync("git", ["init", "-q"], { cwd: noBranchRepo });
    provisionLocalPath = noBranchRepo;
    const destroyBefore = countDestroyCalls();
    try {
      const r = await runFleetLocal(["provision", "websites--release"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("could not resolve the default branch");
      expect(countDestroyCalls() - destroyBefore).toBe(1);
    } finally {
      provisionLocalPath = undefined;
      rmSync(noBranchRepo, { recursive: true, force: true });
    }
  }, 40_000);

  // Fix 4 (#1259 round 4): `res.ok` on the flip-back POST is now checked —
  // a flip-back that itself fails must say so distinctly, never be silently
  // assumed to have worked.
  test("a flip-back POST that itself fails is reported distinctly, never silently assumed to have worked (#1259 round 4 fix 4)", async () => {
    // No orca binary, TERM_PROGRAM=not-orca (the default): hits the "no
    // local lead" exit — any of the 5 flip-back sites shares the same
    // helper, so this one case proves `res.ok` is honored for all of them.
    destroyAnswer = () => new Response("destroy route unavailable", { status: 500 });
    try {
      const r = await runFleetLocal(["provision", "websites--release"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("has no local lead"); // the actual refusal still ran first
      expect(r.err).toContain("could not be flipped back to stopped");
      expect(r.err).toContain("500");
    } finally {
      destroyAnswer = undefined;
    }
  }, 40_000);

  // #1259 round 5 minor fix: the "answered 200 but the body was not a studio
  // row" exit runs BEFORE `studio.host` is otherwise known (that early --
  // `parseStudioStatus` itself just failed) -- but the raw body can still
  // carry `host: "local"` even on an otherwise-malformed row, and when it
  // does, flipping back is provably safe (the SAME synchronous D1 flip a
  // local row's own teardown already uses, no container checks either way).
  test("the 'not a studio row' exit still flips back when the malformed body's own host says local (#1259 round 5 minor fix)", async () => {
    provisionMalformedHostLocal = true;
    const destroyBefore = countDestroyCalls();
    try {
      const r = await runFleetLocal(["provision", "websites--release"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("answered 200 but the body was not a studio row");
      expect(countDestroyCalls() - destroyBefore).toBe(1);
    } finally {
      provisionMalformedHostLocal = false;
    }
  }, 40_000);

  // Fix 2 (#1259 round 3) widened ensureLocalStudioWorktree's resume-reuse
  // branch to return `{ kind: "exists" }` when a healthy attach terminal is
  // already live — cmdProvision's own fatal check must treat that the SAME
  // as "created", or every real resume of a studio whose terminal survived
  // `fleet destroy`'s default keep-path would now wrongly exit 1 and tell
  // the operator to tear the row down, even though the lead is still alive.
  //
  // #1259 round 5: the reuse decision now asks the OS directly
  // (`isClaudeForeground`: tty -> `ps` -> `ps`, see `defaultIsClaudeForeground`'s
  // own doc comment), not the terminal's title — and this test's own
  // subprocess boundary cannot fake that OS answer (there is no injection
  // point across a real `Bun.spawn`, by design: production code always asks
  // the real OS, never a test double). `wtPath` below has no `.fleet/lead.tty`
  // (nothing ever wrote one in this test), so the real check fails closed to
  // "not foreground," and the resume now re-materializes a fresh terminal
  // (closing the stale-looking one first) rather than reusing it — `kind:
  // "created"`, not `kind: "exists"`. What this test still proves, and what
  // it is actually FOR: `cmdProvision`'s fatal check treats that outcome as
  // success too (exit 0, never the destroy hint), exactly like a brand-new
  // studio's first-ever provision.
  test("a resume whose worktree already has an attach terminal still succeeds end to end, never told to destroy (item 7)", async () => {
    // `existing.path` (the WORKTREE on disk, where the lead's project-scoped
    // files land) must be a REAL writable directory — materializeLocalLead
    // runs on it before the health check this test is actually about.
    const wtRoot = mkdtempSync(join(tmpdir(), "orca-resume-exists-wt-"));
    const wtPath = join(wtRoot, "studio-websites-release");
    mkdirSync(wtPath, { recursive: true });
    const fakeOrca = join(home, "orca-resume-exists");
    const logFile = join(home, "orca-resume-exists.log");
    writeFileSync(fakeOrca, [
      "#!/bin/sh",
      `echo "$@" >> "${logFile}"`,
      'case "$1:$2" in',
      "  worktree:list)",
      `    echo '{"ok":true,"result":{"worktrees":[{"id":"repo-websites::/w/studio-websites-release","displayName":"studio-websites--release","path":"${wtPath}"}]}}'`,
      "    ;;",
      "  terminal:list)",
      '    echo \'{"ok":true,"result":{"terminals":[{"handle":"term_live","title":"websites--release","connected":true,"orphaned":false,"writable":true}]}}\'',
      "    ;;",
      "  *)",
      "    echo '{}'",
      "    ;;",
      "esac",
    ].join("\n"));
    chmodSync(fakeOrca, 0o755);
    try {
      const r = await runFleetLocal(["provision", "websites--release"], { ORCA_CLI_COMMAND: fakeOrca, TERM_PROGRAM: "Orca" });
      expect(r.code).toBe(0);
      expect(r.err).not.toContain("fleet destroy websites--release");
    } finally {
      rmSync(logFile, { force: true });
      rmSync(wtRoot, { recursive: true, force: true });
    }
  }, 40_000);
});