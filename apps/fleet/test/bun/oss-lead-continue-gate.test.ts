import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSnippet } from "./exec-snippet";
import { BRINGUP, extractRegion } from "./exec-snippet";

// Issue #1112 layer 2: a Stop hook for OSS leads. The lead's last TodoWrite
// still has pending or in_progress items -> decision:block with the first open
// todo as the reason. Layer 1 (the router rule) is the primary fix; this is the
// backstop. Exercises the REAL gates/oss-lead-continue.sh on disk, the same
// single-source-of-truth convention install-marker-gate.test.ts uses.
const GATE = readFileSync(join(import.meta.dir, "../../../../gates/oss-lead-continue.sh"), "utf8");

const OSS_BASE = "https://fleet.example.workers.dev/fleet/llm/anthropic";
const SESSION = "sess-example-1";

let base: string;
let home: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "fleet-oss-continue-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

function todoWrite(todos: Todo[], extra: Record<string, unknown> = {}) {
  return { type: "assistant", ...extra, message: { role: "assistant", content: [
    { type: "text", text: "Working." },
    { type: "tool_use", id: "tu_1", name: "TodoWrite", input: { todos } },
  ] } };
}

function assistantText(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** A real user prompt: string content, with a uuid so the hook can tell turns apart. */
function userLine(text: string, uuid = `u-${text}`) {
  return { type: "user", uuid, message: { role: "user", content: text } };
}

/** A tool result: also type "user" in a transcript, but NOT a new prompt. */
function toolResultLine(uuid: string) {
  return { type: "user", uuid, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
  ] } };
}

