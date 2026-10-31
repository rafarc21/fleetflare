// #715 Phase 1 Task 14: pure fan-out planning for GateWorkflow. No I/O, no
// Workflow/DO bindings — this file is what bun test can load, so
// workflow.ts (which imports cloudflare:workers) stays a thin driver over
// the decisions made here.
import { DEFAULT_GATE_IMAGE, legTimeoutMin, matchesPathRules, MAX_LEGS_PER_PR, type GateLeg } from "./config";
import { bunLaneCwd } from "./bun-lane";
import { BUNDLE_LEG } from "./leg-env";
import type { LegResult, Verdict } from "./verdict";

/** GitHub 422s a commit-status description over 140 chars, which would
 *  silently drop the verdict entirely. */
const MAX_STATUS_CHARS = 140;

export interface RosterInput {
  /** Every planned leg name, in plan order. A leg with no result counts as red. */
  expected: string[];
  results: LegResult[];
  /** The Workflow instance id; the roster names the run by its full id (#1144). */
  runId: string;
}

/** The commit status: state from the verdict, description the per-leg roster
 *  (#1049 addendum): "<n>/<n> green (run <id8>)" on an all-green run, naming any
 *  flaky legs; otherwise "<green>/<total> green; red: <legs> (run <id8>)". */
export function verdictToStatusArgs(
  verdict: Exclude<Verdict, { state: "pending" }>,
  roster: RosterInput,
): { state: "success" | "failure" | "error"; description: string } {
  return { state: verdict.state, description: rosterDescription(roster) };
}

/** The run-start status (#1088): pending on the head, naming the run and how
 *  many legs it fans out to. The verdict overwrites it when the run ends. The
 *  run is named by its full id (#1144): a short tag is not an id `fleet gate
 *  watch` can look up, and two reruns would share it. */
export function pendingStatusArgs(runId: string, legCount: number): { state: "pending"; description: string } {
  return { state: "pending", description: `running (run ${runId}) — ${legCount} legs` };
}

function rosterDescription({ expected, results, runId }: RosterInput): string {
  const byLeg = new Map(results.map((r) => [r.leg, r]));
  const red = expected.filter((leg) => byLeg.get(leg)?.state !== "success");
  const total = expected.length;
  const green = total - red.length;
  const runTag = `(run ${runId})`;
  // #1449: a run whose legs reported parseable test counts carries the totals
  // in the roster, and a leg that ran zero tests is flagged. The container's
  // summary is the only source (the image is frozen): vitest's "Tests ... (N)"
  // and bun's "N pass, M fail". Totals ride BETWEEN the roster body and the run
  // tag, so the tag (what `fleet gate watch` copies) always ends the text.
  const counts = testCountsSuffix(expected, byLeg);
  let head: string;
  let names: string[];
  let tail: string;
  if (red.length > 0) {
    // #1343 LOW: a DID-NOT-RUN leg reads "<leg> (DID-NOT-RUN)", not the bare
    // generic "<leg>" — the zero-spec reason is the headline, never hidden
    // behind "red: e2e".
    head = `${green}/${total} green; red: `;
    names = red.map((leg) => byLeg.get(leg)?.description?.startsWith("DID-NOT-RUN") ? `${leg} (DID-NOT-RUN)` : leg);
    tail = ` ${runTag}`;
  } else {
    const flaky = expected.filter((leg) => byLeg.get(leg)?.description?.startsWith("flaky:"));
    head = flaky.length === 0 ? `${total}/${total} green` : `${total}/${total} green (${flaky.length} flaky: `;
    names = flaky;
    tail = flaky.length === 0 ? ` ${runTag}` : `) ${runTag}`;
  }
  // The counts are the first thing dropped when the roster is long, then the
  // leg names (collapsed by withLegList). The run tag is never cut: GitHub 422s
  // a status over 140 chars, and the tag is what `fleet gate watch` copies.
  const withCounts = withLegList(head, names, `${counts}${tail}`);
  if (withCounts.length <= MAX_STATUS_CHARS) return withCounts;
  return withLegList(head, names, tail);
}

/** Executed/skipped test counts parsed from one leg's stored summary. */
export interface SummaryCounts { run: number; skipped: number }

