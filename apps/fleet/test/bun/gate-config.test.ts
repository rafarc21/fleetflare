import { describe, it, expect } from "bun:test";
import { MAX_LEG_TIMEOUT_MIN } from "../../src/gate/config";
import {
  parseGateRunnerRepos, isGateRunnerRepo, parseGateBlock, gateMapEntry, matchesPathRules,
  DEFAULT_VITEST_SHARDS, DEFAULT_BUN_SHARDS, MAX_LEGS_PER_PR, legTimeoutMin,
  GATE_IMAGES, fleetJsonChanged, gateDecision, decideGateRun, headFleetJsonFailure,
  gateMapHasInvalidEntry,
  guardSuccessStatus, sharedHeadFailure,
} from "../../src/gate/config";
import FLEET_JSON from "../../../../fleet.json";

const BASE_SHA = "b".repeat(40);

// Fixture repos are neutral on purpose (this repo is public).
const BLOCK = { install: "x", legs: [], vitestCmd: "t", pathRules: ["a/**"] };
const names = (n: number) => Array.from({ length: n }, (_, i) => `leg-${i}`);

describe("parseGateRunnerRepos", () => {
  it("absent/empty -> no repos gated in", () => {
    expect(parseGateRunnerRepos(undefined)).toEqual([]);
    expect(parseGateRunnerRepos("")).toEqual([]);
  });
  it("comma-separated, trimmed, lowercased", () => {
    expect(parseGateRunnerRepos(" Acme/Example , other/repo ")).toEqual([
      "acme/example", "other/repo",
    ]);
  });
});

describe("isGateRunnerRepo", () => {
  it("case-insensitive match", () => {
    expect(isGateRunnerRepo("acme/example", "Acme/Example")).toBe(true);
  });
  it("no match when repo not listed", () => {
    expect(isGateRunnerRepo("acme/example", "other/repo")).toBe(false);
  });
});

describe("parseGateBlock: a well-formed block", () => {
  it("parses every field; string legs become { name, cmd: bun run <name> }", () => {
    const cfg = parseGateBlock({
      install: "bun install --frozen-lockfile", legs: ["typecheck", "lint"],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
    });
    expect(cfg).toEqual({
      install: "bun install --frozen-lockfile",
      legs: [
        { name: "typecheck", cmd: "bun run typecheck" },
        { name: "lint", cmd: "bun run lint" },
      ],
      vitestCmd: "bun run test --shard={i}/{n}", pathRules: ["apps/fleet/**"],
      vitestShards: DEFAULT_VITEST_SHARDS, bunShards: DEFAULT_BUN_SHARDS,
    });
  });
  it("null on a missing or non-object block, not a throw", () => {
    expect(parseGateBlock(undefined)).toBeNull();
    expect(parseGateBlock(null)).toBeNull();
    expect(parseGateBlock("gate")).toBeNull();
  });
  it("null on a block missing a required field", () => {
    expect(parseGateBlock({ install: "x" })).toBeNull();
  });
});

describe("parseGateBlock: object legs", () => {
  it("an object leg keeps its own cmd verbatim", () => {
    const cfg = parseGateBlock({
      ...BLOCK, legs: [{ name: "e2e", cmd: "cd apps/web && bun run e2e -- --bail" }],
    });
    expect(cfg?.legs).toEqual([{ name: "e2e", cmd: "cd apps/web && bun run e2e -- --bail" }]);
  });
  it("an object leg's timeoutMin is read as its per-leg deadline", () => {
    const cfg = parseGateBlock({ ...BLOCK, legs: [{ name: "e2e", cmd: "make e2e", timeoutMin: 12 }] });
    expect(cfg?.legs).toEqual([{ name: "e2e", cmd: "make e2e", timeoutMin: 12 }]);
  });
  it("a timeoutMin above MAX_LEG_TIMEOUT_MIN (25) is clamped to it, below 1 to 1, and a fraction rounds down", () => {
    const cfg = parseGateBlock({
      ...BLOCK,
      legs: [{ name: "slow", cmd: "c", timeoutMin: 99 }, { name: "zero", cmd: "c", timeoutMin: 0 }, { name: "frac", cmd: "c", timeoutMin: 7.9 }],
    });
    expect(cfg?.legs.map((l) => l.timeoutMin)).toEqual([MAX_LEG_TIMEOUT_MIN, 1, 7]);
  });
  it("null on an object leg whose timeoutMin is not a number", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "e2e", cmd: "c", timeoutMin: "12" }] })).toBeNull();
  });
