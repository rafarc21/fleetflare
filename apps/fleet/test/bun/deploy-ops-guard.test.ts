import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Issue #365: scripts/deploy.sh runs wrangler against the operator's REAL
 * config from a local checkout of the private ops repo. 2026-09-26 an agent
 * overwrote that checkout's fleet/wrangler.jsonc with the example
 * (uncommitted); the next deploy would have shipped it. deploy.sh now
 * refuses a dirty or not-current ops checkout for every subcommand that
 * changes remote state. Each test runs a COPY of deploy.sh in a temp tree
 * (so wrangler.local.jsonc never lands in this repo), a stub `wrangler` on
 * PATH, and throwaway git repos — never a real ops clone.
 */
const DEPLOY_SH = resolve(import.meta.dir, "../../scripts/deploy.sh");
const GIT_ID = ["-c", "user.email=t@e.com", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const CONFIG = '{ "name": "fleet-test" }\n';

let root: string;
let fleet: string;
let ops: string;
let origin: string;
let calls: string;

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...GIT_ID, ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-ops-"));
  fleet = join(root, "fleet-app");
  mkdirSync(join(fleet, "scripts"), { recursive: true });
  copyFileSync(DEPLOY_SH, join(fleet, "scripts", "deploy.sh"));
  calls = join(root, "wrangler.calls");
  // Issue #379: deploy.sh runs the repo's OWN pinned wrangler
  // (node_modules/.bin), so the stub lives there. A decoy on PATH records a
  // different line: it must never run.
  const local = join(fleet, "node_modules", ".bin");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, "wrangler"), `#!/bin/sh\necho "wrangler $*" >> "${calls}"\n`);
  chmodSync(join(local, "wrangler"), 0o755);
  setWranglerVersions("4.141.0", "4.141.0");
  // Issue #20: deploy.sh runs `bun cli/fleet.ts rescue-all` before a deploy.
  // A passing stub: this suite is about the ops guard only
  // (deploy-rescue-gate.test.ts covers the rescue gate).
  mkdirSync(join(fleet, "cli"));
  writeFileSync(join(fleet, "cli", "fleet.ts"), "process.exit(0);\n");
  // Issue #36: and scripts/deploy-target.ts before that. Same passing stub.
  writeFileSync(join(fleet, "scripts", "deploy-target.ts"), "process.exit(0);\n");
  // Issue #204: and scripts/deploy-env-guard.ts before that. Same passing
  // stub: this suite is about the ops-checkout dirty guard, not the dotenv
  // guard.
  writeFileSync(join(fleet, "scripts", "deploy-env-guard.ts"), "process.exit(0);\n");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "wrangler"), `#!/bin/sh\necho "PATH-wrangler $*" >> "${calls}"\n`);
  chmodSync(join(bin, "wrangler"), 0o755);
  // The ops repo: a bare origin and the operator's clone of it.
  //
  // Issue #126: /usr/local/bin/git refuses any push that would MOVE a
  // remote's resolved default branch (#253) -- it can't tell this bare repo
  // is a throwaway fixture, not the studio's real GitHub remote. Naming the
  // default branch "main" broke every push after the first (the wrapper
  // treats an unborn/nonexistent ref as "unknown" and lets it through once,
  // then refuses every later move once it can resolve "main" as the
  // default). The fix: the default branch ("unused-default") gets exactly
  // ONE commit here and is never pushed to again; every push this suite
  // actually exercises moves a different branch ("trunk"), which is never
  // the resolved default, so the wrapper never refuses it.
  origin = join(root, "ops.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "unused-default", origin]);
  const seedDefault = join(root, "seed-default");
  mkdirSync(seedDefault, { recursive: true });
  git(root, "init", "-q", "-b", "unused-default", seedDefault);
  git(seedDefault, "commit", "-q", "--allow-empty", "-m", "unused default branch seed");
  git(seedDefault, "push", "-q", origin, "unused-default");
  const seed = join(root, "seed");
  mkdirSync(join(seed, "fleet"), { recursive: true });
  git(root, "init", "-q", "-b", "trunk", seed);
  writeFileSync(join(seed, "fleet", "wrangler.jsonc"), CONFIG);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "ops");
  git(seed, "push", "-q", origin, "trunk");
  ops = join(root, "ops");
  git(root, "clone", "-q", "--branch", "trunk", origin, ops);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Issue #379 round 2: the installed node_modules/wrangler version and the
 *  bun.lock pin deploy.sh compares it against. `null` = absent. */
