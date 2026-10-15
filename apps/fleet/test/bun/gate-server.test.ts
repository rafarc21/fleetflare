import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreBaseline, putResult, type FetchFn } from "../../container/gate-server";
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

  it("verifies the node tarball and the rustup-init binary by checksum (#1011, #1037)", () => {
    expect(raw).toContain("sha256sum -c");
    expect(raw).toContain("node-v22.23.3-linux-x64.tar.xz");
    expect(raw).toContain("20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c  /tmp/rustup-init");
    expect(raw).toMatch(/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1\.96\.0/);
  });

  it("copies only the two container sources and repro-seal into the image", () => {
    expect(raw).toContain("COPY repro-seal.sh gate-server.ts gate-merge-tree.ts /src/");
  });

  it("starts gate-server.ts by absolute path, on port 8080", () => {
    expect(instructions).toContain('CMD ["bun", "run", "/app/gate-server.ts"]');
    expect(raw).toContain("ENV PORT=8080");
  });
});