it("an object leg's paths filter is read as its per-leg file globs (#1274)", () => {
    const cfg = parseGateBlock({ ...BLOCK, legs: [{ name: "rust", cmd: "scripts/cargo-test-gate.sh", paths: ["src-tauri/**", "Cargo.toml"] }] });
    expect(cfg?.legs).toEqual([{ name: "rust", cmd: "scripts/cargo-test-gate.sh", paths: ["src-tauri/**", "Cargo.toml"] }]);
  });
  it("null on an object leg whose paths is not a string array (#1274)", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "rust", cmd: "c", paths: "src-tauri/**" }] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "rust", cmd: "c", paths: [1] }] })).toBeNull();
  });
  it("an object leg's image is read as its per-leg container image (#1274)", () => {
    const cfg = parseGateBlock({ ...BLOCK, legs: [{ name: "rust", cmd: "c", image: "desktop" }] });
    expect(cfg?.legs).toEqual([{ name: "rust", cmd: "c", image: "desktop" }]);
  });
  it("null on an object leg whose image is not an allowlisted key (#1274 fail-closed)", () => {
    for (const image of ["other", "", "gate-desktop", 3, null]) {
      expect(parseGateBlock({ ...BLOCK, legs: [{ name: "rust", cmd: "c", image }] })).toBeNull();
    }
  });
  it("a string leg has no timeoutMin, so it takes the 25 min default at run time", () => {
    const cfg = parseGateBlock({ ...BLOCK, legs: ["lint"] });
    expect(cfg?.legs[0]).toEqual({ name: "lint", cmd: "bun run lint" });
  });
  it("legTimeoutMin: 25 when unset, the clamped value otherwise", () => {
    expect(legTimeoutMin(undefined)).toBe(25);
    expect(legTimeoutMin(3)).toBe(3);
    expect(legTimeoutMin(40)).toBe(MAX_LEG_TIMEOUT_MIN);
    expect(legTimeoutMin(-2)).toBe(1);
  });
  it("mixes string and object legs in configured order", () => {
    const cfg = parseGateBlock({ ...BLOCK, legs: ["lint", { name: "docs", cmd: "make docs" }] });
    expect(cfg?.legs.map((l) => l.name)).toEqual(["lint", "docs"]);
    expect(cfg?.legs[1].cmd).toBe("make docs");
  });
  it("null on an object leg with no cmd, or an empty cmd", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "e2e" }] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "e2e", cmd: "" }] })).toBeNull();
  });
  it("null on an object leg with a non-string name", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: 3, cmd: "x" }] })).toBeNull();
  });
  it("null on a leg that is neither a string nor an object", () => {
    expect(parseGateBlock({ ...BLOCK, legs: [42] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [null] })).toBeNull();
  });
});

describe("parseGateBlock: leg names", () => {
  it("accepts names matching ^[a-z0-9][a-z0-9-]{0,39}$ in both forms", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["a", "x9-y", "0lint", { name: "a".repeat(40), cmd: "c" }] })).not.toBeNull();
  });
  it("rejects a name that breaks the pattern, in either form", () => {
    const bad = ["", "Lint", "test:unit", "under_score", "-lead", "a".repeat(41), "sp ace", "dot.name"];
    for (const name of bad) {
      expect(parseGateBlock({ ...BLOCK, legs: [name] })).toBeNull();
      expect(parseGateBlock({ ...BLOCK, legs: [{ name, cmd: "c" }] })).toBeNull();
    }
  });
  it("rejects duplicate names across string and object legs", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["lint", { name: "lint", cmd: "other" }] })).toBeNull();
  });
  it("rejects the reserved merge-tree name", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["merge-tree"] })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: [{ name: "merge-tree", cmd: "c" }] })).toBeNull();
  });
  it("rejects bun-N and vitest-N names, which the bun and vitest lanes own", () => {
    for (const name of ["bun-1", "bun-12", "vitest-3"]) {
      expect(parseGateBlock({ ...BLOCK, legs: [name] })).toBeNull();
      expect(parseGateBlock({ ...BLOCK, legs: [{ name, cmd: "c" }] })).toBeNull();
    }
  });
  it("keeps names that only look like the reserved ones", () => {
    expect(parseGateBlock({ ...BLOCK, legs: ["bun", "bun-lint", "vitest-only"] })).not.toBeNull();
  });
});

