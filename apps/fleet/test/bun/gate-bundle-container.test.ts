// #1080 container side: a leg reads the run's snapshot bundle instead of cloning,
// falls back to the clone when the bundle is missing or unusable, and the bundle
// leg builds a snapshot (base, head, merge-base and base tip, shallow) and streams
// it up once. Exec and R2 are faked, as in gate-server.test.ts; the real-git cases
// run the same git commands the container runs.
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_MAX_BYTES, readRunEnv, runGate, type FetchFn, type GateRun } from "../../container/gate-server";
import { gitSupportsMergeBase, type ExecFn } from "../../container/gate-merge-tree";
import { MAX_BUNDLE_BYTES } from "../../src/gate/outbound-handler";

const R2 = "http://gate-r2.internal/";
const BUNDLE_KEY = `gate-bundles/acme/example/run-a/${"f".repeat(40)}.bundle`;
const RUN_KEY = "gate/acme/example/runs/7/run-a/shard-lint.json";
const SHA = { base: "a".repeat(40), head: "f".repeat(40), merge: "1".repeat(40), tree: "2".repeat(40) };
const MERGE_BASE = "c".repeat(40);
const TIP = "d".repeat(40);
const GIT_NEW = "git version 2.43.0";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "gate-bundle-"));
  dirs.push(d);
  return d;
}

const LEG: GateRun = {
  repo: "acme/example", commit: `${SHA.base}..${SHA.head}`, leg: "lint",
  installCmd: "bun install", legCmd: "bun run lint", resultKey: RUN_KEY, baselineKeys: [],
  baseRef: "main", pr: "7", private: false, bundleKey: BUNDLE_KEY, mergeBase: MERGE_BASE,
};
const BUNDLE_LEG: GateRun = { ...LEG, leg: "bundle", legCmd: "", installCmd: "", resultKey: "gate/acme/example/runs/7/run-a/shard-bundle.json" };

/** Records every exec call. Answers the verbs runSteps, resolveMergeTree and the
 *  bundle code use; `bundle create` writes its output file so the bundle leg has
 *  bytes to upload. `gitVersion` is what `git --version` prints. */
function fakeExec(opts: { cloneCode?: number; fetchCode?: number; createCode?: number; missingAfterFetch?: boolean; gitVersion?: string } = {}) {
  const calls: string[][] = [];
  const known: Record<string, string> = {
    [SHA.base]: SHA.base, [SHA.head]: SHA.head, [MERGE_BASE]: MERGE_BASE,
    "refs/remotes/origin/main": SHA.base,
  };
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const out = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });
    if (cmd === "bash") return out(0);
    if (cmd === "rm" || cmd === "tar") return out(0);
    if (args.includes("--version")) return out(0, `${opts.gitVersion ?? GIT_NEW}\n`);
    if (args.includes("clone")) return out(opts.cloneCode ?? 0, "", opts.cloneCode ? "fatal: boom" : "");
    if (args.includes("list-heads")) {
      return out(0, `${SHA.base} refs/gate/base\n${SHA.head} refs/gate/head\n${MERGE_BASE} refs/gate/merge-base\n${TIP} refs/remotes/origin/main\n`);
    }
    if (args.includes("fetch")) return out(opts.fetchCode ?? 0, "", opts.fetchCode ? "fatal: bad bundle" : "");
    if (args.includes("bundle") && args.includes("create")) {
      if (opts.createCode) return out(opts.createCode, "", "fatal: refs missing");
      writeFileSync(args[args.indexOf("create") + 1], Buffer.from("PACK"));
      return out(0);
    }
    if (args.includes("rev-parse")) {
      const name = args[args.length - 1].replace(/\^\{commit\}$/, "");
      // missingAfterFetch: the bundle fetched but its objects are not there (a stale or partial bundle).
      const cloned = calls.some((c) => c.includes("clone"));
      const sha = opts.missingAfterFetch && calls.some(isBundleFetch) && !cloned ? undefined : known[name];
      return sha ? out(0, `${sha}\n`) : out(1);
    }
    if (args.includes("merge-tree")) return out(0, `${SHA.tree}\n`);
    if (args.includes("commit-tree")) return out(0, `${SHA.merge}\n`);
    if (args.includes("rev-list")) return out(0, `${SHA.merge} ${SHA.base} ${SHA.head}\n`);
    return out(0);
  };
  return { exec, calls };
}

/** R2 fake: GETs answer from `table` (404 when absent); a PUT records its raw body. */
function fakeR2(table: Record<string, number> = {}) {
  const gets: string[] = [];
  const puts: { key: string; body: string; headers: Headers }[] = [];
  const fn: FetchFn = async (url, init) => {
    const key = url.slice(R2.length);
    if (init?.method === "PUT") {
      puts.push({ key, body: await new Response(init.body).text(), headers: new Headers(init.headers) });
      return new Response(null, { status: 201 });
    }
    gets.push(key);
    const status = table[key] ?? 404;
    return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status });
  };
  return { fn, gets, puts };
}

