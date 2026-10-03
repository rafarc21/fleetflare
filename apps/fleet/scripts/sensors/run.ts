#!/usr/bin/env bun
/**
 * Board issue #187 (#168 phase 2) — turns the design doc's
 * (`docs/superpowers/specs/2026-10-01-sensor-task-control-loop-168-design.md`)
 * dampener rule and pinned-issue visibility mechanism into real, runnable
 * code for the two sensors it named as buildable today with no new
 * credential: CI failures (`fleet-check.yml`, `main`-only, last 50 runs)
 * and known-flaky count (`apps/fleet/scripts/localci/known-flaky.txt`).
 *
 * Board issue #208 (ask 3) added a THIRD sensor: platform container
 * replacements, fleet-wide, per day. The per-studio counter this rolls up
 * already exists (`src/studio/restarts.ts`'s `RestartLog`/`restartsInWindow`,
 * already surfaced per-studio as `fleet ls`'s RST column) — this sensor does
 * not reimplement replacement DETECTION, only sums that existing count
 * across every studio `GET /studio/` returns, the SAME endpoint and
 * credential seam `cmdLs` (cli/fleet.ts) already uses (`loadCredentials`/
 * `accessHeaders`, reused here rather than re-implemented).
 *
 *   bun run scripts/sensors/run.ts [--dry-run]
 *
 * Still record-only, same as `scripts/sensors/measure.sh` (the earlier
 * read-only spike this supersedes for these two sensors): no auto-filing
 * of a board task, no CI gate wired. Each run reads the pinned
 * `fleet: sensor burn log` issue's own body for the PREVIOUS run's
 * baseline numbers (carried forward in a hidden HTML-comment JSON block —
 * see `parseState`/`renderBody`), computes this run's dampener state
 * against that baseline, then rewrites the issue body with this run's
 * numbers as the new baseline for the NEXT run. No separate state store.
 *
 * `--dry-run`: does the real `gh run list`/`gh issue list` READS (so the
 * printed dampener state is the real comparison against the real pinned
 * issue), but skips the `gh issue edit`/`gh issue create` WRITE, printing
 * the computed body to stdout instead. Used in review so this doesn't
 * repeatedly touch the real issue. Without the flag: writes for real —
 * intended once a scheduled workflow (not part of this PR) calls it.
 *
 * `SENSOR_REPO` env var overrides the default `rafarc21/fleetflare`.
 *
 * Pure compute (`dampenerState`, `buildReport`, `parseState`,
 * `renderBody`) is exported and under test
 * (`test/bun/sensors-run.test.ts`) with no subprocess/fs involved — same
 * "pure compute fn + thin CLI I/O under `if (import.meta.main)`" shape as
 * `scripts/merge-danger.ts`. Everything below that line is thin I/O: one
 * `gh run list`, one file read, one `gh issue list`, one
 * `gh issue edit`/`gh issue create`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials, accessHeaders } from "../../cli/fleet";
import { restartsInWindow } from "../../src/studio/restarts";
import type { StudioStatus } from "../../src/studio/types";

const PINNED_ISSUE_TITLE = "fleet: sensor burn log";
const FLEET_CHECK_WORKFLOW = "fleet-check.yml";
const CI_WINDOW = 50;
const STATE_COMMENT_RE = /<!--\s*fleet-sensor-state\s*([\s\S]*?)-->/;

export type Dampener = "FIRED" | "OK";

/** Pure. FIRED when `current` exceeds `baseline + slack`, else OK — the
 *  design doc's absolute-count-plus-slack dampener rule. */
export function dampenerState(current: number, baseline: number, slack = 1): Dampener {
  return current > baseline + slack ? "FIRED" : "OK";
}

export interface RawSensorInputs {
  ciFailures: number;
  ciTotal: number;
  knownFlaky: number;
  /** Board issue #208 (ask 3) — summed `restartsInWindow` across every
   *  studio `GET /studio/` returns, fleet-wide, for the last 24h. */
  platformReplacements: number;
}

export interface PreviousBaselines {
  ciFailures: number | null;
  knownFlaky: number | null;
  platformReplacements: number | null;
}

export interface SensorResult {
  current: number;
  baseline: number;
  dampener: Dampener;
}

export interface Report {
  ciFailures: SensorResult & { total: number };
  knownFlaky: SensorResult;
  platformReplacements: SensorResult;
}

