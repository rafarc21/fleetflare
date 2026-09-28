# P7a Tier-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five defects the firstmate analysis measured in our own code, and build the executable test lane that would have caught three of them.

**Architecture:** Two lanes, split by what workerd can do. `vitest` runs under `vitest-pool-workers` — no filesystem, no `child_process` — so it can only ASSERT ON source text, which is how all three defects got in. A `bun:test` lane already exists (23 tests, 2 files, 22ms) and has real `node:fs` + `Bun.spawnSync`. Tasks 1–3 move emitted-shell verification into that lane and make it runnable. Task 4 is Worker-side and disjoint. Tasks 5–6 both edit `container/studio-bringup.sh`, so they are ordered and share ONE image bump, verified live in Task 7.

**Tech Stack:** Bun + TypeScript (Worker), bash/POSIX sh (container bring-up), Claude Code hooks, vitest + `bun:test`.

**Spec:** `docs/fleet/firstmate-analysis.md` — §2 names each defect with the file and line that proves it; §3 Tier-1 names the firstmate mechanism each task ports and where to read it. Read §2 before starting: every task here traces to a defect measured in our tree, not to a firstmate feature we admired.

## Global Constraints

- `bun` only, never npm/npx/pnpm.
- Caveman-compressed persistent text (comments, commits, PRs, plans). NOT code. NOT user-facing messages.
- Baseline measured 2026-09-05: **1562 vitest across 64 files**, **23 bun-side across 2 files**, `bun run check` clean across 5 tsconfig projects. There is no `lint` script in `apps/fleet`.
- A check command must NEVER contain the `exit` builtin — it kills the shared `sandbox-default` session's shell and the SDK throws instead of returning. Task 2 replaces the existing TEXT assertion of this rule with an EXECUTED one.
- Fail-CLOSED for a gate (no gate → do not boot). Fail-OPEN for a CHECK (inconclusive is a statement about the check, never about the studio). Already ruled in code — honour it.
- Touching `studio-bringup.sh` or `Dockerfile.studio` requires bumping `LABEL fleet.image.rev`, deploying, AND recycling to verify. Current value: `guardrail-gate-2` (`container/Dockerfile.studio:24`). Deploy is not rollout.
- `wrangler deploy` builds the image from the WORKING TREE, not from git. Never deploy with someone else's uncommitted edits present.
- Run every command from `apps/fleet/`.

---

### Task 1: Make the bun lane runnable, add the snippet-exec harness

The bun lane exists and nothing runs it — `package.json` has only `"test": "vitest run"`. New executable tests added to an unrunnable lane are exactly firstmate's own failure: their nonce probe, detach probe and skill eval are all real and none run on PR (analysis §5.2, §3 item 34).

**Files:**
- Modify: `apps/fleet/package.json` (scripts block, lines 9-19)
- Create: `apps/fleet/test/bun/exec-snippet.ts`
- Create: `apps/fleet/test/bun/exec-snippet.test.ts`

**Interfaces:**
- Produces, consumed by Tasks 2 and 3:
  - `extractHeredoc(src: string, marker: string): string` — returns the body between `<<'MARKER'` and a line that is exactly `MARKER`. Throws if either delimiter is missing.
  - `runSnippet(opts: { script: string; stdin?: string; env?: Record<string, string>; shell?: "sh" | "bash" | "dash"; timeout?: number; sourced?: boolean; }): { code: number; stdout: string; stderr: string; parentAlive: boolean }` — writes `script` to a temp file, runs it inside a WRAPPER shell that echoes a sentinel afterwards. `parentAlive` is whether that sentinel reached stdout.
  - **`sourced` picks which real execution context is modelled, and getting it wrong silently disarms the check.** `false` (default) runs the snippet as a CHILD (`sh <path>`) — faithful to a Claude Code HOOK, which the harness spawns as its own process. `true` runs it as `. <path>` in the wrapper shell itself — faithful to `sbExec`, which runs every command inside ONE long-lived `sandbox-default` session. Measured: with snippet `echo before; exit 0`, child mode still prints the sentinel (`parentAlive` true, always, for every possible snippet) while sourced mode does not. A check command tested in child mode passes against the exact code that caused the original outage.

- [ ] **Step 1: Write the failing test**

Create `apps/fleet/test/bun/exec-snippet.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { extractHeredoc, runSnippet } from "./exec-snippet";

describe("extractHeredoc", () => {
  test("returns the body between the quoted delimiters", () => {
    const src = ["prefix", "cat > f <<'MARK'", "line one", "line two", "MARK", "suffix"].join("\n");
    expect(extractHeredoc(src, "MARK")).toBe("line one\nline two");
  });

  test("throws when the marker is absent", () => {
    expect(() => extractHeredoc("nothing here", "MARK")).toThrow("MARK");
  });
});

describe("runSnippet", () => {
  test("reports stdout, exit code, and a surviving parent", () => {
    const r = runSnippet({ script: 'echo hello; echo oops >&2' });
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("oops");
    expect(r.code).toBe(0);
    expect(r.parentAlive).toBe(true);
  });

  test("a snippet that calls exit still leaves the PARENT shell alive", () => {
    // The wrapper is what models sbExec's shared `sandbox-default` session:
    // the snippet runs as a child, so its `exit` must not take the parent.
    const r = runSnippet({ script: "echo before; exit 3" });
    expect(r.stdout).toContain("before");
    expect(r.parentAlive).toBe(true);
    // And the snippet's OWN status must survive the wrapper. Asserting only
    // parentAlive here once hid a wrapper that reported 0 for every snippet.
    expect(r.code).toBe(3);
  });

  test("passes stdin and env through", () => {
    const r = runSnippet({ script: 'read line; echo "got:$line:$WHO"', stdin: "payload\n", env: { WHO: "member" } });
    expect(r.stdout).toContain("got:payload:member");
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd apps/fleet && bun test test/bun/exec-snippet.test.ts`
Expected: FAIL — `Cannot find module './exec-snippet'`.