/** The executed/skipped counts from one stored summary line, or null when the
 *  line is not one of the two formats the container writes. vitest's total is
 *  the "(N)" — executed is that minus any "| K skipped". bun's has no total: run
 *  is pass+fail, and its skip line is not stored (the container keeps only the
 *  pass/fail lines), so a bun leg's skipped count reads 0. */
export function parseSummaryCounts(summary?: string): SummaryCounts | null {
  if (summary === undefined) return null;
  const line = summary.trim();
  const vitest = /Tests\s+.*\((\d+)\)\s*$/.exec(line);
  if (vitest !== null) {
    const total = Number(vitest[1]);
    const skipped = /(\d+)\s+skipped/.exec(line)?.[1];
    const skip = skipped === undefined ? 0 : Number(skipped);
    return { run: total - skip, skipped: skip };
  }
  const pass = /(?:^|,\s*)(\d+)\s+pass\b/.exec(line);
  const fail = /(?:^|,\s*)(\d+)\s+fail\b/.exec(line);
  if (pass === null && fail === null) return null;
  const p = pass === null ? 0 : Number(pass[1]);
  const f = fail === null ? 0 : Number(fail[1]);
  return { run: p + f, skipped: 0 };
}

/** The totals for one expected leg, null when its result carries no summary or
 *  a summary that does not parse. */
function legCounts(leg: string, byLeg: Map<string, LegResult & { summary?: string }>): SummaryCounts | null {
  const summary = byLeg.get(leg)?.summary;
  return summary === undefined ? null : parseSummaryCounts(summary);
}

/** The roster's test-count suffix: "; tests N run, M skipped" plus "; K leg ran
 *  0 tests" when a leg reports zero executed. Empty when no leg's summary parses
 *  — a run with no parseable counts keeps the legacy text byte-identical. */
function testCountsSuffix(expected: string[], byLeg: Map<string, LegResult & { summary?: string }>): string {
  const parsed: SummaryCounts[] = [];
  for (const leg of expected) {
    const c = legCounts(leg, byLeg);
    if (c !== null) parsed.push(c);
  }
  if (parsed.length === 0) return "";
  const run = parsed.reduce((n, c) => n + c.run, 0);
  const skipped = parsed.reduce((n, c) => n + c.skipped, 0);
  const zeroLegs = expected.filter((leg) => legCounts(leg, byLeg)?.run === 0).length;
  let suffix = `; tests ${run} run, ${skipped} skipped`;
  if (zeroLegs > 0) suffix += `; ${zeroLegs} leg${zeroLegs === 1 ? "" : "s"} ran 0 tests`;
  return suffix;
}

/** head + the leg names + tail, within 140 chars. Names are cut from the end
 *  and "+N more" stands in for them; head and tail are always kept whole. */
function withLegList(head: string, names: string[], tail: string): string {
  const full = `${head}${names.join(", ")}${tail}`;
  if (full.length <= MAX_STATUS_CHARS) return full;
  for (let keep = names.length - 1; keep >= 1; keep--) {
    const text = `${head}${names.slice(0, keep).join(", ")}, +${names.length - keep} more${tail}`;
    if (text.length <= MAX_STATUS_CHARS) return text;
  }
  return `${head}+${names.length} more${tail}`;
}

export interface PlanInput {
  owner: string; repo: string; pr: number;
  /** The Workflow instance id: unique per run, so a second run on the same PR
   *  writes its own result keys (a write-once key would 412 otherwise). */
  runId: string;
  headSha: string; baseSha: string;
  install: string; legs: GateLeg[];
  /** The bun-test lane, already packed: one array of lane files per leg. */
  bunShards: string[][];
  /** The block's bunLaneRoot: each bun leg enters this directory first. */
  bunLaneRoot: string;
  /** Absent means the block has no vitest lane: zero vitest legs. */
  vitestCmd?: string; vitestShards: number;
  /** #1319: every generated vitest-N leg's deadline. Absent: the default. */
  vitestTimeoutMin?: number;
  /** #1319: every generated bun-N leg's deadline. Absent: the default. */
  bunTimeoutMin?: number;
  baselineKeys: string[];
  /** The block's image key, carried onto every leg of this plan. Absent: the default image. */
  image?: string;
  /** Renames a planned leg (the head's `@head` names). Absent: the name is kept. */
  legName?: (name: string) => string;
}

