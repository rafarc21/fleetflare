import { describe, it, expect } from "vitest";
import { parseCliArgs, CLI_USAGE, VERBS, renderHelp } from "../src/studio/cli-args";
import { RETRO_TASK_TEMPLATE } from "../src/studio/retro-template";
// Per-verb describes over parseCliArgs — split from studio.cli-args.test.ts
// (sweep-45 F13). The parse-core half lives in studio.cli-args-parse.test.ts.
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

  // #501 F6: both usage errors name all three target forms the parser accepts
  // (VERBS.task-assign's args line spells them; the error strings must too).
  // The assertion reads the message's OWN first line, not the full CLI_USAGE
  // dump appended after it — the dump already carries the args line's
  // three-form spelling and would make this pass on the wrong string.
  it("usage errors name all three target forms: role | role--k | studio-id (#501 F6)", () => {
    const missing = parseCliArgs(["task", "assign", "84"]);
    expect(missing.cmd).toBe("usage");
    if (missing.cmd !== "usage") throw new Error("unreachable");
    expect(missing.message.split("\n")[0]).toContain("fleet task assign <n> <role | role--k | studio-id>");
    const flagLooking = parseCliArgs(["task", "assign", "84", "--why"]);
    expect(flagLooking.cmd).toBe("usage");
    if (flagLooking.cmd !== "usage") throw new Error("unreachable");
    expect(flagLooking.message.split("\n")[0]).toContain("fleet task assign <n> <role | role--k | studio-id>");
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
    // The message's OWN first line, not the full CLI_USAGE dump appended
    // after it (which also lists task-ls's own --state vocabulary and would
    // make this assertion pass on the wrong string).
    const firstLine = parsed.message.split("\n")[0];
    expect(firstLine).toContain("submitted|working|input_required|awaiting_merge|completed|failed|canceled");
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
    expect(parseCliArgs(["ls", "--json"])).toEqual({ cmd: "ls", fresh: false, json: true, prs: false });
    expect(parseCliArgs(["ls", "--fresh", "--json"])).toEqual({ cmd: "ls", fresh: true, json: true, prs: false });
    expect(parseCliArgs(["ls"])).toEqual({ cmd: "ls", fresh: false, json: false, prs: false });
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

// Issue #165: `fleet task new --template retro` files the weekly retro board
// task from a fixed brief (apps/fleet/src/studio/retro-template.ts's
// RETRO_TASK_TEMPLATE) instead of the operator retyping the same four
// sections every week. `--template` is an ordinary value-taking flag through
// the ALREADY-existing parseFlags path (TASK_FLAGS.new), not a bare boolean
// like --junior/--provision — see cli-args.ts's own TASK_FLAGS comment for
// why an unknown flag is always a usage error rather than silently ignored.
describe("fleet task new --template retro — issue #165", () => {
  it("`--template retro` alone produces the full template brief", () => {
    const cmd = parseCliArgs(["task", "new", "--template", "retro"]);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd !== "task-new") return;
    expect(cmd.brief).toEqual({
      title: RETRO_TASK_TEMPLATE.title,
      objective: RETRO_TASK_TEMPLATE.objective,
      outputFormat: RETRO_TASK_TEMPLATE.outputFormat,
      boundaries: RETRO_TASK_TEMPLATE.boundaries,
    });
  });

  it("`--template retro --title \"custom\"` overrides just the title, rest from template", () => {
    const cmd = parseCliArgs(["task", "new", "--template", "retro", "--title", "custom retro title"]);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd !== "task-new") return;
    expect(cmd.brief).toEqual({
      title: "custom retro title",
      objective: RETRO_TASK_TEMPLATE.objective,
      outputFormat: RETRO_TASK_TEMPLATE.outputFormat,
      boundaries: RETRO_TASK_TEMPLATE.boundaries,
    });
  });

  it("`--template bogus` is refused with a usage error naming the problem", () => {
    const cmd = parseCliArgs(["task", "new", "--template", "bogus"]);
    expect(cmd.cmd).toBe("usage");
    if (cmd.cmd !== "usage") return;
    expect(cmd.message).toContain("retro");
  });

  it("a plain `task new` with no --template is completely unaffected", () => {
    const required = ["--title", "T", "--objective", "O", "--output", "F", "--boundaries", "B"];
    expect(parseCliArgs(["task", "new", ...required])).toEqual({
      cmd: "task-new",
      brief: { title: "T", objective: "O", outputFormat: "F", boundaries: "B" },
    });
  });

  it("other brief flags, --studio, --sprint, --continues, --junior still work alongside --template retro", () => {
    const cmd = parseCliArgs([
      "task", "new", "--template", "retro",
      "--studio", "websites--maestro", "--sprint", "Sprint 1", "--junior",
    ]);
    expect(cmd.cmd).toBe("task-new");
    if (cmd.cmd !== "task-new") return;
    expect(cmd.brief.assignee).toBe("websites--maestro");
    expect(cmd.brief.milestone).toBe("Sprint 1");
    expect(cmd.brief.junior).toBe(true);
    expect(cmd.brief.objective).toBe(RETRO_TASK_TEMPLATE.objective);
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
      // #717: models' three cmd literals (models-ls/-assign/-set) don't
      // share task-/accounts-'s "suffix is the sub-action word" shape (ls
      // has none, set's own sub-action is promote/demote, not "set") — the
      // collapsed verb name alone is still a genuine substring of every one
      // of its rendered lines, which is all this test is pinning.
      if (cmd.startsWith("models-")) { expect(help).toContain("fleet models"); continue; }
      if (cmd.startsWith("gate-")) { expect(help).toContain("fleet gate"); continue; }
      const two = ["task-", "memory-", "accounts-"].find((prefix) => cmd.startsWith(prefix));
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
      const name = cmd.startsWith("task-") ? "task" : cmd.startsWith("memory-") ? "memory"
        : cmd.startsWith("accounts-") ? "accounts" : cmd.startsWith("models-") ? "models"
        : cmd.startsWith("gate-") ? "gate" : cmd;
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
  // #568 / sweep-20 F6: compact is the one memory verb with a durable,
  // outward-facing artifact — it opens a PR in the blueprint repo — so a
  // stray token (a flag the caller believes in, a paste accident) must be
  // a usage error, never a silently-dropped extra.
  it("an extra token after `memory compact` (or after `memory ls`) is a usage error, never silently dropped (#568)", () => {
    for (const argv of [["junk"], ["--json"]]) {
      const parsed = parseCliArgs(["memory", "compact", ...argv]);
      expect(parsed.cmd).toBe("usage");
      if (parsed.cmd === "usage") {
        expect(parsed.message).toMatch(/unexpected/);
        expect(parsed.message).toContain("fleet memory takes only ls | compact");
      }
    }
    const ls = parseCliArgs(["memory", "ls", "x"]);
    expect(ls.cmd).toBe("usage");
    if (ls.cmd === "usage") expect(ls.message).toMatch(/unexpected/);
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

// Issue #232, step 3: `fleet accounts [sync] [--watch] [--json]`. `sync` is
// an optional sub-action (like `fleet memory ls|compact`'s bare-word split),
// never a value-taking flag — the Worker POST it triggers is real, so it must
// be spelled out, never defaulted to by a flag combination.
describe("fleet accounts", () => {
  it("bare accounts: read-only, no watch, no json, no write-labels", () => {
    expect(parseCliArgs(["accounts"])).toEqual({ cmd: "accounts", sync: false, watch: false, json: false, writeLabels: false });
  });

  it("accounts sync sets sync: true", () => {
    expect(parseCliArgs(["accounts", "sync"])).toEqual({ cmd: "accounts", sync: true, watch: false, json: false, writeLabels: false });
  });

  it("--watch and --json combine, in any order, with or without sync", () => {
    expect(parseCliArgs(["accounts", "--watch"])).toEqual({ cmd: "accounts", sync: false, watch: true, json: false, writeLabels: false });
    expect(parseCliArgs(["accounts", "--json"])).toEqual({ cmd: "accounts", sync: false, watch: false, json: true, writeLabels: false });
    expect(parseCliArgs(["accounts", "--watch", "--json"])).toEqual({ cmd: "accounts", sync: false, watch: true, json: true, writeLabels: false });
    expect(parseCliArgs(["accounts", "sync", "--watch"])).toEqual({ cmd: "accounts", sync: true, watch: true, json: false, writeLabels: false });
    expect(parseCliArgs(["accounts", "sync", "--json", "--watch"])).toEqual({ cmd: "accounts", sync: true, watch: true, json: true, writeLabels: false });
  });

  // MAJOR 4 (STATUS comment): --write-labels is independent of every other
  // flag here, combinable with any of them, in any order.
  it("--write-labels combines with sync/--watch/--json, in any order", () => {
    expect(parseCliArgs(["accounts", "--write-labels"])).toEqual({ cmd: "accounts", sync: false, watch: false, json: false, writeLabels: true });
    expect(parseCliArgs(["accounts", "--json", "--write-labels"])).toEqual({ cmd: "accounts", sync: false, watch: false, json: true, writeLabels: true });
    expect(parseCliArgs(["accounts", "sync", "--write-labels", "--watch"])).toEqual({ cmd: "accounts", sync: true, watch: true, json: false, writeLabels: true });
  });

  it("an unrecognised token is a usage error, not silently ignored", () => {
    expect(parseCliArgs(["accounts", "--fresh"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "sync", "--force"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "nuke"]).cmd).toBe("usage");
  });
});

// Issue #336: the operator's manual slot hold and its clear.
describe("fleet accounts hold|clear", () => {
  it("hold <slot> alone holds until cleared", () => {
    expect(parseCliArgs(["accounts", "hold", "CLAUDE_CODE_OAUTH_TOKEN_2"]))
      .toEqual({ cmd: "accounts-hold", name: "CLAUDE_CODE_OAUTH_TOKEN_2", until: null, reason: null });
  });

  it("hold takes --until ISO and --reason TEXT, in any order", () => {
    expect(parseCliArgs(["accounts", "hold", "CLAUDE_CODE_OAUTH_TOKEN_2", "--reason", "org cap", "--until", "2026-11-01T00:00:00Z"]))
      .toEqual({ cmd: "accounts-hold", name: "CLAUDE_CODE_OAUTH_TOKEN_2", until: "2026-11-01T00:00:00Z", reason: "org cap" });
  });

  it("hold refuses a missing slot, an unparseable --until, a flag with no value, an unknown flag", () => {
    expect(parseCliArgs(["accounts", "hold"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "hold", "--until", "2026-11-01T00:00:00Z"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "hold", "S", "--until", "tomorrow"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "hold", "S", "--reason"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "hold", "S", "--force"]).cmd).toBe("usage");
  });

  // #501 F7: same refusals as above, but the message NAMES the flag (and the
  // bad value for --until) instead of the bare usage line — wording only; the
  // parse result on every shape above stays "usage" exactly as it was.
  it("hold names the flag in its refusals: --until's bad/missing value, --reason's missing value (#501 F7)", () => {
    const badDate = parseCliArgs(["accounts", "hold", "S", "--until", "not-a-date"]);
    expect(badDate.cmd).toBe("usage");
    if (badDate.cmd !== "usage") throw new Error("unreachable");
    expect(badDate.message).toContain('--until needs a parseable ISO date (got "not-a-date")');

    const noReason = parseCliArgs(["accounts", "hold", "S", "--reason"]);
    expect(noReason.cmd).toBe("usage");
    if (noReason.cmd !== "usage") throw new Error("unreachable");
    expect(noReason.message).toContain("--reason needs a text value");

    const noUntil = parseCliArgs(["accounts", "hold", "S", "--until"]);
    expect(noUntil.cmd).toBe("usage");
    if (noUntil.cmd !== "usage") throw new Error("unreachable");
    expect(noUntil.message).toContain("--until needs a parseable ISO date");
  });

  // --reason keeps accepting any text value, "--"-prefixed included — the
  // #501 F7 behavior pin: wording changes, never what parses.
  it("hold still accepts a --reason value that starts with -- (behavior unchanged, #501 F7)", () => {
    expect(parseCliArgs(["accounts", "hold", "S", "--reason", "--until"]))
      .toEqual({ cmd: "accounts-hold", name: "S", until: null, reason: "--until" });
  });

  it("clear <slot>", () => {
    expect(parseCliArgs(["accounts", "clear", "CLAUDE_CODE_OAUTH_TOKEN_2"]))
      .toEqual({ cmd: "accounts-clear", name: "CLAUDE_CODE_OAUTH_TOKEN_2" });
  });

  // #717: `fleet models [assign <studio> <model> | promote <model> | demote
  // <model>]` — bare lists the pool table, the three sub-actions each POST.
  it("models parses", () => {
    expect(parseCliArgs(["models"])).toEqual({ cmd: "models-ls" });
    expect(parseCliArgs(["models", "assign", "r--web-studio--49", "kimi"]))
      .toEqual({ cmd: "models-assign", studio: "r--web-studio--49", model: "kimi" });
    expect(parseCliArgs(["models", "demote", "deepseek"]))
      .toEqual({ cmd: "models-set", state: "demote", model: "deepseek" });
    expect(parseCliArgs(["models", "promote", "deepseek"]))
      .toEqual({ cmd: "models-set", state: "promote", model: "deepseek" });
    expect(parseCliArgs(["models", "bogus"]).cmd).toBe("usage");
  });

  it("clear refuses a missing slot or extra tokens", () => {
    expect(parseCliArgs(["accounts", "clear"]).cmd).toBe("usage");
    expect(parseCliArgs(["accounts", "clear", "S", "T"]).cmd).toBe("usage");
  });
});

// Board task #565 (sweep 20, S20-F3): `0` is GitHub's "no issue" and this
// CLI's own --continues grammar already refuses it; a >2^53 digit string
// rounds in Number() to an issue that cannot exist. All four number-taking
// task verbs share the grammar — pinned here per verb.
describe("task number grammar refuses 0 and past-2^53 — board task #565", () => {
  const past = "99999999999999999999"; // 20 nines — Number() rounds past 2^53

  it("task show refuses 0, a leading-zero string, and past-2^53", () => {
    expect(parseCliArgs(["task", "show", "0"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "show", "042"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "show", past]).cmd).toBe("usage");
    // 2^53-1 is the top of the accepted range; 2^53 itself is past it.
    expect(parseCliArgs(["task", "show", "9007199254740991"])).toEqual({ cmd: "task-show", number: 9007199254740991 });
    expect(parseCliArgs(["task", "show", "9007199254740992"]).cmd).toBe("usage");
  });

  it("task verify refuses 0 and past-2^53", () => {
    expect(parseCliArgs(["task", "verify", "0"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "verify", past]).cmd).toBe("usage");
  });

  it("task assign refuses 0 and past-2^53 as its number", () => {
    expect(parseCliArgs(["task", "assign", "0", "pilot"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "assign", past, "pilot"]).cmd).toBe("usage");
  });

  it("task state refuses 0 and past-2^53 as its number", () => {
    expect(parseCliArgs(["task", "state", "0", "working"]).cmd).toBe("usage");
    expect(parseCliArgs(["task", "state", past, "working"]).cmd).toBe("usage");
  });

  it("the refusal names the got value — not just a bare needs-an-issue-number", () => {
    const parsed = parseCliArgs(["task", "show", "0"]);
    expect(parsed.cmd).toBe("usage");
    if (parsed.cmd !== "usage") return;
    expect(parsed.message).toContain(`(got "0")`);
  });

  it("a real issue number still parses — the grammar is a floor, not a ceiling", () => {
    expect(parseCliArgs(["task", "show", "12"])).toEqual({ cmd: "task-show", number: 12 });
    expect(parseCliArgs(["task", "verify", "12"])).toEqual({ cmd: "task-verify", number: 12 });
    expect(parseCliArgs(["task", "assign", "42", "pilot"]))
      .toEqual({ cmd: "task-assign", number: 42, target: "pilot" });
    expect(parseCliArgs(["task", "state", "42", "working"]))
      .toEqual({ cmd: "task-state", number: 42, to: "working" });
  });
});

// ---------------------------------------------------------------------------
// #501 F3-F11: help-text accuracy. Every assertion here is on VERBS
// summaries / usage strings — the strings an agent actually reads — pinned
// to the NEW wording the sweep-12 findings proposed. None of these change
// what parses; F7's parse-shape pins live up in the hold block above.
// ---------------------------------------------------------------------------

describe("VERBS help text — #501 F3-F11", () => {
  // F3: `fleet resume` is the IN-CONTAINER binary's verb, not the Mac CLI's
  // — the summary must say so and name the Mac-side restart (`fleet provision`).
  it("destroy: park names the in-container binary and the Mac CLI's own restart (#501 F3)", () => {
    expect(VERBS.destroy.summary).toContain("in-container binary");
    expect(VERBS.destroy.summary).toContain("fleet provision <id>");
  });

  // F8: --force DOES pass the cannot-answer refusal server-side, but also
  // skips the open-task check — the help must say both, since the refusal
  // lines deliberately never suggest --force.
  it("destroy: --force's extra price is stated next to --discard-unsynced (#501 F8)", () => {
    expect(VERBS.destroy.summary).toContain("also skips the open-task check");
  });

  // F4: the --json lead vocabulary includes `dead`, and the row carries
  // `lastLine` and `openPrs` the old field list omitted.
  it("ls: --json lead list ends .../stopped/dead; lastLine and openPrs are named (#501 F4)", () => {
    expect(VERBS.ls.summary).toContain("/stopped/dead");
    expect(VERBS.ls.summary).toContain("lastLine");
    expect(VERBS.ls.summary).toContain("openPrs");
  });

  // F5: the role list is fleet.json's, not a hardcoded set the config can
  // make stale; and maestro's Mac-vs-ff split is stated, not implied.
  it("spawn: no hardcoded role list; maestro's operator-edge/ff-refusal stated (#501 F5)", () => {
    expect(VERBS.spawn.summary).toContain("the roles this fleet declares in fleet.json");
    expect(VERBS.spawn.summary).toContain("ff refuses it");
    expect(VERBS.spawn.summary).not.toContain("release-studio, pilot");
  });

  // F7's help half: the args line states the pairing rule the parser
  // actually enforces (intact flag+value pairs, any order after the slot).
  it("accounts hold: args line states the intact flag+value pairs rule (#501 F7)", () => {
    expect(VERBS["accounts-hold"].args).toContain("intact flag+value pairs");
  });

  // F9: ~60 is the route's default, not a property of the verb — the route
  // takes ?lines=N and the Mac CLI never sends it.
  it("inspect: ~60 pane lines named as the route's default, lines=N override stated (#501 F9)", () => {
    expect(VERBS.inspect.summary).toContain("route's default");
    expect(VERBS.inspect.summary).toContain("lines=N");
  });

  // F11: the stats table has no dedup across the remote/local halves — an
  // id on both sides prints twice, and TOTAL covers both.
  it("junior: stats says an id can appear twice and TOTAL sums both halves (#501 F11)", () => {
    expect(VERBS.junior.summary).toContain("can appear twice");
    expect(VERBS.junior.summary).toContain("sums both halves");
  });
});

// #715 Phase 1: `fleet gate [start <pr> | watch <pr>]`. Same sub-action-word
// shape `fleet models` above uses; one top-level `gate` word, rest[0] picks
// the verb. Internal cmd tags stay hyphenated (gate-start / gate-watch).
describe("gate start / gate watch", () => {
  it("gate start <pr> parses the PR number", () => {
    expect(parseCliArgs(["gate", "start", "715"])).toEqual({ cmd: "gate-start", pr: 715 });
  });
  it("gate watch <pr> <runId> parses the PR number and run id", () => {
    expect(parseCliArgs(["gate", "watch", "715", "wf-abc123"])).toEqual({
      cmd: "gate-watch", pr: 715, runId: "wf-abc123",
    });
  });
  it("gate watch without a run id -> usage (the status route needs one)", () => {
    expect(parseCliArgs(["gate", "watch", "715"]).cmd).toBe("usage");
  });
  it("gate start with no PR -> usage", () => {
    expect(parseCliArgs(["gate", "start"]).cmd).toBe("usage");
  });
  it("gate start with a non-numeric PR -> usage", () => {
    expect(parseCliArgs(["gate", "start", "abc"]).cmd).toBe("usage");
  });
  it("gate with no sub-verb -> usage", () => {
    expect(parseCliArgs(["gate"]).cmd).toBe("usage");
  });
  it("gate with an unrecognized sub-verb -> usage", () => {
    expect(parseCliArgs(["gate", "frobnicate", "715"]).cmd).toBe("usage");
  });
});