/**
 * Pure. `previous` holds the PREVIOUS run's recorded baseline per sensor
 * (or null on the very first run ever). When null, baseline = this run's
 * own current number — the first run is always OK, never a false FIRED,
 * since the whole point is rolling the baseline forward each run instead
 * of hardcoding it (design doc, "Dampener design").
 */
export function buildReport(raw: RawSensorInputs, previous: PreviousBaselines, slack = 1): Report {
  const ciBaseline = previous.ciFailures ?? raw.ciFailures;
  const flakyBaseline = previous.knownFlaky ?? raw.knownFlaky;
  const platformBaseline = previous.platformReplacements ?? raw.platformReplacements;
  return {
    ciFailures: {
      current: raw.ciFailures,
      total: raw.ciTotal,
      baseline: ciBaseline,
      dampener: dampenerState(raw.ciFailures, ciBaseline, slack),
    },
    knownFlaky: {
      current: raw.knownFlaky,
      baseline: flakyBaseline,
      dampener: dampenerState(raw.knownFlaky, flakyBaseline, slack),
    },
    platformReplacements: {
      current: raw.platformReplacements,
      baseline: platformBaseline,
      dampener: dampenerState(raw.platformReplacements, platformBaseline, slack),
    },
  };
}

/**
 * Pure, never throws. Pulls the previous run's baseline numbers back out
 * of the pinned issue's own body text, via the hidden
 * `<!-- fleet-sensor-state ... -->` JSON block `renderBody` writes. Any
 * missing block, malformed JSON, or missing field is a silent fallback to
 * null for that field — never an exception (a sensor run with no readable
 * previous state must still proceed as a first run, not crash).
 */
export function parseState(body: string | null | undefined): PreviousBaselines {
  const none: PreviousBaselines = { ciFailures: null, knownFlaky: null, platformReplacements: null };
  if (!body) return none;
  const m = body.match(STATE_COMMENT_RE);
  if (!m) return none;
  try {
    const parsed = JSON.parse(m[1]) as Record<string, unknown>;
    const ciFailures = typeof parsed?.ciFailures === "number" ? parsed.ciFailures : null;
    const knownFlaky = typeof parsed?.knownFlaky === "number" ? parsed.knownFlaky : null;
    const platformReplacements = typeof parsed?.platformReplacements === "number" ? parsed.platformReplacements : null;
    return { ciFailures, knownFlaky, platformReplacements };
  } catch {
    return none;
  }
}

/**
 * Pure. The full pinned issue body: a markdown table (window, current,
 * baseline, dampener) per sensor, the rate-cap line, a timestamp, and the
 * hidden state comment carrying THIS run's current numbers forward as the
 * NEXT run's baseline — round-trips with `parseState` by construction.
 */
export function renderBody(report: Report, timestamp: string): string {
  const state = JSON.stringify({
    ciFailures: report.ciFailures.current,
    knownFlaky: report.knownFlaky.current,
    platformReplacements: report.platformReplacements.current,
  });
  return [
    "# fleet sensor burn log",
    "",
    "Board issue #187 (#168 phase 2) — record-only. No board task is auto-filed",
    "by this run, and no CI gate is wired to the dampener state below.",
    "",
    "Rate cap: TBD, pending operator decision — filing disabled (record-only)",
    `Last run: ${timestamp}`,
    "",
    "| sensor | window | current | baseline | dampener |",
    "| --- | --- | --- | --- | --- |",
    `| CI failures (${FLEET_CHECK_WORKFLOW}, main) | last ${report.ciFailures.total} runs | ${report.ciFailures.current} | ${report.ciFailures.baseline} | ${report.ciFailures.dampener} |`,
    `| known-flaky entries | current list | ${report.knownFlaky.current} | ${report.knownFlaky.baseline} | ${report.knownFlaky.dampener} |`,
    // Board issue #208 (ask 3): platform container replacements, fleet-wide,
    // per day — the same RST count `fleet ls` already shows per-studio
    // (restarts.ts's `restartsInWindow`), summed across the whole fleet.
    `| platform replacements (fleet-wide, 24h) | last 24h | ${report.platformReplacements.current} | ${report.platformReplacements.baseline} | ${report.platformReplacements.dampener} |`,
    "",
    "<!-- fleet-sensor-state",
    state,
    "-->",
    "",
  ].join("\n");
}

