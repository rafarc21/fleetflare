/**
 * Finding F6 of docs/maintainability/2026-10-10-deep-modules-sweep-2.md
 * (board issue #321): the list → read → scan → report → exit dance that
 * scripts/english-check.ts (#66) and scripts/test-lies-check.ts
 * (#174/#164) each grew a copy of, drifted between (stderr vs stdout
 * findings, a second `git ls-files` run only to count files), and now
 * share here. Tier: GLM-OK, behavior-preserving — both scripts keep their
 * exact CLI bytes (pinned by test/bun/repo-check-runner.test.ts).
 *
 * Each script keeps its own detectors, allowlist, escape point, and
 * output stream; the runner never touches those. It owns only the
 * mechanics: one `git ls-files -z`, select + allowlist filtering, reading
 * each listed file (skipping binaries — a NUL byte — for text-decoding
 * safety), collecting `scanFile` hits, the report lines, and the exit
 * code.
 *
 * Stream contract, matching both scripts' bytes exactly: findings and
 * `failSummary` go to `opts.stream` (english-check: stderr; test-lies-
 * check: stdout). `cleanLine` ALWAYS goes to stdout, because both
 * scripts' clean/summary output is stdout — english-check's findings are
 * stderr, but its clean line is stdout; test-lies-check's everything is
 * stdout (its count line prints on both paths: as `cleanLine` when
 * clean, as `failSummary` when not).
 *
 * Library only — no `import.meta.main` block. Each script's main becomes
 * `process.exit(await runRepoCheck({ ... }))` (Tasks 3-4 of
 * docs/plans/2026-10-10-refactor-321-repo-check-runner.md).
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
  failSummary: (findings: Array<F & { path: string }>, fileCount: number | string | undefined) => string;
  /** Printed to stdout only when there are no findings — always stdout (see header). */
  cleanLine: (fileCount: number | string | undefined) => string;
  cleanExit: number;
  /** test-lies-check's "across N test files" count, derived from the
   *  runner's own single listing (drops the second `git ls-files` its
   *  main ran only to count). */
  fileCount?: (listed: string[]) => number | string;
}

/** The one listing+collect pass both exports share, so the dance exists
 *  exactly once: a single `git ls-files -z`, select + allowlist filtering,
 *  then read (skip missing, skip binaries — a NUL byte — for text-decoding
 *  safety) + `scanFile` per listed file. */
async function scanOnce<F extends object>(
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

/** The scan half of the dance, for callers (and tests) that want findings
 *  without printing or exiting — the same single `git ls-files` + select +
 *  allowlist + read + binary-skip + scanFile collect runRepoCheck prints
 *  from, extracted so scanRepo-style exports don't grow a second copy. */
export async function collectRepoCheck<F extends object>(
  root: string,
  select: (path: string) => boolean,
  scanFile: (path: string, text: string) => F[],
  allowlist: Record<string, string>,
): Promise<Array<F & { path: string }>> {
  return (await scanOnce(root, select, scanFile, allowlist)).findings;
}

export async function runRepoCheck<F extends object>(opts: RepoCheckOpts<F>): Promise<number> {
  const { listed, findings } = await scanOnce(opts.root, opts.select, opts.scanFile, opts.allowlist);
  const fileCount = opts.fileCount ? opts.fileCount(listed) : undefined;
  const print = opts.stream === "stderr" ? console.error : console.log;
  if (findings.length > 0) {
    for (const f of findings) print(opts.format(f.path, f));
    print(opts.failSummary(findings, fileCount));
    return 1;
  }
  console.log(opts.cleanLine(fileCount));
  return opts.cleanExit;
}
