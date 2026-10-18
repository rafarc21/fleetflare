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
    expect(parseCliArgs(["ls"])).toEqual({ cmd: "ls", fresh: false, json: false, prs: false });
  });

  it("ls --fresh asks for a live check per studio", () => {
    expect(parseCliArgs(["ls", "--fresh"])).toEqual({ cmd: "ls", fresh: true, json: false, prs: false });
  });

  // #332 review H1: the PRS column is OPT-IN — bare `fleet ls` never makes
  // live GitHub reads (a 30s monitor polling ls was burning ~27k calls/hr
  // through the Worker's per-studio scans). Same "no value, just presence"
  // shape --fresh already takes, read from anywhere after the verb.
  it("ls --prs asks for the PRS column's live open-prs read (opt-in, never the default)", () => {
    expect(parseCliArgs(["ls", "--prs"])).toEqual({ cmd: "ls", fresh: false, json: false, prs: true });
  });

  it("ls --prs composes with --fresh and --json, in any order", () => {
    expect(parseCliArgs(["ls", "--fresh", "--prs", "--json"])).toEqual({ cmd: "ls", fresh: true, json: true, prs: true });
    expect(parseCliArgs(["ls", "--json", "--prs", "--fresh"])).toEqual({ cmd: "ls", fresh: true, json: true, prs: true });
  });

  it("ls ignores a stray extra token (only the first two argv slots are read)", () => {
    expect(parseCliArgs(["ls", "extra"])).toEqual({ cmd: "ls", fresh: false, json: false, prs: false });
  });

  // Sweep 20 F2 (#564): `--json=false` is not a stray positional — it is a
  // known flag spelled with a value, which reads as accepted-and-overridden
  // (the operator believes =false means table mode and gets the default by
  // accident, wrong reason). Same for `=value` on any of the three flags,
  // and for an unknown -- token entirely. Stray positionals stay ignored:
  // that is ls's documented long-standing grammar.
  it("ls refuses a flag spelled with a value (--json=false is not --json)", () => {
    const r = parseCliArgs(["ls", "--json=false"]);
    expect(r.cmd).toBe("usage");
    if (r.cmd === "usage") expect(r.message).toMatch(/unexpected "--json=false" — ls flags are --fresh --prs --json \(no values\)/);
    expect(parseCliArgs(["ls", "--fresh=1"]).cmd).toBe("usage");
    expect(parseCliArgs(["ls", "--prs=x"]).cmd).toBe("usage");
  });

  it("ls refuses an unknown -- token, naming it", () => {
    const r = parseCliArgs(["ls", "--no-such"]);
    expect(r.cmd).toBe("usage");
    if (r.cmd === "usage") expect(r.message).toMatch(/unexpected "--no-such" — ls flags are --fresh --prs --json \(no values\)/);
    expect(parseCliArgs(["ls", "--fresh", "--jsonx"]).cmd).toBe("usage");
  });

  it("ls still ignores a stray positional next to valid flags", () => {
    expect(parseCliArgs(["ls", "extra", "--json"])).toEqual({ cmd: "ls", fresh: false, json: true, prs: false });
    // A single-dash token (-x) is not --prefixed: ls has no short flags,
    // and the refusal line drawn by #564 starts at --.
    expect(parseCliArgs(["ls", "-x"])).toEqual({ cmd: "ls", fresh: false, json: false, prs: false });
  });

  // Issue #37's second half: there was no way to ask for the truth NOW. The
  // container check already existed (provisionedCheckCmd); nothing exposed it
  // on demand, so an operator needed a shell inside the container.
  it("check requires an id", () => {
    expect(parseCliArgs(["check", "websites--pilot"])).toEqual({ cmd: "check", id: "websites--pilot" });
    expect(parseCliArgs(["check"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Issue #567 (sweep 20 finding 5): a flag-shaped token used to slide into
  // the id slot (`check --json` parsed as a request for a studio named
  // "--json") and a token after a good id used to be silently dropped
  // (`check x --json` did a plain check while reading as a JSON-output ask).
  // Same posture `destroy`'s own id-slot comment block already documents —
  // a usage error, never a silent misparse.
  it("check refuses a flag-shaped id and any trailing token", () => {
    expect(parseCliArgs(["check", "--json"])).toEqual({
      cmd: "usage", message: `fleet check needs a studio id (got "--json")\n${CLI_USAGE}`,
    });
    expect(parseCliArgs(["check", "websites--pilot", "--json"])).toEqual({
      cmd: "usage", message: `unexpected "--json" — fleet check takes exactly one studio id\n${CLI_USAGE}`,
    });
  });

  // Issue #567 review round 1: an EMPTY id is not an id. The idArg() helper
  // destructures it as "present" (`id === undefined` only), and an empty
  // string would have sailed to the Worker as /studio//check — the route
  // regex rejects it, a bare 404 after a full round trip. Every untouched
  // id verb (destroy/provision/recycle/spawn) still refuses "" via its
  // truthiness check; this pin keeps check in that same posture.
  it("check refuses an empty id", () => {
    expect(parseCliArgs(["check", ""])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Board #140 (#94 follow-up): the operator's escape from a sync guard
  // stuck on a stale/wrong baseline. Same one-argument grammar as `check`.
  it("clear-session-guard requires an id", () => {
    expect(parseCliArgs(["clear-session-guard", "websites--pilot"])).toEqual({
      cmd: "clear-session-guard", id: "websites--pilot",
    });
    expect(parseCliArgs(["clear-session-guard"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Issue #567: same refusal shape as `check`'s pins above, for the same
  // reasons — clear-session-guard is the destructive override of a safety
  // mechanism, so a misparsed id is the worst place for one.
  it("clear-session-guard refuses a flag-shaped id and any trailing token", () => {
    expect(parseCliArgs(["clear-session-guard", "--json"])).toEqual({
      cmd: "usage", message: `fleet clear-session-guard needs a studio id (got "--json")\n${CLI_USAGE}`,
    });
    expect(parseCliArgs(["clear-session-guard", "websites--pilot", "--json"])).toEqual({
      cmd: "usage", message: `unexpected "--json" — fleet clear-session-guard takes exactly one studio id\n${CLI_USAGE}`,
    });
  });

  // Board issue #47: read a studio without attaching a tmux client. Same
  // one-argument grammar as `check`.
  it("inspect requires an id", () => {
    expect(parseCliArgs(["inspect", "websites--pilot"])).toEqual({ cmd: "inspect", id: "websites--pilot" });
    expect(parseCliArgs(["inspect"])).toEqual({ cmd: "usage", message: CLI_USAGE });
  });

  // Issue #567: same refusal shape as `check`'s own flag/trailing pins above.
  it("inspect refuses a flag-shaped id and any trailing token", () => {
    expect(parseCliArgs(["inspect", "--json"])).toEqual({
      cmd: "usage", message: `fleet inspect needs a studio id (got "--json")\n${CLI_USAGE}`,
    });
    expect(parseCliArgs(["inspect", "websites--pilot", "--json"])).toEqual({
      cmd: "usage", message: `unexpected "--json" — fleet inspect takes exactly one studio id\n${CLI_USAGE}`,
    });
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

  // Issue #567: same refusal shape as `check`'s pins above — paste pushes
  // text at a live studio, so a flag-shaped id must never reach the Worker.
  it("paste refuses a flag-shaped id and any trailing token", () => {
    expect(parseCliArgs(["paste", "--json"])).toEqual({
      cmd: "usage", message: `fleet paste needs a studio id (got "--json")\n${CLI_USAGE}`,
    });
    expect(parseCliArgs(["paste", "websites--pilot", "--json"])).toEqual({
      cmd: "usage", message: `unexpected "--json" — fleet paste takes exactly one studio id\n${CLI_USAGE}`,
    });
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

  // Issue #249: `fleet spawn <role> --lead glm` — the studio-creation path's
  // CLI surface for `StudioStatus.leadType`.
  it("spawn takes --lead glm, alone or combined with --new, in either order", () => {
    expect(parseCliArgs(["spawn", "pilot", "--lead", "glm"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: false, leadType: "glm" });
    expect(parseCliArgs(["spawn", "pilot", "--new", "--lead", "glm"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: true, leadType: "glm" });
    expect(parseCliArgs(["spawn", "pilot", "--lead", "glm", "--new"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: true, leadType: "glm" });
    // "claude" is accepted too — an explicit, redundant statement of today's
    // default, never silently coerced away.
    expect(parseCliArgs(["spawn", "pilot", "--lead", "claude"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: false, leadType: "claude" });
  });

  // #717: the model pool's two extra pool keys ride the SAME --lead flag.
  it("spawn --lead also takes kimi/deepseek (#717)", () => {
    expect(parseCliArgs(["spawn", "pilot", "--lead", "kimi"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: false, leadType: "kimi" });
    expect(parseCliArgs(["spawn", "pilot", "--lead", "deepseek"]))
      .toEqual({ cmd: "spawn", role: "pilot", newInstance: false, leadType: "deepseek" });
  });

  it("spawn --lead rejects anything other than claude/glm, and a bare --lead with no value", () => {
    expect(parseCliArgs(["spawn", "pilot", "--lead", "gpt4"]).cmd).toBe("usage");
    expect(parseCliArgs(["spawn", "pilot", "--lead"]).cmd).toBe("usage");
    expect(parseCliArgs(["spawn", "pilot", "--lead", "--new"]).cmd).toBe("usage");
  });

  it("no --lead at all: the returned command carries no leadType key (byte-identical to pre-#249)", () => {
    const cmd = parseCliArgs(["spawn", "pilot"]);
    expect(cmd.cmd === "spawn" && "leadType" in cmd).toBe(false);
  });

  it("provision requires an id", () => {
    expect(parseCliArgs(["provision", "websites--scratch"])).toEqual({
      cmd: "provision", id: "websites--scratch", freshSession: false, cancelFreshSession: false, discardSession: false,
    });
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
      cmd: "provision", id: "websites--scratch", freshSession: true, cancelFreshSession: false, discardSession: false,
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

  // Issue #115: `--no-fresh-session` cancels a pending fresh-session intent
  // (FRESH_SESSION_PENDING_KEY) — same bespoke flag shape as `--fresh-session`
  // above, mutually exclusive with it, each at most once, unknown flag never
  // silently ignored (recycle's own two-flag parsing's own posture).
  it("--no-fresh-session: cancels a pending intent; mutually exclusive with --fresh-session; repeats and strays are usage errors", () => {
    expect(parseCliArgs(["provision", "websites--scratch", "--no-fresh-session"])).toEqual({
      cmd: "provision", id: "websites--scratch", freshSession: false, cancelFreshSession: true, discardSession: false,
    });
    expect(parseCliArgs(["provision", "websites--scratch", "--fresh-session", "--no-fresh-session"]).cmd).toBe("usage");
    expect(parseCliArgs(["provision", "websites--scratch", "--no-fresh-session", "--fresh-session"]).cmd).toBe("usage");
    expect(parseCliArgs(["provision", "websites--scratch", "--no-fresh-session", "--no-fresh-session"]).cmd).toBe("usage");
    expect(parseCliArgs(["provision", "websites--scratch", "--no-fresh-session", "--bogus"]).cmd).toBe("usage");
  });

  // Issue #231: `--discard-session` — the operator's stated override of
  // provisionWithStorage's own involuntary-stop refusal. Only meaningful
  // alongside --fresh-session.
  //
  // Maestro review round 1 on PR #235, MINOR 8 — `--discard-session` WITHOUT
  // `--fresh-session` used to parse fine and silently do nothing (the
  // refusal check it exists to override never runs without `--fresh-session`
  // in the first place) — now a usage error, same "unknown/invalid
  // combination" convention this parser already uses for
  // `--fresh-session`/`--no-fresh-session` together.
  it("--discard-session: provision only, any order with --fresh-session; repeats and strays are usage errors", () => {
    expect(parseCliArgs(["provision", "websites--scratch", "--fresh-session", "--discard-session"])).toEqual({
      cmd: "provision", id: "websites--scratch", freshSession: true, cancelFreshSession: false, discardSession: true,
    });
    expect(parseCliArgs(["provision", "websites--scratch", "--discard-session", "--fresh-session"])).toEqual({
      cmd: "provision", id: "websites--scratch", freshSession: true, cancelFreshSession: false, discardSession: true,
    });
    expect(parseCliArgs(["provision", "websites--scratch", "--discard-session", "--discard-session"]).cmd).toBe("usage");
    expect(parseCliArgs(["provision", "websites--scratch", "--discard-session", "--bogus"]).cmd).toBe("usage");
  });

  // Maestro review round 1 on PR #235, MINOR 8 (issue #231) — standalone
  // `--discard-session`, with no `--fresh-session` on the same call, is now
  // rejected outright rather than silently accepted and ignored.
  it("--discard-session without --fresh-session: usage error, never silently accepted", () => {
    expect(parseCliArgs(["provision", "websites--scratch", "--discard-session"]).cmd).toBe("usage");
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

  // Board task #131 ask 2: `fleet recycle <id> --account mapped`.
  it("recycle --account mapped sets forceMappedAccount: true", () => {
    expect(parseCliArgs(["recycle", "websites--scratch", "--account", "mapped"])).toEqual({
      cmd: "recycle", id: "websites--scratch", discardUnsynced: false, freshSession: false, forceMappedAccount: true,
    });
  });

  it("recycle --account only accepts the literal \"mapped\" — any other value is a usage error naming the flag", () => {
    const res = parseCliArgs(["recycle", "websites--scratch", "--account", "primary"]);
    expect(res.cmd).toBe("usage");
    expect((res as { message: string }).message).toContain('--account only accepts "mapped"');
    expect(parseCliArgs(["recycle", "websites--scratch", "--account"]).cmd).toBe("usage");
    expect(parseCliArgs(["recycle", "websites--scratch", "--account", "mapped", "--account", "mapped"]).cmd).toBe("usage");
  });

  it("recycle --account mapped coexists with --discard-unsynced and --fresh-session, in any order", () => {
    const combos = [
      ["--account", "mapped", "--discard-unsynced", "--fresh-session"],
      ["--discard-unsynced", "--account", "mapped", "--fresh-session"],
      ["--discard-unsynced", "--fresh-session", "--account", "mapped"],
    ];
    for (const flags of combos) {
      expect(parseCliArgs(["recycle", "websites--scratch", ...flags])).toEqual({
        cmd: "recycle", id: "websites--scratch", discardUnsynced: true, freshSession: true, forceMappedAccount: true,
      });
    }
  });

  // Regression pin: a plain recycle (no --account) keeps the exact shape it
  // always had — no forceMappedAccount key at all, same "only present when
  // true" discipline destroy's own park?: true (#59) already established.
  it("plain recycle (no --account) has no forceMappedAccount key", () => {
    const res = parseCliArgs(["recycle", "websites--scratch"]);
    expect(res).toEqual({ cmd: "recycle", id: "websites--scratch", discardUnsynced: false, freshSession: false });
    expect(Object.keys(res)).not.toContain("forceMappedAccount");
  });

  it("recycle's help names --account mapped", () => {
    expect(VERBS.recycle.args).toContain("--account mapped");
    expect(VERBS.recycle.summary).toContain('"mapped"');
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

  // Board issue #332: --strict-unmerged — the same bespoke "no value, just
  // presence" shape as --force/--discard-unsynced/--park, refused with every
  // other trailing token and when slid into the id slot.
  it("destroy --strict-unmerged parses, alone or beside every other flag, in any order (#332)", () => {
    expect(parseCliArgs(["destroy", "websites--scratch", "--strict-unmerged"])).toEqual({
      cmd: "destroy", id: "websites--scratch", force: false, discardUnsynced: false, strictUnmerged: true,
    });
    for (const rest of [
      ["--force", "--park", "--strict-unmerged"],
      ["--strict-unmerged", "--force", "--park"],
      ["--discard-unsynced", "--strict-unmerged"],
    ]) {
      expect(parseCliArgs(["destroy", "websites--scratch", ...rest])).toEqual({
        cmd: "destroy", id: "websites--scratch", force: rest.includes("--force"),
        discardUnsynced: rest.includes("--discard-unsynced"),
        ...(rest.includes("--park") ? { park: true } : {}),
        strictUnmerged: true,
      });
    }
  });

  it("plain destroy (no --strict-unmerged) keeps its exact shape — no strictUnmerged key (#332 regression pin)", () => {
    const res = parseCliArgs(["destroy", "websites--scratch"]);
    expect(res).toEqual({ cmd: "destroy", id: "websites--scratch", force: false, discardUnsynced: false });
    expect(Object.keys(res)).not.toContain("strictUnmerged");
  });

  it("destroy --strict-unmerged twice, or sliding into the id slot, or beside an unknown flag, is a usage error", () => {
    expect(parseCliArgs(["destroy", "websites--scratch", "--strict-unmerged", "--strict-unmerged"]).cmd).toBe("usage");
    expect(parseCliArgs(["destroy", "--strict-unmerged"])).toEqual({ cmd: "usage", message: CLI_USAGE });
    // A typo'd prefix (--strict) is an unknown token, never silently ignored.
    expect(parseCliArgs(["destroy", "websites--scratch", "--strict"]).cmd).toBe("usage");
    expect(parseCliArgs(["destroy", "websites--scratch", "--strict-unmerged", "--verbose"]).cmd).toBe("usage");
  });

  it("destroy's help names --strict-unmerged (#332)", () => {
    expect(VERBS.destroy.args).toContain("--strict-unmerged");
    expect(VERBS.destroy.summary).toContain("--strict-unmerged");
    expect(VERBS.destroy.summary).toContain("park warning");
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

  it("task ls accepts --state awaiting_merge — its own vocabulary is not validated at parse time, but its help text names the full vocabulary (board issue #110)", () => {
    expect(parseCliArgs(["task", "ls", "--state", "awaiting_merge"])).toEqual({
      cmd: "task-ls", query: { state: "awaiting_merge" },
    });
    expect(VERBS["task-ls"].args).toContain("submitted|working|input_required|awaiting_merge|completed|failed|canceled");
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

  // Issue #1133: `--allow-duplicate` opts a task out of the duplicate-task
  // refusal — same bare-boolean shape `--junior` already uses.
  it("task new --allow-duplicate is a bare boolean flag, anywhere after new", () => {
    const a = parseCliArgs(["task", "new", ...flags, "--allow-duplicate"]);
    expect(a.cmd === "task-new" && a.brief.allowDuplicate).toBe(true);
    const b = parseCliArgs(["task", "new", "--allow-duplicate", ...flags]);
    expect(b.cmd === "task-new" && b.brief.allowDuplicate).toBe(true);
    const c = parseCliArgs(["task", "new", ...flags]);
    expect(c.cmd === "task-new" && c.brief.allowDuplicate).toBeUndefined();
    expect(parseCliArgs(["task", "ls", "--allow-duplicate"]).cmd).toBe("usage");
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

  // Issue #113 ask 9: `--provision [--fresh-session]` lets `task new` boot or
  // heal the assigned studio in the same call, instead of leaving a filed
  // task's "NO WAKE" to a human running a second `fleet provision <id>`.
  // `--provision` and `--fresh-session` are TWO MORE bare booleans, extracted
  // in the exact same loop as `--junior` above — the same value-slot
  // protection (a flag's VALUE that happens to equal the literal string
  // "--provision" is never mistaken for the bare flag) comes for free.
  it("task new --studio x --provision succeeds with provision: true and no freshSession key", () => {
    const res = parseCliArgs(["task", "new", ...flags, "--studio", "x", "--provision"]);
    expect(res).toEqual({
      cmd: "task-new",
      brief: {
        title: "Build the board",
        objective: "A Worker-side board module.",
        outputFormat: "A PR, tests green.",
        boundaries: "No sprint close.",
        assignee: "x",
      },
      provision: true,
    });
  });

  it("task new --continues 7 --provision succeeds: --continues alone names a target studio", () => {
    const res = parseCliArgs(["task", "new", ...flags, "--continues", "7", "--provision"]);
    expect(res.cmd).toBe("task-new");
    if (res.cmd !== "task-new") return;
    expect(res.provision).toBe(true);
    expect(res.freshSession).toBeUndefined();
  });

  it("task new --studio x --provision --fresh-session sets both flags", () => {
    const res = parseCliArgs(["task", "new", ...flags, "--studio", "x", "--provision", "--fresh-session"]);
    expect(res).toEqual({
      cmd: "task-new",
      brief: {
        title: "Build the board",
        objective: "A Worker-side board module.",
        outputFormat: "A PR, tests green.",
        boundaries: "No sprint close.",
        assignee: "x",
      },
      provision: true,
      freshSession: true,
    });
  });

  it("task new --fresh-session without --provision is a usage error naming --provision", () => {
    const res = parseCliArgs(["task", "new", ...flags, "--studio", "x", "--fresh-session"]);
    expect(res.cmd).toBe("usage");
    if (res.cmd !== "usage") return;
    expect(res.message).toContain("--provision");
  });

  it("task new --provision with no --studio and no --continues is a usage error naming what's missing", () => {
    const res = parseCliArgs(["task", "new", ...flags, "--provision"]);
    expect(res.cmd).toBe("usage");
    if (res.cmd !== "usage") return;
    expect(res.message).toContain("--studio");
    expect(res.message).toContain("--continues");
  });

  // Same protection the --junior value-slot test above proves: a value that
  // happens to equal "--provision" must stay that flag's literal value, never
  // flip provision to true.
  it("a --provision VALUE (e.g. --boundaries --provision) is not the bare boolean flag", () => {
    const res = parseCliArgs([
      "task", "new",
      "--title", "t",
      "--objective", "o",
      "--output", "f",
      "--boundaries", "--provision",
      "--studio", "a",
    ]);
    expect(res.cmd).toBe("task-new");
    if (res.cmd !== "task-new") return;
    expect(res.brief.boundaries).toBe("--provision");
    expect(res.brief.assignee).toBe("a");
    expect((res as { provision?: true }).provision).toBeUndefined();
  });

  // Same protection, for --fresh-session: a value that happens to equal
  // "--fresh-session" must stay that flag's literal value, never flip
  // freshSession to true.
  it("a --fresh-session VALUE (e.g. --boundaries --fresh-session) is not the bare boolean flag", () => {
    const res = parseCliArgs([
      "task", "new",
      "--title", "t",
      "--objective", "o",
      "--output", "f",
      "--boundaries", "--fresh-session",
      "--provision",
      "--studio", "x",
    ]);
    expect(res.cmd).toBe("task-new");
    if (res.cmd !== "task-new") return;
    expect(res.brief.boundaries).toBe("--fresh-session");
    expect(res.provision).toBe(true);
    expect(res.freshSession).toBeUndefined();
  });

  // Regression pin: plain `task new` (no --provision/--fresh-session at all)
  // must keep returning EXACTLY { cmd: "task-new", brief: {...} } — no
  // `provision`/`freshSession` keys leaking in, false or otherwise. The
  // pre-existing tests above (lines ~267-276, ~280) already pin this shape;
  // this one pins it explicitly against the new fields.
  it("plain task new carries no provision/freshSession keys at all", () => {
    const res = parseCliArgs(["task", "new", ...flags]);
    expect(res).toEqual({
      cmd: "task-new",
      brief: {
        title: "Build the board",
        objective: "A Worker-side board module.",
        outputFormat: "A PR, tests green.",
        boundaries: "No sprint close.",
      },
    });
  });
});


// Issue #1074 ask 2: `fleet provision <id> --account mapped` forces the repo's
// mapped account, same as `recycle --account mapped` (board task #131).
describe("provision --account mapped (#1074)", () => {
  it("provision --account mapped sets forceMappedAccount: true", () => {
    expect(parseCliArgs(["provision", "websites--scratch", "--account", "mapped"])).toEqual({
      cmd: "provision", id: "websites--scratch", freshSession: false, cancelFreshSession: false, discardSession: false,
      forceMappedAccount: true,
    });
  });

  it("provision without --account leaves forceMappedAccount absent", () => {
    const res = parseCliArgs(["provision", "websites--scratch"]) as Record<string, unknown>;
    expect("forceMappedAccount" in res).toBe(false);
  });

  it("provision --account only accepts the literal \"mapped\" — any other value is a usage error", () => {
    const res = parseCliArgs(["provision", "websites--scratch", "--account", "primary"]);
    expect(res.cmd).toBe("usage");
    expect((res as { message: string }).message).toContain('--account only accepts "mapped"');
    expect(parseCliArgs(["provision", "websites--scratch", "--account"]).cmd).toBe("usage");
    expect(parseCliArgs(["provision", "websites--scratch", "--account", "mapped", "--account", "mapped"]).cmd).toBe("usage");
  });

  it("provision --account mapped coexists with --fresh-session, in any order", () => {
    const want = { cmd: "provision", id: "websites--scratch", freshSession: true, cancelFreshSession: false, discardSession: false, forceMappedAccount: true };
    expect(parseCliArgs(["provision", "websites--scratch", "--account", "mapped", "--fresh-session"])).toEqual(want);
    expect(parseCliArgs(["provision", "websites--scratch", "--fresh-session", "--account", "mapped"])).toEqual(want);
  });
});