- [ ] **Step 3: Implement the harness**

Create `apps/fleet/test/bun/exec-snippet.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pull a heredoc body out of shell source. studio-bringup.sh emits its hook
 * scripts as `cat > path <<'MARKER' ... MARKER`; the quoted marker means the
 * body is literal, so what is extracted here is byte-identical to what lands
 * in the container.
 */
export function extractHeredoc(src: string, marker: string): string {
  const open = `<<'${marker}'`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`heredoc opener <<'${marker}' not found in source`);
  const bodyStart = src.indexOf("\n", openAt);
  if (bodyStart === -1) throw new Error(`heredoc <<'${marker}' has no body`);
  const rest = src.slice(bodyStart + 1);
  const lines = rest.split("\n");
  const endIdx = lines.findIndex((l) => l === marker);
  if (endIdx === -1) throw new Error(`heredoc terminator ${marker} not found in source`);
  return lines.slice(0, endIdx).join("\n");
}

const PARENT_SENTINEL = "__PARENT_STILL_ALIVE__";

export interface RunSnippetOpts {
  script: string;
  stdin?: string;
  env?: Record<string, string>;
  shell?: "sh" | "bash" | "dash";
}

export interface RunSnippetResult {
  code: number;
  stdout: string;
  stderr: string;
  parentAlive: boolean;
}

/**
 * Run an emitted snippet as a CHILD of a wrapper shell, then echo a sentinel.
 *
 * The wrapper is the point. sbExec runs every command inside ONE long-lived
 * container-server session; a snippet containing `exit` terminated that
 * session's shell and the SDK threw instead of returning — the historical bug
 * this harness exists to catch. `parentAlive` false means the snippet took
 * its parent down with it.
 */
export function runSnippet(opts: RunSnippetOpts): RunSnippetResult {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snippet-"));
  try {
    const scriptPath = join(dir, "snippet.sh");
    writeFileSync(scriptPath, opts.script, { mode: 0o755 });
    const shell = opts.shell ?? "sh";
    // `;` alone would make the wrapper report the trailing echo's status, not
    // the snippet's -- `code` would be 0 forever. Capture $? first, re-exit with it.
    const wrapper = `${shell} ${JSON.stringify(scriptPath)}; __rc=$?; echo ${PARENT_SENTINEL}; exit $__rc`;
    const proc = Bun.spawnSync({
      cmd: ["sh", "-c", wrapper],
      stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString();
    return {
      code: proc.exitCode ?? -1,
      stdout: stdout.replace(PARENT_SENTINEL, "").trimEnd(),
      stderr: proc.stderr.toString(),
      parentAlive: stdout.includes(PARENT_SENTINEL),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests — green**

Run: `cd apps/fleet && bun test test/bun/exec-snippet.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the script so the lane cannot be orphaned**

In `apps/fleet/package.json`, add after the `"test"` line:

```json
    "bun-test": "bun test test/bun test/studio.files.test.ts test/studio.studio-blueprint.test.ts",
```

