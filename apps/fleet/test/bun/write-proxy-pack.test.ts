import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parsePack, PackError, type GitObject } from "../../src/write-proxy/pack";
import { pushText } from "../../src/write-proxy/scan-push";

// Issue #7 Task 2: packfile parser + push text, proven against packs built by
// a real git in a throwaway repo. Never touches the runner's own repo/config.

const REAL_GIT = Bun.which("git");
const LANE = REAL_GIT ? describe : describe.skip;

let dir = "";
const env = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: dir,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Acme Dev", GIT_AUTHOR_EMAIL: "dev@example-org.test",
  GIT_COMMITTER_NAME: "Acme Dev", GIT_COMMITTER_EMAIL: "dev@example-org.test",
});

function git(args: string[], input?: string): Buffer {
  const r = spawnSync("git", args, { cwd: join(dir, "repo"), env: env(), input, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function packOf(stdin: string, flags: string[]): Uint8Array {
  return new Uint8Array(git(["pack-objects", "--stdout", "--revs", ...flags], stdin));
}

// Count delta entries via git verify-pack (type column is space-padded).
function deltaCount(pack: Uint8Array): number {
  const p = join(dir, `probe-${Math.random().toString(36).slice(2)}.pack`);
  writeFileSync(p, pack);
  git(["index-pack", p]);
  const out = git(["verify-pack", "-v", p.replace(/\.pack$/, ".idx")]).toString();
  return out.split("\n").filter((l) => /^[0-9a-f]{40} \S+ +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(l)).length;
}

const BIG = Array.from({ length: 200 }, (_, i) => `acmeclient line ${i} of the example-org ledger`).join("\n");

const LIMITS = { maxInflated: 64 << 20 };
const hexSet = (objs: GitObject[]) => new Set(objs.map((o) => o.oid));

LANE("parsePack + pushText against real git packs", () => {
  let expected = new Set<string>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wp-pack-"));
    mkdirSync(join(dir, "repo"));
    git(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "repo", "dir", "sub"), { recursive: true });
    writeFileSync(join(dir, "repo", "dir", "sub", "file.txt"), "nested acmeclient blob line\n");
    for (let v = 1; v <= 4; v++) {
      writeFileSync(join(dir, "repo", "big.txt"), `${BIG}\nrevision ${v}\n`);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", `acmeclient commit number ${v}`]);
    }
    git(["tag", "-a", "v1", "-m", "example-org tag message"]);
    expected = new Set(git(["rev-list", "--objects", "--all"]).toString().trim().split("\n").map((l) => l.slice(0, 40)));
  });

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("OFS_DELTA pack: oid set equals rev-list --objects --all", async () => {
    const pack = packOf("", ["--all", "--delta-base-offset"]);
    expect(deltaCount(pack)).toBeGreaterThan(0);
    const objs = await parsePack(pack, LIMITS);
    expect(hexSet(objs)).toEqual(expected);
  });

  test("REF_DELTA pack: oid set equals rev-list --objects --all", async () => {
    const pack = packOf("", ["--all"]);
    expect(deltaCount(pack)).toBeGreaterThan(0);
    const objs = await parsePack(pack, LIMITS);
    expect(hexSet(objs)).toEqual(expected);
  });

  test("pushText carries ref, commit message, nested path, blob line, tag message", async () => {
    const objs = await parsePack(packOf("", ["--all", "--delta-base-offset"]), LIMITS);
    const text = pushText(["refs/heads/acmeclient-branch"], objs);
    expect(text).toContain("refs/heads/acmeclient-branch");
    expect(text).toContain("acmeclient commit number 4");
    expect(text).toContain("dir/sub/file.txt");
    expect(text).toContain("nested acmeclient blob line");
    expect(text).toContain("acmeclient line 57 of the example-org ledger");
    expect(text).toContain("example-org tag message");
  });

  test("extra trailing byte → PackError", async () => {
    const pack = packOf("HEAD\n", []);
    const bad = new Uint8Array(pack.length + 1);
    bad.set(pack);
    await expect(parsePack(bad, LIMITS)).rejects.toThrow(PackError);
  });

  test("flipped trailer byte → PackError", async () => {
    const bad = packOf("HEAD\n", []).slice();
    bad[bad.length - 1] ^= 0x01;
    await expect(parsePack(bad, LIMITS)).rejects.toThrow(PackError);
  });

  test("truncated by 30 bytes → PackError", async () => {
    const pack = packOf("HEAD\n", []);
    await expect(parsePack(pack.subarray(0, pack.length - 30), LIMITS)).rejects.toThrow(PackError);
  });

  test("bad magic / version → PackError", async () => {
    const pack = packOf("HEAD\n", []);
    const m = pack.slice(); m[0] = 0x51;
    await expect(parsePack(m, LIMITS)).rejects.toThrow(PackError);
    const v = pack.slice(); v[7] = 4;
    await expect(parsePack(v, LIMITS)).rejects.toThrow(PackError);
  });

  test("thin pack with base outside pack → PackError delta base not in pack", async () => {
    const pack = packOf("HEAD\n^HEAD~1\n", ["--thin"]);
    await expect(parsePack(pack, LIMITS)).rejects.toThrow("delta base not in pack");
  });

  test("same range without --thin parses", async () => {
    const objs = await parsePack(packOf("HEAD\n^HEAD~1\n", []), LIMITS);
    expect(objs.some((o) => o.type === "commit")).toBe(true);
  });

  test("maxInflated tiny → PackError", async () => {
    await expect(parsePack(packOf("", ["--all"]), { maxInflated: 100 })).rejects.toThrow(PackError);
  });
});

describe("pushText tree parsing", () => {
  test("malformed tree throws", () => {
    const bad: GitObject = { type: "tree", data: new TextEncoder().encode("100644 name-without-nul"), oid: "0".repeat(40) };
    expect(() => pushText([], [bad])).toThrow();
  });
});

// Issue #7 review, finding 8: text GitHub renders that a UTF-8 decode misses.
describe("pushText: non-UTF-8 text", () => {
  const obj = (type: "commit" | "tag" | "blob", data: Uint8Array | string) => ({
    type, oid: "0".repeat(40), data: typeof data === "string" ? new TextEncoder().encode(data) : data,
  });
  const TREE = `tree ${"a".repeat(40)}\n`;

  test("a UTF-16LE blob with a BOM is decoded as UTF-16 too", () => {
    const body = new Uint8Array([0xff, 0xfe, ...Array.from("acmeclient").flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(pushText([], [obj("blob", body)])).toContain("acmeclient");
  });

  test("a UTF-16BE blob with a BOM is decoded as UTF-16 too", () => {
    const body = new Uint8Array([0xfe, 0xff, ...Array.from("acmeclient").flatMap((c) => [0, c.charCodeAt(0)])]);
    expect(pushText([], [obj("blob", body)])).toContain("acmeclient");
  });

  test("a commit declaring a non-UTF-8 encoding is refused", () => {
    expect(() => pushText([], [obj("commit", `${TREE}author a <a@x> 1 +0000\nencoding ISO-2022-JP\n\nmsg\n`)])).toThrow(/encoding/);
  });

  test("a tag declaring a non-UTF-8 encoding is refused", () => {
    expect(() => pushText([], [obj("tag", `object ${"a".repeat(40)}\ntype commit\ntag v1\nencoding UTF-16\n\nmsg\n`)])).toThrow(/encoding/);
  });

  test("encoding UTF-8 is fine", () => {
    expect(pushText([], [obj("commit", `${TREE}author a <a@x> 1 +0000\nencoding UTF-8\n\nmsg\n`)])).toContain("msg");
  });
});