function setWranglerVersions(installed: string | null, locked: string | null) {
  const pkg = join(fleet, "node_modules", "wrangler", "package.json");
  rmSync(pkg, { force: true });
  if (installed !== null) {
    mkdirSync(join(fleet, "node_modules", "wrangler"), { recursive: true });
    writeFileSync(pkg, JSON.stringify({ name: "wrangler", version: installed }));
  }
  const lock = join(fleet, "bun.lock");
  rmSync(lock, { force: true });
  if (locked !== null) {
    writeFileSync(lock, [
      "{",
      '  "packages": {',
      '    "@cloudflare/vitest-pool-workers/wrangler": ["wrangler@4.116.0", "", {}, "sha512-y"],',
      `    "wrangler": ["wrangler@${locked}", "", {}, "sha512-x"],`,
      "  }",
      "}",
      "",
    ].join("\n"));
  }
}

function deploy(args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", join(fleet, "scripts", "deploy.sh"), ...args], {
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FLEET_OPS_DIR: ops, ...env },
  });
  const ran = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return { code: r.exitCode, err: r.stderr.toString(), ran };
}

/** Another clone pushes a newer ops commit: ours is now behind. */
function pushNewerOps() {
  const other = join(root, "other");
  git(root, "clone", "-q", "--branch", "trunk", origin, other);
  writeFileSync(join(other, "fleet", "wrangler.jsonc"), '{ "name": "fleet-newer" }\n');
  git(other, "commit", "-q", "-am", "newer");
  git(other, "push", "-q", "origin", "trunk");
}

// Issue #379: a bare `exec wrangler` ran whatever was first on PATH -- a
// global 4.74 on the operator's Mac when deploy.sh was called directly, so a
// repo bump never reached the deploy. The pinned binary runs, always.
describe("deploy.sh runs the repo's pinned wrangler, never PATH's (#379)", () => {
  test("a different wrangler first on PATH is never run", () => {
    const r = deploy([]);
    expect(r.code, r.err).toBe(0);
    expect(r.ran).toContain("wrangler deploy -c wrangler.local.jsonc");
    expect(r.ran).not.toContain("PATH-wrangler");
  });

  test("subcommands use the pinned wrangler too", () => {
    const r = deploy(["d1", "migrations", "list", "fleet", "--remote"]);
    expect(r.ran).toContain("wrangler d1 migrations list fleet --remote -c wrangler.local.jsonc");
    expect(r.ran).not.toContain("PATH-wrangler");
  });

  test("no pinned wrangler installed: refuses, names bun install, runs nothing", () => {
    rmSync(join(fleet, "node_modules"), { recursive: true, force: true });
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("bun install");
    expect(r.ran).toBe("");
  });
});