const cloneCalls = (calls: string[][]) => calls.filter((c) => c.includes("clone"));
const isInit = (c: string[]) => c[0] === "git" && c.includes("init");
const isBundleFetch = (c: string[]) => c[0] === "git" && c.includes("fetch") && c.includes("refs/gate/*:refs/gate/*");
const isShallowFetch = (c: string[]) => c[0] === "git" && c.includes("fetch") && c.includes("--depth=1");

describe("readRunEnv: the bundle key and merge base ride in the container env (#1080)", () => {
  it("reads GATE_BUNDLE_KEY and GATE_MERGE_BASE, and both are undefined when the leg has none", () => {
    const env = readRunEnv({ GATE_BUNDLE_KEY: BUNDLE_KEY, GATE_MERGE_BASE: MERGE_BASE });
    expect(env.bundleKey).toBe(BUNDLE_KEY);
    expect(env.mergeBase).toBe(MERGE_BASE);
    expect(readRunEnv({}).bundleKey).toBeUndefined();
    expect(readRunEnv({}).mergeBase).toBeUndefined();
  });
});

describe("the container's bundle cap is the Worker's bundle cap (#1080 HIGH 1)", () => {
  it("both sides refuse the same size, so the leg never uploads a bundle the Worker would refuse", () => {
    expect(BUNDLE_MAX_BYTES).toBe(MAX_BUNDLE_BYTES);
  });
});

describe("git gate for the snapshot: merge-tree --merge-base needs git 2.40 (#1080 HIGH 1)", () => {
  it("accepts git 2.40 and newer", () => {
    expect(gitSupportsMergeBase("git version 2.40.0")).toBe(true);
    expect(gitSupportsMergeBase("git version 2.43.0")).toBe(true);
    expect(gitSupportsMergeBase("git version 3.0.0")).toBe(true);
  });

  it("refuses git before 2.40 and anything it cannot parse", () => {
    expect(gitSupportsMergeBase("git version 2.39.5")).toBe(false);
    expect(gitSupportsMergeBase("git version 1.9.1")).toBe(false);
    expect(gitSupportsMergeBase("")).toBe(false);
    expect(gitSupportsMergeBase("bash: git: command not found")).toBe(false);
  });
});

describe("a leg reads the run's snapshot instead of cloning (#1080)", () => {
  it("GETs the bundle, initialises a repo and fetches every ref from it, with no clone", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec();
    const out = await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(r2.gets).toContain(BUNDLE_KEY);
    expect(world.calls.some(isInit)).toBe(true);
    expect(world.calls.some(isBundleFetch)).toBe(true);
    expect(cloneCalls(world.calls)).toHaveLength(0);
    expect(out.state).toBe("success");
  });

  it("writes the bundle bytes where the fetch reads them", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const bundlePath = join(scratch(), "b.bundle");
    await runGate(LEG, { exec: fakeExec().exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath });
    expect(existsSync(bundlePath)).toBe(true);
    expect(readFileSync(bundlePath)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("a missing bundle (404) falls back to the clone, as before", async () => {
    const r2 = fakeR2({});
    const world = fakeExec();
    const out = await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(cloneCalls(world.calls)).toHaveLength(1);
    expect(world.calls.some(isInit)).toBe(false);
    expect(out.state).toBe("success");
  });

  it("fetches only the refs the bundle carries, never a wildcard over every ref", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec();
    await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    const fetch = world.calls.find(isBundleFetch)!;
    expect(fetch).toContain("refs/gate/*:refs/gate/*");
    expect(fetch).toContain("refs/remotes/origin/*:refs/remotes/origin/*");
    expect(fetch).not.toContain("refs/*:refs/*");
  });

  it("marks every head the bundle carries as a shallow boundary before it fetches, so the snapshot's parents are not required", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec();
    const workdir = join(scratch(), "repo");
    mkdirSync(workdir, { recursive: true });
    await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir, bundlePath: join(scratch(), "b.bundle") });
    const listed = world.calls.findIndex((c) => c.includes("list-heads"));
    const fetched = world.calls.findIndex(isBundleFetch);
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(listed).toBeLessThan(fetched);
    expect(readFileSync(join(workdir, ".git", "shallow"), "utf8").trim().split("\n").sort())
      .toEqual([SHA.base, SHA.head, MERGE_BASE, TIP].sort());
  });

  it("merges with --merge-base=<merge base>, since the snapshot has no history to find it in", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec();
    await runGate({ ...LEG, leg: "merge-tree" }, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    const merge = world.calls.find((c) => c.includes("merge-tree"))!;
    expect(merge).toContain(`--merge-base=${MERGE_BASE}`);
  });

  it("a leg with no bundle merges exactly as before: no --merge-base", async () => {
    const world = fakeExec();
    await runGate({ ...LEG, leg: "merge-tree", bundleKey: undefined, mergeBase: undefined }, { exec: world.exec, fetchFn: fakeR2().fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    const merge = world.calls.find((c) => c.includes("merge-tree"))!;
    expect(merge.some((a) => a.startsWith("--merge-base"))).toBe(false);
  });

  it("a bundle leg with no merge base in its env clones instead, since it cannot merge the snapshot", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec();
    const out = await runGate({ ...LEG, mergeBase: undefined }, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(r2.gets).toHaveLength(0);
    expect(cloneCalls(world.calls)).toHaveLength(1);
    expect(out.state).toBe("success");
  });

  it("a leg on git before 2.40 never reads the snapshot, and clones", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec({ gitVersion: "git version 2.39.5" });
    const out = await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(r2.gets).toHaveLength(0);
    expect(cloneCalls(world.calls)).toHaveLength(1);
    expect(out.state).toBe("success");
  });

  it("a bundle whose base or head is missing after unbundling is discarded and the leg clones", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec({ missingAfterFetch: true });
    const out = await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(cloneCalls(world.calls)).toHaveLength(1);
    expect(out.state).toBe("success");
  });

  it("a bundle that fails to fetch is removed and the leg clones instead", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec({ fetchCode: 1 });
    const workdir = join(scratch(), "repo");
    const out = await runGate(LEG, { exec: world.exec, fetchFn: r2.fn, workdir, bundlePath: join(scratch(), "b.bundle") });
    expect(world.calls.some((c) => c[0] === "rm" && c.includes("-rf") && c.includes(workdir))).toBe(true);
    expect(cloneCalls(world.calls)).toHaveLength(1);
    expect(out.state).toBe("success");
  });

  it("a leg with no bundle key never asks R2 for a bundle", async () => {
    const r2 = fakeR2({ [BUNDLE_KEY]: 200 });
    const world = fakeExec();
    await runGate({ ...LEG, bundleKey: undefined }, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(r2.gets).toHaveLength(0);
    expect(cloneCalls(world.calls)).toHaveLength(1);
  });
});

