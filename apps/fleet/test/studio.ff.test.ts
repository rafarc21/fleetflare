import { describe, it, expect } from "vitest";
import {
  parseFfArgs, ffDecision, isProvisioned, describeState, ffTaskBrief,
  DEFAULT_FF_ROLE, FF_USAGE, FF_HELP, FF_DEFAULT_OUTPUT, FF_DEFAULT_BOUNDARIES,
  ffTimeoutLines, parseVerdict, verdictOutcome, ffAttachGate,
  type ProvisionedVerdict,
} from "../src/studio/ff";
import type { ProvisionedVerdict as DoVerdict } from "../src/studio/do";
import type { StudioStatus } from "../src/studio/types";

// `ff` (P4 design §2.13/§10) is spawn-or-attach in two letters. Everything
// worth asserting on is the DECISION — which studio, and whether it may be
// attached to yet — so that decision is a pure function here rather than
// inline in cli/ff.ts, which (like cli/fleet.ts) is never imported from
// test/: those files carry bun-only globals. Same split src/studio/cli-args.ts
// already draws for argv.

function row(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--maestro", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: "acme-org/websites",
    ...overrides,
  };
}

describe("parseFfArgs", () => {
  it("bare `ff` means the maestro", () => {
    expect(parseFfArgs([])).toEqual({
      cmd: "ff", role: DEFAULT_FF_ROLE, task: null, newInstance: false,
    });
    expect(DEFAULT_FF_ROLE).toBe("maestro");
  });

  it("`ff <role>` takes the role", () => {
    expect(parseFfArgs(["web-studio"])).toEqual({
      cmd: "ff", role: "web-studio", task: null, newInstance: false,
    });
  });

  it("--help and -h ask for help", () => {
    expect(parseFfArgs(["--help"])).toEqual({ cmd: "help" });
    expect(parseFfArgs(["-h"])).toEqual({ cmd: "help" });
  });

  it("rejects a role that could never be half of a studio id", () => {
    expect(parseFfArgs(["Web_Studio"])).toEqual({ cmd: "usage", message: FF_USAGE });
    expect(parseFfArgs(["--nope"])).toEqual({ cmd: "usage", message: FF_USAGE });
  });

  it("`ff <role> \"<task>\"` takes the task as one quoted argument", () => {
    expect(parseFfArgs(["web-studio", "  fix the header  "]))
      .toEqual({
        cmd: "ff", role: "web-studio", task: { kind: "new", text: "fix the header" },
        newInstance: false,
      });
  });

  it("`ff <role> <n>` ADOPTS issue #n rather than filing a task called \"42\" (P5 §3)", () => {
    expect(parseFfArgs(["web-studio", "42"]))
      .toEqual({
        cmd: "ff", role: "web-studio", task: { kind: "adopt", number: 42 }, newInstance: false,
      });
    // `#42` is how an issue number is written everywhere else.
    expect(parseFfArgs(["web-studio", "#42"]))
      .toEqual({
        cmd: "ff", role: "web-studio", task: { kind: "adopt", number: 42 }, newInstance: false,
      });
    // Only a BARE number adopts — anything with words in it is a new task.
    expect(parseFfArgs(["web-studio", "42 things are broken"]))
      .toEqual({
        cmd: "ff", role: "web-studio", task: { kind: "new", text: "42 things are broken" },
        newInstance: false,
      });
  });

  // Issue #269: `--new` is lifted out of argv before the positional grammar
  // runs, so it works on either side of the role and costs the "quote your
  // task" check nothing.
  it("`--new` is recognised in every position, and only as an exact token", () => {
    expect(parseFfArgs(["--new"])).toEqual({
      cmd: "ff", role: DEFAULT_FF_ROLE, task: null, newInstance: true,
    });
    expect(parseFfArgs(["pilot", "--new"])).toEqual({
      cmd: "ff", role: "pilot", task: null, newInstance: true,
    });
    expect(parseFfArgs(["--new", "pilot"])).toEqual({
      cmd: "ff", role: "pilot", task: null, newInstance: true,
    });
    expect(parseFfArgs(["pilot", "--new", "fix the header"])).toEqual({
      cmd: "ff", role: "pilot", task: { kind: "new", text: "fix the header" }, newInstance: true,
    });
    expect(parseFfArgs(["pilot", "--new", "42"])).toEqual({
      cmd: "ff", role: "pilot", task: { kind: "adopt", number: 42 }, newInstance: true,
    });
  });

  it("a task that merely CONTAINS --new stays the task, flag off", () => {
    expect(parseFfArgs(["pilot", "drop the --new flag"])).toEqual({
      cmd: "ff", role: "pilot", task: { kind: "new", text: "drop the --new flag" },
      newInstance: false,
    });
  });

  it("still refuses an unquoted task, counting only REAL positionals", () => {
    expect(parseFfArgs(["pilot", "--new", "fix", "the", "header"]).cmd).toBe("usage");
  });

  it("refuses issue #0 — there is no such issue to adopt", () => {
    expect(parseFfArgs(["web-studio", "0"]).cmd).toBe("usage");
  });

  it("rejects an UNQUOTED task rather than filing one that says \"fix\"", () => {
    const res = parseFfArgs(["web-studio", "fix", "the", "header"]);
    expect(res.cmd).toBe("usage");
    if (res.cmd === "usage") {
      expect(res.message).toContain("ONE argument");
      // The message hands back the command that would have worked.
      expect(res.message).toContain('ff web-studio "fix the header"');
    }
  });

  it("rejects an empty task, and one over GitHub's issue-title limit, locally", () => {
    expect(parseFfArgs(["web-studio", "   "]).cmd).toBe("usage");
    const long = parseFfArgs(["web-studio", "x".repeat(257)]);
    expect(long.cmd).toBe("usage");
    if (long.cmd === "usage") expect(long.message).toContain("256-char");
  });

  it("the help text names the default role and the escape key", () => {
    expect(FF_HELP).toContain(DEFAULT_FF_ROLE);
    expect(FF_HELP).toContain("ctrl-]");
  });
});