// Issue #379 round 2: a stale node_modules (installed before the bump) ran
// 4.119 silently. deploy.sh compares the installed version with bun.lock's
// top-level pin and refuses when installed is OLDER.
describe("deploy.sh refuses a wrangler older than bun.lock pins (#379)", () => {
  test("installed older than the lock: refuses, names both versions and bun install, runs nothing", () => {
    setWranglerVersions("4.119.0", "4.141.0");
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("4.119.0");
    expect(r.err).toContain("4.141.0");
    expect(r.err).toContain("bun install");
    expect(r.ran).toBe("");
  });

  test("minor compared numerically, never as text (4.99 < 4.141)", () => {
    setWranglerVersions("4.99.0", "4.141.0");
    expect(deploy([]).code).not.toBe(0);
  });

  test("installed equal to the lock: runs", () => {
    expect(deploy([]).ran).toContain("wrangler deploy -c wrangler.local.jsonc");
  });

  test("installed newer than the lock: runs", () => {
    setWranglerVersions("4.142.1", "4.141.0");
    expect(deploy([]).ran).toContain("wrangler deploy -c wrangler.local.jsonc");
  });

  test("the lock's nested vitest-pool-workers wrangler never counts as the pin", () => {
    setWranglerVersions("4.120.0", "4.141.0");
    expect(deploy([]).code).not.toBe(0);
  });

  test("installed version unreadable: refuses, runs nothing", () => {
    setWranglerVersions(null, "4.141.0");
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });

  test("no bun.lock pin found: refuses, runs nothing", () => {
    setWranglerVersions("4.141.0", null);
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });
});