describe("parseGateBlock: vitestCmd is optional", () => {
  it("absent vitestCmd -> vitestCmd is undefined (zero vitest legs)", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    const cfg = parseGateBlock({ ...noVitest, legs: ["lint"] });
    expect(cfg).not.toBeNull();
    expect(cfg?.vitestCmd).toBeUndefined();
  });
  it("a present vitestCmd must be a non-empty string", () => {
    expect(parseGateBlock({ ...BLOCK, vitestCmd: "" })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, vitestCmd: 8 })).toBeNull();
  });
});

describe("parseGateBlock: cap, 1 + legs + bun legs + vitest legs <= MAX_LEGS_PER_PR", () => {
  it("bun shards count only when the block has a bun lane", () => {
    // 1 + 21 legs + 6 bun shards without a lane = 28 would breach, but no lane, so no bun legs.
    expect(parseGateBlock({ ...BLOCK, legs: names(21), bunShards: 6 })).not.toBeNull();
  });
  it("absent vitestCmd: the largest legs list is merge-tree + 23 legs = 24", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    expect(parseGateBlock({ ...noVitest, legs: names(MAX_LEGS_PER_PR - 1) })).not.toBeNull();
  });
  it("absent vitestCmd: merge-tree + 24 legs = 25 is rejected", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    expect(parseGateBlock({ ...noVitest, legs: names(MAX_LEGS_PER_PR) })).toBeNull();
  });
  it("absent vitestCmd: bun shards with a lane still count against the cap", () => {
    const { vitestCmd: _omit, ...noVitest } = BLOCK;
    expect(parseGateBlock({ ...noVitest, legs: names(22), bunShards: 1, bunLaneRoot: "apps/fleet" })).not.toBeNull();
    expect(parseGateBlock({ ...noVitest, legs: names(23), bunShards: 1, bunLaneRoot: "apps/fleet" })).toBeNull();
  });
  it("present vitestCmd still needs one vitest shard of room", () => {
    expect(parseGateBlock({ ...BLOCK, legs: names(23) })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, legs: names(22) })).not.toBeNull();
  });
});

describe("parseGateBlock shard counts", () => {
  it("defaults to 6 bun-test shards when the block names none", () => {
    expect(parseGateBlock({ ...BLOCK })?.bunShards).toBe(6);
  });
  it("reads a configured bun shard count", () => {
    expect(parseGateBlock({ ...BLOCK, bunShards: 4 })?.bunShards).toBe(4);
  });
  it("null on a bun shard count that is not a positive integer", () => {
    for (const bad of [0, -2, 1.5, "6", null]) {
      expect(parseGateBlock({ ...BLOCK, bunShards: bad })).toBeNull();
    }
  });
  it("defaults to 8 vitest shards when the block names none", () => {
    expect(parseGateBlock({ ...BLOCK })?.vitestShards).toBe(8);
  });
  it("reads a configured vitest shard count", () => {
    expect(parseGateBlock({ ...BLOCK, vitestShards: 12 })?.vitestShards).toBe(12);
  });
  it("null on a vitest shard count that is not a positive integer", () => {
    for (const bad of [0, -1, 2.5, "8", null]) {
      expect(parseGateBlock({ ...BLOCK, vitestShards: bad })).toBeNull();
    }
  });
  it("reads a per-repo bun lane root and globs", () => {
    const cfg = parseGateBlock({ ...BLOCK, bunLaneRoot: "packages/web", bunLaneGlobs: ["suites/*.test.ts"] });
    expect(cfg?.bunLaneRoot).toBe("packages/web");
    expect(cfg?.bunLaneGlobs).toEqual(["suites/*.test.ts"]);
  });
});

describe("gateMapEntry", () => {
  it("returns the entry for the repo, matched case-insensitively on both sides", () => {
    const entry = { ...BLOCK, vitestCmd: "example-test" };
    expect(gateMapEntry({ gates: { "Acme/Example": entry } }, "acme/EXAMPLE")).toEqual(entry);
  });
  it("undefined when the repo has no map entry", () => {
    expect(gateMapEntry({ gates: { "acme/example": BLOCK } }, "acme/other")).toBeUndefined();
  });
  it("undefined when there is no gates map, or it is not an object", () => {
    expect(gateMapEntry({}, "acme/example")).toBeUndefined();
    expect(gateMapEntry({ gates: "nope" }, "acme/example")).toBeUndefined();
    expect(gateMapEntry(null, "acme/example")).toBeUndefined();
  });
});

