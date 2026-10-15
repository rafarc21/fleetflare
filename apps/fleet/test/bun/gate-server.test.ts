import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreBaseline, putResult, cloneUrl, runGate, readRunEnv, createRunServer, type FetchFn, type GateRun } from "../../container/gate-server";
import type { ExecFn } from "../../container/gate-merge-tree";

const containerDir = join(import.meta.dir, "..", "..", "container");
const R2 = "http://gate-r2.internal/";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function workdir() {
  const d = mkdtempSync(join(tmpdir(), "gate-server-"));
  dirs.push(d);
  return d;
}

// key -> HTTP status. Any key not in the table answers 404. Records every URL asked for.
function fakeFetch(table: Record<string, number>) {
  const seen: string[] = [];
  const fn: FetchFn = async (url) => {
    seen.push(url);
    const status = table[url.slice(R2.length)] ?? 404;
    return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status });
  };
  return { fn, seen };
}

// Only `tar` can fail here; every other command succeeds.
function fakeExec(tarCode = 0) {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: cmd === "tar" ? tarCode : 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const tarCalls = (calls: string[][]) => calls.filter((c) => c[0] === "tar").length;

describe("restoreBaseline (container fallback path, plain R2 keys)", () => {
  it("stops at the first key that restores", async () => {
    const { fn, seen } = fakeFetch({ a: 200, b: 200 });
    const { exec, calls } = fakeExec();
    const restored = await restoreBaseline(["a", "b"], { fetchFn: fn, exec, workdir: workdir() });
    expect(restored).toBe(true);
    expect(seen).toEqual([`${R2}a`]);
    expect(tarCalls(calls)).toBe(1);
  });

  it("falls through to the next key when the first is absent", async () => {
    const { fn, seen } = fakeFetch({ b: 200 });
    const { exec, calls } = fakeExec();
    const restored = await restoreBaseline(["a", "b"], { fetchFn: fn, exec, workdir: workdir() });
    expect(restored).toBe(true);
    expect(seen).toEqual([`${R2}a`, `${R2}b`]);
    expect(tarCalls(calls)).toBe(1);
  });

  it("tries the next key when extraction fails", async () => {
    const { fn, seen } = fakeFetch({ a: 200, b: 200 });
    const { exec, calls } = fakeExec(2);
    const restored = await restoreBaseline(["a", "b"], { fetchFn: fn, exec, workdir: workdir() });
    expect(restored).toBe(false);
    expect(seen).toEqual([`${R2}a`, `${R2}b`]);
    expect(tarCalls(calls)).toBe(2);
  });

  it("reports false and extracts nothing when no key exists", async () => {
    const { fn } = fakeFetch({});
    const { exec, calls } = fakeExec();
    const restored = await restoreBaseline(["a"], { fetchFn: fn, exec, workdir: workdir() });
    expect(restored).toBe(false);
    expect(tarCalls(calls)).toBe(0);
  });
});

describe("putResult (plain R2 key, no credential on the request)", () => {
  it("PUTs JSON to the fixed internal path with no auth headers", async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    const fn: FetchFn = async (url, init) => {
      sent.push({ url, init });
      return new Response(null, { status: 200 });
    };
    await putResult("runs/r1/shard-1.json", { state: "success" }, fn);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${R2}runs/r1/shard-1.json`);
    expect(sent[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({ state: "success" });
    const headerNames = Object.keys(new Headers(sent[0].init?.headers));
    expect(headerNames.filter((h) => /auth|token|secret|x-amz/i.test(h))).toEqual([]);
  });

  it("swallows a failed PUT so the leg still reports its own outcome", async () => {
    const fn: FetchFn = async () => { throw new Error("network down"); };
    await expect(putResult("runs/r1/shard-1.json", { state: "failure" }, fn)).resolves.toBeUndefined();
  });

  it("does nothing for an empty key", async () => {
    let called = false;
    const fn: FetchFn = async () => { called = true; return new Response(null); };
    await putResult("", { state: "success" }, fn);
    expect(called).toBe(false);
  });
});

describe("cloneUrl (#715: private repos clone through the Worker git proxy)", () => {
  it("a public repo clones anonymously from github.com", () => {
    expect(cloneUrl("acme/example", false)).toBe("https://github.com/acme/example.git");
  });

  it("a private repo clones from the Worker proxy host, never from github.com", () => {
    expect(cloneUrl("acme/example", true)).toBe("http://git-proxy.internal/acme/example.git");
  });
});

const SHA = { base: "a".repeat(40), head: "b".repeat(40), merge: "c".repeat(40), tree: "d".repeat(40) };
const RUN: GateRun = {
  repo: "owner/repo", commit: `${SHA.base}..${SHA.head}`, leg: "lint",
  installCmd: "bun install", legCmd: "bun run lint", resultKey: "runs/7/shard-lint.json",
  baselineKeys: [], baseRef: "main", pr: "7",
};
const MERGE_RUN: GateRun = { ...RUN, leg: "merge-tree", installCmd: "", legCmd: "" };

interface WorldOpts { cloneCode?: number; checkoutCode?: number; mergeCode?: number; legCode?: number; headPresent?: boolean }

// A scripted git. Every command succeeds unless the opts fail it. `rev-parse` resolves only the
// refs in `known`; the PR head is missing until a fetch brings it in (the fork-PR path).
function fakeWorld(opts: WorldOpts = {}) {
  const calls: string[][] = [];
  let headPresent = opts.headPresent ?? true;
  const known: Record<string, string> = {
    [SHA.base]: SHA.base, [SHA.head]: SHA.head,
    "refs/remotes/origin/main": SHA.base, "refs/remotes/origin/staging": SHA.base,
  };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (code: number, stderr: string) => ({ code, stdout: "", stderr });
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "tar") return ok();
    if (cmd === "bash") {
      if (args[1] === RUN.legCmd && opts.legCode) return fail(opts.legCode, "leg broke");
      return ok();
    }
    // `git -c k=v commit-tree` puts its own flags first, so match the verb anywhere in argv.
    const verb = args.find((a) => ["clone", "fetch", "rev-parse", "merge-tree", "commit-tree", "rev-list", "checkout"].includes(a)) ?? args[0];
    switch (verb) {
      case "clone": return opts.cloneCode ? fail(opts.cloneCode, "fatal: repository not found") : ok();
      case "fetch": headPresent = true; return ok();
      case "rev-parse": {
        const name = args[args.length - 1].replace(/\^\{commit\}$/, "");
        const sha = name === SHA.head && !headPresent ? undefined : known[name];
        return sha ? ok(`${sha}\n`) : fail(1, "");
      }
      case "merge-tree": return opts.mergeCode !== undefined ? fail(opts.mergeCode, "") : ok(`${SHA.tree}\n`);
      case "commit-tree": return ok(`${SHA.merge}\n`);
      case "rev-list": return ok(`${SHA.merge} ${SHA.base} ${SHA.head}\n`);
      case "checkout": return opts.checkoutCode ? fail(opts.checkoutCode, "error: pathspec") : ok();
      default: return ok();
    }
  };
  return { exec, calls };
}

// Records every PUT body by R2 key; GETs answer from `table` like fakeFetch.
function fakeR2(table: Record<string, number> = {}) {
  const puts: { key: string; body: { state: string; description?: string; commit?: string } }[] = [];
  const fn: FetchFn = async (url, init) => {
    const key = url.slice(R2.length);
    if (init?.method === "PUT") {
      puts.push({ key, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 200 });
    }
    const status = table[key] ?? 404;
    return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status });
  };
  return { fn, puts };
}

const indexOfCall = (calls: string[][], pred: (c: string[]) => boolean) => calls.findIndex(pred);
const isCheckout = (c: string[]) => c[0] === "git" && c.includes("checkout");

describe("runGate: every leg tests the merge result", () => {
  it("checks out the merge commit before install and before the leg command", async () => {
    const world = fakeWorld();
    await runGate(RUN, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    const checkout = indexOfCall(world.calls, isCheckout);
    expect(world.calls[checkout]).toEqual(["git", "checkout", "--quiet", SHA.merge]);
    const install = indexOfCall(world.calls, (c) => c[0] === "bash" && c[2] === RUN.installCmd);
    const leg = indexOfCall(world.calls, (c) => c[0] === "bash" && c[2] === RUN.legCmd);
    expect(checkout).toBeLessThan(install);
    expect(install).toBeLessThan(leg);
  });

  it("restores the baseline after checkout, never before it", async () => {
    const world = fakeWorld();
    const r2 = fakeR2({ "base.tar": 200 });
    await runGate({ ...RUN, baselineKeys: ["base.tar"] }, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    const tar = indexOfCall(world.calls, (c) => c[0] === "tar");
    expect(tar).toBeGreaterThan(indexOfCall(world.calls, isCheckout));
  });

  it("merge-tree leg resolves the merge and reports its commit, with no checkout or install", async () => {
    const world = fakeWorld();
    const r2 = fakeR2();
    await runGate(MERGE_RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    expect(world.calls.some(isCheckout)).toBe(false);
    expect(world.calls.some((c) => c[0] === "bash")).toBe(false);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0].body).toMatchObject({ state: "success", commit: SHA.merge });
  });

  it("a conflict reports failure against the base branch and installs nothing", async () => {
    const world = fakeWorld({ mergeCode: 1 });
    const r2 = fakeR2();
    const outcome = await runGate(RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    expect(outcome).toMatchObject({ state: "failure", description: "merge conflict against main" });
    expect(world.calls.some((c) => c[0] === "bash")).toBe(false);
    expect(r2.puts[0].body).toMatchObject({ state: "failure", description: "merge conflict against main" });
  });

  it("a non-conflict merge-tree failure reports error, not failure", async () => {
    const world = fakeWorld({ mergeCode: 128 });
    const r2 = fakeR2();
    await runGate(RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    expect(r2.puts[0].body.state).toBe("error");
    expect(r2.puts[0].body.description).toMatch(/merge-tree exited 128/);
  });

  it("resolves the stale-base check against origin/<baseRef> from the request", async () => {
    const world = fakeWorld();
    await runGate({ ...RUN, baseRef: "staging" }, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    expect(world.calls).toContainEqual(["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/staging"]);
    expect(world.calls.some((c) => c.includes("refs/remotes/origin/main"))).toBe(false);
  });

  it("clones blobless and without a checkout", async () => {
    const world = fakeWorld();
    await runGate(RUN, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    expect(world.calls[0].slice(0, 6)).toEqual([
      "git", "clone", "--filter=blob:none", "--no-checkout", "--quiet", "https://github.com/owner/repo.git",
    ]);
  });

  it("fetches the PR head when the head commit is missing after clone (fork PR)", async () => {
    const world = fakeWorld({ headPresent: false });
    const r2 = fakeR2();
    await runGate(RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    const fetch = indexOfCall(world.calls, (c) => c.includes("fetch"));
    expect(world.calls[fetch]).toEqual(["git", "fetch", "--quiet", "origin", "+refs/pull/7/head"]);
    expect(fetch).toBeLessThan(indexOfCall(world.calls, (c) => c.includes("merge-tree")));
    expect(r2.puts[0].body.state).toBe("success");
  });

  it("writes an error result when the clone fails", async () => {
    const world = fakeWorld({ cloneCode: 128 });
    const r2 = fakeR2();
    await runGate(RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0].key).toBe(RUN.resultKey);
    expect(r2.puts[0].body).toMatchObject({ state: "error" });
    expect(r2.puts[0].body.description).toMatch(/clone failed/);
  });

  it("writes an error result when checkout fails", async () => {
    const world = fakeWorld({ checkoutCode: 1 });
    const r2 = fakeR2();
    await runGate(RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    expect(r2.puts[0].body).toMatchObject({ state: "error" });
    expect(r2.puts[0].body.description).toMatch(/checkout failed/);
  });

  it("writes a failure result when the leg command fails", async () => {
    const world = fakeWorld({ legCode: 2 });
    const r2 = fakeR2();
    await runGate(RUN, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    expect(r2.puts[0].body).toMatchObject({ state: "failure", description: "lint exited 2" });
  });

  it("writes an error result when a step throws, so no leg ends without one", async () => {
    const exec: ExecFn = async () => { throw new Error("spawn EACCES"); };
    const r2 = fakeR2();
    const outcome = await runGate(RUN, { exec, fetchFn: r2.fn, workdir: workdir() });
    expect(outcome.state).toBe("error");
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0].body.description).toMatch(/spawn EACCES/);
  });
});

describe("readRunEnv", () => {
  it("reads every run field from the container env, including baseRef and pr", () => {
    expect(readRunEnv({
      GATE_REPO: "owner/repo", GATE_COMMIT: "a..b", GATE_LEG: "lint",
      GATE_INSTALL_CMD: "bun install", GATE_LEG_CMD: "bun run lint",
      GATE_RESULT_KEY: "k", GATE_BASELINE_KEYS: "", GATE_BASE_REF: "staging", GATE_PR: "7",
    })).toEqual({
      repo: "owner/repo", commit: "a..b", leg: "lint", installCmd: "bun install", legCmd: "bun run lint",
      resultKey: "k", baselineKeys: [], baseRef: "staging", pr: "7", private: false,
    });
  });
});

describe("gate-server.ts source pins (Review Focus item 5)", () => {
  // Comments are stripped first: the file's own header explains what it must
  // not contain, and that explanation must not trip the check.
  const code = readFileSync(join(containerDir, "gate-server.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");

  it("holds no token, auth header, presigned or signed URL material", () => {
    expect(code).not.toMatch(/authorization|bearer|token|presign|x-amz|r2\.cloudflarestorage|secret/i);
  });

  it("clones anonymously over plain HTTPS", () => {
    expect(code).toContain("`https://github.com/${repo}.git`");
  });
});