function writeTranscript(lines: unknown[]): string {
  const path = join(base, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function run(
  transcriptLines: unknown[],
  opts: { stopHookActive?: boolean; omitActiveFlag?: boolean; env?: Record<string, string>; sessionId?: string } = {},
) {
  const transcript_path = writeTranscript(transcriptLines);
  const payload: Record<string, unknown> = {
    hook_event_name: "Stop",
    session_id: opts.sessionId ?? SESSION,
    transcript_path,
  };
  if (!opts.omitActiveFlag) payload.stop_hook_active = opts.stopHookActive ?? false;
  return runSnippet({
    script: GATE,
    stdin: JSON.stringify(payload),
    shell: "bash",
    env: {
      HOME: home,
      STUDIO_ID: "acme-org--oss-studio",
      ANTHROPIC_BASE_URL: OSS_BASE,
      ...opts.env,
    },
    timeout: 10_000,
  });
}

function blocked(res: { stdout: string }): { decision: string; reason: string } | null {
  const out = res.stdout.trim();
  if (out === "") return null;
  return JSON.parse(out);
}

const OPEN_TODOS: Todo[] = [
  { content: "Write the schema", status: "completed" },
  { content: "Wire the route", status: "in_progress" },
  { content: "Add the tests", status: "pending" },
];

describe("oss-lead-continue.sh — scope", () => {
  test("no-ops without STUDIO_ID", () => {
    const res = run([todoWrite(OPEN_TODOS)], { env: { STUDIO_ID: "" } });
    expect(res.code).toBe(0);
    expect(blocked(res)).toBeNull();
  });

  test("no-ops for a Claude-led studio (ANTHROPIC_BASE_URL is not the fleet route)", () => {
    const res = run([todoWrite(OPEN_TODOS)], { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
    expect(res.code).toBe(0);
    expect(blocked(res)).toBeNull();
  });

  test("no-ops when ANTHROPIC_BASE_URL is unset", () => {
    const res = run([todoWrite(OPEN_TODOS)], { env: { ANTHROPIC_BASE_URL: "" } });
    expect(res.code).toBe(0);
    expect(blocked(res)).toBeNull();
  });
});

describe("oss-lead-continue.sh — blocking", () => {
  test("blocks when the last TodoWrite has pending/in_progress items, reason names the first open todo", () => {
    const res = run([userLine("do it"), todoWrite(OPEN_TODOS)]);
    expect(res.code).toBe(0);
    const out = blocked(res);
    expect(out).not.toBeNull();
    expect(out!.decision).toBe("block");
    expect(out!.reason).toContain("continue with Wire the route");
  });

  test("an in_progress item alone is enough to block", () => {
    const res = run([todoWrite([{ content: "Only step", status: "in_progress" }])]);
    expect(blocked(res)!.reason).toContain("Only step");
  });

  test("uses the LAST TodoWrite in the transcript, not an earlier one", () => {
    const res = run([
      todoWrite([{ content: "Old open", status: "pending" }]),
      todoWrite([{ content: "Old open", status: "completed" }]),
    ]);
    expect(blocked(res)).toBeNull();
  });

  // Maestro review (#1116, item 4): a subagent's TodoWrite is not the lead's list.
  test("ignores TodoWrite entries from sidechain (subagent) transcript lines", () => {
    const res = run([
      todoWrite(OPEN_TODOS, { isSidechain: true }),
      todoWrite([{ content: "Lead step", status: "completed" }]),
    ]);
    expect(blocked(res)).toBeNull();
  });

  test("a sidechain TodoWrite never supplies the reason for a lead block", () => {
    const res = run([
      todoWrite([{ content: "Lead open", status: "pending" }]),
      todoWrite([{ content: "Member open", status: "pending" }], { isSidechain: true }),
    ]);
    expect(blocked(res)!.reason).toContain("Lead open");
  });
});

describe("oss-lead-continue.sh — allowing", () => {
  test("allows when every todo is completed", () => {
    const res = run([todoWrite([
      { content: "a", status: "completed" }, { content: "b", status: "completed" },
    ])]);
    expect(res.code).toBe(0);
    expect(blocked(res)).toBeNull();
  });

  test("allows when the transcript has no TodoWrite at all", () => {
    const res = run([userLine("hi"), assistantText("done")]);
    expect(blocked(res)).toBeNull();
  });

  test("allows when the last assistant text asks the operator a question", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Which branch should I target?")]);
    expect(blocked(res)).toBeNull();
  });

  test("a question ending is detected even with trailing whitespace", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Should I drop the flag?  \n")]);
    expect(blocked(res)).toBeNull();
  });

  // Maestro review (#1116, item 3): a question need not be the last line.
  test("allows when a question line is followed by a numbered option list", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Should I force-push main?\n1. yes\n2. no")]);
    expect(blocked(res)).toBeNull();
  });

  test("allows when the operator is asked to pick from a numbered list with no question mark", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Pick one:\n1. rebase\n2. merge")]);
    expect(blocked(res)).toBeNull();
  });

  test("allows when the text asks for confirmation without a question mark", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Please confirm the target branch before I continue.")]);
    expect(blocked(res)).toBeNull();
  });
});

describe("oss-lead-continue.sh — fail open", () => {
  // Maestro review (#1116, item 1): a counter that cannot be written must never
  // turn into an endless block. No counter write -> no block.
  test("allows the stop when the counter directory cannot be created (a regular file sits in its place)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "state"), "not a directory");
    const res = run([userLine("go"), todoWrite(OPEN_TODOS)]);
    expect(res.code).toBe(0);
    expect(blocked(res)).toBeNull();
  });

  test("allows the stop when the counter file exists but cannot be read", () => {
    const stateDir = join(home, ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    // A directory where the counter file should be: opening it for read fails.
    mkdirSync(join(stateDir, `oss-lead-continue-${SESSION}`));
    const res = run([userLine("go"), todoWrite(OPEN_TODOS)]);
    expect(blocked(res)).toBeNull();
  });
});