describe("the bundle leg snapshots the run and uploads it once (#1080 HIGH 1)", () => {
  it("clones nothing: it fetches base, head, merge base and the base tip shallow, and bundles only those refs", async () => {
    const r2 = fakeR2();
    const world = fakeExec();
    const out = await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(cloneCalls(world.calls)).toHaveLength(0);
    const shallow = world.calls.filter(isShallowFetch).map((c) => c[c.length - 1]);
    expect(shallow).toEqual(expect.arrayContaining([SHA.base, SHA.head, MERGE_BASE]));
    expect(shallow.some((a) => a.includes("refs/heads/main:refs/remotes/origin/main"))).toBe(true);
    expect(world.calls.some((c) => c.some((a) => a.startsWith("--filter")))).toBe(false);
    const create = world.calls.find((c) => c.includes("bundle") && c.includes("create"));
    expect(create!.slice(-4)).toEqual(["refs/gate/base", "refs/gate/head", "refs/gate/merge-base", "refs/remotes/origin/main"]);
    expect(out.state).toBe("success");
  });

  it("refuses to build on git before 2.40: an error result, no fetch, no upload", async () => {
    const r2 = fakeR2();
    const world = fakeExec({ gitVersion: "git version 2.39.5" });
    const out = await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(out.state).toBe("error");
    expect(world.calls.some(isShallowFetch)).toBe(false);
    expect(r2.puts.filter((p) => p.key === BUNDLE_KEY)).toHaveLength(0);
  });

  it("uploads the bundle under the run's bundle key, and runs no install, checkout or test", async () => {
    const r2 = fakeR2();
    const world = fakeExec();
    await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(r2.puts.map((p) => p.key)).toContain(BUNDLE_KEY);
    expect(world.calls.some((c) => c.includes("checkout"))).toBe(false);
    expect(world.calls.some((c) => c[0] === "bash")).toBe(false);
  });

  it("streams the file up with its byte length as content-length, not as a buffered body", async () => {
    let seen: RequestInit | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      if (url.endsWith(BUNDLE_KEY) && init?.method === "PUT") seen = init;
      return new Response(null, { status: 201 });
    };
    const bundlePath = join(scratch(), "b.bundle");
    await runGate(BUNDLE_LEG, { exec: fakeExec().exec, fetchFn, workdir: join(scratch(), "repo"), bundlePath });
    expect(seen?.body).toBeInstanceOf(Blob);
    expect(new Headers(seen?.headers).get("content-length")).toBe(String(readFileSync(bundlePath).byteLength));
  });

  it("a bundle over the cap is not uploaded: an error result, and the legs clone", async () => {
    const r2 = fakeR2();
    const world = fakeExec();
    const out = await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle"), maxBundleBytes: 3 });
    expect(out.state).toBe("error");
    expect(out.description).toContain("bundle");
    expect(r2.puts.filter((p) => p.key === BUNDLE_KEY)).toHaveLength(0);
  });

  it("a failed bundle create is an error result and uploads nothing", async () => {
    const r2 = fakeR2();
    const world = fakeExec({ createCode: 128 });
    const out = await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(out.state).toBe("error");
    expect(out.description).toContain("bundle");
    expect(r2.puts.some((p) => p.key === BUNDLE_KEY)).toBe(false);
  });
});

