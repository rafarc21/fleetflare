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

  test("a question ending is detected even with trailing whitespace", () => {
    const res = run([todoWrite(OPEN_TODOS), assistantText("Should I drop the flag?  \n")]);
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

  test("a fresh turn (stop_hook_active false) resets the chain counter", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) run(lines, { stopHookActive: i > 1 });
    // Chain exhausted; a new user turn starts again from zero.
    const fresh = run(lines, { stopHookActive: false });
    expect(blocked(fresh)?.decision).toBe("block");
  });

  test("the counter is keyed by session: another session's chain does not exhaust this one", () => {
    const lines = [userLine("go"), todoWrite(OPEN_TODOS)];
    for (let i = 1; i <= 8; i++) run(lines, { stopHookActive: i > 1, sessionId: "sess-a" });
    const other = run(lines, { stopHookActive: true, sessionId: "sess-b" });
    expect(blocked(other)?.decision).toBe("block");
  });

  test("an allowed stop clears the counter so the next chain starts fresh", () => {
    const open = [userLine("go"), todoWrite(OPEN_TODOS)];
    const done = [userLine("go"), todoWrite([{ content: "x", status: "completed" }])];
    run(open, { stopHookActive: false });
    run(done, { stopHookActive: true });
    const counterDir = join(home, ".claude", "state");
    const files = existsSync(counterDir) ? readFileSync(join(counterDir, `oss-lead-continue-${SESSION}`), "utf8").trim() : "0";
    expect(files).toBe("0");
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
});
