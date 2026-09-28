#!/usr/bin/env bun
/**
 * Issue #267 — the pure half of the local CI runner. localci.sh runs the
 * lanes and drops their raw output into a run directory; this file reads
 * that directory into counts, failing test names, the known-flaky rerun
 * decision, and the two commit statuses the run posts.
 *
 *   bun summarize.ts rerun-plan <bun|vitest> <log-or-json> <flaky-list>
 *       prints the files to rerun, one per line (none → rerun nothing)
 *   bun summarize.ts result <run-dir>
 *       writes <run-dir>/result.json, prints "<context>\t<state>\t<description>"
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Failing {
  file: string;
  name: string;
}
export interface LaneCounts {
  parsed: boolean;
  pass: number;
  fail: number;
  skip: number;
  /** Errors outside any test — bun's " N error": a file that failed to load. */
  errors: number;
  failing: Failing[];
}
export type State = "success" | "failure" | "error";
export interface Status {
  context: "local-ci/fleet-check" | "local-ci/english";
  state: State;
  description: string;
}

const FLEET = "local-ci/fleet-check";
const ENGLISH = "local-ci/english";
const MAX_DESC = 140;

/** bun test's text output: "<file>:" headers, "(fail) name [ms]" lines, " N pass" summary. */
export function parseBunTest(text: string): LaneCounts {
  let file = "";
  const failing: Failing[] = [];
  const seen = new Set<string>();
  const num = (label: string) => {
    const m = text.match(new RegExp(`^\\s*(\\d+) ${label}$`, "m"));
    return m ? Number(m[1]) : null;
  };
  for (const line of text.split("\n")) {
    const header = line.match(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/);
    if (header) file = header[1];
    // bun's closing "N tests failed:" recap repeats failures with no header.
    if (/^\d+ tests? (failed|skipped):$/.test(line)) file = "";
    const fail = line.match(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/);
    if (fail && !seen.has(fail[1])) {
      seen.add(fail[1]);
      failing.push({ file, name: fail[1] });
    }
  }
  const pass = num("pass");
  const failCount = num("fail");
  return {
    parsed: pass !== null && failCount !== null,
    pass: pass ?? 0,
    fail: failCount ?? failing.length,
    skip: num("skip") ?? 0,
    errors: num("errors?") ?? 0,
    failing,
  };
}

/** vitest's --reporter=json output (jest-shaped). File names relative to apps/fleet. */
export function parseVitestJson(text: string): LaneCounts {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return { parsed: false, pass: 0, fail: 0, skip: 0, errors: 0, failing: [] };
  }
  const failing: Failing[] = [];
  for (const r of j.testResults ?? []) {
    const file = String(r.name ?? "").replace(/^.*\/apps\/fleet\//, "");
    for (const a of r.assertionResults ?? []) {
      if (a.status === "failed") failing.push({ file, name: a.fullName ?? a.title ?? "" });
    }
    // A file that failed to load has no assertions, only a message.
    if (r.status === "failed" && !(r.assertionResults ?? []).some((a: any) => a.status === "failed")) {
      failing.push({ file, name: "(file failed to load)" });
    }
  }
  return {
    parsed: true,
    pass: j.numPassedTests ?? 0,
    fail: Math.max(j.numFailedTests ?? 0, failing.length),
    skip: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0),
    // vitest reports an unhandled error only as success:false with no failed test.
    errors: j.success === false && failing.length === 0 ? 1 : 0,
    failing,
  };
}

export function parseFlakyList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

/**
 * Rerun only when the lane's output accounts for every failure — parsed, no
 * errors outside a test (a file that failed to load prints no (fail) line),
 * and as many named failures as the runner counted — AND every one of them
 * sits in a known-flaky file. Then rerun just those files.
 */
export function rerunPlan(counts: LaneCounts, flaky: string[]): string[] {
  const { failing } = counts;
  if (failing.length === 0) return [];
  if (!counts.parsed || counts.errors > 0 || counts.fail !== failing.length) return [];
  if (!failing.every((f) => flaky.some((entry) => sameFile(f.file, entry)))) return [];
  return [...new Set(failing.map((f) => f.file))];
}