Run: `cd apps/fleet && bun run bun-test`
Expected: PASS, 28 tests (23 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/package.json apps/fleet/test/bun/
git commit -m "test(fleet): bun lane runnable, snippet-exec harness"
```

---

### Task 2: Execute the provisioned check, prove the parent survives

`provisionedCheckCmd` is a POSIX-sh expression built in TypeScript. Today one test asserts `not.toContain("exit ")` — a text assertion standing in for a behaviour. Executing it is strictly stronger and catches forms the string match misses.

**Files:**
- Create: `apps/fleet/test/bun/provisioned-check.test.ts`
- Read only: `apps/fleet/src/studio/provision.ts:472-481` (`provisionedCheckCmd`), and `harnessCheckSnippet` below it

**Interfaces:**
- Consumes: `extractHeredoc`, `runSnippet` from Task 1; `provisionedCheckCmd(repo: string, harness?: string | null): string` from `src/studio/provision.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/fleet/test/bun/provisioned-check.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { runSnippet } from "./exec-snippet";
import { provisionedCheckCmd } from "../../src/studio/provision";

// A repo name that cannot exist on disk sends the command down its FIRST
// branch, so this runs instantly and needs no tmux, no claude, no container.
const ABSENT = "no-such-repo-p7a";

describe("provisionedCheckCmd, executed", () => {
  test("reports a missing checkout on stdout and leaves the parent shell alive", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT), sourced: true });
    expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
    expect(r.parentAlive).toBe(true);
  });

  test("same under dash, the shell a container actually uses for /bin/sh", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT), shell: "dash", sourced: true });
    expect(r.stdout).toContain(`no git checkout at /workspace/${ABSENT}`);
    expect(r.parentAlive).toBe(true);
  });

  test("the harness variant also leaves the parent alive", () => {
    const r = runSnippet({ script: provisionedCheckCmd(ABSENT, "claude"), sourced: true });
    expect(r.parentAlive).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, watch it fail if `dash` is absent, then decide**

Run: `cd apps/fleet && bun run bun-test`
Expected on a Mac without dash: the dash test FAILS with a spawn error. Install it — `brew install dash` — and re-run. If dash cannot be installed on this machine, delete that ONE test and say so in the commit body; do not silently switch it to `sh`, because on macOS `/bin/sh` is bash in POSIX mode and would make the test claim coverage it does not have.

- [ ] **Step 3: Run tests — green**

Run: `cd apps/fleet && bun run bun-test`
Expected: PASS, 31 tests.

- [ ] **Step 4: Prove the harness would have caught the historical bug**

Temporarily append `; exit 0` to `provisionedCheckCmd`'s returned string, re-run, and confirm `parentAlive` is FALSE. It will only go false under `sourced: true` — if it stays true, the harness is modelling a child process and the whole task is theatre. Revert the edit. Record the observed output in the task report — a harness that cannot fail proves nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/test/bun/provisioned-check.test.ts
git commit -m "test(fleet): run the provisioned check, assert parent survives"
```

---

### Task 3: Execute both hook scripts, lock the gate's generated prose

Two defects in one file. The lead gate and completion gate are emitted as heredocs and have never been executed by a test. Separately, `test/studio.session.test.ts:121` documents that the gate "never asks a studio for `learnings`" — that gap was closed (`studio-bringup.sh:734`) and nothing pins the fix, which is how it opened the first time.

This task is a REGRESSION LOCK, not a bug fix. The gate asks correctly today.

**Files:**
- Create: `apps/fleet/test/bun/bringup-hooks.test.ts`
- Read only: `apps/fleet/container/studio-bringup.sh:445-570` (lead gate, marker `HOOKEOF`), `:655-829` (completion gate, marker `GATEEOF`), `:734-735` (the `learnings` lines)

**Interfaces:**
- Consumes: `extractHeredoc`, `runSnippet` from Task 1

- [ ] **Step 1: Write the failing test**

Create `apps/fleet/test/bun/bringup-hooks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractHeredoc, runSnippet } from "./exec-snippet";

const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");
const LEAD_GATE = extractHeredoc(BRINGUP, "HOOKEOF");
const COMPLETION_GATE = extractHeredoc(BRINGUP, "GATEEOF");

function leadGate(payload: unknown) {
  return runSnippet({ script: LEAD_GATE, stdin: JSON.stringify(payload), shell: "bash" });
}

describe("lead gate, executed", () => {
  test("blocks the LEAD's Write with exit 2", () => {
    const r = leadGate({ tool_name: "Write", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(2);
    // The invariant every refusal path shares. Do NOT assert a prose tail:
    // ":523" (non-Bash) says "-- dispatch a member" lowercase, while the two
    // Bash paths capitalise it after a parenthetical. Case-sensitive fragments
    // of one branch's wording assert nothing about behaviour.
    expect(r.stderr).toContain("leads never implement");
  });

  test("permits a MEMBER's Write — agent_id present means it is not the lead", () => {
    const r = leadGate({ tool_name: "Write", agent_id: "member-1", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(0);
  });

  test("blocks a lead Bash write-form", () => {
    const r = leadGate({ tool_name: "Bash", tool_input: { command: "echo hi > /workspace/x.ts" } });
    expect(r.code).toBe(2);
  });

  test("permits a lead Bash read-form", () => {
    const r = leadGate({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(r.code).toBe(0);
  });

  test("malformed stdin does not crash the hook into permitting a write", () => {
    const r = runSnippet({ script: LEAD_GATE, stdin: "not json", shell: "bash" });
    expect([0, 2]).toContain(r.code);
  });
});

describe("completion gate, generated prose", () => {
  // The gap this locks: the gate's HOWTO once named plan / verification /
  // verification_intent and never `learnings`, so the teardown harvest found
  // nothing on every recycle -- a pipe with no water. Fixed; pinned here.
  test("the emitted HOWTO asks for learnings", () => {
    expect(COMPLETION_GATE).toContain("learnings");
  });

  test("it still demands verification intent", () => {
    expect(COMPLETION_GATE).toContain("verification_intent");
  });

  test("learnings is named OPTIONAL and never a refusal condition", () => {
    expect(COMPLETION_GATE).toMatch(/learnings is OPTIONAL/);
    expect(COMPLETION_GATE).toMatch(/never checks it|[Nn]ever a refusal/);
  });

  test("no stale wording claiming the gate checks learnings", () => {
    expect(COMPLETION_GATE).not.toMatch(/learnings (is )?required/i);
  });
});

describe("completion gate, executed", () => {
  // FIXTURE IS LOAD-BEARING. An unseeded temp dir refuses at
  // studio-bringup.sh:739 ("No git checkout") and NEVER reaches the
  // verification_intent check at :810-822 -- and the assertion still passes,
  // because HOWTO (:726-737) is appended to every refusal and always names
  // the field. The fixture must therefore seed:
  //   1. `git init` in the temp dir                        (:739 wants .git)
  //   2. a plan doc, COMMITTED -- :756-760 runs
  //      `git log -1 --format=%H -- <plan>` and rejects a working-tree-only
  //      file. Needs `git -c user.email=... -c user.name=... commit`.
  //   3. `.fleet/done.json` with plan + verification, verification_intent ABSENT
  //   4. a fake $HOME -- the refusal counter writes ~/.claude/.fleet-stop-gate
  //      and would advance MAX_REFUSALS on the host otherwise
  // The authoritative version is the committed test; see
  // apps/fleet/test/bun/bringup-hooks.test.ts.
  //
  // `not.toContain("No git checkout")` is the assertion that proves the early
  // guard was passed. Without it this test silently pins the wrong property.
  test("refuses a done-report with no verification intent, and names the field", () => {
    // ... seeded fixture per the comment above ...
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("verification_intent");
    expect(r.stderr).not.toContain("No git checkout");
  });

  // A gate that only ever refuses is not proven usable. An unsatisfiable Stop
  // hook makes a studio unusable, which is worse than the gap it closes.
  test("lets the stop through when verification_intent is well-formed", () => {
    expect(r.code).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd apps/fleet && bun run bun-test`
Expected: FAIL. The exact failures are unknown until it runs — both hooks read files under `$HOME/.claude` and a repo checkout that do not exist here.

- [ ] **Step 3: Adjust the harness call, NOT the hook**

Give each hook a fake `$HOME` and working directory via `runSnippet`'s `env`, e.g. `env: { HOME: <temp dir> }`, seeding whatever files the failure names. If a hook cannot run outside a container at all, say WHICH line makes that true and drop only that test — do not weaken an assertion to make it pass. The four generated-prose tests have no such dependency and must pass regardless.

- [ ] **Step 4: Run tests — green**

Run: `cd apps/fleet && bun run bun-test && bun run test && bun run check`
Expected: bun lane green, 1562 vitest still green, check clean.

- [ ] **Step 5: Update the stale comment**

`apps/fleet/test/studio.session.test.ts:121` still says the gate "never asks a studio for `learnings`". That is now false. Rewrite it to state that the gate asks, is OPTIONAL, and that `test/bun/bringup-hooks.test.ts` pins it.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/test/bun/bringup-hooks.test.ts apps/fleet/test/studio.session.test.ts
git commit -m "test(fleet): execute both gate hooks, lock the learnings ask"
```

---

### Task 4: The Worker verifies a claimed PR exists

`src/board/envelope.ts` validates an artifact's SHAPE — a `kind` plus one of `path|pr|url` — and nothing reads it afterwards (`src/board/types.ts:251` holds the type; `src/studio/ff.ts:100` is prose). A studio can report a PR that does not exist and the Worker records it as fact.

`envelope.ts` is deliberately PURE — its own header says "no I/O, no token, no fetch — so every rule here is unit-tested directly". The check therefore goes at the CALL SITE, `commentEnvelope`, not in the schema.

**Files:**
- Modify: `apps/fleet/src/github/api.ts` (add `pullRequestExists` beside `repoIsWritable`, ~line 447)
- Modify: `apps/fleet/src/board/board.ts:207-224` (`commentEnvelope`)
- Modify: `apps/fleet/src/board/board.ts:41-50` (`BoardApi`)
- Test: `apps/fleet/test/board.envelope.test.ts`

**Interfaces:**
- Produces: `pullRequestExists(token: string, repo: string, number: number): Promise<boolean>` — `false` on 404, `true` on 2xx, THROWS on anything else. Mirrors `repoIsWritable`'s convention exactly (`src/github/api.ts:447-465`).
- Produces: `BoardApi.pullRequestExists: (repo: string, number: number) => Promise<boolean>` — a new member, so every existing fake in the test suite must gain it.
- Consumes: `commentEnvelope(api, repo, number, raw, msgId)` — unchanged signature.

- [ ] **Step 1: Write the failing test**

Add to `apps/fleet/test/board.envelope.test.ts`:

```ts
describe("commentEnvelope verifies PR artifacts", () => {
  const RESULT = {
    sender: "web-studio", intent: "result", status: "ok",
    artifacts: [{ kind: "pr", pr: "#4242" }],
    verification: { url: "https://staging.example/x", steps: ["open it"], expected: "renders" },
  };

  it("refuses a result whose claimed PR does not exist", async () => {
    const api = fakeBoardApi({ labels: ["working"], pullRequestExists: async () => false });
    const res = await commentEnvelope(api, "o/r", 7, RESULT, "m1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.message).toContain("4242");
    }
  });

  it("accepts the same result when the PR is real", async () => {
    const api = fakeBoardApi({ labels: ["working"], pullRequestExists: async () => true });
    const res = await commentEnvelope(api, "o/r", 7, RESULT, "m1");
    expect(res.ok).toBe(true);
  });

  it("never calls GitHub for a non-PR artifact", async () => {
    let calls = 0;
    const api = fakeBoardApi({
      labels: ["working"],
      pullRequestExists: async () => { calls++; return true; },
    });
    const res = await commentEnvelope(
      api, "o/r", 7, { ...RESULT, artifacts: [{ kind: "doc", path: "docs/x.md" }] }, "m1",
    );
    expect(res.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("a GitHub outage does NOT refuse the envelope — the check fails OPEN", async () => {
    // Gate fail-CLOSED, check fail-OPEN: an unreachable API is a statement
    // about the API, never about the studio's work. Losing a real report to a
    // 500 is worse than recording one unverified claim.
    const api = fakeBoardApi({
      labels: ["working"],
      pullRequestExists: async () => { throw new Error("read o/r#4242 failed (503): upstream"); },
    });
    const res = await commentEnvelope(api, "o/r", 7, RESULT, "m1");
    expect(res.ok).toBe(true);
  });
});
```

Extend the file's existing board-api fake to accept and default `pullRequestExists`. If that file has no shared fake, build one in this describe block rather than editing unrelated tests.

- [ ] **Step 2: Run, watch it fail**

Run: `cd apps/fleet && bun run test -- board.envelope`
Expected: FAIL — `api.pullRequestExists is not a function`.

- [ ] **Step 3: Implement**

In `src/github/api.ts`, beside `repoIsWritable`:

```ts
/**
 * Does this PR exist? 404 is `false`; 2xx is `true`; everything else THROWS.
 *
 * Same convention as repoIsWritable above, and the same 404 ambiguity applies
 * — under a PAT a private repo outside the grant answers exactly as a missing
 * one does. That ambiguity is acceptable HERE in a way it is not for auth: the
 * caller (board.ts's commentEnvelope) treats a throw as inconclusive and
 * proceeds, so the only outcome a false 404 produces is a refused claim on a
 * repo the fleet cannot see anyway.
 */
export async function pullRequestExists(token: string, repo: string, number: number): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
    method: "GET", headers: GH_HEADERS(token),
  });
  const text = await res.text();
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`read ${repo}#${number} failed (${res.status}): ${text.slice(0, 300)}`);
  return true;
}
```

In `src/board/board.ts`, add to `BoardApi`:

```ts
  pullRequestExists: (repo: string, number: number) => Promise<boolean>;
```

In `commentEnvelope`, after the state-label guard and BEFORE `createComment`:

```ts
  // A claimed artifact is a claim, not a fact. Shape is all envelope.ts can
  // check -- it is pure by design -- so existence is checked here, where a
  // token lives. Only `pr` artifacts: a path or url the Worker cannot resolve
  // without the checkout it does not have.
  //
  // Fail-OPEN on a thrown error, deliberately: a gate fails closed, a CHECK
  // fails open. An unreachable GitHub is a statement about GitHub.
  for (const art of parsed.doc.payload.artifacts) {
    const pr = art.pr;
    if (pr === undefined) continue;
    const num = Number.parseInt(pr.replace(/^#/, ""), 10);
    if (!Number.isInteger(num) || num <= 0) {
      return { ok: false, status: 409, message: `artifact pr ${JSON.stringify(pr)} is not an issue number` };
    }
    let exists: boolean;
    try {
      exists = await api.pullRequestExists(repo, num);
    } catch {
      continue;
    }
    if (!exists) {
      return {
        ok: false, status: 409,
        message: `artifact claims PR #${num} in ${repo}, which does not exist — refusing to record it as fact`,
      };
    }
  }
```

Wire the real implementation wherever `BoardApi` is constructed (grep `createComment:` to find every construction site) as `pullRequestExists: (repo, number) => pullRequestExists(token, repo, number)`.

- [ ] **Step 4: Run tests — green**

Run: `cd apps/fleet && bun run test && bun run check`
Expected: 1566 vitest pass, check clean. Any other test constructing a `BoardApi` fake needs the new member — add it there, do not widen the interface to optional.

- [ ] **Step 5: Commit**

```bash
# All 7: the interface change does not compile without the real construction
# site AND all three fakes.
git add apps/fleet/src/github/api.ts apps/fleet/src/board/board.ts \
        apps/fleet/src/board/routes.ts apps/fleet/test/board.envelope.test.ts \
        apps/fleet/test/board.fleet-routes.test.ts apps/fleet/test/board.routes.test.ts \
        apps/fleet/test/board.board.test.ts
git commit -m "feat(fleet): worker verifies a claimed PR exists before recording it"
```

---

### Task 5: The lead gate matches on tool SHAPE, not a fixed list

`studio-bringup.sh:610` pins `"matcher": "Edit|Write|NotebookEdit|Bash"`. A new write-capable or delegation-shaped tool walks past. firstmate hit this live and lost 73 minutes of supervision (`docs/subagent-guard.md:15-27`); their fix was matcher `.*` with the decision moved INTO the script, "because the failure is precisely the absence of that metadata".

Matcher `.*` means the hook runs on EVERY tool call, so the script's fast path must stay cheap and must never block an unrecognised tool by accident.

**Files:**
- Modify: `apps/fleet/container/studio-bringup.sh:445-570` (the lead-gate script — add the shape test)
- Modify: `apps/fleet/container/studio-bringup.sh:604-618` (the settings.json merge — matcher)
- Modify: `apps/fleet/container/Dockerfile.studio:24` (`LABEL fleet.image.rev`)
- Test: `apps/fleet/test/bun/bringup-hooks.test.ts` (from Task 3)

**Interfaces:**
- Consumes: `extractHeredoc`, `runSnippet`, and the `leadGate()` helper from Task 3

- [ ] **Step 1: Write the failing test**

Add to `apps/fleet/test/bun/bringup-hooks.test.ts`:

```ts
describe("lead gate matches on shape", () => {
  test("blocks a lead's write through a tool NOT on the old list", () => {
    const r = leadGate({ tool_name: "MultiEdit", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(2);
  });

  // The brief's example list IS the specification — test every entry. An
  // earlier round tested only `Glob` with no `path`, the single read-shaped
  // input that dodged the key-list collision, and shipped a gate that refused
  // the lead's own Read.
  test.each([
    ["Read", { file_path: "/workspace/plan.md" }],
    ["Grep", { pattern: "TODO", path: "/workspace/src" }],
    ["Glob", { pattern: "**/*.ts", path: "/workspace/src" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["TodoWrite", { todos: [] }],
    ["Task", { prompt: "x" }],
    ["WebFetch", { url: "https://example.com" }],
  ])("permits read-shaped %s", (tool_name, tool_input) => {
    expect(leadGate({ tool_name, tool_input }).code).toBe(0);
  });

  test("permits a member identified by agent_type", () => {
    // studio-bringup.sh:520 exempts on `agent_id` OR `agent_type`. Both
    // branches must be pinned: a member wrongly blocked is the regression that
    // starved members once already.
    const r = leadGate({ tool_name: "Write", agent_type: "implementer", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(0);
  });

  test("a member is still exempt whatever the tool is called", () => {
    const r = leadGate({ tool_name: "MultiEdit", agent_id: "member-1", tool_input: { file_path: "/workspace/x.ts" } });
    expect(r.code).toBe(0);
  });
});

test("the installed matcher is not a fixed tool list", () => {
  expect(BRINGUP).not.toContain('"matcher": "Edit|Write|NotebookEdit|Bash"');
});
```

- [ ] **Step 2: Run, watch it fail**

Run: `cd apps/fleet && bun run bun-test`
Expected: FAIL on `MultiEdit` (permitted today) and on the matcher assertion.

- [ ] **Step 3: Implement**

In the lead-gate script, replace the tool-name equality checks with a shape test. Two rules, in this order:

1. `agent_id` present → exit 0. Unchanged, and it must stay FIRST: a member is exempt whatever the tool is.
2. Otherwise: `write_shaped = (name_is_writeish and has_locator) or has_write_content`.
   - `name_is_writeish` = `(?i)(edit|write|notebook|patch|apply)` on the tool NAME
   - `has_locator` = `tool_input` carries `file_path`, `path`, or `notebook_path`
   - `has_write_content` = `tool_input` carries `content`, `contents`, `edits`, `new_string`, `new_str`, or `patch`

   **`file_path` alone is NOT a write signal — `Read`'s only required parameter is `file_path`, and `Grep`/`Glob` take `path` as their directory scope.** An earlier form of this rule OR'd the locator keys in directly and refused the lead's own `Read`, `Grep` and path-scoped `Glob`: strictly worse than the fixed tool list it replaced, since those tools never reached the hook at all before. A write carries CONTENT, or is a write-NAMED tool naming a target. `TodoWrite` matches the name regex and carries no locator, so it passes — a lead losing its todo bookkeeping is a real degradation and not what this gate is for.

   Read `tool_input` as `payload.get("tool_input") or {}`: a present-but-null value raises `TypeError`, python exits 1, and **exit 1 PERMITS the call** — fail-open inside a fail-closed gate.

   `Bash` keeps its existing write-FORM analysis, unchanged, and is never routed through this test.

Anything else exits 0. An unknown tool is not a write, and a `.*` matcher that blocked on uncertainty would make every studio unusable.

In the settings.json merge, change the matcher to `".*"` and leave the fail-closed `guarded` wrapper exactly as it is.

- [ ] **Step 4: Bump the image rev**

`container/Dockerfile.studio:24` → `LABEL fleet.image.rev="p7a-shape-gate"`.

- [ ] **Step 5: Run tests — green**

Run: `cd apps/fleet && bun run bun-test && bun run test && bun run check`

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/container/studio-bringup.sh apps/fleet/container/Dockerfile.studio apps/fleet/test/bun/bringup-hooks.test.ts
git commit -m "fix(fleet): lead gate matches write SHAPE, not a fixed tool list"
```

---

### Task 6: SessionStart re-emits the working set after a compaction

`studio-bringup.sh` never reads the SessionStart payload's `source` field — no `compact` branch, no `resume` branch. A lead compacts mid-task and nothing replays its working set. The material already exists in the container: `ROLE_PROMPT_B64` (`src/studio/studio-blueprint.ts:305`) carries studio prompt + memory index + brief, and bring-up decodes it at `:958` into a shell variable that is then thrown away.

firstmate routes the same event (`bin/fm-sessionstart-run.sh:130-144`): `clear|compact` → re-emit, skipping mutating sweeps. They register NO `PreCompact` hook and a test pins its absence — compaction is a session-open event, not its own lifecycle. Follow that.

**Files:**
- Modify: `apps/fleet/container/studio-bringup.sh` (persist the decoded prompt; install the hook in the same python merge as the lead gate, ~line 604)
- Test: `apps/fleet/test/bun/bringup-hooks.test.ts`

**Interfaces:**
- Produces: `~/.claude/hooks/session-reemit.sh` — a SessionStart hook. Reads the payload's `source`; on `compact` or `clear` prints the persisted working set on stdout (SessionStart stdout is injected into context); on any other source, or an unreadable payload, prints nothing and exits 0.
- Produces: `/workspace/.fleet/working-set.md` — the decoded `ROLE_PROMPT_B64`, written once at bring-up.

- [ ] **Step 1: Write the failing test**

Add to `apps/fleet/test/bun/bringup-hooks.test.ts`:

```ts
const REEMIT = extractHeredoc(BRINGUP, "REEMITEOF");

function reemit(payload: unknown, workingSet: string) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ws-"));
  mkdirSync(join(dir, ".fleet"), { recursive: true });
  writeFileSync(join(dir, ".fleet", "working-set.md"), workingSet);
  try {
    return runSnippet({
      script: REEMIT, stdin: JSON.stringify(payload), shell: "bash",
      env: { FLEET_WORKSPACE: dir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("session re-emit hook", () => {
  test("replays the working set when source is compact", () => {
    const r = reemit({ source: "compact" }, "THE BRIEF");
    expect(r.stdout).toContain("THE BRIEF");
    expect(r.code).toBe(0);
  });

  test("replays it on clear too", () => {
    expect(reemit({ source: "clear" }, "THE BRIEF").stdout).toContain("THE BRIEF");
  });

  test("stays silent on a normal startup — bring-up already sent the prompt", () => {
    const r = reemit({ source: "startup" }, "THE BRIEF");
    expect(r.stdout.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  test("stays silent on resume — --continue restores the transcript itself", () => {
    expect(reemit({ source: "resume" }, "THE BRIEF").stdout.trim()).toBe("");
  });

  test("a missing working-set file is silent, never a crash", () => {
    const r = runSnippet({
      script: REEMIT, stdin: JSON.stringify({ source: "compact" }), shell: "bash",
      env: { FLEET_WORKSPACE: "/no/such/dir" },
    });
    expect(r.code).toBe(0);
    // stdout too, not just the code. Deleting the `[ -r "$ws" ] || exit 0`
    // guard outright still returns 0 while leaking the header with no body --
    // a code-only assertion stays green through exactly that regression.
    expect(r.stdout.trim()).toBe("");
  });

  test("malformed payload is silent, never a crash", () => {
    const r = runSnippet({ script: REEMIT, stdin: "not json", shell: "bash" });
    expect(r.code).toBe(0);
  });
});

test("no PreCompact hook is registered", () => {
  // Compaction is a session-open event. A PreCompact hook fires INSIDE the
  // compaction the lead is already losing context to, and cannot inject.
  expect(BRINGUP).not.toContain("PreCompact");
});
```

Add `mkdirSync`, `mkdtempSync`, `writeFileSync`, `rmSync`, `tmpdir` to that file's imports.

- [ ] **Step 2: Run, watch it fail**

Run: `cd apps/fleet && bun run bun-test`
Expected: FAIL — `heredoc opener <<'REEMITEOF' not found in source`.

- [ ] **Step 3: Implement**

In `studio-bringup.sh`, immediately after `role_prompt="$(base64 -d <<< "${ROLE_PROMPT_B64:-}")"` at `:958`, persist it:

```bash
  # The working set, kept on disk so a compaction can replay it. Bring-up
  # sends this once as claude's opening prompt; after a compact that prompt is
  # gone from context and nothing else holds it.
  #
  # BOTH lines guarded. `set -euo pipefail` is live (:21), so a bare failing
  # command here ABORTS BRING-UP -- a studio that cannot write this file would
  # not boot at all. Replay is a convenience layered on bring-up and must never
  # prevent it: degraded beats dead. Same idiom as :331, which carries its own
  # comment about not being a bare command under this script's set -e.
  mkdir -p "${FLEET_WORKSPACE:-/workspace}/.fleet" || true
  printf '%s\n' "$role_prompt" > "${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md" || true
```

Emit the hook as a heredoc with marker `REEMITEOF`, beside the other two:

```bash
    cat > ~/.claude/hooks/session-reemit.sh <<'REEMITEOF'
#!/usr/bin/env bash
# SessionStart hook. Stdout is injected into the model's context.
#
# Fires on EVERY session open; acts only on compact/clear. A normal startup
# already got the working set as claude's opening prompt, and a resume has the
# transcript. Re-emitting on those would duplicate what is already there.
#
# Silent on every failure. This is a CHECK, not a gate: an unreadable payload
# says nothing about the studio, and a SessionStart hook cannot block anyway.
ws="${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md"
src="$(python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("source", ""))
except Exception:
    print("")
' 2>/dev/null || true)"
case "$src" in
  compact|clear) ;;
  *) exit 0 ;;
esac
[ -r "$ws" ] || exit 0
printf 'Context was compacted. Your working set, replayed from disk:\n\n'
cat "$ws"
exit 0
REEMITEOF
    chmod 0755 ~/.claude/hooks/session-reemit.sh
```

Register it in the SAME python merge that installs the lead gate, as a `SessionStart` entry with no matcher, dropping prior entries by `"session-reemit.sh" not in json.dumps(e)` exactly as the lead gate does. Install it for EVERY studio including the maestro — losing context is not a code-writing problem.

- [ ] **Step 4: Run tests — green**

Run: `cd apps/fleet && bun run bun-test && bun run test && bun run check`

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/container/studio-bringup.sh apps/fleet/test/bun/bringup-hooks.test.ts
git commit -m "feat(fleet): replay the working set after a compaction"
```

---

### Task 7: Live verification

No new code. Tasks 5 and 6 both changed `studio-bringup.sh`; unit tests have never been sufficient for that file. A clean run here that proves nothing live is a FAILED task.

- [ ] **Step 1: Confirm the tree is clean and the rev is bumped**

`git status` clean, `container/Dockerfile.studio:24` reads `p7a-shape-gate`.

- [ ] **Step 2: Deploy, and read the output**

```bash
cd apps/fleet && export CLOUDFLARE_ACCOUNT_ID=0000000000000000000000000000ac && env -u CLOUDFLARE_API_TOKEN bunx wrangler deploy
```

Expected: `EDIT fleetflare-studiodo`. `no changes fleetflare-studiodo` means the image did not rebuild and NOTHING below is being tested — stop and find out why.

- [ ] **Step 3: Recycle a disposable studio and poll on script CONTENT**

`fleet recycle websites--pilot`. Then, via the probe, `grep -c REEMITEOF /path/to/materialized` inside the container — poll on the presence of the NEW hook file `~/.claude/hooks/session-reemit.sh`, never on a route's verdict. First recycle after a deploy commonly lands on the OLD image.

Probe: `/private/tmp/claude-501/-Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch/6278510d-956c-463e-bdcc-2b39e9138717/scratchpad/probe2.ts <studio-id> '<cmd>' <ms>` — runs in the shell tmux window, returns to claude, never types into the lead's prompt.

- [ ] **Step 4: Prove each change, live**
  - `~/.claude/settings.json` PreToolUse matcher reads `.*`, and `~/.claude/hooks/lead-gate.sh` exists and is executable
  - lead attempts a write through a tool not on the old list → blocked, stderr names dispatch
  - a member's write still succeeds — this is the regression that matters most; `--disallowedTools` starved members once already
  - `/workspace/.fleet/working-set.md` exists and holds the brief
  - `~/.claude/hooks/session-reemit.sh` exists; run it by hand with `{"source":"compact"}` on stdin and confirm it prints the working set, and with `{"source":"startup"}` and confirm silence
  - healthy studio still returns `{"kind":"provisioned"}` — no false flag

- [ ] **Step 5: Record what could NOT be proven live, by name**

A real compaction cannot be forced on demand; the hook is proven by hand-invocation, not by an observed compaction. Say so explicitly. Unproven is a finding, not a gap to paper over.

---

## Self-review

- **Spec coverage.** `firstmate-analysis.md` §2.1 → Task 4. §2.2 → Task 6. §2.3 → Task 3. §2.4 → Task 5. §2.5 → Tasks 1–3. Every Tier-1 item in §3 has a task.
- **NOT in this plan, deliberately:** the DO watcher (§3 Tier-2) — its own spec and plan, and it depends on Task 1's lane existing. Everything in §3 Tier-3 is unscheduled.
- **Ordering.** Tasks 1→2→3 build the lane before using it. Task 4 is Worker-side and file-disjoint from everything else, so it may run in parallel with 1–3 if a second implementer is free. Tasks 5 and 6 both edit `studio-bringup.sh` — strictly sequential, no parallel dispatch, one image bump between them, Task 7 last.
- **Type consistency.** `extractHeredoc` / `runSnippet` / `RunSnippetResult.parentAlive` are used with those exact names in Tasks 2, 3, 5, 6. `pullRequestExists` has the same name as the free function in `api.ts` and as the `BoardApi` member, matching how `repoIsWritable` is already wired.
- **Known plan risk.** Task 3 Step 2 cannot state the exact failure text, because neither hook has ever been executed outside a container — that is the defect. Step 3 gives the rule for resolving it (fix the harness, never weaken the assertion) and names the four tests that must pass regardless.