describe("oss-lead-continue.sh — loop guard", () => {
  test("blocks up to 8 consecutive times within one user prompt, then allows", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) {
      const res = run(lines, { stopHookActive: i > 1 });
      expect(blocked(res)?.decision).toBe("block");
    }
    const ninth = run(lines, { stopHookActive: true });
    expect(blocked(ninth)).toBeNull();
  });

  // Maestro review (#1116, item 2): the cap must not depend on stop_hook_active.
  test("caps at 8 per prompt even when stop_hook_active is absent from the payload", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) {
      const res = run(lines, { omitActiveFlag: true });
      expect(blocked(res)?.decision).toBe("block");
    }
    expect(blocked(run(lines, { omitActiveFlag: true }))).toBeNull();
  });

  test("a new user prompt starts a fresh count", () => {
    const first = [userLine("go", "u-A"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) run(first, { stopHookActive: i > 1 });
    expect(blocked(run(first, { stopHookActive: true }))).toBeNull();
    const second = [...first, userLine("next task", "u-B"), todoWrite(OPEN_TODOS)];
    expect(blocked(run(second, { stopHookActive: false }))?.decision).toBe("block");
  });

  test("tool results between blocks do not count as a new prompt", () => {
    const lines: unknown[] = [userLine("go", "u-A"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) {
      run(lines, { stopHookActive: i > 1 });
      lines.push(toolResultLine(`tr-${i}`));
    }
    expect(blocked(run(lines, { stopHookActive: true }))).toBeNull();
  });

  test("the counter is keyed by session: another session's chain does not exhaust this one", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) run(lines, { stopHookActive: i > 1, sessionId: "sess-a" });
    const other = run(lines, { stopHookActive: true, sessionId: "sess-b" });
    expect(blocked(other)?.decision).toBe("block");
  });

  test("an allowed stop clears the count so the same prompt can block again", () => {
    const open = [userLine("go", "u-A"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 3; i++) run(open, { stopHookActive: i > 1 });
    const done = [...open, todoWrite([{ content: "x", status: "completed" }])];
    expect(blocked(run(done, { stopHookActive: true }))).toBeNull();
    const reopened = [...done, todoWrite(OPEN_TODOS)];
    expect(blocked(run(reopened, { stopHookActive: false }))?.decision).toBe("block");
    const counter = readFileSync(join(home, ".claude", "state", `oss-lead-continue-${SESSION}`), "utf8");
    expect(counter).toContain("\t1");
  });
});

describe("studio-bringup.sh installs the Stop hook for OSS leads", () => {
  test("copies gates/oss-lead-continue.sh into ~/.claude/hooks", () => {
    expect(BRINGUP).toContain("/opt/blueprint/gates/oss-lead-continue.sh");
    expect(BRINGUP).toContain("~/.claude/hooks/oss-lead-continue.sh");
  });

  // Maestro review (#1116, item 5): the Stop entry rides the SAME settings.json
  // write as lead-gate.sh, so there is one settings write, not a second that can
  // abort boot on its own. The region is extracted and executed for real.
  test("the lead-gate settings write also registers the OSS Stop hook", () => {
    // bring-up runs `mkdir -p ~/.claude` before this write; mirror that precondition.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const region = extractRegion(BRINGUP, "lead-gate-settings-merge");
    const res = runSnippet({ script: region, shell: "bash", env: { HOME: home }, timeout: 10_000 });
    expect(res.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(cfg.hooks.Stop)).toContain("oss-lead-continue.sh");
    expect(JSON.stringify(cfg.hooks.PreToolUse)).toContain("lead-gate.sh");
  });

  test("a failing OSS Stop registration does not abort the lead-gate settings write", () => {
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // Stop as a string: the Stop registration cannot merge into it.
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ hooks: { Stop: "not-a-list" } }));
    const region = extractRegion(BRINGUP, "lead-gate-settings-merge");
    const res = runSnippet({ script: region, shell: "bash", env: { HOME: home }, timeout: 10_000 });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("oss-lead-continue");
    const cfg = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(JSON.stringify(cfg.hooks.PreToolUse)).toContain("lead-gate.sh");
  });
});