/** Runs real git. The bundle leg's commands are the same ones buildSnapshot and cloneFromBundle run. */
function git(cwd: string, ...args: string[]): { code: number; stdout: string } {
  const p = Bun.spawnSync(["git", "-c", "user.email=gate@example.test", "-c", "user.name=gate", ...args], { cwd });
  return { code: p.exitCode, stdout: new TextDecoder().decode(p.stdout).trim() };
}

describe("real git: a snapshot carries what a leg needs, is smaller than the history, and merges the same (#1080 HIGH 1)", () => {
  it("the snapshot bundle is smaller than the full history, and a leg merges it to the same tree as the full repo", () => {
    const dir = scratch();
    const src = join(dir, "src");
    git(dir, "init", "-q", "-b", "main", src);
    // Thirty commits that each rewrite a 16 KiB file: history much larger than the tips.
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(src, "big"), `${i}\n${"y".repeat(16384)}`);
      git(src, "add", "big");
      git(src, "commit", "-q", "-m", `history ${i}`);
    }
    const mergeBase = git(src, "rev-parse", "HEAD").stdout;
    git(src, "checkout", "-q", "-b", "pr");
    writeFileSync(join(src, "feature"), "head\n");
    git(src, "add", "feature");
    git(src, "commit", "-q", "-m", "head");
    const head = git(src, "rev-parse", "HEAD").stdout;
    git(src, "checkout", "-q", "main");
    writeFileSync(join(src, "big"), `base\n${"z".repeat(16384)}`);
    git(src, "add", "big");
    git(src, "commit", "-q", "-m", "base");
    const base = git(src, "rev-parse", "HEAD").stdout;

    // The full-history bundle, for the size comparison and the expected merge.
    const full = join(dir, "full.bundle");
    expect(git(src, "bundle", "create", full, "--all").code).toBe(0);
    const expectedTree = git(src, "merge-tree", "--write-tree", base, head).stdout.split("\n")[0];

    // The bundle leg: a shallow fetch of the three commits and the base tip, refs pinned, the snapshot bundled.
    const snap = join(dir, "snap");
    git(dir, "init", "-q", snap);
    const url = `file://${src}`;
    for (const sha of [base, head, mergeBase]) expect(git(snap, "fetch", "-q", "--depth=1", url, sha).code).toBe(0);
    expect(git(snap, "fetch", "-q", "--depth=1", url, "+refs/heads/main:refs/remotes/origin/main").code).toBe(0);
    git(snap, "update-ref", "refs/gate/base", base);
    git(snap, "update-ref", "refs/gate/head", head);
    git(snap, "update-ref", "refs/gate/merge-base", mergeBase);
    const bundle = join(dir, "gate.bundle");
    expect(git(snap, "bundle", "create", bundle, "refs/gate/base", "refs/gate/head", "refs/gate/merge-base", "refs/remotes/origin/main").code).toBe(0);
    expect(readFileSync(bundle).byteLength).toBeLessThan(readFileSync(full).byteLength / 2);

    // A leg: init, mark the bundle's heads shallow (as cloneFromBundle does), fetch, merge with the merge base.
    const leg = join(dir, "leg");
    git(dir, "init", "-q", leg);
    const heads = git(leg, "bundle", "list-heads", bundle).stdout.split("\n").map((l) => l.split(" ")[0]);
    writeFileSync(join(leg, ".git", "shallow"), `${[...new Set(heads)].join("\n")}\n`);
    expect(git(leg, "fetch", "-q", bundle, "refs/gate/*:refs/gate/*", "refs/remotes/origin/*:refs/remotes/origin/*").code).toBe(0);
    const merged = git(leg, "merge-tree", "--write-tree", `--merge-base=${mergeBase}`, base, head);
    expect(merged.code).toBe(0);
    expect(merged.stdout.split("\n")[0]).toBe(expectedTree);
    expect(git(leg, "commit-tree", expectedTree, "-p", base, "-p", head, "-m", "gate").code).toBe(0);
  });
});
