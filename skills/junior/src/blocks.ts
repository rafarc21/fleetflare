// Edit blocks the junior model returns, validated before the senior sees them.
// Every SEARCH must match exactly once; a miss is an error, never a guess.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface EditBlock { path: string; search: string; replace: string }
export type ApplyResult = { ok: true; after: Map<string, string> } | { ok: false; error: string };

const BLOCK_RE = /^([^\n]*)\n<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/gm;
const FENCE_RE = /^```[\w-]*\s*$/gm;

function cleanPath(raw: string): string {
  return raw.trim().replace(/^(file|path)\s*:\s*/i, "").replace(/^[*`"']+|[*`"':]+$/g, "").trim();
}

export function parseBlocks(text: string): EditBlock[] {
  const body = text.replace(/\r\n/g, "\n").replace(FENCE_RE, "");
  const out: EditBlock[] = [];
  for (const m of body.matchAll(BLOCK_RE)) {
    out.push({ path: cleanPath(m[1]), search: m[2], replace: m[3] });
  }
  return out;
}

function outsideRepo(path: string): boolean {
  return path.startsWith("/") || path.split("/").some((seg) => seg === "..");
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function applyBlocks(
  before: Map<string, string>, blocks: EditBlock[], existsOnDisk: (path: string) => boolean,
): ApplyResult {
  if (blocks.length === 0) return { ok: false, error: "no edit blocks found in output" };
  const after = new Map(before);
  for (const [i, b] of blocks.entries()) {
    const n = i + 1;
    if (outsideRepo(b.path)) return { ok: false, error: `block ${n}: path ${b.path} is outside the repository` };
    if (b.search === "") {
      if (before.has(b.path) || after.has(b.path) || existsOnDisk(b.path)) {
        return { ok: false, error: `block ${n} (${b.path}): empty SEARCH creates a file, but ${b.path} already exists` };
      }
      after.set(b.path, b.replace.endsWith("\n") ? b.replace : `${b.replace}\n`);
      continue;
    }
    const cur = after.get(b.path);
    if (cur === undefined) return { ok: false, error: `block ${n} names ${b.path}, which was not given as input` };
    const crlf = cur.includes("\r\n");
    const search = crlf ? b.search.replace(/\n/g, "\r\n") : b.search;
    const replace = crlf ? b.replace.replace(/\n/g, "\r\n") : b.replace;
    const c = count(cur, search);
    if (c !== 1) return { ok: false, error: `block ${n} (${b.path}): SEARCH matched ${c} times, must match exactly once` };
    const at = cur.indexOf(search);
    after.set(b.path, cur.slice(0, at) + replace + cur.slice(at + search.length));
  }
  return { ok: true, after };
}

function fixHeader(line: string): string {
  if (line.startsWith("diff --git ")) return line.replace(" a/a/", " a/").replace(" b/b/", " b/");
  if (line.startsWith("--- a/a/")) return `--- a/${line.slice(8)}`;
  if (line.startsWith("+++ b/b/")) return `+++ b/${line.slice(8)}`;
  return line;
}

export function toUnifiedDiff(before: Map<string, string>, after: Map<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "junior-diff-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    const put = (side: string, path: string, content: string) => {
      const f = join(root, side, path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
    };
    for (const [p, c] of before) put("a", p, c);
    for (const [p, c] of after) put("b", p, c);
    const r = spawnSync("git", [
      "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
      "diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "a", "b",
    ], { cwd: root, encoding: "utf8" });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
    return r.stdout === "" ? "" : r.stdout.split("\n").map(fixHeader).join("\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