describe("isProvisioned", () => {
  it("running with no error is the only provisioned shape", () => {
    expect(isProvisioned(row())).toBe(true);
    expect(isProvisioned(row({ state: "provisioning" }))).toBe(false);
    expect(isProvisioned(row({ state: "degraded", error: "clone failed" }))).toBe(false);
    expect(isProvisioned(row({ state: "stopped" }))).toBe(false);
  });

  it("running WITH an error is not provisioned — recycle's own unverified note lands here", () => {
    // do.ts's recycleWithSync reports "provisioned, but NOT verified: ..."
    // as a 200 with state running and that note in `error`. Unverified is
    // not proof, so ff re-provisions rather than attaching to it.
    expect(isProvisioned(row({ error: "provisioned, but NOT verified: check never ran" }))).toBe(false);
  });

  it("an absent row is not provisioned", () => {
    expect(isProvisioned(undefined)).toBe(false);
    expect(isProvisioned(null)).toBe(false);
  });
});

describe("describeState", () => {
  it("names the state, and the error when there is one", () => {
    expect(describeState(row({ state: "degraded", error: "bring-up failed (1): boom" })))
      .toBe("degraded: bring-up failed (1): boom");
    expect(describeState(row({ state: "provisioning" }))).toBe("provisioning");
  });

  it("collapses whitespace and caps the error, so one line stays one line", () => {
    const long = describeState(row({ state: "degraded", error: `a\n b\t c ${"x".repeat(500)}` }));
    expect(long.includes("\n")).toBe(false);
    expect(long.length).toBeLessThanOrEqual(240);
  });

  it("reads as unknown when there is no row at all", () => {
    expect(describeState(undefined)).toBe("not in the registry");
  });
});

describe("ffDecision — inside a repo", () => {
  it("attaches to a provisioned studio", () => {
    expect(ffDecision([row()], "websites", "maestro", "acme-org/websites"))
      .toEqual({ kind: "attach", id: "websites--maestro" });
  });

  it("spawns when this repo has no studio for the role yet", () => {
    expect(ffDecision([row()], "beta", "maestro", "acme-org/beta"))
      .toEqual({ kind: "spawn", id: "beta--maestro" });
  });

  it("provisions — never attaches — when the studio exists but is degraded", () => {
    const rows = [row({ state: "degraded", error: "bring-up failed (1): boom" })];
    expect(ffDecision(rows, "websites", "maestro", "acme-org/websites")).toEqual({
      kind: "provision", id: "websites--maestro",
      reason: "degraded: bring-up failed (1): boom",
    });
  });

  it("provisions a studio still mid-provision rather than racing it", () => {
    const rows = [row({ state: "provisioning" })];
    expect(ffDecision(rows, "websites", "maestro", "acme-org/websites"))
      .toEqual({ kind: "provision", id: "websites--maestro", reason: "provisioning" });
  });

  it("the role picks the studio, not the repo", () => {
    const rows = [row(), row({ id: "websites--web-studio" })];
    expect(ffDecision(rows, "websites", "web-studio", "acme-org/websites"))
      .toEqual({ kind: "attach", id: "websites--web-studio" });
  });

  it("ignores rows whose id does not parse", () => {
    const rows = [row({ id: "not-an-id" }), row()];
    expect(ffDecision(rows, "websites", "maestro", "acme-org/websites"))
      .toEqual({ kind: "attach", id: "websites--maestro" });
  });
});