describe("matchesPathRules", () => {
  const rules = ["apps/fleet/**", "skills/**"];
  it("matches a file under a **-suffixed rule", () => {
    expect(matchesPathRules(["apps/fleet/src/index.ts"], rules)).toBe(true);
  });
  it("no match when every changed file is outside every rule", () => {
    expect(matchesPathRules(["README.md"], rules)).toBe(false);
  });
  it("empty changed-file list never matches", () => {
    expect(matchesPathRules([], rules)).toBe(false);
  });
});

// #1032 (refs #715): the shipped fleet.json's own pathRules must gate the
// files the bringup gates read — gates/*.sh and fleet.json itself. A
// gates-only PR skipping the gate reads as a false green.
describe("shipped fleet.json pathRules", () => {
  it("covers gates/ scripts and fleet.json itself", () => {
    const rules = FLEET_JSON.gate?.pathRules ?? [];
    expect(matchesPathRules(["gates/lead-gate.sh"], rules)).toBe(true);
    expect(matchesPathRules(["gates/completion-gate.sh"], rules)).toBe(true);
    expect(matchesPathRules(["fleet.json"], rules)).toBe(true);
  });
  it("still excludes a file nothing reads", () => {
    const rules = FLEET_JSON.gate?.pathRules ?? [];
    expect(matchesPathRules(["docs/notes.md"], rules)).toBe(false);
  });
});

// #1066: a gate block may name its container image by key. The key is an
// allowlisted lookup into the operator's images map, never an image ref.
describe("parseGateBlock: per-repo image key", () => {
  it("keeps an allowlisted image key as image", () => {
    expect(parseGateBlock({ ...BLOCK, image: "desktop" })?.image).toBe("desktop");
  });
  it("absent image -> no image key on the config (the default gate image applies at run time)", () => {
    const cfg = parseGateBlock(BLOCK);
    expect(cfg).not.toBeNull();
    expect(Object.hasOwn(cfg ?? {}, "image")).toBe(false);
  });
  it("the allowlist is exactly gate and desktop", () => {
    expect([...GATE_IMAGES].sort()).toEqual(["desktop", "gate"]);
  });
  it("null on a key outside the allowlist", () => {
    expect(parseGateBlock({ ...BLOCK, image: "evil" })).toBeNull();
  });
  it("null on a registry ref, which is never a key", () => {
    expect(parseGateBlock({ ...BLOCK, image: "ghcr.io/acme/desktop:latest" })).toBeNull();
  });
  it("null on inherited Object keys that look like allowlisted-adjacent names", () => {
    expect(parseGateBlock({ ...BLOCK, image: "__proto__" })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, image: "constructor" })).toBeNull();
  });
  it("null on a non-string image and on the empty string", () => {
    expect(parseGateBlock({ ...BLOCK, image: 7 })).toBeNull();
    expect(parseGateBlock({ ...BLOCK, image: "" })).toBeNull();
  });
});

// #1091 review round 2 (refs #715): the gate decides on fleet.json CONTENT at
// base vs head, not on the diff's file list. The compare API lists a rename by
// its new name only and caps at 300 files, so a file list can miss a move.
describe("fleetJsonChanged (#1091 review round 2)", () => {
  const CFG = { gate: { install: "x", legs: [], pathRules: ["a/**"] } };
  it("false when the root fleet.json is identical at base and head", () => {
    expect(fleetJsonChanged(CFG, { ...CFG })).toBe(false);
  });
  it("false when the file is absent at both shas", () => {
    expect(fleetJsonChanged(null, null)).toBe(false);
  });
  it("true when the content differs at all", () => {
    expect(fleetJsonChanged(CFG, { gate: { install: "y", legs: [], pathRules: ["a/**"] } })).toBe(true);
  });
  it("true when the file is deleted or moved away: present at base, null at head", () => {
    expect(fleetJsonChanged(CFG, null)).toBe(true);
  });
  it("true when the file is added: null at base, present at head (gate added with no base)", () => {
    expect(fleetJsonChanged(null, CFG)).toBe(true);
  });
});