describe("Dockerfile.gate (image shape per the repo's reproducible-build rules)", () => {
  const raw = readFileSync(join(containerDir, "Dockerfile.gate"), "utf8");
  // Join continuation lines so each Dockerfile instruction is one string.
  const instructions = raw.replace(/\\\n\s*/g, " ").split("\n").map((l) => l.trim());
  const runs = instructions.filter((l) => /^RUN\b/.test(l));

  it("pins every base image by digest", () => {
    const froms = instructions.filter((l) => /^FROM\b/.test(l));
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f).toContain("@sha256:");
  });

  it("wraps every installing or downloading RUN in repro-seal begin/end", () => {
    const installs = runs.filter((r) => /apt-get|bun install|cargo|rustup|curl/.test(r));
    expect(installs.length).toBeGreaterThan(0);
    for (const r of installs) {
      expect(r).toContain("repro-seal begin");
      expect(r).toContain("repro-seal end");
    }
  });

  it("points apt at the dated snapshot", () => {
    expect(raw).toMatch(/ARG APT_SNAPSHOT=\d{8}T\d{6}Z/);
  });

  it("never pipes a download straight into a shell", () => {
    for (const r of runs) expect(r).not.toMatch(/\|\s*(ba)?sh\b/);
  });

  it("verifies the node tarball by checksum and has no Rust layer (#1011)", () => {
    expect(raw).toContain("sha256sum -c");
    expect(raw).toContain("node-v22.23.3-linux-x64.tar.xz");
    expect(raw).not.toMatch(/rustup|cargo|nextest/);
  });

  it("copies only the two container sources and repro-seal into the image", () => {
    expect(raw).toContain("COPY repro-seal.sh gate-server.ts gate-merge-tree.ts /src/");
  });

  it("starts gate-server.ts by absolute path, on port 8080", () => {
    expect(instructions).toContain('CMD ["bun", "run", "/app/gate-server.ts"]');
    expect(raw).toContain("ENV PORT=8080");
  });
});