// Issue #269: `--new` is the one form that always spawns. Landing in the
// existing lead's session is the single outcome that cannot be what an
// operator who typed `--new` meant.
describe("ffDecision — --new allocates a fresh instance (#269)", () => {
  it("spawns instance 2 beside a provisioned instance 1 instead of attaching to it", () => {
    expect(ffDecision([row({ id: "websites--pilot" })], "websites", "pilot", "acme-org/websites", true))
      .toEqual({ kind: "spawn", id: "websites--pilot--2", instance: 2 });
  });

  // Round 2: maestro is a SINGLETON role — refused client-side, matching
  // runSpawn's own server-side 409 (spawn.ts). Also covers bare `ff --new`
  // (no role given), which defaults to DEFAULT_FF_ROLE ("maestro") and would
  // otherwise silently try to allocate `<repo>--maestro--2`.
  it("refuses --new for maestro — a singleton role, never a second instance", () => {
    const decision = ffDecision([row()], "websites", "maestro", "acme-org/websites", true);
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") throw new Error("unreachable");
    expect(decision.message).toContain("singleton");
  });

  it("lands on instance 1 when the role has nothing running — a free slot, not a second one", () => {
    expect(ffDecision([row()], "websites", "pilot", "acme-org/websites", true))
      .toEqual({ kind: "spawn", id: "websites--pilot", instance: 1 });
  });

  it("fills the lowest hole rather than appending", () => {
    const rows = [
      row({ id: "websites--pilot" }),
      row({ id: "websites--pilot--2" }),
      row({ id: "websites--pilot--4" }),
    ];
    expect(ffDecision(rows, "websites", "pilot", "acme-org/websites", true))
      .toEqual({ kind: "spawn", id: "websites--pilot--3", instance: 3 });
  });

  it("counts only this repo's studios for this role", () => {
    const rows = [row({ id: "beta--pilot" }), row({ id: "beta--pilot--2" }), row({ id: "websites--web-studio" })];
    expect(ffDecision(rows, "websites", "pilot", "acme-org/websites", true))
      .toEqual({ kind: "spawn", id: "websites--pilot", instance: 1 });
  });

  it("keeps a hyphenated role whole in the allocated id", () => {
    const rows = [row({ id: "websites--web-studio" })];
    expect(ffDecision(rows, "websites", "web-studio", "acme-org/websites", true))
      .toEqual({ kind: "spawn", id: "websites--web-studio--2", instance: 2 });
  });

  it("refuses outside a repo — the allocation is per repo and cannot be guessed", () => {
    const decision = ffDecision([row()], null, "pilot", null, true);
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") throw new Error("unreachable");
    expect(decision.message).toContain("--new");
    expect(decision.message).toContain("pilot");
  });

  it("without the flag, every answer is exactly what it was before #269", () => {
    expect(ffDecision([row()], "websites", "maestro", "acme-org/websites", false))
      .toEqual({ kind: "attach", id: "websites--maestro" });
    expect(ffDecision([row()], "websites", "maestro", "acme-org/websites"))
      .toEqual({ kind: "attach", id: "websites--maestro" });
  });
});