describe("deploy.sh refuses a dirty or stale ops checkout (#365)", () => {
  test("clean and current: wrangler deploy runs", () => {
    const r = deploy([]);
    expect(r.code, r.err).toBe(0);
    expect(r.ran).toContain("wrangler deploy -c wrangler.local.jsonc");
  });

  test("an uncommitted change to the ops config is refused, and wrangler never runs", () => {
    writeFileSync(join(ops, "fleet", "wrangler.jsonc"), '{ "name": "example" }\n');
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("uncommitted");
    expect(r.err).toContain("fleet/wrangler.jsonc");
    expect(r.ran).toBe("");
  });

  test("HEAD behind its upstream (after a fetch) is refused, naming both commits", () => {
    const before = git(ops, "rev-parse", "HEAD");
    pushNewerOps();
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    const upstream = git(origin, "rev-parse", "trunk");
    expect(r.err).toContain(before);
    expect(r.err).toContain(upstream);
    expect(r.ran).toBe("");
  });

  test("HEAD AHEAD of its upstream (an unpushed local commit) is refused too", () => {
    writeFileSync(join(ops, "fleet", "wrangler.jsonc"), '{ "name": "local-only" }\n');
    git(ops, "commit", "-q", "-am", "local only");
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });

  test("--allow-dirty-ops lets a dirty checkout through, loudly, and is not forwarded to wrangler", () => {
    writeFileSync(join(ops, "fleet", "wrangler.jsonc"), '{ "name": "hotfix" }\n');
    const r = deploy(["--allow-dirty-ops"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("--allow-dirty-ops");
    expect(r.ran).toContain("wrangler deploy -c wrangler.local.jsonc");
    expect(r.ran).not.toContain("--allow-dirty-ops");
  });

  test("a FLEET_CONFIG outside any git repo only warns", () => {
    const loose = join(root, "loose.jsonc");
    writeFileSync(loose, CONFIG);
    const r = deploy([], { FLEET_OPS_DIR: "", FLEET_CONFIG: loose });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("not in a git repo");
    expect(r.ran).toContain("wrangler deploy");
  });

  test("deploy --dry-run changes nothing remote: a dirty checkout does not block it", () => {
    writeFileSync(join(ops, "fleet", "wrangler.jsonc"), '{ "name": "example" }\n');
    const r = deploy(["deploy", "--dry-run"]);
    expect(r.code, r.err).toBe(0);
    expect(r.ran).toContain("wrangler deploy --dry-run -c wrangler.local.jsonc");
  });

  test("secret put and d1 migrations apply --remote are guarded; a --local migration and read-only commands are not", () => {
    writeFileSync(join(ops, "fleet", "wrangler.jsonc"), '{ "name": "example" }\n');
    expect(deploy(["secret", "put", "X"]).code).not.toBe(0);
    expect(deploy(["d1", "migrations", "apply", "fleet", "--remote"]).code).not.toBe(0);
    expect(deploy(["d1", "migrations", "apply", "fleet", "--local"]).code).toBe(0);
    expect(deploy(["tail"]).code).toBe(0);
  });
});

/** Leave the ops checkout's config modified (uncommitted). */
function dirty() {
  writeFileSync(join(ops, "fleet", "wrangler.jsonc"), '{ "name": "example" }\n');
}

describe("round 2 (#368 review): guard every remote-changing command, not a list (#365)", () => {
  // Inverted: only these known read-only commands skip the guard.
  const readOnly: string[][] = [
    ["deploy", "--dry-run"], ["tail"], ["d1", "migrations", "apply", "fleet", "--local"], ["d1"],
    ["whoami"], ["secret", "list"], ["versions", "list"], ["--env", "prod", "tail"],
  ];
  for (const args of readOnly) {
    test(`read-only \`${args.join(" ")}\` runs despite a dirty checkout`, () => {
      dirty();
      const r = deploy(args);
      expect(r.code, r.err).toBe(0);
    });
  }

  // Unlisted remote-changing commands the round-1 allowlist let through.
  const remote: string[][] = [
    ["versions", "upload"], ["versions", "deploy"], ["rollback"], ["delete"], ["triggers", "deploy"],
    ["kv", "key", "put", "--remote", "k", "v"], ["r2", "object", "put", "b/k"],
    ["--env", "prod", "deploy"], ["-e", "prod", "secret", "put", "X"],
  ];
  for (const args of remote) {
    test(`\`${args.join(" ")}\` is refused on a dirty checkout, wrangler never runs`, () => {
      dirty();
      const r = deploy(args);
      expect(r.code).not.toBe(0);
      expect(r.ran).toBe("");
    });
  }
});

describe("round 2 (#368 review): 'committed' means tracked AND equal to HEAD (#365)", () => {
  test("assume-unchanged hides a local edit from git status — still refused", () => {
    git(ops, "update-index", "--assume-unchanged", "fleet/wrangler.jsonc");
    dirty();
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });

  test("skip-worktree hides it too — still refused", () => {
    git(ops, "update-index", "--skip-worktree", "fleet/wrangler.jsonc");
    dirty();
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });

  test("a gitignored, never-committed config in the ops checkout is refused (not tracked)", () => {
    writeFileSync(join(ops, ".gitignore"), "fleet/local.jsonc\n");
    git(ops, "add", ".gitignore");
    git(ops, "commit", "-q", "-m", "ignore local");
    git(ops, "push", "-q", "origin", "trunk");
    writeFileSync(join(ops, "fleet", "local.jsonc"), CONFIG);
    const r = deploy([], { FLEET_CONFIG: join(ops, "fleet", "local.jsonc") });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not tracked");
    expect(r.ran).toBe("");
  });

  test("a symlinked FLEET_CONFIG is judged by the repo it POINTS INTO, not the link's own directory", () => {
    dirty();
    const link = join(root, "linked.jsonc");
    symlinkSync(join(ops, "fleet", "wrangler.jsonc"), link);
    const r = deploy([], { FLEET_OPS_DIR: "", FLEET_CONFIG: link });
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });
});

describe("round 2 (#368 review): cannot prove current → refuse (#365)", () => {
  test("the fetch fails (origin unreachable): refused, and quickly", () => {
    git(ops, "remote", "set-url", "origin", join(root, "gone.git"));
    const t0 = Date.now();
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("could not fetch");
    expect(r.ran).toBe("");
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  test("a branch with no upstream: refused", () => {
    git(ops, "checkout", "-q", "-b", "local-only");
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no upstream");
    expect(r.ran).toBe("");
  });
});

describe("round 3 (#368 review): parse strictly — anything unrecognised is guarded (#365)", () => {
  const refused: string[][] = [
    ["--profile", "whoami", "deploy"],
    ["--env-file", ".env", "deploy"],
    ["versions", "--message", "list", "deploy"],
    ["deploy", "--var", "X: --dry-run y"],
    ["deploy", "--dry-run=false"],
    ["d1", "migrations", "apply", "fleet", "--local", "--remote=true"],
    ["d1", "migrations", "apply", "fleet", "--remote=true"],
  ];
  for (const args of refused) {
    test(`\`${args.join(" ")}\` is guarded: refused on a dirty checkout`, () => {
      dirty();
      const r = deploy(args);
      expect(r.code).not.toBe(0);
      expect(r.ran).toBe("");
    });
  }

  test("`deploy --dry-run=true` is still read-only", () => {
    dirty();
    expect(deploy(["deploy", "--dry-run=true"]).code).toBe(0);
  });
});

describe("round 3 (#368 review): the fetch cannot hang the deploy (#365)", () => {
  test("a remote that never answers is cut off by the watchdog and refused", () => {
    git(ops, "config", "protocol.ext.allow", "always");
    git(ops, "remote", "set-url", "origin", "ext::sh -c sleep% 60");
    const t0 = Date.now();
    const r = deploy([], { DEPLOY_FETCH_TIMEOUT: "2" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("timed out");
    expect(r.ran).toBe("");
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  test("an operator's own core.sshCommand is respected, not overridden", () => {
    const marker = join(root, "ssh.used");
    const ssh = join(root, "my-ssh");
    writeFileSync(ssh, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(ssh, 0o755);
    git(ops, "config", "core.sshCommand", ssh);
    git(ops, "remote", "set-url", "origin", "ssh://example.invalid/ops.git");
    const r = deploy([], { GIT_SSH_COMMAND: "" });
    expect(r.code).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test("the watchdog leaves no helper process behind", () => {
    git(ops, "config", "protocol.ext.allow", "always");
    git(ops, "remote", "set-url", "origin", "ext::sh -c sleep% 61");
    deploy([], { DEPLOY_FETCH_TIMEOUT: "1" });
    Bun.sleepSync(500);
    const left = Bun.spawnSync(["pgrep", "-f", "^sleep 61$"]).stdout.toString().trim();
    expect(left).toBe("");
  });
});

/**
 * Issue #377: the Worker commits completion records to the ops repo
 * (done/**). Requiring HEAD == upstream refused every deploy after each
 * record although the config never changed. The guard now judges the CONFIG:
 * refuse when it differs between HEAD and upstream or local unpushed commits
 * touch it; behind/ahead on other paths only is allowed, with a note.
 */
describe("#377: only the config's own history decides", () => {
  /** Another clone pushes a completion record — not the config. */
  function pushRecord() {
    const other = join(root, "other-rec");
    git(root, "clone", "-q", "--branch", "trunk", origin, other);
    mkdirSync(join(other, "done"), { recursive: true });
    writeFileSync(join(other, "done", "373.json"), "{}\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "completion record #373");
    git(other, "push", "-q", "origin", "trunk");
  }

  test("behind only on a completion record: deploy runs, with a note", () => {
    pushRecord();
    const r = deploy([]);
    expect(r.code, r.err).toBe(0);
    expect(r.ran).toContain("wrangler deploy -c wrangler.local.jsonc");
    expect(r.err).toContain("behind");
  });

  test("behind on a record AND on the config: refused", () => {
    pushRecord();
    pushNewerOps();
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });

  test("a local unpushed commit that does not touch the config: deploy runs", () => {
    mkdirSync(join(ops, "notes"), { recursive: true });
    writeFileSync(join(ops, "notes", "x.md"), "x\n");
    git(ops, "add", "-A");
    git(ops, "commit", "-q", "-m", "local note");
    const r = deploy([]);
    expect(r.code, r.err).toBe(0);
  });

  test("local unpushed commits that touch the config are refused even when they net to no change", () => {
    const cfg = join(ops, "fleet", "wrangler.jsonc");
    writeFileSync(cfg, '{ "name": "tmp" }\n');
    git(ops, "commit", "-q", "-am", "try");
    writeFileSync(cfg, CONFIG);
    git(ops, "commit", "-q", "-am", "revert");
    const r = deploy([]);
    expect(r.code).not.toBe(0);
    expect(r.ran).toBe("");
  });
});

/**
 * Issue #380: d1's value-taking flags. 'd1 execute fleet --command --local'
 * was classed local-only (the parse read "--local" as the flag) and skipped
 * the guard. It is guarded now because deploy.sh does not model wrangler's
 * parse of such an argv — not because it would run remotely (#383: wrangler
 * 4.119 reads the flag, with an empty command, and fails locally). Values of
 * --command, --file and --persist-to are opaque; unknown flags are guarded.
 */
describe("#380: d1 flag values are opaque", () => {
  const refused: string[][] = [
    ["d1", "execute", "fleet", "--command", "--local"],
    ["d1", "execute", "fleet", "--file", "--local"],
    ["d1", "execute", "fleet", "--local", "--unknown-flag"],
    ["d1", "execute", "fleet", "--command=SELECT 1"],
  ];
  for (const args of refused) {
    test(`\`${args.join(" ")}\` is guarded on a dirty checkout`, () => {
      dirty();
      const r = deploy(args);
      expect(r.code).not.toBe(0);
      expect(r.ran).toBe("");
    });
  }

  const local: string[][] = [
    ["d1", "execute", "fleet", "--command", "SELECT 1", "--local"],
    ["d1", "execute", "fleet", "--local", "--file=seed.sql", "--json"],
  ];
  for (const args of local) {
    test(`\`${args.join(" ")}\` is local, runs despite a dirty checkout`, () => {
      dirty();
      expect(deploy(args).code).toBe(0);
    });
  }
});

describe("#380: the config path is matched literally, never as a pathspec glob", () => {
  test("a config named with a glob character is judged on ITSELF, not on files the glob would match", () => {
    // Config literally named "w*.jsonc"; a sibling "wx.jsonc" changes upstream.
    const star = join(ops, "fleet", "w*.jsonc");
    writeFileSync(star, CONFIG);
    writeFileSync(join(ops, "fleet", "wx.jsonc"), "{}\n");
    git(ops, "add", "-A");
    git(ops, "commit", "-q", "-m", "star config + sibling");
    git(ops, "push", "-q", "origin", "trunk");
    const other = join(root, "other-star");
    git(root, "clone", "-q", "--branch", "trunk", origin, other);
    writeFileSync(join(other, "fleet", "wx.jsonc"), '{ "changed": true }\n');
    git(other, "commit", "-q", "-am", "sibling changes");
    git(other, "push", "-q", "origin", "trunk");
    const r = deploy([], { FLEET_CONFIG: star });
    expect(r.code, r.err).toBe(0);
  });
});

describe("#383: follow-ups from the #381 review", () => {
  test("an operator's GIT_GLOB_PATHSPECS (or ICASE/NOGLOB) does not break the guard's git calls", () => {
    for (const v of ["GIT_GLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_NOGLOB_PATHSPECS"]) {
      const r = deploy([], { [v]: "1" });
      expect({ v, code: r.code, err: r.err }).toEqual({ v, code: 0, err: expect.any(String) });
      expect(r.ran).toContain("wrangler deploy");
      rmSync(calls, { force: true });
    }
  });

  test("an unpushed commit touching only a sibling the config's name would glob-match is allowed", () => {
    // Config literally named "w[1].jsonc"; as a glob it would match "w1.jsonc".
    const cfg = join(ops, "fleet", "w[1].jsonc");
    writeFileSync(cfg, CONFIG);
    writeFileSync(join(ops, "fleet", "w1.jsonc"), "{}\n");
    git(ops, "add", "-A");
    git(ops, "commit", "-q", "-m", "bracket config + sibling");
    git(ops, "push", "-q", "origin", "trunk");
    writeFileSync(join(ops, "fleet", "w1.jsonc"), '{ "local": true }\n');
    git(ops, "commit", "-q", "-am", "local sibling change");
    const r = deploy([], { FLEET_CONFIG: cfg });
    expect(r.code, r.err).toBe(0);
  });
});