// The leg command blocks until release(), so a test can observe a leg mid-run.
function heldWorld(opts: WorldOpts = {}) {
  const world = fakeWorld(opts);
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const exec: ExecFn = async (cmd, args, execOpts) => {
    if (cmd === "bash") await held;
    return world.exec(cmd, args, execOpts);
  };
  return { exec, calls: world.calls, release };
}

const RUN_ENV = {
  GATE_REPO: RUN.repo, GATE_COMMIT: RUN.commit, GATE_LEG: RUN.leg, GATE_INSTALL_CMD: RUN.installCmd,
  GATE_LEG_CMD: RUN.legCmd, GATE_RESULT_KEY: RUN.resultKey, GATE_BASE_REF: RUN.baseRef, GATE_PR: RUN.pr,
};
type Handler = (req: Request) => Promise<Response>;
const post = (handler: Handler) => handler(new Request("http://container/run", { method: "POST" }));
const get = (handler: Handler) => handler(new Request("http://container/result"));
const cloneCount = (calls: string[][]) => calls.filter((c) => c[0] === "git" && c.includes("clone")).length;

// Polls GET /result until the leg stops answering 202. Bounded: a stuck run fails the test.
async function untilDone(handler: Handler): Promise<Response> {
  for (let i = 0; i < 200; i++) {
    const res = await get(handler);
    if (res.status !== 202) return res;
    await Bun.sleep(5);
  }
  throw new Error("leg never finished");
}

