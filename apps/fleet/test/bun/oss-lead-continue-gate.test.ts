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

function todoWrite(todos: Todo[]) {
  return { type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "Working." },
    { type: "tool_use", id: "tu_1", name: "TodoWrite", input: { todos } },
  ] } };
}

function assistantText(text: string) {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function userLine(text: string) {
  return { type: "user", message: { role: "user", content: text } };
}

// The entry Claude Code appends after every Stop block: a meta user line, not
// an operator prompt.
function stopFeedbackLine(reason: string) {
  return { type: "user", isMeta: true, message: { role: "user", content: `Stop hook feedback:\n${reason}` } };
}

function toolResultLine() {
  return { type: "user", message: { role: "user", content: [
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
  opts: { stopHookActive?: boolean; env?: Record<string, string>; sessionId?: string } = {},
) {
  const transcript_path = writeTranscript(transcriptLines);
  return runSnippet({
    script: GATE,
    stdin: JSON.stringify({
      hook_event_name: "Stop",
      session_id: opts.sessionId ?? SESSION,
      transcript_path,
      stop_hook_active: opts.stopHookActive ?? false,
    }),
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

  test("an option-list question is allowed even when the question is not the last line", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Should I force-push main?\n1. yes\n2. no")]);
    expect(blocked(res)).toBeNull();
  });

  test("a numbered option list alone is allowed", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Pick one:\n1) keep it\n2) drop it")]);
    expect(blocked(res)).toBeNull();
  });

  test("a question ending is detected even with trailing whitespace", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Should I drop the flag?  \n")]);
    expect(blocked(res)).toBeNull();
  });
});

describe("oss-lead-continue.sh — fail open", () => {
  test("unwritable ~/.claude (state dir cannot be created) -> allow, never block", () => {
    // ~/.claude as a plain file: makedirs and the counter write both fail.
    writeFileSync(join(home, ".claude"), "not a dir");
    const res = run([userLine("go"), todoWrite(OPEN_TODOS)]);
    expect(res.code).toBe(0);
    expect(blocked(res)).toBeNull();
  });

  test("unreadable existing counter -> allow, never block", () => {
    const stateDir = join(home, ".claude", "state");
    mkdirSync(join(stateDir, `oss-lead-continue-${SESSION}`), { recursive: true }); // a dir where the file should be
    const res = run([userLine("go"), todoWrite(OPEN_TODOS)]);
    expect(blocked(res)).toBeNull();
  });
});

describe("oss-lead-continue.sh — sidechain", () => {
  test("an open TodoWrite inside a sidechain (subagent) entry is ignored", () => {
    const side = { ...todoWrite(OPEN_TODOS), isSidechain: true };
    const res = run([userLine("go"), todoWrite([{ content: "x", status: "completed" }]), side]);
    expect(blocked(res)).toBeNull();
  });
});

describe("oss-lead-continue.sh — loop guard", () => {
  test("blocks up to 8 consecutive times within one turn chain, then allows", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) {
      const res = run(lines, { stopHookActive: i > 1 });
      expect(blocked(res)?.decision).toBe("block");
    }
    const ninth = run(lines, { stopHookActive: true });
    expect(blocked(ninth)).toBeNull();
  });

  test("a new user prompt starts a fresh chain", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) run(lines, { stopHookActive: i > 1 });
    // Chain exhausted for prompt #1; prompt #2 starts again from zero.
    const next = [...lines, userLine("next"), todoWrite(OPEN_TODOS)];
    const fresh = run(next, { stopHookActive: false });
    expect(blocked(fresh)?.decision).toBe("block");
  });

  test("the cap holds without stop_hook_active (flag absent -> still 8 per prompt)", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) {
      expect(blocked(run(lines, { stopHookActive: false }))?.decision).toBe("block");
    }
    expect(blocked(run(lines, { stopHookActive: false }))).toBeNull();
    expect(blocked(run(lines, { stopHookActive: false }))).toBeNull();
  });

  test("the counter is keyed by session: another session's chain does not exhaust this one", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) run(lines, { stopHookActive: i > 1, sessionId: "sess-a" });
    const other = run(lines, { stopHookActive: true, sessionId: "sess-b" });
    expect(blocked(other)?.decision).toBe("block");
  });

  test("live loop: the isMeta Stop-feedback entry after each block does not reset the cap (<= 8 blocks)", () => {
    // Real loop, not a frozen transcript: every block appends the feedback
    // entry and the lead's next TodoWrite, the way Claude Code grows the file.
    const transcript: unknown[] = [userLine("go"), todoWrite(OPEN_TODOS)];
    let blocks = 0;
    for (let i = 0; i < 30; i++) {
      if (blocked(run(transcript, { stopHookActive: true })) === null) break;
      blocks++;
      transcript.push(stopFeedbackLine("continue with Wire the route"), todoWrite(OPEN_TODOS));
    }
    expect(blocks).toBeLessThanOrEqual(8);
    expect(blocks).toBe(8);
  });

  test("tool_result entries between blocks do not start a new chain (live loop, <= 8 blocks)", () => {
    const transcript: unknown[] = [userLine("go"), todoWrite(OPEN_TODOS)];
    let blocks = 0;
    for (let i = 0; i < 30; i++) {
      if (blocked(run(transcript, {})) === null) break;
      blocks++;
      transcript.push(toolResultLine(), todoWrite(OPEN_TODOS));
    }
    expect(blocks).toBe(8);
  });

  test("an allowed stop clears the counter so the next chain starts fresh", () => {
    const open = [userLine("go"), todoWrite(OPEN_TODOS)];
    const done = [userLine("go"), todoWrite([{ content: "x", status: "completed" }])];
    run(open, { stopHookActive: false });
    run(done, { stopHookActive: true });
    const counterDir = join(home, ".claude", "state");
    const count = existsSync(counterDir) ? readFileSync(join(counterDir, `oss-lead-continue-${SESSION}`), "utf8").trim().split("\n")[1] : "0";
    expect(count).toBe("0");
  });
});

