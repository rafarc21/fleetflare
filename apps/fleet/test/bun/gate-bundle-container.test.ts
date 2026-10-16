// #1080 container side: a leg reads the run's bundle instead of cloning, falls
// back to the clone when the bundle is missing or unusable, and the bundle leg
// builds the bundle once and uploads it. Exec and R2 are faked, as in gate-server.test.ts.
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunEnv, runGate, type FetchFn, type GateRun } from "../../container/gate-server";
import type { ExecFn } from "../../container/gate-merge-tree";

const R2 = "http://gate-r2.internal/";
const BUNDLE_KEY = `gate/acme/example/bundles/run-a/${"f".repeat(40)}.bundle`;
const RUN_KEY = "gate/acme/example/runs/7/run-a/shard-lint.json";
const SHA = { base: "a".repeat(40), head: "f".repeat(40), merge: "1".repeat(40), tree: "2".repeat(40) };

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
  baseRef: "main", pr: "7", private: false, bundleKey: BUNDLE_KEY,
};
const BUNDLE_LEG: GateRun = { ...LEG, leg: "bundle", legCmd: "", installCmd: "", resultKey: "gate/acme/example/runs/7/run-a/shard-bundle.json" };

/** Records every exec call. Answers the verbs runSteps and resolveMergeTree use;
 *  `bundle create` writes its output file so the bundle leg has bytes to upload. */
function fakeExec(opts: { cloneCode?: number; fetchCode?: number; createCode?: number } = {}) {
  const calls: string[][] = [];
  const known: Record<string, string> = {
    [SHA.base]: SHA.base, [SHA.head]: SHA.head,
    "refs/remotes/origin/main": SHA.base,
  };
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const out = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });
    if (cmd === "bash") return out(0);
    if (cmd === "rm" || cmd === "tar") return out(0);
    if (args.includes("clone")) return out(opts.cloneCode ?? 0, "", opts.cloneCode ? "fatal: boom" : "");
    if (args.includes("fetch")) return out(opts.fetchCode ?? 0, "", opts.fetchCode ? "fatal: bad bundle" : "");
    if (args.includes("bundle") && args.includes("create")) {
      if (opts.createCode) return out(opts.createCode, "", "fatal: refs missing");
      writeFileSync(args[args.indexOf("create") + 1], Buffer.from("PACK"));
      return out(0);
    }
    if (args.includes("rev-parse")) {
      const name = args[args.length - 1].replace(/\^\{commit\}$/, "");
      const sha = known[name];
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
  const puts: { key: string; body: string }[] = [];
  const fn: FetchFn = async (url, init) => {
    const key = url.slice(R2.length);
    if (init?.method === "PUT") {
      puts.push({ key, body: await new Response(init.body).text() });
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
const isBundleFetch = (c: string[]) => c[0] === "git" && c.includes("fetch") && c.includes("refs/*:refs/*");

describe("readRunEnv: the bundle key rides in the container env (#1080)", () => {
  it("reads GATE_BUNDLE_KEY, and is undefined when the leg has none", () => {
    expect(readRunEnv({ GATE_BUNDLE_KEY: BUNDLE_KEY }).bundleKey).toBe(BUNDLE_KEY);
    expect(readRunEnv({}).bundleKey).toBeUndefined();
  });
});

describe("a leg reads the run's bundle instead of cloning (#1080)", () => {
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

describe("the bundle leg builds and uploads the run's bundle once (#1080)", () => {
  it("clones in full (no blob filter), pins the refs the bundle needs, and bundles them", async () => {
    const r2 = fakeR2();
    const world = fakeExec();
    const bundlePath = join(scratch(), "b.bundle");
    const out = await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath });
    const clone = cloneCalls(world.calls)[0];
    expect(clone).toBeDefined();
    expect(clone.some((a) => a.startsWith("--filter"))).toBe(false);
    const create = world.calls.find((c) => c.includes("bundle") && c.includes("create"));
    expect(create).toEqual(["git", "bundle", "create", bundlePath, "refs/gate/base", "refs/gate/head", "refs/remotes/origin/main"]);
    expect(out.state).toBe("success");
  });

  it("uploads the bundle bytes under the run's bundle key, and runs no install, checkout or test", async () => {
    const r2 = fakeR2();
    const world = fakeExec();
    await runGate(BUNDLE_LEG, { exec: world.exec, fetchFn: r2.fn, workdir: join(scratch(), "repo"), bundlePath: join(scratch(), "b.bundle") });
    expect(r2.puts.map((p) => p.key)).toContain(BUNDLE_KEY);
    expect(world.calls.some((c) => c.includes("checkout"))).toBe(false);
    expect(world.calls.some((c) => c[0] === "bash")).toBe(false);
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

/** Runs real git. The bundle leg's commands are the same ones buildBundle and cloneFromBundle run. */
function git(cwd: string, ...args: string[]): { code: number; stdout: string } {
  const p = Bun.spawnSync(["git", "-c", "user.email=gate@example.test", "-c", "user.name=gate", ...args], { cwd });
  return { code: p.exitCode, stdout: new TextDecoder().decode(p.stdout).trim() };
}

describe("real git: a bundle carries every object a leg needs (#1080)", () => {
  it("a leg fetched from the bundle sees head and base, merges, and checks out the head", () => {
    const dir = scratch();
    const src = join(dir, "src");
    git(dir, "init", "-q", "-b", "main", src);
    git(src, "commit", "-q", "--allow-empty", "-m", "base");
    const base = git(src, "rev-parse", "HEAD").stdout;
    writeFileSync(join(src, "f"), "head\n");
    git(src, "add", "f");
    git(src, "commit", "-q", "-m", "head");
    const head = git(src, "rev-parse", "HEAD").stdout;

    // The bundle leg: a clone, its refs pinned, the bundle written.
    const full = join(dir, "full");
    git(dir, "clone", "-q", "--no-checkout", src, full);
    git(full, "update-ref", "refs/gate/base", base);
    git(full, "update-ref", "refs/gate/head", head);
    const bundle = join(dir, "gate.bundle");
    expect(git(full, "bundle", "create", bundle, "refs/gate/base", "refs/gate/head", "refs/remotes/origin/main").code).toBe(0);

    // A leg: init, then fetch every ref from the bundle, as cloneFromBundle does.
    const leg = join(dir, "leg");
    git(dir, "init", "-q", leg);
    expect(git(leg, "fetch", "-q", bundle, "refs/*:refs/*").code).toBe(0);

    expect(git(leg, "cat-file", "-t", head).stdout).toBe("commit");
    expect(git(leg, "cat-file", "-t", base).stdout).toBe("commit");
    expect(git(leg, "rev-parse", "--verify", "-q", "refs/remotes/origin/main").code).toBe(0);
    expect(git(leg, "merge-tree", "--write-tree", base, head).code).toBe(0);
    expect(git(leg, "checkout", "-q", head).code).toBe(0);
    expect(readFileSync(join(leg, "f"), "utf8")).toBe("head\n");
  });
});