// --- Thin I/O below. No business logic — gather numbers, one gh read, one
// gh write (skipped under --dry-run). ---

function runGh(args: string[]): string {
  const proc = Bun.spawnSync(["gh", ...args]);
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

async function readCiFailures(repo: string): Promise<{ failures: number; total: number }> {
  const out = runGh([
    "run", "list",
    "--repo", repo,
    `--workflow=${FLEET_CHECK_WORKFLOW}`,
    "--branch", "main",
    "--limit", String(CI_WINDOW),
    "--json", "conclusion",
  ]);
  const runs = JSON.parse(out) as Array<{ conclusion: string }>;
  const failures = runs.filter((r) => r.conclusion === "failure").length;
  return { failures, total: runs.length };
}

async function readKnownFlakyCount(): Promise<number> {
  const path = join(import.meta.dir, "..", "localci", "known-flaky.txt");
  const text = await Bun.file(path).text();
  return text.split("\n").filter((line) => /^test\//.test(line)).length;
}

/**
 * Board issue #208 (ask 3) — fleet-wide platform container replacements in
 * the last 24h: the SAME `GET /studio/` endpoint and credential seam
 * `cmdLs` (cli/fleet.ts) already uses, reusing its `loadCredentials`/
 * `accessHeaders` rather than re-implementing either. Sums the EXISTING
 * per-studio count (`restartsInWindow`, restarts.ts) across every studio the
 * Worker returns — this does not re-detect a replacement, only rolls up a
 * counter that already exists and is already surfaced per-studio
 * (`fleet ls`'s RST column).
 *
 * No bespoke soft-fail wrapper: `readCiFailures`/`readKnownFlakyCount` above
 * carry none either (a `gh` failure or an unreadable known-flaky.txt
 * propagates uncaught, same as `main`'s own `Promise.all` has always let it)
 * — this sensor's own failure (no credentials file, an unreachable Worker)
 * is left to propagate exactly the same way, rather than inventing a new,
 * sensor-specific isolation this script has never had for the other two.
 */
async function readPlatformReplacements(): Promise<number> {
  const creds = await loadCredentials();
  const res = await fetch(new URL("/studio/", creds.workerUrl), {
    headers: { ...accessHeaders(creds), Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET /studio/ failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const studios = (await res.json()) as StudioStatus[];
  const now = new Date();
  return studios.reduce((sum, s) => sum + restartsInWindow(s.observed?.restarts, now), 0);
}

interface PinnedIssue {
  number: number;
  body: string;
}

async function findPinnedIssue(repo: string): Promise<PinnedIssue | null> {
  const out = runGh([
    "issue", "list",
    "--repo", repo,
    "--state", "all",
    "--search", `${PINNED_ISSUE_TITLE} in:title`,
    "--json", "number,title,body",
  ]);
  const issues = JSON.parse(out) as Array<{ number: number; title: string; body: string }>;
  const exact = issues.find((i) => i.title === PINNED_ISSUE_TITLE);
  return exact ? { number: exact.number, body: exact.body } : null;
}

async function writePinnedIssue(repo: string, existing: PinnedIssue | null, body: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fleet-sensor-"));
  const bodyFile = join(dir, "body.md");
  try {
    await writeFile(bodyFile, body, "utf8");
    if (existing) {
      runGh(["issue", "edit", String(existing.number), "--repo", repo, "--body-file", bodyFile]);
    } else {
      runGh(["issue", "create", "--repo", repo, "--title", PINNED_ISSUE_TITLE, "--body-file", bodyFile]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const repo = process.env.SENSOR_REPO ?? "rafarc21/fleetflare";
  const dryRun = process.argv.includes("--dry-run");

  const [{ failures: ciFailures, total: ciTotal }, knownFlaky, platformReplacements, existing] = await Promise.all([
    readCiFailures(repo),
    readKnownFlakyCount(),
    readPlatformReplacements(),
    findPinnedIssue(repo),
  ]);

  const previous = parseState(existing?.body);
  const report = buildReport({ ciFailures, ciTotal, knownFlaky, platformReplacements }, previous);
  const body = renderBody(report, new Date().toISOString());

  if (dryRun) {
    console.log(body);
    return;
  }
  await writePinnedIssue(repo, existing, body);
}

if (import.meta.main) {
  await main();
}