describe("ffDecision — outside any repo", () => {
  it("spawns with no id at all, so the Worker names it from the fleet default repo", () => {
    expect(ffDecision([], null, "maestro", null)).toEqual({ kind: "spawn", id: null });
  });

  it("uses the one existing studio for that role", () => {
    const rows = [row(), row({ id: "websites--pilot" })];
    expect(ffDecision(rows, null, "maestro", null)).toEqual({ kind: "attach", id: "websites--maestro" });
  });

  it("re-provisions that one studio when it is not provisioned", () => {
    const rows = [row({ state: "stopped" })];
    expect(ffDecision(rows, null, "maestro", null))
      .toEqual({ kind: "provision", id: "websites--maestro", reason: "stopped" });
  });

  it("refuses to guess between two repos' studios for the same role", () => {
    const rows = [row(), row({ id: "beta--maestro" })];
    const decision = ffDecision(rows, null, "maestro", null);
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") throw new Error("unreachable");
    expect(decision.message).toContain("websites--maestro");
    expect(decision.message).toContain("beta--maestro");
  });

  // #281: once instances exist, "more than one" no longer means "more than
  // one repo". One repo's instance 1 is the studio `ff <role>` has always meant.
  it("one repo with several instances: instance 1, not a refusal (#281)", () => {
    const rows = [row({ id: "websites--pilot" }), row({ id: "websites--pilot--2" }), row({ id: "websites--pilot--3" })];
    expect(ffDecision(rows, null, "pilot", null)).toEqual({ kind: "attach", id: "websites--pilot" });
  });

  it("one repo whose instance 1 is gone: its lowest remaining instance (#281)", () => {
    const rows = [row({ id: "websites--pilot--3" }), row({ id: "websites--pilot--2" })];
    expect(ffDecision(rows, null, "pilot", null)).toEqual({ kind: "attach", id: "websites--pilot--2" });
  });

  it("two repos: refuses, naming ONE studio per repo with the exact command for each (#281)", () => {
    const rows = [
      row({ id: "websites--pilot" }), row({ id: "websites--pilot--2" }),
      row({ id: "beta--pilot--2", repoSlug: "o/beta" }), row({ id: "beta--pilot", repoSlug: "o/beta" }),
    ];
    const decision = ffDecision(rows, null, "pilot", null);
    if (decision.kind !== "error") throw new Error(`expected a refusal, got ${decision.kind}`);
    expect(decision.message).toContain("fleet attach websites--pilot\n");
    expect(decision.message).toContain("fleet attach beta--pilot\n");
    expect(decision.message).not.toContain("--pilot--2");
    expect(decision.message).toContain('cd into that repo and run: ff pilot');
  });
});

// Board #21. Folding `.`/`_` onto `-` means `o/a.b` and `o/a-b` name the same
// segment, so `ff` in one of them could ATTACH to the other's studio without
// a word. The Worker's fleet-wide segment claim already refuses the second
// SPAWN; this is the matching refusal on the attach path, which never asks
// the Worker to resolve a repo at all.

describe("ffDecision — a folded-segment collision is refused, never attached to", () => {
  it("refuses when the studio holding this segment is bound to a DIFFERENT repo", () => {
    const rows = [row({ id: "a-b--maestro", repoSlug: "acme-org/a.b" })];
    const decision = ffDecision(rows, "a-b", "maestro", "acme-org/a-b");
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") throw new Error("unreachable");
    expect(decision.message).toContain("a-b--maestro");
    expect(decision.message).toContain("acme-org/a.b");
    expect(decision.message).toContain("acme-org/a-b");
  });

  it("attaches to a dotted repo's own studio — same segment, same repo", () => {
    const rows = [row({ id: "exampleorg-com--maestro", repoSlug: "demosite-life/exampleorg.com" })];
    expect(ffDecision(rows, "exampleorg-com", "maestro", "demosite-life/exampleorg.com"))
      .toEqual({ kind: "attach", id: "exampleorg-com--maestro" });
  });

  it("compares case-insensitively — a slug is a repo name, not a byte string", () => {
    const rows = [row({ id: "a-b--maestro", repoSlug: "Acme-Org/A.B" })];
    expect(ffDecision(rows, "a-b", "maestro", "acme-org/a.b").kind).toBe("attach");
  });

  it("a legacy row with no repoSlug is not treated as a collision", () => {
    const rows = [row({ id: "websites--maestro", repoSlug: null })];
    expect(ffDecision(rows, "websites", "maestro", "acme-org/websites"))
      .toEqual({ kind: "attach", id: "websites--maestro" });
  });
});

describe("ffTimeoutLines", () => {
  const lines = ffTimeoutLines("websites--maestro", "degraded: bring-up failed (1): boom", 241);

  it("names the studio, what was missing, and how long it waited", () => {
    expect(lines[0]).toContain("websites--maestro");
    expect(lines[0]).toContain("241s");
    expect(lines[1]).toContain("degraded: bring-up failed (1): boom");
  });

  it("says it is NOT attaching — the one thing this path must never do", () => {
    expect(lines[0]).toContain("NOT attaching");
  });

  it("hands over the exact commands to retry with", () => {
    expect(lines).toContain("retry with: fleet provision websites--maestro");
    expect(lines.some((l) => l.includes("fleet recycle websites--maestro"))).toBe(true);
  });
});

