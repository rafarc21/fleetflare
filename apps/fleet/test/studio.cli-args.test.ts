import { describe, it, expect } from "vitest";
import { parseCliArgs, CLI_USAGE, VERBS, renderHelp } from "../src/studio/cli-args";

// Fleet Spawn P3, Task 3: the Mac CLI's argv parser — see cli-args.ts's own
// header for why this pure logic lives outside cli/fleet.ts (which is never
// imported from test/, anywhere in this codebase — bun-only globals).

describe("parseCliArgs", () => {
  // Issue #37: `ls` reads the registry only — one D1 read, no container round
  // trips — unless the operator asks for a live check per studio with
  // --fresh. Opt-in, never the default: `fleet ls` is the first command an
  // operator reaches for when something looks wrong, and fanning an exec out
  // to every studio there is how it becomes the slowest.
  it("ls takes no argument and is NOT fresh by default", () => {
    expect(parseCliArgs(["ls"])).toEqual({ cmd: "ls", fresh: false, json: false });
  });

  it("ls --fresh asks for a live check per studio", () => {
    expect(parseCliArgs(["ls", "--fresh"])).toEqual({ cmd: "ls", fresh: true, json: false });
  });

  it("ls ignores a stray extra token (only the first two argv slots are read)", () => {
    expect(parseCliArgs(["ls", "extra"])).toEqual({ cmd: "ls", fresh: false, json: false });
  });

  // Issue #37's second half: there was no way to ask for the truth NOW. The
  // container check already existed (provisionedCheckCmd); nothing exposed it
  // on demand, so an operator needed a shell inside the container.
  it("check requires an id", () => {
    expect(parseCliArgs(["check", "websites--pilot"])).toEqual({ cmd: "check", id: "websites--pilot" });
    expect(parseCliArgs(["check"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Board #140 (#94 follow-up): the operator's escape from a sync guard
  // stuck on a stale/wrong baseline. Same one-argument grammar as `check`.
  it("clear-session-guard requires an id", () => {
    expect(parseCliArgs(["clear-session-guard", "websites--pilot"])).toEqual({
      cmd: "clear-session-guard", id: "websites--pilot",
    });
    expect(parseCliArgs(["clear-session-guard"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Board issue #47: read a studio without attaching a tmux client. Same
  // one-argument grammar as `check`.
  it("inspect requires an id", () => {
    expect(parseCliArgs(["inspect", "websites--pilot"])).toEqual({ cmd: "inspect", id: "websites--pilot" });
    expect(parseCliArgs(["inspect"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Board task #125: same zero-argument grammar as `ls`.
  it("onboard takes no argument", () => {
    expect(parseCliArgs(["onboard"])).toEqual({ cmd: "onboard" });
  });

  // Visible studios: the reconcile verb. Issue #216: scoped by default (repo
  // resolved later, in cmdTabs, from the cwd) rather than acting on the whole
  // fleet with no argument at all.
  it("tabs bare defaults to repo: null, all: false, yes: false (cwd-scoped, resolved later)", () => {
    expect(parseCliArgs(["tabs"])).toEqual({ cmd: "tabs", repo: null, all: false, yes: false });
  });

  it("tabs --repo <owner/repo> carries the raw slug, unresolved", () => {
    expect(parseCliArgs(["tabs", "--repo", "rafarc21/fleetflare"])).toEqual({
      cmd: "tabs", repo: "rafarc21/fleetflare", all: false, yes: false,
    });
    expect(parseCliArgs(["tabs", "--repo=rafarc21/fleetflare"])).toEqual({
      cmd: "tabs", repo: "rafarc21/fleetflare", all: false, yes: false,
    });
  });

  it("tabs --repo with no value is a usage error", () => {
    expect(parseCliArgs(["tabs", "--repo"]).cmd).toBe("usage");
  });

  it("tabs --all opts into the whole fleet, explicitly", () => {
    expect(parseCliArgs(["tabs", "--all"])).toEqual({ cmd: "tabs", repo: null, all: true, yes: false });
  });

  it("tabs --all --yes skips the confirmation prompt", () => {
    expect(parseCliArgs(["tabs", "--all", "--yes"])).toEqual({ cmd: "tabs", repo: null, all: true, yes: true });
    expect(parseCliArgs(["tabs", "--yes", "--all"])).toEqual({ cmd: "tabs", repo: null, all: true, yes: true });
  });

  it("tabs --repo and --all together is a usage error, not one silently winning", () => {
    expect(parseCliArgs(["tabs", "--repo", "rafarc21/fleetflare", "--all"]).cmd).toBe("usage");
  });

  it("tabs: an unrecognised token is a usage error, not silently ignored", () => {
    const parsed = parseCliArgs(["tabs", "--fresh"]);
    expect(parsed.cmd).toBe("usage");
    if (parsed.cmd === "usage") expect(parsed.message).toMatch(/unexpected "--fresh"/);
  });

  it("attach requires an id", () => {
    expect(parseCliArgs(["attach", "websites--pilot"])).toEqual({ cmd: "attach", id: "websites--pilot" });
    expect(parseCliArgs(["attach"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Board #220: a distinct, read-only sub-mode — print the studio's healthy
  // Orca attach terminal handle and exit, never the interactive WS attach.
  it("attach --print-handle parses as a read-only sub-mode", () => {
    expect(parseCliArgs(["attach", "websites--pilot", "--print-handle"])).toEqual({
      cmd: "attach", id: "websites--pilot", printHandle: true,
    });
  });

  it("attach --print-handle still requires an id", () => {
    expect(parseCliArgs(["attach", "--print-handle"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("attach rejects an unknown trailing flag rather than silently ignoring it", () => {
    expect(parseCliArgs(["attach", "websites--pilot", "--bogus"])).toEqual({
      cmd: "usage", message: `unexpected "--bogus"\n${CLI_USAGE}`,
    });
  });

  it("paste requires an id", () => {
    expect(parseCliArgs(["paste", "websites--pilot"])).toEqual({ cmd: "paste", id: "websites--pilot" });
    expect(parseCliArgs(["paste"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("spawn requires a role", () => {
    expect(parseCliArgs(["spawn", "scratch"]))
      .toEqual({ cmd: "spawn", role: "scratch", newInstance: false });
    expect(parseCliArgs(["spawn"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Issue #269: `--new` asks for an ADDITIONAL studio of this role in this
  // repo, on the lowest free instance number.
  it("spawn takes --new, and only as a flag after a real role", () => {
    expect(parseCliArgs(["spawn", "pilot", "--new"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: true });
    // `--new` with no role names no role — a usage error, never a spawn of a
    // studio called "--new".
    expect(parseCliArgs(["spawn", "--new"])).toEqual({ cmd: "usage", message: CLI_USAGE });
    expect(parseCliArgs(["spawn", "pilot", "--nope"]).cmd).toBe("usage");
    expect(parseCliArgs(["spawn", "pilot", "--new", "extra"]).cmd).toBe("usage");
  });

  it("provision requires an id", () => {
    expect(parseCliArgs(["provision", "websites--scratch"])).toEqual({ cmd: "provision", id: "websites--scratch", freshSession: false });
    expect(parseCliArgs(["provision"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("recycle requires an id", () => {
    expect(parseCliArgs(["recycle", "websites--scratch"])).toEqual({
      cmd: "recycle", id: "websites--scratch", discardUnsynced: false, freshSession: false,
    });
    expect(parseCliArgs(["recycle"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Issue #96: the only way past the guard is saying so.
  it("recycle <id> --discard-unsynced sets discardUnsynced: true", () => {
    expect(parseCliArgs(["recycle", "websites--scratch", "--discard-unsynced"])).toEqual({
      cmd: "recycle", id: "websites--scratch", discardUnsynced: true, freshSession: false,
    });
  });

  // Issue #28.
  it("--fresh-session: provision and recycle, in any order with --discard-unsynced; repeats and strays are usage errors", () => {
    expect(parseCliArgs(["provision", "websites--scratch", "--fresh-session"])).toEqual({
      cmd: "provision", id: "websites--scratch", freshSession: true,
    });
    expect(parseCliArgs(["recycle", "websites--scratch", "--fresh-session"])).toEqual({
      cmd: "recycle", id: "websites--scratch", discardUnsynced: false, freshSession: true,
    });
    for (const flags of [["--fresh-session", "--discard-unsynced"], ["--discard-unsynced", "--fresh-session"]]) {
      expect(parseCliArgs(["recycle", "websites--scratch", ...flags])).toEqual({
        cmd: "recycle", id: "websites--scratch", discardUnsynced: true, freshSession: true,
      });
    }
    expect(parseCliArgs(["provision", "websites--scratch", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["provision", "--fresh-session"])).toEqual({ cmd: "usage", message: CLI_USAGE });
    expect(parseCliArgs(["recycle", "websites--scratch", "--fresh-session", "--fresh-session"]).cmd).toBe("usage");
  });

  // Issue #35.
  it("task junior-sweep: bare/--dry-run is a dry run, --apply applies, anything else is usage", () => {
    expect(parseCliArgs(["task", "junior-sweep"])).toEqual({ cmd: "task-junior-sweep", apply: false });
    expect(parseCliArgs(["task", "junior-sweep", "--dry-run"])).toEqual({ cmd: "task-junior-sweep", apply: false });
    expect(parseCliArgs(["task", "junior-sweep", "--apply"])).toEqual({ cmd: "task-junior-sweep", apply: true });
    expect(parseCliArgs(["task", "junior-sweep", "--force"]).cmd).toBe("usage");
  });

  it("recycle: any other trailing token, or the flag in the id slot, is a usage error", () => {
    expect(parseCliArgs(["recycle", "websites--scratch", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["recycle", "--discard-unsynced"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("recycle's help names the flag and the price", () => {
    expect(CLI_USAGE).toContain("--discard-unsynced");
    expect(renderHelp()).toContain("No commits is NOT evidence of death");
  });

  // Board task #124: `fleet destroy <id> [--force]`.
  it("destroy requires an id, and force defaults to false", () => {
    expect(parseCliArgs(["destroy", "websites--scratch"])).toEqual({ cmd: "destroy", id: "websites--scratch", force: false, discardUnsynced: false });
    expect(parseCliArgs(["destroy"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("destroy <id> --force sets force: true", () => {
    expect(parseCliArgs(["destroy", "websites--scratch", "--force"])).toEqual({
      cmd: "destroy", id: "websites--scratch", force: true, discardUnsynced: false,
    });
  });

  it("destroy <id> --discard-unsynced, alone or with --force, in either order (#113 M3)", () => {
    expect(parseCliArgs(["destroy", "websites--scratch", "--discard-unsynced"])).toEqual({
      cmd: "destroy", id: "websites--scratch", force: false, discardUnsynced: true,
    });
    for (const rest of [["--force", "--discard-unsynced"], ["--discard-unsynced", "--force"]]) {
      expect(parseCliArgs(["destroy", "websites--scratch", ...rest])).toEqual({
        cmd: "destroy", id: "websites--scratch", force: true, discardUnsynced: true,
      });
    }
    expect(parseCliArgs(["destroy", "--discard-unsynced"])).toEqual({ cmd: "usage", message: CLI_USAGE });
    expect(parseCliArgs(["destroy", "websites--scratch", "--force", "--force"]).cmd).toBe("usage");
  });

  it("destroy: any trailing token other than --force is a usage error, not silently ignored", () => {
    const parsed = parseCliArgs(["destroy", "websites--scratch", "--verbose"]);
    expect(parsed.cmd).toBe("usage");
    if (parsed.cmd === "usage") expect(parsed.message).toMatch(/unexpected "--verbose"/);
  });

  // Code review round: `fleet destroy --force` with the id OMITTED must not
  // silently treat "--force" itself as the id (which would parse as
  // `{ cmd: "destroy", id: "--force", force: false }`, a real destroy target
  // named "--force") — it is a usage error, same as `fleet destroy` bare.
  it("destroy --force with no id is a usage error, not a destroy of a studio named \"--force\"", () => {
    expect(parseCliArgs(["destroy", "--force"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("an unrecognised command is a usage error, not a crash", () => {
    expect(parseCliArgs(["nonsense"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("empty argv (bare `fleet`) is a usage error", () => {
    expect(parseCliArgs([])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("every recognised command name is a case-sensitive exact match (no prefix matching)", () => {
    expect(parseCliArgs(["Spawn", "scratch"])).toEqual({ cmd: "usage", message: CLI_USAGE });
    expect(parseCliArgs(["spawning", "scratch"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  it("CLI_USAGE names every command this parser recognises", () => {
    for (const name of ["ls", "attach", "paste", "spawn", "provision", "recycle"]) {
      expect(CLI_USAGE).toContain(name);
    }
  });
});

// P4 §5's board verbs. Two words, unlike every command above them, because
// `task` is a NOUN with three operations — and flags rather than positionals
// because a brief is four fields (§5: objective, output format, boundaries),
// which no positional order would survive.
describe("parseCliArgs: task", () => {
  const flags = [
    "--title", "Build the board",
    "--objective", "A Worker-side board module.",
    "--output", "A PR, tests green.",
    "--boundaries", "No sprint close.",
  ];

  it("task new collects the whole brief", () => {
    expect(parseCliArgs(["task", "new", ...flags])).toEqual({
      cmd: "task-new",
      brief: {
        title: "Build the board",
        objective: "A Worker-side board module.",
        outputFormat: "A PR, tests green.",
        boundaries: "No sprint close.",
      },
    });
  });

  it("accepts --flag=value as well as --flag value", () => {
    const res = parseCliArgs(["task", "new", "--title=T", "--objective=O", "--output=F", "--boundaries=B"]);
    expect(res).toEqual({ cmd: "task-new", brief: { title: "T", objective: "O", outputFormat: "F", boundaries: "B" } });
  });

  it("carries --sprint through as the milestone", () => {
    const res = parseCliArgs(["task", "new", ...flags, "--sprint", "Sprint 1"]);
    expect(res.cmd).toBe("task-new");
    if (res.cmd !== "task-new") return;
    expect(res.brief.milestone).toBe("Sprint 1");
  });

  it("names the missing section rather than printing bare usage", () => {
    const res = parseCliArgs(["task", "new", "--title", "T", "--objective", "O"]);
    expect(res.cmd).toBe("usage");
    if (res.cmd !== "usage") return;
    expect(res.message).toContain("--output");
  });

  it("refuses an unknown flag and a flag with no value", () => {
    expect(parseCliArgs(["task", "new", ...flags, "--assignee", "x"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "new", ...flags, "--sprint"]).cmd).toBe("usage");
  });

  it("task ls takes no filters, or a sprint and a state", () => {
    expect(parseCliArgs(["task", "ls"])).toEqual({ cmd: "task-ls", query: {} });
    expect(parseCliArgs(["task", "ls", "--sprint", "Sprint 1", "--state", "working"])).toEqual({
      cmd: "task-ls", query: { milestone: "Sprint 1", state: "working" },
    });
  });

  it("task show takes one issue number and refuses anything else", () => {
    expect(parseCliArgs(["task", "show", "12"])).toEqual({ cmd: "task-show", number: 12 });
    expect(parseCliArgs(["task", "show", "abc"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "show"]).cmd).toBe("usage");
  });

  // Board task #119: the mechanical-followability check, same grammar as
  // `task show` — one positional issue number, nothing else.
  it("task verify takes one issue number and refuses anything else", () => {
    expect(parseCliArgs(["task", "verify", "12"])).toEqual({ cmd: "task-verify", number: 12 });
    expect(parseCliArgs(["task", "verify", "abc"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "verify"]).cmd).toBe("usage");
  });

  it("refuses an unknown task subcommand and a bare `task`", () => {
    expect(parseCliArgs(["task"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "close", "12"]).cmd).toBe("usage");
  });

  // Task 5: the maestro's per-task authorization for the junior skill.
  // `--junior` is the one bare boolean flag on `task new` — no value, unlike
  // every other flag here — so it must be pulled out before parseFlags runs,
  // which is why it can sit anywhere in the argv, not just at the end.
  it("task new --junior is a bare boolean flag, anywhere after new", () => {
    const a = parseCliArgs(["task", "new", ...flags, "--junior"]);
    expect(a.cmd === "task-new" && a.brief.junior).toBe(true);
    const b = parseCliArgs(["task", "new", "--junior", ...flags]);
    expect(b.cmd === "task-new" && b.brief.junior).toBe(true);
    const c = parseCliArgs(["task", "new", ...flags]);
    expect(c.cmd === "task-new" && c.brief.junior).toBeUndefined();
    expect(parseCliArgs(["task", "ls", "--junior"]).cmd).toBe("usage");
  });

  // Task 5 review: the naive `rest.includes("--junior")` extraction is
  // positionally blind — it matches the literal string "--junior" no matter
  // WHERE it sits, including inside another flag's VALUE slot. Here
  // `--boundaries`'s value is itself the literal string "--junior"; that must
  // stay `boundaries: "--junior"` and must NOT flip `brief.junior` to true.
  it("a --junior VALUE (e.g. --boundaries --junior) is not the bare boolean flag", () => {
    const res = parseCliArgs([
      "task", "new",
      "--title", "t",
      "--objective", "o",
      "--output", "f",
      "--boundaries", "--junior",
      "--studio", "a",
    ]);
    expect(res.cmd).toBe("task-new");
    if (res.cmd !== "task-new") return;
    expect(res.brief.boundaries).toBe("--junior");
    expect(res.brief.assignee).toBe("a");
    expect(res.brief.junior).toBeUndefined();
  });
});

describe("fleet task assign — P5 §3 reassignment", () => {
  it("takes the issue number and the role as positionals", () => {
    expect(parseCliArgs(["task", "assign", "42", "release-studio"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "release-studio" });
  });

  it("takes an optional --why, which is what the lineage comment carries", () => {
    expect(parseCliArgs(["task", "assign", "42", "release-studio", "--why", "web studio died"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "release-studio", why: "web studio died" });
  });

  // Issue #269: the second positional is a TARGET. Its SHAPE is resolved by
  // repo.ts's studioIdForTarget at the call site (test/studio.repo.test.ts);
  // what this verb owes is carrying every shape through verbatim rather than
  // refusing the two new ones as "not a role".
  it("carries an instance-suffixed role and a full studio id through unchanged", () => {
    expect(parseCliArgs(["task", "assign", "42", "pilot--2"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "pilot--2" });
    expect(parseCliArgs(["task", "assign", "42", "websites--pilot"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "websites--pilot" });
    expect(parseCliArgs(["task", "assign", "42", "websites--web-studio--3", "--why", "second lead"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "websites--web-studio--3", why: "second lead" });
  });

  it("refuses a missing or non-numeric issue number", () => {
    expect(parseCliArgs(["task", "assign"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "assign", "abc", "release-studio"]).cmd).toBe("usage");
  });

  it("refuses a missing role rather than assigning to nobody", () => {
    expect(parseCliArgs(["task", "assign", "42"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "assign", "42", "--why", "x"]).cmd).toBe("usage");
  });

  it("refuses an unknown flag — a silently dropped --why loses the reason", () => {
    expect(parseCliArgs(["task", "assign", "42", "release-studio", "--reason", "x"]).cmd).toBe("usage");
  });
});

// Board task #131: `fleet task state <n> <to>` — the CLI verb wrapping
// transitionTask's existing compare-and-swap route. `to` is validated at
// PARSE TIME against the full TASK_STATES vocabulary, same discipline
// `task show`'s numeric-id regex already applies — no wasted round trip for
// an obviously bad state name.
describe("fleet task state — board task #131", () => {
  it("parses a valid target state — proven for more than one vocabulary value", () => {
    expect(parseCliArgs(["task", "state", "42", "working"]))
      .toEqual({ cmd: "task-state", number: 42, to: "working" });
    expect(parseCliArgs(["task", "state", "42", "completed"]))
      .toEqual({ cmd: "task-state", number: 42, to: "completed" });
    expect(parseCliArgs(["task", "state", "7", "canceled"]))
      .toEqual({ cmd: "task-state", number: 7, to: "canceled" });
  });

  it("refuses a missing or non-numeric issue number", () => {
    expect(parseCliArgs(["task", "state"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "state", "abc", "working"]).cmd).toBe("usage");
  });

  it("rejects an unknown target state at parse time, listing the vocabulary — no network round trip", () => {
    const parsed = parseCliArgs(["task", "state", "42", "bogus"]);
    expect(parsed.cmd).toBe("usage");
    if (parsed.cmd !== "usage") return;
    expect(parsed.message).toContain("submitted|working|input_required|completed|failed|canceled");
  });

  it("refuses a missing target state rather than defaulting to one", () => {
    expect(parseCliArgs(["task", "state", "42"]).cmd).toBe("usage");
  });
});

// Board issue #8: `fleet task reap [--dry-run|--apply]`. Zero positionals,
// an optional bare boolean flag — same shape `destroy`'s own bespoke
// `--force` handling takes (top-level switch), adapted here inside
// parseTask's own "reap" branch. Bare and `--dry-run` are the SAME
// non-executing posture; `--apply` is the only flag that closes anything.
describe("fleet task ls --repo — issue #63", () => {
  it("--repo rides the query", () => {
    expect(parseCliArgs(["task", "ls", "--studio", "acmeclient--web-studio", "--repo", "example-org/acmeclient"]))
      .toEqual({ cmd: "task-ls", query: { assignedTo: "acmeclient--web-studio", repo: "example-org/acmeclient" } });
  });
});

describe("fleet task new --continues — issue #54", () => {
  const base = ["task", "new", "--title", "T", "--objective", "O", "--output", "F", "--boundaries", "B"];
  it("--continues N rides the brief as a number", () => {
    const r = parseCliArgs([...base, "--continues", "7"]);
    expect(r).toMatchObject({ cmd: "task-new", brief: { continues: 7 } });
    expect(parseCliArgs([...base, "--continues=12"])).toMatchObject({ cmd: "task-new", brief: { continues: 12 } });
  });
  it("a non-number is usage", () => {
    expect(parseCliArgs([...base, "--continues", "seven"])).toMatchObject({ cmd: "usage" });
    expect(parseCliArgs([...base, "--continues", "0"])).toMatchObject({ cmd: "usage" });
  });
});

describe("fleet ls --json — issue #70", () => {
  it("--json sets json; combines with --fresh", () => {
    expect(parseCliArgs(["ls", "--json"])).toEqual({ cmd: "ls", fresh: false, json: true });
    expect(parseCliArgs(["ls", "--fresh", "--json"])).toEqual({ cmd: "ls", fresh: true, json: true });
    expect(parseCliArgs(["ls"])).toEqual({ cmd: "ls", fresh: false, json: false });
  });
});

describe("fleet task state --from-none — issue #82", () => {
  it("--from-none after the positionals sets fromNone", () => {
    expect(parseCliArgs(["task", "state", "12", "completed", "--from-none"]))
      .toEqual({ cmd: "task-state", number: 12, to: "completed", fromNone: true });
  });
  it("without it the shape is unchanged; anything else extra is usage", () => {
    expect(parseCliArgs(["task", "state", "12", "completed"])).toEqual({ cmd: "task-state", number: 12, to: "completed" });
    expect(parseCliArgs(["task", "state", "12", "completed", "--force"])).toMatchObject({ cmd: "usage" });
  });
});

describe("fleet task reap --terminal — issue #55", () => {
  it("--terminal is a dry run; with --apply it applies; flag order free", () => {
    expect(parseCliArgs(["task", "reap", "--terminal"])).toEqual({ cmd: "task-reap", apply: false, terminal: true });
    expect(parseCliArgs(["task", "reap", "--terminal", "--apply"])).toEqual({ cmd: "task-reap", apply: true, terminal: true });
    expect(parseCliArgs(["task", "reap", "--apply", "--terminal"])).toEqual({ cmd: "task-reap", apply: true, terminal: true });
    expect(parseCliArgs(["task", "reap", "--dry-run", "--terminal"])).toEqual({ cmd: "task-reap", apply: false, terminal: true });
  });
  it("plain reap keeps its old shape", () => {
    expect(parseCliArgs(["task", "reap", "--apply"])).toEqual({ cmd: "task-reap", apply: true });
  });
});

describe("fleet task reap — board issue #8", () => {
  it("bare `task reap` is a dry-run — apply: false", () => {
    expect(parseCliArgs(["task", "reap"])).toEqual({ cmd: "task-reap", apply: false });
  });

  it("`--dry-run` is an explicit synonym for the same default posture", () => {
    expect(parseCliArgs(["task", "reap", "--dry-run"])).toEqual({ cmd: "task-reap", apply: false });
  });

  it("`--apply` is the only flag that executes", () => {
    expect(parseCliArgs(["task", "reap", "--apply"])).toEqual({ cmd: "task-reap", apply: true });
  });

  it("an unrecognised trailing token is a usage error, never silently ignored", () => {
    expect(parseCliArgs(["task", "reap", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "reap", "bogus"]).cmd).toBe("usage");
  });

  it("more than one token after `reap` is a usage error, not last-one-wins", () => {
    expect(parseCliArgs(["task", "reap", "--apply", "--dry-run"]).cmd).toBe("usage");
  });
});

describe("fleet task — --studio (§5 assignment)", () => {
  const required = ["--title", "T", "--objective", "O", "--output", "F", "--boundaries", "B"];

  it("`fleet task new --studio <id>` carries the studio to the wire as `assignee`", () => {
    const cmd = parseCliArgs(["task", "new", ...required, "--studio", "websites--web-studio"]);
    expect(cmd).toEqual({
      cmd: "task-new",
      brief: { title: "T", objective: "O", outputFormat: "F", boundaries: "B", assignee: "websites--web-studio" },
    });
  });

  it("omitting it files an unassigned task rather than guessing an owner", () => {
    const cmd = parseCliArgs(["task", "new", ...required]);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd === "task-new") expect(cmd.brief.assignee).toBeUndefined();
  });

  it("`fleet task ls --studio <id>` filters the board by owner", () => {
    expect(parseCliArgs(["task", "ls", "--studio", "websites--web-studio"]))
      .toEqual({ cmd: "task-ls", query: { assignedTo: "websites--web-studio" } });
  });

  it("the usage text names the flag on both subcommands", () => {
    expect(CLI_USAGE).toContain("--studio");
  });
});

// Issue #278: `--repo <owner/name>` overrides CWD detection for `task new` —
// same override-wins-over-detection precedence `fleet tabs`'s own `--repo`
// already establishes for itself (cli-args.ts stays pure here; cmdTaskNew in
// cli/fleet.ts is what actually applies the override over detectRepo()).
describe("fleet task new — --repo (issue #278)", () => {
  const required = ["--title", "T", "--objective", "O", "--output", "F", "--boundaries", "B"];

  it("`fleet task new --repo <owner/name>` carries repo into the brief", () => {
    const cmd = parseCliArgs(["task", "new", ...required, "--repo", "acme/widgets"]);
    expect(cmd).toEqual({
      cmd: "task-new",
      brief: { title: "T", objective: "O", outputFormat: "F", boundaries: "B", repo: "acme/widgets" },
    });
  });

  it("accepts --repo=value as well as --repo value", () => {
    const cmd = parseCliArgs(["task", "new", ...required, "--repo=acme/widgets"]);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd === "task-new") expect(cmd.brief.repo).toBe("acme/widgets");
  });

  it("omitting it leaves repo absent — CWD detection stays the default", () => {
    const cmd = parseCliArgs(["task", "new", ...required]);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd === "task-new") expect(cmd.brief.repo).toBeUndefined();
  });

  it("combines with every other existing flag", () => {
    const cmd = parseCliArgs([
      "task", "new", ...required,
      "--sprint", "Sprint 1", "--studio", "websites--web-studio", "--repo", "acme/widgets",
    ]);
    expect(cmd).toEqual({
      cmd: "task-new",
      brief: {
        title: "T", objective: "O", outputFormat: "F", boundaries: "B",
        milestone: "Sprint 1", assignee: "websites--web-studio", repo: "acme/widgets",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// `fleet help` — the whole surface, for an agent. Accurate BY CONSTRUCTION:
// VERBS is typed against the CliCommand union, so a new command that ships
// without help is a compile error. These tests pin the properties that
// typing alone cannot: that both renderings come from that one table, and
// that the text names the things an agent cannot otherwise discover.
// ---------------------------------------------------------------------------

describe("fleet help", () => {
  it("answers to help, --help and -h", () => {
    expect(parseCliArgs(["help"])).toEqual({ cmd: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ cmd: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ cmd: "help" });
  });

  it("documents every verb the CLI dispatches, by name — no verb can be missing", () => {
    const help = renderHelp();
    for (const cmd of Object.keys(VERBS)) {
      const two = ["task-", "memory-"].find((prefix) => cmd.startsWith(prefix));
      const word = two ? `fleet ${two.slice(0, -1)} ${cmd.slice(two.length)}` : `fleet ${cmd}`;
      expect(help).toContain(word);
    }
  });

  it("gives every verb a real one-line summary, never a bare restatement of its name", () => {
    for (const [cmd, help] of Object.entries(VERBS)) {
      expect(help.summary.length, cmd).toBeGreaterThan(20);
      expect(help.summary.trim().endsWith("."), cmd).toBe(true);
    }
  });

  it("derives the short usage from the same table, so the two can never disagree", () => {
    for (const [cmd, help] of Object.entries(VERBS)) {
      const name = cmd.startsWith("task-") ? "task" : cmd.startsWith("memory-") ? "memory" : cmd;
      expect(CLI_USAGE).toContain(`fleet ${name}${help.args ? " " + help.args : ""}`);
    }
    expect(CLI_USAGE).toContain("fleet help");
  });

  it("covers ff and the in-container CLI — an agent that finds only this binary is still lost", () => {
    const help = renderHelp();
    expect(help).toContain("ff <role>");
    expect(help).toContain("fleet task report <n>");
    expect(help).toContain("There is no ls, attach or recycle there");
  });

  it("names the two facts an agent gets wrong: recycle-vs-provision, and who writes task state", () => {
    const help = renderHelp();
    expect(help).toContain("only through recycle");
    expect(help).toContain("single writer of task state");
  });
});

// P5 §9's memory pass, on the Mac cockpit.
describe("fleet memory", () => {
  it("bare `memory` and `memory ls` are both the survey — the read you do before proposing anything", () => {
    expect(parseCliArgs(["memory"])).toEqual({ cmd: "memory-ls" });
    expect(parseCliArgs(["memory", "ls"])).toEqual({ cmd: "memory-ls" });
  });
  it("`memory compact` is the write, and it is the only one", () => {
    expect(parseCliArgs(["memory", "compact"])).toEqual({ cmd: "memory-compact" });
  });
  it("anything else under memory is a usage error, never a silent no-op", () => {
    const parsed = parseCliArgs(["memory", "delete"]);
    expect(parsed.cmd).toBe("usage");
    if (parsed.cmd === "usage") expect(parsed.message).toMatch(/unknown memory command/);
  });
  it("help renders both under one `fleet memory` heading and says nothing is deleted", () => {
    const help = renderHelp();
    expect(help).toContain("fleet memory ls");
    expect(help).toContain("fleet memory compact");
    expect(help).toMatch(/never deletes/);
  });
});

// Issue #217: `fleet rescue-gc [--older-than N] [--dry-run|--apply]`.
describe("fleet rescue-gc — issue #217", () => {
  it("bare is a dry-run over branches older than 14 days", () => {
    expect(parseCliArgs(["rescue-gc"])).toEqual({ cmd: "rescue-gc", apply: false, olderThanDays: 14 });
  });
  it("--apply, --dry-run, --older-than N and --older-than=N", () => {
    expect(parseCliArgs(["rescue-gc", "--apply"])).toEqual({ cmd: "rescue-gc", apply: true, olderThanDays: 14 });
    expect(parseCliArgs(["rescue-gc", "--dry-run"])).toEqual({ cmd: "rescue-gc", apply: false, olderThanDays: 14 });
    expect(parseCliArgs(["rescue-gc", "--older-than", "7"])).toEqual({ cmd: "rescue-gc", apply: false, olderThanDays: 7 });
    expect(parseCliArgs(["rescue-gc", "--older-than=3", "--apply"])).toEqual({ cmd: "rescue-gc", apply: true, olderThanDays: 3 });
  });
  it("a non-number age, an unknown flag, or --apply with --dry-run is a usage error", () => {
    expect(parseCliArgs(["rescue-gc", "--older-than", "soon"]).cmd).toBe("usage");
    expect(parseCliArgs(["rescue-gc", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["rescue-gc", "--apply", "--dry-run"]).cmd).toBe("usage");
  });
});

// Issue #251: `fleet rescue-all [--repo R] [--dry-run]`.
describe("fleet rescue-all — issue #251", () => {
  it("bare targets every repo, live (not a dry-run)", () => {
    expect(parseCliArgs(["rescue-all"])).toEqual({ cmd: "rescue-all", repo: null, dryRun: false });
  });
  it("--dry-run, --repo <value> and --repo=<value>", () => {
    expect(parseCliArgs(["rescue-all", "--dry-run"])).toEqual({ cmd: "rescue-all", repo: null, dryRun: true });
    expect(parseCliArgs(["rescue-all", "--repo", "acme/website"])).toEqual({ cmd: "rescue-all", repo: "acme/website", dryRun: false });
    expect(parseCliArgs(["rescue-all", "--repo=acme/website", "--dry-run"])).toEqual({ cmd: "rescue-all", repo: "acme/website", dryRun: true });
  });
  it("an unknown flag or a --repo with no value is a usage error", () => {
    expect(parseCliArgs(["rescue-all", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["rescue-all", "--repo"]).cmd).toBe("usage");
  });
});

// Issue #53: `fleet reap [--idle D] [--repo R] [--dry-run|--apply]`.
describe("fleet reap — issue #53", () => {
  it("bare is a dry-run with the long default threshold and no repo override", () => {
    expect(parseCliArgs(["reap"])).toEqual({ cmd: "reap", apply: false, idleMs: 30 * 60_000, repo: null });
  });
  it("--apply, --dry-run, --idle <d>, --idle=<d>, --repo", () => {
    expect(parseCliArgs(["reap", "--apply"])).toEqual({ cmd: "reap", apply: true, idleMs: 30 * 60_000, repo: null });
    expect(parseCliArgs(["reap", "--dry-run", "--idle", "5m"])).toEqual({ cmd: "reap", apply: false, idleMs: 5 * 60_000, repo: null });
    expect(parseCliArgs(["reap", "--idle=2h", "--repo", "example-org/acmeclient", "--apply"]))
      .toEqual({ cmd: "reap", apply: true, idleMs: 2 * 3_600_000, repo: "example-org/acmeclient" });
  });
  it("a bad duration, an unknown flag, or both modes is a usage error", () => {
    expect(parseCliArgs(["reap", "--idle", "5"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--idle"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--discard-unsynced"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--apply", "--dry-run"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--repo"]).cmd).toBe("usage");
  });
  it("--idle below 5m is refused (review item 6); exactly 5m is allowed", () => {
    expect(parseCliArgs(["reap", "--idle", "4m"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--idle", "299s"]).cmd).toBe("usage");
    expect(parseCliArgs(["reap", "--idle", "300s"])).toEqual({ cmd: "reap", apply: false, idleMs: 5 * 60_000, repo: null });
  });
});

// Task 8: `fleet junior enable|disable|status` — local opt-in, never touches
// the Worker or any studio.
describe("fleet junior", () => {
  it("junior verbs", () => {
    expect(parseCliArgs(["junior", "enable"])).toEqual({ cmd: "junior", action: "enable" });
    expect(parseCliArgs(["junior", "enable", "--account", "abc"])).toEqual({ cmd: "junior", action: "enable", account: "abc" });
    expect(parseCliArgs(["junior", "disable"])).toEqual({ cmd: "junior", action: "disable" });
    expect(parseCliArgs(["junior", "status"])).toEqual({ cmd: "junior", action: "status" });
    expect(parseCliArgs(["junior"]).cmd).toBe("usage");
    expect(parseCliArgs(["junior", "nuke"]).cmd).toBe("usage");
    expect(parseCliArgs(["junior", "enable", "--acount", "x"]).cmd).toBe("usage");
  });
});