describe("headFleetJsonFailure (#1091 review round 2)", () => {
  const HEAD = parseGateBlock(BLOCK);
  it("null when the config did not change, whatever the head holds", () => {
    expect(headFleetJsonFailure(false, undefined)).toBeNull();
    expect(headFleetJsonFailure(false, null)).toBeNull();
  });
  it("null when the config changed and the head block is valid", () => {
    expect(headFleetJsonFailure(true, HEAD)).toBeNull();
  });
  it("a failure, never a skip, when the config changed and the head block is absent or invalid", () => {
    expect(headFleetJsonFailure(true, null)).toBe("head fleet.json invalid");
    expect(headFleetJsonFailure(true, undefined)).toBe("head fleet.json invalid");
  });
});

describe("gateDecision (#1091)", () => {
  const rules = ["apps/fleet/**"];
  it("a config change gates even when no pathRule matches", () => {
    expect(gateDecision(["README.md"], rules, true)).toBe("gate");
  });
  it("a diff matching a pathRule gates", () => {
    expect(gateDecision(["apps/fleet/src/index.ts"], rules, false)).toBe("gate");
  });
  it("a diff with neither a pathRule match nor a config change skips", () => {
    expect(gateDecision(["README.md"], rules, false)).toBe("skip");
    expect(gateDecision([], rules, false)).toBe("skip");
  });
});

// The workflow's decision chain, as one pure function (#1091 review round 2).
describe("decideGateRun (#1091 review round 2)", () => {
  const cfg = parseGateBlock(BLOCK)!;
  const rules = ["apps/fleet/**"];
  it("a moved fleet.json (docs/fleet.json; root file gone at head) fails: head config absent", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["docs/fleet.json"], fleetJsonChanged: true, base: cfg, head: null }))
      .toEqual({ action: "fail", description: "head fleet.json invalid" });
  });
  it("a truncated file list still gates when the config changed by content", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["README.md"], fleetJsonChanged: true, base: cfg, head: cfg }))
      .toEqual({ action: "run" });
  });
  it("gate added with no base config runs on the head config", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["fleet.json"], fleetJsonChanged: true, base: null, head: cfg }))
      .toEqual({ action: "run" });
  });
  // #1132 (refs #715): a gated repo whose base sha has no gate block is never a
  // silent skip. The head gets a visible failure that names the base and the fix.
  it("no gate block at the base and no config change: fails with the base sha and the fix, never a skip", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["README.md"], fleetJsonChanged: false, base: null, head: undefined }))
      .toEqual({ action: "fail", description: "no valid gate config at base bbbbbbbb" });
  });
  it("the no-gate-block failure description fits GitHub's 140-char status description", () => {
    const decision = decideGateRun({ baseSha: BASE_SHA, changedFiles: [], fleetJsonChanged: false, base: null, head: undefined });
    expect(decision.action === "fail" && decision.description.length <= 140).toBe(true);
  });
  it("config present, nothing gated changed: skipped (the workflow posts success)", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["README.md"], fleetJsonChanged: false, base: { ...cfg, pathRules: rules }, head: undefined }))
      .toEqual({ action: "skip", reason: "no gated paths changed" });
  });
  it("a pathRule match runs the gate", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["apps/fleet/src/x.ts"], fleetJsonChanged: false, base: { ...cfg, pathRules: rules }, head: undefined }))
      .toEqual({ action: "run" });
  });
});

// #1095 round 3 (item 2): the compare API lists at most 300 files. A list cut at
// the cap cannot prove that no gated path changed, so the run gates.
describe("truncated compare list gates (#1095 round 3)", () => {
  const cfg = parseGateBlock(BLOCK)!;
  const rules = ["apps/fleet/**"];
  it("a list cut at the cap runs the gate even when no pathRule matches", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["notes/a.md"], fleetJsonChanged: false, base: { ...cfg, pathRules: rules }, head: undefined, truncated: true }))
      .toEqual({ action: "run" });
  });
  it("an untruncated list with no pathRule match still skips", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["notes/a.md"], fleetJsonChanged: false, base: { ...cfg, pathRules: rules }, head: undefined, truncated: false }))
      .toEqual({ action: "skip", reason: "no gated paths changed" });
  });
});