describe("createRunServer: single-flight /run, polled /result", () => {
  it("answers POST /run at once with 202 running while the leg is still going", async () => {
    const world = heldWorld();
    const handler = createRunServer(RUN_ENV, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    const res = await post(handler);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: "running" });
    world.release();
  });

  it("a repeat POST /run never starts a second run in the same container", async () => {
    const world = heldWorld();
    const handler = createRunServer(RUN_ENV, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    await post(handler);
    const again = await post(handler);
    expect(again.status).toBe(202);
    await Bun.sleep(10);
    expect(cloneCount(world.calls)).toBe(1);

    world.release();
    await untilDone(handler);
    const afterDone = await post(handler);
    expect(afterDone.status).toBe(200);
    expect(cloneCount(world.calls)).toBe(1);
  });

  it("GET /result answers 202 while running, then the leg body with 200, and still writes the R2 result", async () => {
    const world = heldWorld();
    const r2 = fakeR2();
    const handler = createRunServer(RUN_ENV, { exec: world.exec, fetchFn: r2.fn, workdir: workdir() });
    await post(handler);
    const running = await get(handler);
    expect(running.status).toBe(202);
    expect(await running.json()).toEqual({ state: "running" });

    world.release();
    const done = await untilDone(handler);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ state: "success" });
    expect(r2.puts.map((p) => p.key)).toEqual([RUN.resultKey]);
  });

  it("carries a failed leg's own state and description through GET /result", async () => {
    const world = heldWorld({ legCode: 1 });
    const handler = createRunServer(RUN_ENV, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    await post(handler);
    world.release();
    const done = await untilDone(handler);
    expect(await done.json()).toEqual({ state: "failure", description: "lint exited 1" });
  });

  it("GET /result before any POST /run is a 404, and starts nothing", async () => {
    const world = heldWorld();
    const handler = createRunServer(RUN_ENV, { exec: world.exec, fetchFn: fakeR2().fn, workdir: workdir() });
    expect((await get(handler)).status).toBe(404);
    expect(cloneCount(world.calls)).toBe(0);
    world.release();
  });
});