/**
 * One file named two ways: equal, or one ends with "/" + the other — so a
 * bare name, test/bun/… and apps/fleet/test/bun/… all match, and
 * session-memory.test.ts never matches other-session-memory.test.ts.
 */
function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function parseMeta(text: string | undefined): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) meta[line.slice(0, i)] = line.slice(i + 1);
  }
  return meta;
}

const short = (file: string) => file.replace(/^.*\//, "").replace(/\.test\.[cm]?[jt]sx?$/, "");

function clip(s: string, max = MAX_DESC): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

interface Lane extends LaneCounts {
  exit: number | null;
  ok: boolean;
  rerun?: { files: string[]; exit: number | null; counts: LaneCounts; ok: boolean };
}

function lane(files: Record<string, string>, name: string, parse: (t: string) => LaneCounts, out: string): Lane {
  const exit = files[`${name}.exit`] === undefined ? null : Number(files[`${name}.exit`].trim());
  const counts = parse(files[out] ?? "");
  let ok = exit === 0 && counts.parsed && counts.fail === 0;
  const l: Lane = { ...counts, exit, ok };
  const rerunOut = out.replace(name, `${name}-rerun`);
  // A rerun only rescues a lane whose failures it could have covered at all.
  if (!ok && files[`${name}-rerun.exit`] !== undefined && counts.errors === 0 && counts.fail === counts.failing.length) {
    const rexit = Number(files[`${name}-rerun.exit`].trim());
    const rcounts = parse(files[rerunOut] ?? "");
    const rok = rexit === 0 && rcounts.parsed && rcounts.fail === 0;
    l.rerun = { files: [...new Set(counts.failing.map((f) => f.file))], exit: rexit, counts: rcounts, ok: rok };
    l.ok = rok;
  }
  return l;
}

const exitOk = (v: string | undefined) => v !== undefined && v.trim() === "0";

/**
 * A lane that hit its timeout, or died by a signal (exit >= 128: memguard,
 * OOM, a reboot's TERM), produced no test verdict — that is an error, never
 * failure and never success. localci.sh writes <lane>.timeout (seconds) when
 * its watchdog fired.
 */
function laneError(files: Record<string, string>, names: string[]): string | null {
  for (const n of names) {
    const t = files[`${n}.timeout`];
    if (t !== undefined) {
      const secs = Number(t.trim());
      return `lane ${n} timed out after ${secs % 60 === 0 ? `${secs / 60}m` : `${secs}s`}`;
    }
    const exit = files[`${n}.exit`] === undefined ? 0 : Number(files[`${n}.exit`].trim());
    if (exit >= 128) return `lane ${n} killed (signal ${exit - 128})`;
  }
  return null;
}

export interface Result {
  sha?: string;
  pr?: string;
  base?: string;
  tree?: string;
  lanes: { install?: boolean; check?: boolean; vitest?: Lane; bun?: Lane };
  statuses: Status[];
}

/**
 * #279: every final status names the machine that ran the lanes (meta
 * runner=, "mac" or "studio"). The verdict is clipped first so the suffix
 * always survives GitHub's 140-character limit.
 */
export function computeResult(files: Record<string, string>): Result {
  const result = verdict(files);
  const runner = parseMeta(files.meta).runner;
  if (!runner) return result;
  const suffix = ` · runner=${runner}`;
  return {
    ...result,
    statuses: result.statuses.map((s) => ({ ...s, description: clip(s.description, MAX_DESC - suffix.length) + suffix })),
  };
}

function verdict(files: Record<string, string>): Result {
  const meta = parseMeta(files.meta);
  const base = { sha: meta.sha, pr: meta.pr, base: meta.base, tree: meta.tree };
  const both = (state: State, description: string): Status[] => [
    { context: FLEET, state, description: clip(description) },
    { context: ENGLISH, state, description: clip(description) },
  ];
  if (meta.error) return { ...base, lanes: {}, statuses: both("error", `error: ${meta.error}`) };
  if (meta.conflict) return { ...base, lanes: {}, statuses: both("failure", "conflicts with main") };

  const englishError = laneError(files, ["english"]);
  const english: Status = englishError
    ? { context: ENGLISH, state: "error", description: englishError }
    : exitOk(files["english.exit"])
    ? { context: ENGLISH, state: "success", description: "english-check ok" }
    : { context: ENGLISH, state: "failure", description: "english-check found non-English lines (see log)" };

  if (meta.skip_fleet) {
    return {
      ...base,
      lanes: {},
      statuses: [{ context: FLEET, state: "success", description: clip(`skipped: ${meta.skip_fleet}`) }, english],
    };
  }

  const fleetError = laneError(files, ["install", "check", "vitest", "vitest-rerun", "linux", "linux-rerun"]);
  if (fleetError) {
    return { ...base, lanes: {}, statuses: [{ context: FLEET, state: "error", description: clip(fleetError) }, english] };
  }

  const vitest = lane(files, "vitest", parseVitestJson, "vitest.json");
  const bun = lane(files, "linux", parseBunTest, "linux.log");
  // A runner that ran nothing (config failed to load, wrong runtime, missing
  // script) gave no verdict: an error, never success, never a plain failure.
  for (const [label, l, log] of [["vitest", vitest, "vitest.log"], ["bun", bun, "linux.log"]] as const) {
    if (l.pass + l.fail === 0) {
      return { ...base, lanes: {}, statuses: [{ context: FLEET, state: "error", description: `${label} ran 0 tests (see ${log})` }, english] };
    }
  }
  const install = exitOk(files["install.exit"]);
  const check = exitOk(files["check.exit"]);

  const parts: string[] = [];
  const count = (label: string, l: Lane) => `${label} ${l.pass}/${l.pass + l.fail}`;
  if (!install) parts.push("bun install FAILED");
  parts.push(check ? "tsc ok" : "tsc FAILED");
  parts.push(count("vitest", vitest), count("bun", bun));
  for (const [label, l] of [["vitest", vitest], ["bun", bun]] as const) {
    if (l.rerun?.ok) parts.push(`flaky rerun ok: ${l.rerun.files.map(short).join(",")}`);
    else if (!l.ok) {
      const names = [...new Set(l.failing.map((f) => short(f.file) || "?"))];
      parts.push(names.length ? `${label} red: ${names.join(",")}` : `${label} lane exit ${l.exit}`);
      if (l.rerun) parts.push("flaky rerun failed");
    }
  }
  const ok = install && check && vitest.ok && bun.ok;
  const fleet: Status = { context: FLEET, state: ok ? "success" : "failure", description: clip(parts.join(" · ")) };
  return { ...base, lanes: { install, check, vitest, bun }, statuses: [fleet, english] };
}

function readDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir)) {
    try {
      files[f] = readFileSync(join(dir, f), "utf8");
    } catch {}
  }
  return files;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "rerun-plan") {
    const [kind, out, flakyFile] = args;
    const text = existsSync(out) ? readFileSync(out, "utf8") : "";
    const counts = kind === "vitest" ? parseVitestJson(text) : parseBunTest(text);
    const flaky = existsSync(flakyFile) ? parseFlakyList(readFileSync(flakyFile, "utf8")) : [];
    for (const f of rerunPlan(counts, flaky)) console.log(f);
  } else if (cmd === "result") {
    const result = computeResult(readDir(args[0]));
    writeFileSync(join(args[0], "result.json"), JSON.stringify(result, null, 2) + "\n");
    for (const s of result.statuses) console.log(`${s.context}\t${s.state}\t${s.description}`);
  } else {
    console.error("usage: summarize.ts rerun-plan <bun|vitest> <out> <flaky-list> | result <run-dir>");
    process.exit(2);
  }
}