// #1095 round 3 (item 3): a head gates map holding an invalid entry fails the run.
describe("gateMapHasInvalidEntry (#1095 round 3)", () => {
  it("false when there is no gates map, or every entry is a valid block", () => {
    expect(gateMapHasInvalidEntry({})).toBe(false);
    expect(gateMapHasInvalidEntry({ gates: { "acme/example": BLOCK } })).toBe(false);
  });
  it("true when any entry is malformed: an empty object, or an image key outside the allowlist", () => {
    expect(gateMapHasInvalidEntry({ gates: { "acme/example": {} } })).toBe(true);
    expect(gateMapHasInvalidEntry({ gates: { "acme/a": BLOCK, "acme/b": { ...BLOCK, image: "registry.example/x" } } })).toBe(true);
  });
  it("true when gates is present but not an object", () => {
    expect(gateMapHasInvalidEntry({ gates: "nope" })).toBe(true);
    expect(gateMapHasInvalidEntry({ gates: [] })).toBe(true);
  });
  it("false for a fleet.json that is not an object: nothing to validate", () => {
    expect(gateMapHasInvalidEntry(null)).toBe(false);
  });
});

describe("headFleetJsonFailure with a bad head gates map (#1095 round 3)", () => {
  const HEAD = parseGateBlock(BLOCK);
  it("a changed config with a valid head block still fails when the head gates map has an invalid entry", () => {
    expect(headFleetJsonFailure(true, HEAD, true)).toBe("head fleet.json invalid");
  });
  it("an unchanged config never consults the gates map", () => {
    expect(headFleetJsonFailure(false, HEAD, true)).toBeNull();
  });
});

describe("decideGateRun with a bad head gates map (#1095 round 3)", () => {
  const cfg = parseGateBlock(BLOCK)!;
  it("fails the run when the config changed and the head gates map is invalid", () => {
    expect(decideGateRun({ baseSha: BASE_SHA, changedFiles: ["fleet.json"], fleetJsonChanged: true, base: cfg, head: cfg, headGatesInvalid: true }))
      .toEqual({ action: "fail", description: "head fleet.json invalid" });
  });
});

describe("sharedHeadFailure / guardSuccessStatus: red wins across PRs sharing a head (#1172)", () => {
  const HEAD = "f".repeat(40);
  const open = (number: number, baseRef: string, headSha = HEAD) => ({ number, baseRef, headSha });

  it("A-red-then-B-green ends red: a sibling open PR with a different base fails the success", () => {
    const openPulls = [open(7, "ungated-base"), open(8, "gated-base")];
    expect(sharedHeadFailure(HEAD, "gated-base", 8, openPulls)).toBe(`head ${HEAD.slice(0, 8)} shared with PR #7`);
  });

  it("B-green-then-A-red ends red: order does not matter, the different-base sibling fails the success", () => {
    const openPulls = [open(8, "gated-base"), open(7, "ungated-base")];
    expect(sharedHeadFailure(HEAD, "ungated-base", 7, openPulls)).toBe(`head ${HEAD.slice(0, 8)} shared with PR #8`);
  });

  it("a same-base pair stays green: no sibling with a different base -> null", () => {
    const openPulls = [open(7, "main"), open(8, "main")];
    expect(sharedHeadFailure(HEAD, "main", 8, openPulls)).toBeNull();
  });

  it("the current PR is never its own sibling, and a different-head PR is ignored", () => {
    const openPulls = [open(8, "main"), open(9, "main", "e".repeat(40))];
    expect(sharedHeadFailure(HEAD, "main", 8, openPulls)).toBeNull();
  });

  it("an empty open list is green", () => {
    expect(sharedHeadFailure(HEAD, "main", 8, [])).toBeNull();
  });

  it("guardSuccessStatus: a lookup error ends red (fail closed)", () => {
    const args = guardSuccessStatus(HEAD, "main", 8, { error: "boom" }, { state: "success", description: "no gated paths changed" });
    expect(args).toEqual({ state: "failure", description: "gate: cannot list shared-head PRs" });
  });

  it("guardSuccessStatus: a shared head downgrades success to failure, and passes a clean success through", () => {
    const guarded = guardSuccessStatus(HEAD, "gated-base", 8, { open: [open(7, "ungated-base"), open(8, "gated-base")] }, { state: "success", description: "2/2 green" });
    expect(guarded).toEqual({ state: "failure", description: `head ${HEAD.slice(0, 8)} shared with PR #7` });
    const clean = guardSuccessStatus(HEAD, "main", 8, { open: [open(7, "main"), open(8, "main")] }, { state: "success", description: "2/2 green" });
    expect(clean).toEqual({ state: "success", description: "2/2 green" });
  });
});