export interface PlannedLeg {
  leg: string; commit: string; installCmd: string; legCmd: string;
  resultKey: string; baselineKeys: string[];
  /** The leg's own deadline in minutes. Absent on lanes and default legs: the run applies the default. */
  timeoutMin?: number;
  /** The image key of the block that planned this leg (#1066). Absent: the default image. */
  image?: string;
  /** #1343: the leg is a browser leg — its result is a real verdict only when
   *  spec evidence exists. Absent: a plain leg, no evidence contract. */
  browser?: boolean;
}

/** #1080: the R2 key of one run's git bundle. Keyed by run (the run id is
 *  already one head sha, #1072), so a later run never reads an older base. Under
 *  its own top-level prefix: a bucket lifecycle rule matches a plain prefix only,
 *  and gate/ holds results and baselines that must not expire with it. */
export function bundleKeyFor(owner: string, repo: string, runId: string, headSha: string): string {
  return `gate-bundles/${owner}/${repo}/${runId}/${headSha}.bundle`;
}

/** #1080: the bundle leg's own deadline. A bundle is one clone and one upload;
 *  a hang past this falls back to the legs cloning, not to a 25-minute stall. */
export const BUNDLE_LEG_TIMEOUT_MIN = 5;

/** #1080: the bundle leg's plan. It takes the base..head range like every
 *  other leg, and has no install or test command: it only clones, bundles, and uploads. */
export function planBundleLeg(input: { owner: string; repo: string; pr: number; runId: string; headSha: string; baseSha: string }): PlannedLeg {
  const { owner, repo, pr, runId, headSha, baseSha } = input;
  return {
    leg: BUNDLE_LEG, commit: `${baseSha}..${headSha}`, installCmd: "", legCmd: "",
    resultKey: `gate/${owner}/${repo}/runs/${pr}/${runId}/shard-${BUNDLE_LEG}.json`, baselineKeys: [],
    timeoutMin: BUNDLE_LEG_TIMEOUT_MIN,
  };
}

/** `{i}`/`{n}` are 1-based, matching vitest's own --shard=i/n. Every occurrence
 *  is replaced, so a template that names the shard twice renders consistently. */
export function vitestLegs(vitestCmd: string, shards: number): { leg: string; legCmd: string }[] {
  return Array.from({ length: shards }, (_, idx) => {
    const i = idx + 1;
    return {
      leg: `vitest-${i}`,
      legCmd: vitestCmd.replaceAll("{i}", String(i)).replaceAll("{n}", String(shards)),
    };
  });
}

/** One leg per bun-lane shard, named bun-1..bun-n. Each runs `bun test` on
 *  its own files, entering the block's root first (bunLaneCwd). */
export function bunLegs(shards: string[][], root: string): { leg: string; legCmd: string }[] {
  return shards.map((files, idx) => ({
    leg: `bun-${idx + 1}`,
    legCmd: `${bunLaneCwd(root)}bun test ${files.join(" ")}`,
  }));
}

/** Every leg of one run, in configured order: merge-tree first (it is the
 *  cheap one that proves the PR merges at all), then the block's legs, then
 *  the bun-test shards, then vitest shards. aggregateVerdict reads this order,
 *  so "first failing leg" is deterministic regardless of which container
 *  reports first.
 *
 *  The vitest shard count is clamped so the whole plan never exceeds
 *  MAX_LEGS_PER_PR. Bun shards count against that cap too; parseGateBlock
 *  already rejects blocks that leave no room for one vitest shard when a
 *  vitest lane is configured, so the floor of 1 holds. */
