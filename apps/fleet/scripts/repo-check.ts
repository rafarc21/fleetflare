/**
 * The one list → read → scan → report → exit dance behind english-check and
 * test-lies-check: a single `git ls-files -z` listing, select + allowlist
 * filtering, NUL-byte binary skip, per-file read + `scanFile` collect, the
 * report lines, and the exit code (1 with findings, 0 clean). Stream
 * contract: findings and `failSummary` go to `opts.stream`, while `cleanLine`
 * is always stdout — both scripts' clean output is stdout even when their
 * findings are stderr.
 */
import { join } from "node:path";

export interface RepoCheckOpts<F> {
  root: string;
  select: (path: string) => boolean;
  scanFile: (path: string, text: string) => F[];
  allowlist: Record<string, string>;
  format: (path: string, hit: F) => string;
  /** Where findings and `failSummary` go (english-check: stderr; test-lies-check: stdout). */
  stream: "stdout" | "stderr";
  /** Printed to `stream` only when findings exist. The 2nd argument is the
   *  same `fileCount` value `cleanLine` receives — test-lies-check's count
   *  line prints on both the findings and the clean path, and needs the
   *  file count on both. */
  failSummary: (findings: Array<F & { path: string }>, fileCount: number | undefined) => string;
  /** Printed to stdout only when there are no findings — always stdout (see header). */
  cleanLine: (fileCount: number | undefined) => string;
  /** test-lies-check's "across N test files" count, derived from the
   *  runner's own single listing (drops the second `git ls-files` its
   *  main ran only to count). */
  fileCount?: (listed: string[]) => number;
}

/** The one scan pass behind everything: a single `git ls-files -z`, select +
 *  allowlist filtering, then read (skip missing, skip binaries — a NUL
 *  byte — for text-decoding safety) + `scanFile` per listed file.
 *  `runRepoCheck` prints from it and the scripts' own `scanRepo` exports
 *  collect from it, so the dance exists exactly once. */
export async function scanRepoFiles<F extends object>(
  root: string,
  select: (path: string) => boolean,
  scanFile: (path: string, text: string) => F[],
  allowlist: Record<string, string>,
): Promise<{ listed: string[]; findings: Array<F & { path: string }> }> {
  const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (ls.exitCode !== 0) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
  const listed = ls.stdout.toString().split("\0").filter(Boolean)
    .filter(select).filter((p) => !(p in allowlist));
  const findings: Array<F & { path: string }> = [];
  for (const path of listed) {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) continue; // binary
    for (const hit of scanFile(path, new TextDecoder().decode(bytes))) findings.push({ path, ...hit });
  }
  return { listed, findings };
}

export async function runRepoCheck<F extends object>(opts: RepoCheckOpts<F>): Promise<number> {
  const { listed, findings } = await scanRepoFiles(opts.root, opts.select, opts.scanFile, opts.allowlist);
  const fileCount = opts.fileCount ? opts.fileCount(listed) : undefined;
  const print = opts.stream === "stderr" ? console.error : console.log;
  if (findings.length > 0) {
    for (const f of findings) print(opts.format(f.path, f));
    print(opts.failSummary(findings, fileCount));
    return 1;
  }
  console.log(opts.cleanLine(fileCount));
  return 0;
}