// --- the container check -----------------------------------------------------
// `GET /studio/:id/provisioned` runs do.ts's checkProvisionedWithRetry —
// checkout present AND claude running in `tmux studio:claude` — and destroys
// nothing. ff polls it instead of inferring provisioned-ness from state/error.

describe("ProvisionedVerdict mirrors do.ts", () => {
  it("assigns both ways, so the CLI-side mirror cannot drift from the route's own type", () => {
    // Compile-time only. ff.ts cannot import do.ts (it pulls in
    // "@cloudflare/sandbox", unresolvable under cli/tsconfig.json's bun-only
    // types), so this test is where the two shapes are pinned together.
    const fromDo: DoVerdict = { kind: "bare", reason: "x" };
    const mirrored: ProvisionedVerdict = fromDo;
    const back: DoVerdict = mirrored;
    expect(back).toEqual({ kind: "bare", reason: "x" });
  });
});

describe("parseVerdict", () => {
  it("takes the three real verdicts through unchanged", () => {
    expect(parseVerdict({ kind: "provisioned" })).toEqual({ kind: "provisioned" });
    expect(parseVerdict({ kind: "bare", reason: "no git checkout at /workspace/websites" }))
      .toEqual({ kind: "bare", reason: "no git checkout at /workspace/websites" });
    expect(parseVerdict({ kind: "inconclusive", reason: "shell exited" }))
      .toEqual({ kind: "inconclusive", reason: "shell exited" });
  });

  it("reads anything unrecognisable as INCONCLUSIVE, never as a broken studio", () => {
    // A Worker that predates the route answers 404 "not found"; ff must keep
    // working against it rather than concluding the studio is bare.
    for (const raw of [null, undefined, "not found", 42, { kind: "weird" }, {}]) {
      expect(parseVerdict(raw).kind).toBe("inconclusive");
    }
    const v = parseVerdict("not found");
    if (v.kind !== "inconclusive") throw new Error("unreachable");
    expect(v.reason).toContain("unrecognised check response");
  });

  it("keeps a verdict whose reason is missing, with a placeholder", () => {
    expect(parseVerdict({ kind: "bare" })).toEqual({ kind: "bare", reason: "no reason given" });
  });

  it("collapses and caps a reason, so one progress line stays one line", () => {
    const v = parseVerdict({ kind: "bare", reason: `a\n b\t ${"x".repeat(500)}` });
    if (v.kind !== "bare") throw new Error("unreachable");
    expect(v.reason.includes("\n")).toBe(false);
    expect(v.reason.length).toBeLessThanOrEqual(200);
  });
});

describe("verdictOutcome", () => {
  it("provisioned — the container itself confirmed it", () => {
    expect(verdictOutcome({ kind: "provisioned" }, row())).toEqual({
      kind: "provisioned", note: "provisioned (container check)",
    });
  });

  it("bare — not provisioned, and the note names what is missing", () => {
    expect(verdictOutcome({ kind: "bare", reason: "claude is not running in tmux studio:claude" }, row()))
      .toEqual({ kind: "not-provisioned", note: "not provisioned: claude is not running in tmux studio:claude" });
  });

  it("a bare verdict outranks a registry row that claims running — that is the whole point", () => {
    // The 2026-08-25 shape: state running, error null, container empty.
    expect(verdictOutcome({ kind: "bare", reason: "no git checkout at /workspace/websites" }, row()).kind)
      .toBe("not-provisioned");
  });

  it("inconclusive + status running -> UNVERIFIED: proceed, and say the fallback out loud", () => {
    const out = verdictOutcome({ kind: "inconclusive", reason: "shell exited" }, row());
    expect(out.kind).toBe("unverified");
    expect(out.note).toContain("check inconclusive (shell exited)");
    expect(out.note).toContain("trusting status: running");
  });

  it("inconclusive + status NOT running -> UNKNOWN: nothing here is evidence", () => {
    const out = verdictOutcome({ kind: "inconclusive", reason: "shell exited" }, row({ state: "degraded", error: "boom" }));
    expect(out.kind).toBe("unknown");
    expect(out.note).toContain("status degraded: boom");
  });

  it("inconclusive with no row at all -> UNKNOWN", () => {
    expect(verdictOutcome({ kind: "inconclusive", reason: "x" }, null).kind).toBe("unknown");
  });
});