export function planLegs(input: PlanInput): PlannedLeg[] {
  const {
    owner, repo, pr, runId, headSha, baseSha, install, legs, bunShards, bunLaneRoot, vitestCmd, vitestShards, baselineKeys,
    image, legName = (name: string) => name, vitestTimeoutMin, bunTimeoutMin,
  } = input;
  const keyFor = (leg: string) => `gate/${owner}/${repo}/runs/${pr}/${runId}/shard-${leg}.json`;
  const fixedLegs = 1 + legs.length + bunShards.length; // merge-tree + block legs + bun shards
  const shards = Math.max(1, Math.min(vitestShards, MAX_LEGS_PER_PR - fixedLegs));
  // #1274: a per-leg image overrides the block image for that leg alone; lanes
  // (bun/vitest) and merge-tree always take the block's image.
  const leg = (base: string, commit: string, installCmd: string, legCmd: string, keys: string[], timeoutMin?: number, legImage?: string, browser?: boolean): PlannedLeg => {
    const name = legName(base);
    const imageForLeg = legImage ?? image;
    return {
      leg: name, commit, installCmd, legCmd, resultKey: keyFor(name), baselineKeys: keys,
      ...(timeoutMin === undefined ? {} : { timeoutMin }),
      ...(imageForLeg === undefined ? {} : { image: imageForLeg }),
      ...(browser === true ? { browser: true } : {}),
    };
  };
  // Every leg commits to the base..head range: the container resolves the merge
  // and tests that result, so a PR branched before main moved is judged on the
  // merged tree, not its own stale branch.
  const range = `${baseSha}..${headSha}`;
  return [
    leg("merge-tree", range, "", "", []),
    ...legs.map((l) => leg(l.name, range, install, l.cmd, baselineKeys, l.timeoutMin, l.image, l.browser)),
    ...bunLegs(bunShards, bunLaneRoot).map((b) => leg(b.leg, range, install, b.legCmd, baselineKeys, bunTimeoutMin)),
    ...(vitestCmd === undefined ? [] : vitestLegs(vitestCmd, shards))
      .map((v) => leg(v.leg, range, install, v.legCmd, baselineKeys, vitestTimeoutMin)),
  ];
}

/** A head leg's name (#1091 review): `<leg>@head`, shards `<lane>@head-<n>`.
 *  merge-tree keeps its name: the container keys off `leg === "merge-tree"`. */
export function headLegName(name: string): string {
  if (name === "merge-tree") return name;
  const shard = /^(vitest|bun)-(\d+)$/.exec(name);
  return shard ? `${shard[1]}@head-${shard[2]}` : `${name}@head`;
}

/** A leg's runnable identity: the install, the command, the deadline, the
 *  image it runs on and its browser contract, each normalized to the value the
 *  leg actually runs with (#1091 review round 2; #1230 review: planFingerprint
 *  shares this so an unset `timeoutMin`/`image` and its explicit default
 *  fingerprint the same — they are the identical run, not a different one.
 *  #1343: `browser` is part of the identity: flipping it changes the leg's
 *  verdict contract (DID-NOT-RUN), so the head copy must rerun). */
function legIdentity(l: PlannedLeg): [string, string, number, string, boolean] {
  return [l.installCmd, l.legCmd, legTimeoutMin(l.timeoutMin), l.image ?? DEFAULT_GATE_IMAGE, l.browser === true];
}

/** A leg's runnable content (#1091 review round 2). Two legs with the same
 *  content run once; a leg that differs in any of them runs again as its head copy. */
function legContent(l: PlannedLeg): string {
  return JSON.stringify(legIdentity(l));
}

/** The legs of a run whose PR changes fleet.json (#1091 review). Every base
 *  leg runs in full (integrity). Each head leg whose content differs from every
 *  base leg runs too, named `<leg>@head`. Identical legs run once, under the base
 *  name. A null side has no legs: no base config, or no head config to union.
 *  merge-tree is one leg whatever the configs say: the base's copy runs, and
 *  the head's is added only when there is no base to carry it. */
export function planUnionLegs(base: PlanInput | null, head: PlanInput | null): PlannedLeg[] {
  const baseLegs = base === null ? [] : planLegs(base);
  if (head === null) return baseLegs;
  const seen = new Set(baseLegs.map(legContent));
  const headLegs = planLegs({ ...head, legName: headLegName })
    .filter((l) => !seen.has(legContent(l)) && !(l.leg === "merge-tree" && baseLegs.length > 0));
  return [...baseLegs, ...headLegs];
}