describe("studio-bringup.sh lead-gate settings write — OSS Stop registration fails open", () => {
  test("happy path: one settings write registers the OSS Stop hook and the lead-gate PreToolUse", () => {
    mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(home, ".claude", "hooks", "oss-lead-continue.sh"), "#!/usr/bin/env bash\n");
    const region = extractRegion(BRINGUP, "lead-gate-settings-merge");
    const res = runSnippet({ script: region, shell: "bash", env: { HOME: home }, timeout: 10_000 });
    expect(res.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(cfg.hooks.Stop)).toContain("oss-lead-continue.sh");
    expect(JSON.stringify(cfg.hooks.PreToolUse)).toContain("lead-gate.sh");
  });

  test("Stop as a non-list does not abort the settings write: PreToolUse still lands, exit 0", () => {
    const claudeDir = join(home, ".claude");
    mkdirSync(join(claudeDir, "hooks"), { recursive: true });
    writeFileSync(join(claudeDir, "hooks", "oss-lead-continue.sh"), "#!/usr/bin/env bash\n");
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

describe("studio-bringup.sh installs the Stop hook for OSS leads", () => {
  test("copies gates/oss-lead-continue.sh into ~/.claude/hooks", () => {
    expect(BRINGUP).toContain("/opt/blueprint/gates/oss-lead-continue.sh");
    expect(BRINGUP).toContain("~/.claude/hooks/oss-lead-continue.sh");
  });

  test("registers the hook on the Stop event (lead turn end; members emit SubagentStop)", () => {
    expect(BRINGUP).toContain("oss-lead-continue.sh");
    expect(BRINGUP).toMatch(/setdefault\("Stop", \[\]\)/);
  });

  test("Stop registration rides the SAME settings.json write as the lead gate (one write, all hooks or none)", () => {
    const leadWrite = BRINGUP.indexOf("pre.append(entry)");
    const stopReg = BRINGUP.indexOf('stop.append(');
    expect(leadWrite).toBeGreaterThan(-1);
    expect(stopReg).toBeGreaterThan(leadWrite);
    // No settings.json write between the lead-gate entry and the Stop registration.
    expect(BRINGUP.slice(leadWrite, stopReg)).not.toContain('with open(path, "w")');
  });

  test("a missing source under set -e logs and boot continues without the hook", () => {
    const start = BRINGUP.indexOf("    if cp /opt/blueprint/gates/oss-lead-continue.sh");
    expect(start).toBeGreaterThan(-1);
    const end = BRINGUP.indexOf("\n    fi\n", start) + "\n    fi\n".length;
    const block = BRINGUP.slice(start, end);
    const bringHome = mkdtempSync(join(tmpdir(), "oss-boot-"));
    mkdirSync(join(bringHome, ".claude", "hooks"), { recursive: true });
    const res = runSnippet({
      script: `set -e\n${block}\necho BOOT_CONTINUES`,
      stdin: "",
      shell: "bash",
      env: { HOME: bringHome },
      timeout: 10_000,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("BOOT_CONTINUES");
    expect(res.stderr).toContain("continuing boot without it");
    rmSync(bringHome, { recursive: true, force: true });
  });

  test("the copy is guarded: a failed cp logs and bring-up continues", () => {
    expect(BRINGUP).toMatch(/if cp \/opt\/blueprint\/gates\/oss-lead-continue\.sh/);
  });
});