describe("ffTaskBrief — the two sections a one-liner cannot supply", () => {
  const brief = () => ffTaskBrief("fix the header", "websites--web-studio");

  // Issue #81: ff files before it spawns; the Worker lets that one through.
  it("marks the create pendingSpawn", () => {
    expect(brief().pendingSpawn).toBe(true);
  });

  it("the one-liner is both the title and the objective", () => {
    expect(brief().title).toBe("fix the header");
    expect(brief().objective).toBe("fix the header");
  });

  it("assigns the task to the studio it is about to spawn", () => {
    expect(brief().assignee).toBe("websites--web-studio");
  });

  it("fills output format and boundaries from the fleet's own standing contract, not from thin air", () => {
    // Both restate what every studio prompt already says. §5 makes all three
    // sections a hard floor, so they cannot simply be omitted — and a default
    // the operator can read on the issue beats one hidden in a prompt.
    expect(brief().outputFormat).toBe(FF_DEFAULT_OUTPUT);
    expect(brief().boundaries).toBe(FF_DEFAULT_BOUNDARIES);
    expect(FF_DEFAULT_OUTPUT).toContain("envelope comment");
    expect(FF_DEFAULT_BOUNDARIES).toContain("No merge, no deploy");
    expect(FF_DEFAULT_BOUNDARIES).toContain("single writer");
  });

  it("the help text explains the task form and its repo requirement", () => {
    expect(FF_HELP).toContain('ff <role> "<task>"');
    expect(FF_HELP).toContain("<repo>--<role>");
  });
});

// ---------------------------------------------------------------------------
// ffAttachGate — issue #43, part 1
//
// MEASURED 2026-09-23 on acme-os: `ff web-studio 2565` run from a background
// shell (TTY=??) was still attached two hours later, holding a tmux client at
// 80 columns. An agent invoking `ff <role> <n>` from a background shell is a
// NORMAL thing to do — the task form exists for exactly that — so this must be
// a message, never a hang and never a silent no-op.

describe("ffAttachGate — an attach needs a terminal on both ends", () => {
  const tty = { stdin: true, stdout: true };

  it("a real terminal attaches, as always", () => {
    expect(ffAttachGate(tty, "websites--web-studio", null)).toEqual({ kind: "attach" });
  });

  it("no tty at all hands off instead of attaching", () => {
    const gate = ffAttachGate({ stdin: false, stdout: false }, "websites--web-studio", null);
    expect(gate.kind).toBe("handoff");
  });

  it("half a terminal is not a terminal — a pipe on either end hands off", () => {
    expect(ffAttachGate({ stdin: true, stdout: false }, "websites--web-studio", null).kind).toBe("handoff");
    expect(ffAttachGate({ stdin: false, stdout: true }, "websites--web-studio", null).kind).toBe("handoff");
  });

  it("the handoff NAMES the studio, says it is not attaching, and gives the command that does attach", () => {
    const gate = ffAttachGate({ stdin: false, stdout: false }, "websites--web-studio", null);
    if (gate.kind !== "handoff") throw new Error("expected a handoff");
    const text = gate.lines.join("\n");
    expect(text).toContain("websites--web-studio");
    expect(text).toContain("not attaching");
    expect(text).toContain("no terminal");
    expect(text).toContain("fleet attach websites--web-studio");
  });

  it("the handoff says WHY, so nobody re-adds the attach as a fix", () => {
    const gate = ffAttachGate({ stdin: false, stdout: false }, "websites--web-studio", null);
    if (gate.kind !== "handoff") throw new Error("expected a handoff");
    const text = gate.lines.join("\n");
    // The two costs measured in #43: the stray client never exits, and a
    // client with no terminal cannot declare a size for the shared pty.
    expect(text).toContain("size");
    expect(text).toMatch(/never exits|forever/);
  });

  it("a task the run filed or adopted is named in the handoff — it is the only record the caller gets", () => {
    const gate = ffAttachGate({ stdin: false, stdout: false }, "websites--web-studio", 2565);
    if (gate.kind !== "handoff") throw new Error("expected a handoff");
    expect(gate.lines.join("\n")).toContain("#2565");
  });
});