// #1230: carrying a prior run's green legs into a rerun, so the rerun only
// dispatches the legs that are not already green.
export interface CarryGreen {
  headSha: string;
  baseSha: string;
  planFingerprint: string;
  legs: LegResult[];
}

/** One run's planned legs, fingerprinted by their runnable content (leg name +
 *  install/cmd/timeout/image, normalized by the SAME legIdentity legContent
 *  uses for planUnionLegs, but WITH the leg name and over the WHOLE plan:
 *  this compares two different runs' plans, not a base vs. head leg within
 *  one). Two runs that plan identical legs get the same fingerprint; any
 *  difference (a changed fleet.json, a different shard count) changes it. */
export function planFingerprint(legs: PlannedLeg[]): string {
  return JSON.stringify(legs.map((l) => [l.leg, ...legIdentity(l)]));
}

/** #1274: the legs that run for a PR, per-leg `paths` filters applied. A leg
 *  with no `paths` always runs; one with `paths` runs when a changed file
 *  matches it. Fail-open toward running: a truncated change list or a PR that
 *  changed the gate config itself runs every filtered leg — the list is
 *  incomplete, or the config is the thing under test, so a filter must never
 *  silently skip it. The block's own pathRules gate the whole run; this filters
 *  within it. */
export function legsForChangedFiles(
  legs: GateLeg[], changedFiles: string[], ctx: { truncated: boolean; configChanged: boolean },
): GateLeg[] {
  const runAll = ctx.truncated || ctx.configChanged;
  return legs.filter((l) => l.paths === undefined || runAll || matchesPathRules(changedFiles, l.paths));
}

/** A run's green legs: `state === "success"`, the only state a carry may ever
 *  pass forward (#1230). The one filter every carry producer and consumer
 *  shares, so none hand-rolls its own copy. */
export function greenLegsOf<T extends LegResult>(legs: T[]): T[] {
  return legs.filter((l) => l.state === "success");
}

/** The prior run's green legs, valid ONLY while head sha, base sha and the
 *  plan fingerprint all match this run's own resolve (#1230): a carry from a
 *  different sha or a changed config must never count, so a mismatch returns
 *  an empty map — the caller then runs every leg fresh, same as no carry at
 *  all. Filters to `state === "success"` itself (via greenLegsOf): a caller
 *  must only ever put green legs in `carry.legs`, but this must not trust
 *  that blindly. */
export function carriedGreenByLeg(
  carry: CarryGreen | undefined, ctx: { headSha: string; baseSha: string; planFingerprint: string },
): Map<string, LegResult> {
  if (
    carry === undefined || carry.headSha !== ctx.headSha || carry.baseSha !== ctx.baseSha
    || carry.planFingerprint !== ctx.planFingerprint
  ) {
    return new Map();
  }
  return new Map(greenLegsOf(carry.legs).map((l) => [l.leg, l]));
}

const LEG_STATES = new Set<LegResult["state"]>(["success", "failure", "error"]);

/** What a leg reports beside its state (#1049): wall time summed over its
 *  attempts, and the test summary line from its own output. Both optional. */
export interface LegRunMeta { ms?: number; summary?: string }

/** The leg name is forced to the planned one, whatever the DO echoed back. An
 *  unknown state becomes error: a malformed report must never read as success. */
export function normalizeLegResult(planned: string, payload: LegResult & LegRunMeta): LegResult & LegRunMeta {
  if (!LEG_STATES.has(payload.state)) {
    return { leg: planned, state: "error", description: `${planned} returned an unknown state` };
  }
  return {
    leg: planned, state: payload.state, description: payload.description, ms: payload.ms, summary: payload.summary,
  };
}

/** One leg as the status route reports it, in plan order (#1049). */
export interface OutcomeLeg {
  leg: string;
  state: LegResult["state"];
  ms?: number;
  summary?: string;
  description?: string;
}

/** Per-leg output for the Workflow's final result. `results` is already in
 *  plan order: legs run under Promise.all, which keeps order. */
export function outcomeLegs(results: (LegResult & LegRunMeta)[]): OutcomeLeg[] {
  return results.map((r) => ({
    leg: r.leg, state: r.state, ms: r.ms, summary: r.summary, description: r.description,
  }));
}
