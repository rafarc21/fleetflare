# Junior (Workers AI delegation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in `junior` skill: Claude Code delegates mechanical edits to Workers AI (GLM-5.3), gets back validated unified diff, reviews + applies itself. Works locally and in cloud studios.

**Architecture:** Bun/TS wrapper under `skills/junior/` (shim `junior.sh`). Three transports: studio → Worker proxy `POST /fleet/junior` (AI binding, spawn-token auth, zero creds in container); local → Cloudflare REST with `CLOUDFLARE_API_TOKEN` or fresh `wrangler auth token`. Off by default: Worker flags `FLEET_JUNIOR` + `JUNIOR_REPOS`, local `fleet junior enable`. In the fleet, control rests with the maestro: a studio may call junior only while working a live task the maestro filed with `fleet task new --junior` (label `junior`); the Worker checks the board on every call.

**Tech Stack:** Bun (wrapper, bun:test), Cloudflare Workers TS (vitest + vitest-pool-workers), Workers AI binding, git (`diff --no-index`, `apply --check`).

**Spec:** `docs/superpowers/specs/2026-09-28-junior-workers-ai-design.md`

## Global Constraints

- Primary model `@cf/zai-org/glm-5.3`, fallback `@cf/deepseek-ai/deepseek-v4-pro-0813`. No other model accepted by Worker.
- Default `max_tokens` 64000. Length retry doubles once, cap 128000.
- Input cap ~200k tokens (estimate chars/4). Over cap: refuse before call.
- Default wall timeout 300s per wrapper run.
- Worker body cap 2 MB.
- Junior never writes source files. Wrapper only writes `.junior/<ts>.patch` + `.junior/.gitignore`.
- No Cloudflare credential enters any studio container. House rule `apps/fleet/src/studio/blueprint.ts` "deploy credentials" block unchanged.
- Flags off by default. Absent `FLEET_JUNIOR` = off. Only exact `"on"` enables.
- Only the maestro authorizes fleet junior use: label `junior` (`JUNIOR_LABEL`), set only by `fleet task new --junior`. Maestro studio never gets the skill and never calls junior.
- English only in every new file (`apps/fleet/scripts/english-check.ts`).
- Exit codes: 0 ok, 2 usage/input, 3 api, 4 invalid edit, 5 timeout, 6 auth/not-enabled.
- Mac heavy jobs (full test suites) hold `lockf -k /tmp/fleetflare-gate.lock`. Run single test files freely.

## Review Focus

1. Model wraps blocks in ``` fences or prefixes path with `File:` / backticks → parser still extracts path + blocks. Test: Task 1 step 1 `parses fenced blocks with decorated path lines`.
2. Studio keeps calling after its junior task completed, or after the maestro reassigned it → 403, never a stale allow. Test: Task 6 `403 when the junior task is completed` / `403 when the junior task belongs to another studio`.
3. File uses CRLF line endings, model answers LF → SEARCH still matches, output keeps CRLF. Test: Task 1 `CRLF file matches LF search`.
4. Block path absolute or containing `..` (escape attempt, or new-file create outside repo) → rejected with clear error. Test: Task 1 `rejects paths outside the repo`.
5. Proxy answers plain-text 404/401 (flag off, bad token) or heartbeat spaces before JSON → wrapper exits 6 with "junior not enabled for this repo" / "unauthorized", and parses padded JSON fine. Test: Task 2 `proxy transport` cases.


## Execution notes (for the implementing studio)

- Branch `junior/workers-ai`. Studio clone is shallow single-branch: `git fetch origin junior/workers-ai:junior/workers-ai && git checkout junior/workers-ai`.
- Run with superpowers:subagent-driven-development: fresh member per task, fresh reviewer gate per task, whole-branch review at end. Tasks 1-9 in order, then Task 10 Steps 1 and 4 only.
- Line numbers here are approximate (~). Locate by named symbol.
- Deviation needed? Note it in PR body with reason. Never silently redesign.
- Skip Task 10 Steps 2, 3, 5 (live Workers AI smoke, rollout). Container holds no Cloudflare credential by design: do not look for one, do not add one.
- No `wrangler deploy`, no ops-repo edits, no merging. Operator merges.
- Heavy gates one at a time: full vitest, full `bun test test/bun`, repo tsc. Never parallel. Memory ceiling 11.65 GiB. Ignore `lockf` (Mac-only).
- CI = Mac local-ci commit statuses. Never enable GitHub Actions.
- Public repo: no private names, account ids, personal paths in committed text. English only.
- PR `junior/workers-ai` -> `main`, title "feat(junior): opt-in Workers AI delegation, maestro-gated". Body: summary, eval table from spec, per-task test evidence (command + pass counts), note Task 10 Steps 2, 3, 5 left for operator.

---

## File Structure

| File | Responsibility |
|---|---|
| `skills/junior/SKILL.md` | When to delegate, when never, review contract |
| `skills/junior/junior.sh` | Shim: `exec bun main.ts "$@"` |
| `skills/junior/src/blocks.ts` | Parse SEARCH/REPLACE blocks, apply with validation, render unified diff |
| `skills/junior/src/client.ts` | Chat types, normalize responses, transports (direct/proxy), retry/fallback policy |
| `skills/junior/src/auth.ts` | Pick transport from env + local config + wrangler |
| `skills/junior/src/main.ts` | CLI: args, prompts, input cap, repair turn, patch output, telemetry, exit codes |
| `apps/fleet/src/junior/gate.ts` | `juniorEnabled(env, repo)`, `JUNIOR_HOUSE_RULE`, model allowlist |
| `apps/fleet/src/junior/route.ts` | `POST /fleet/junior` handler |
| `apps/fleet/cli/junior.ts` | `fleet junior enable|disable|status` |
| `fleet/blueprint/studios/maestro/studio.md` | Maestro rulebook: "Junior — your call, per task" |
| Modify `apps/fleet/src/board/{types,brief,board}.ts`, `cli/task-format.ts` | `junior` label: parse, create, gate helper, ls/show marker |
| `scripts/junior-eval/eval.ts` + `README.md` | Replay eval: run, packets, score |
| Modify `apps/fleet/src/env.ts`, `src/index.ts`, `src/studio/provision.ts`, `src/studio/do.ts`, `src/studio/cli-args.ts`, `cli/fleet.ts`, `wrangler.example.jsonc`, `README.md` | Wiring |

Tests: `apps/fleet/test/bun/junior-*.test.ts` (bun, real fs/processes), `apps/fleet/test/junior.*.test.ts` (vitest, Worker).

---

### Task 1: Edit blocks — parse, apply, diff

**Files:**
- Create: `skills/junior/src/blocks.ts`
- Test: `apps/fleet/test/bun/junior-blocks.test.ts`

**Interfaces:**
- Produces:
  - `interface EditBlock { path: string; search: string; replace: string }`
  - `parseBlocks(text: string): EditBlock[]`
  - `type ApplyResult = { ok: true; after: Map<string, string> } | { ok: false; error: string }`
  - `applyBlocks(before: Map<string, string>, blocks: EditBlock[], existsOnDisk: (path: string) => boolean): ApplyResult`
  - `toUnifiedDiff(before: Map<string, string>, after: Map<string, string>): string`

- [ ] **Step 1: Write failing tests**

```ts
// apps/fleet/test/bun/junior-blocks.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBlocks, applyBlocks, toUnifiedDiff } from "../../../../skills/junior/src/blocks";

const B = (path: string, s: string, r: string) =>
  `${path}\n<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;
const none = () => false;

describe("parseBlocks", () => {
  test("parses one block", () => {
    expect(parseBlocks(B("src/a.ts", "const a = 1;", "const a = 2;")))
      .toEqual([{ path: "src/a.ts", search: "const a = 1;", replace: "const a = 2;" }]);
  });

  test("parses fenced blocks with decorated path lines", () => {
    const text = "Here you go:\n```ts\nFile: `src/a.ts`\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```\n" +
      "**src/b.ts**\n<<<<<<< SEARCH\np\n=======\nq\n>>>>>>> REPLACE\n";
    expect(parseBlocks(text)).toEqual([
      { path: "src/a.ts", search: "x", replace: "y" },
      { path: "src/b.ts", search: "p", replace: "q" },
    ]);
  });

  test("empty SEARCH parses as empty string", () => {
    expect(parseBlocks("new.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE")[0].search).toBe("");
  });

  test("no blocks -> empty list", () => {
    expect(parseBlocks("I could not do this.")).toEqual([]);
  });
});

describe("applyBlocks", () => {
  const before = () => new Map([["src/a.ts", "const a = 1;\nconst b = 1;\n"]]);

  test("applies a unique match", () => {
    const r = applyBlocks(before(), parseBlocks(B("src/a.ts", "const a = 1;", "const a = 2;")), none);
    expect(r).toEqual({ ok: true, after: new Map([["src/a.ts", "const a = 2;\nconst b = 1;\n"]]) });
  });

  test("zero matches -> error naming block, file and count", () => {
    const r = applyBlocks(before(), parseBlocks(B("src/a.ts", "nope", "x")), none);
    expect(r).toEqual({ ok: false, error: "block 1 (src/a.ts): SEARCH matched 0 times, must match exactly once" });
  });

  test("two matches -> error", () => {
    const r = applyBlocks(new Map([["a", "x\nx\n"]]), parseBlocks(B("a", "x", "y")), none);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("matched 2 times");
  });

  test("path not given as input -> error", () => {
    const r = applyBlocks(before(), parseBlocks(B("src/other.ts", "x", "y")), none);
    expect(r).toEqual({ ok: false, error: "block 1 names src/other.ts, which was not given as input" });
  });

  test("no blocks -> error", () => {
    expect(applyBlocks(before(), [], none)).toEqual({ ok: false, error: "no edit blocks found in output" });
  });

  test("empty SEARCH creates a new file", () => {
    const r = applyBlocks(before(), parseBlocks("test/a.test.ts\n<<<<<<< SEARCH\n=======\nexport {};\n>>>>>>> REPLACE"), none);
    expect(r.ok && r.after.get("test/a.test.ts")).toBe("export {};\n");
  });

  test("empty SEARCH on existing file -> error", () => {
    const r = applyBlocks(before(), parseBlocks("x.ts\n<<<<<<< SEARCH\n=======\ny\n>>>>>>> REPLACE"), () => true);
    expect(r).toEqual({ ok: false, error: "block 1 (x.ts): empty SEARCH creates a file, but x.ts already exists" });
  });

  test("rejects paths outside the repo", () => {
    for (const p of ["/etc/passwd", "../x.ts", "a/../../x.ts"]) {
      const r = applyBlocks(before(), parseBlocks(`${p}\n<<<<<<< SEARCH\n=======\ny\n>>>>>>> REPLACE`), none);
      expect(r).toEqual({ ok: false, error: `block 1: path ${p} is outside the repository` });
    }
  });

  test("replacement with dollar patterns is literal", () => {
    const r = applyBlocks(new Map([["a", "x\n"]]), parseBlocks(B("a", "x", "y = '$&$1$$'")), none);
    expect(r.ok && r.after.get("a")).toBe("y = '$&$1$$'\n");
  });

  test("CRLF file matches LF search", () => {
    const r = applyBlocks(new Map([["a", "one\r\ntwo\r\n"]]), parseBlocks(B("a", "one\ntwo", "uno\ndos")), none);
    expect(r.ok && r.after.get("a")).toBe("uno\r\ndos\r\n");
  });

  test("blocks apply in order on the updated text", () => {
    const text = B("a", "x", "y") + "\n" + B("a", "y", "z");
    const r = applyBlocks(new Map([["a", "x\n"]]), parseBlocks(text), none);
    expect(r.ok && r.after.get("a")).toBe("z\n");
  });
});

describe("toUnifiedDiff", () => {
  test("output applies cleanly with git apply --check, including a new file", () => {
    const repo = mkdtempSync(join(tmpdir(), "junior-blocks-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "const a = 1;\n");
    const before = new Map([["src/a.ts", "const a = 1;\n"]]);
    const after = new Map([["src/a.ts", "const a = 2;\n"], ["src/new.ts", "export {};\n"]]);
    const diff = toUnifiedDiff(before, after);
    expect(diff).toContain("--- a/src/a.ts");
    expect(diff).toContain("+++ b/src/new.ts");
    writeFileSync(join(repo, "p.patch"), diff);
    const check = spawnSync("git", ["apply", "--check", "p.patch"], { cwd: repo, encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  test("no change -> empty string", () => {
    const m = new Map([["a", "x\n"]]);
    expect(toUnifiedDiff(m, new Map(m))).toBe("");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && bun test test/bun/junior-blocks.test.ts`
Expected: FAIL — `Cannot find module .../skills/junior/src/blocks`.

- [ ] **Step 3: Implement**

```ts
// skills/junior/src/blocks.ts
// Edit blocks the junior model returns, validated before the senior sees them.
// Every SEARCH must match exactly once; a miss is an error, never a guess.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface EditBlock { path: string; search: string; replace: string }
export type ApplyResult = { ok: true; after: Map<string, string> } | { ok: false; error: string };

const BLOCK_RE = /^([^\n]*)\n<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/gm;
const FENCE_RE = /^```[\w-]*\s*$/gm;

function cleanPath(raw: string): string {
  return raw.trim().replace(/^(file|path)\s*:\s*/i, "").replace(/^[*`"']+|[*`"':]+$/g, "").trim();
}

export function parseBlocks(text: string): EditBlock[] {
  const body = text.replace(/\r\n/g, "\n").replace(FENCE_RE, "");
  const out: EditBlock[] = [];
  for (const m of body.matchAll(BLOCK_RE)) {
    out.push({ path: cleanPath(m[1]), search: m[2], replace: m[3] });
  }
  return out;
}

function outsideRepo(path: string): boolean {
  return path.startsWith("/") || path.split("/").some((seg) => seg === "..");
}

function count(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function applyBlocks(
  before: Map<string, string>, blocks: EditBlock[], existsOnDisk: (path: string) => boolean,
): ApplyResult {
  if (blocks.length === 0) return { ok: false, error: "no edit blocks found in output" };
  const after = new Map(before);
  for (const [i, b] of blocks.entries()) {
    const n = i + 1;
    if (outsideRepo(b.path)) return { ok: false, error: `block ${n}: path ${b.path} is outside the repository` };
    if (b.search === "") {
      if (before.has(b.path) || after.has(b.path) || existsOnDisk(b.path)) {
        return { ok: false, error: `block ${n} (${b.path}): empty SEARCH creates a file, but ${b.path} already exists` };
      }
      after.set(b.path, b.replace.endsWith("\n") ? b.replace : `${b.replace}\n`);
      continue;
    }
    const cur = after.get(b.path);
    if (cur === undefined) return { ok: false, error: `block ${n} names ${b.path}, which was not given as input` };
    const crlf = cur.includes("\r\n");
    const search = crlf ? b.search.replace(/\n/g, "\r\n") : b.search;
    const replace = crlf ? b.replace.replace(/\n/g, "\r\n") : b.replace;
    const c = count(cur, search);
    if (c !== 1) return { ok: false, error: `block ${n} (${b.path}): SEARCH matched ${c} times, must match exactly once` };
    const at = cur.indexOf(search);
    after.set(b.path, cur.slice(0, at) + replace + cur.slice(at + search.length));
  }
  return { ok: true, after };
}

function fixHeader(line: string): string {
  if (line.startsWith("diff --git ")) return line.replace(" a/a/", " a/").replace(" b/b/", " b/");
  if (line.startsWith("--- a/a/")) return `--- a/${line.slice(8)}`;
  if (line.startsWith("+++ b/b/")) return `+++ b/${line.slice(8)}`;
  return line;
}

export function toUnifiedDiff(before: Map<string, string>, after: Map<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "junior-diff-"));
  try {
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    const put = (side: string, path: string, content: string) => {
      const f = join(root, side, path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content);
    };
    for (const [p, c] of before) put("a", p, c);
    for (const [p, c] of after) put("b", p, c);
    const r = spawnSync("git", [
      "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
      "diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "a", "b",
    ], { cwd: root, encoding: "utf8" });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`);
    return r.stdout === "" ? "" : r.stdout.split("\n").map(fixHeader).join("\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/fleet && bun test test/bun/junior-blocks.test.ts`
Expected: all pass. If `git diff --no-index` header shape differs on this git version, print `diff` in the failing test, adjust `fixHeader` only.

- [ ] **Step 5: Commit**

```bash
git add skills/junior/src/blocks.ts apps/fleet/test/bun/junior-blocks.test.ts
git commit -m "feat(junior): edit-block parse, validate, unified diff"
```

---

### Task 2: Chat client — transports, normalize, retry/fallback policy

**Files:**
- Create: `skills/junior/src/client.ts`
- Test: `apps/fleet/test/bun/junior-client.test.ts`

**Interfaces:**
- Consumes: `Transport` type — defined HERE (auth.ts in Task 3 imports it).
- Produces:
  - `type Transport = { kind: "proxy"; url: string; spawnToken: string } | { kind: "direct"; base: string; accountId: string; token: () => Promise<string>; source: "api-token" | "wrangler" }`
  - `interface ChatMessage { role: "system" | "user" | "assistant"; content: string }`
  - `interface ChatResult { content: string; finish: string | null; usage: { in: number; out: number; neurons: number | null } }`
  - `class ApiError extends Error { code: number; httpStatus: number }`
  - `class AuthError extends Error`
  - `normalize(json: unknown): ChatResult`
  - `callOnce(t: Transport, req: { model: string; messages: ChatMessage[]; max_tokens: number }, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ChatResult>`
  - `callWithPolicy(o: PolicyOpts): Promise<{ result: ChatResult; model: string; calls: number }>`
  - `const GLM = "@cf/zai-org/glm-5.3"`, `const DEEPSEEK = "@cf/deepseek-ai/deepseek-v4-pro-0813"`, `const MAX_TOKENS_CAP = 128_000`

- [ ] **Step 1: Write failing tests**

```ts
// apps/fleet/test/bun/junior-client.test.ts
import { describe, expect, test } from "bun:test";
import {
  ApiError, AuthError, callOnce, callWithPolicy, normalize, GLM, DEEPSEEK, type Transport,
} from "../../../../skills/junior/src/client";

const direct: Transport = { kind: "direct", base: "https://x/v4", accountId: "acct", token: async () => "tok", source: "api-token" };
const proxy: Transport = { kind: "proxy", url: "https://w", spawnToken: "s".repeat(43) };
const ok = (content: string, finish = "stop") =>
  ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 4, neurons: 5 } });
const cfErr = (code: number, message: string) => ({ success: false, errors: [{ code, message }] });

type Reply = { status?: number; json?: unknown; text?: string };
function fakeFetch(replies: Reply[]) {
  const seen: { url: string; body: any; headers: Headers }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const noSleep = async () => {};
const msgs = [{ role: "user" as const, content: "hi" }];

describe("normalize", () => {
  test("OpenAI shape", () => {
    expect(normalize(ok("hey"))).toEqual({ content: "hey", finish: "stop", usage: { in: 3, out: 4, neurons: 5 } });
  });
  test("already-normalized proxy shape passes through", () => {
    const n = { content: "c", finish: "length", usage: { in: 1, out: 2, neurons: null } };
    expect(normalize(n)).toEqual(n);
  });
  test("null content -> empty string", () => {
    expect(normalize({ choices: [{ message: { content: null }, finish_reason: "length" }] }).content).toBe("");
  });
});

describe("callOnce direct transport", () => {
  test("posts OpenAI-compat request with bearer token", async () => {
    const { f, seen } = fakeFetch([{ json: ok("a") }]);
    await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 10 }, f);
    expect(seen[0].url).toBe("https://x/v4/accounts/acct/ai/v1/chat/completions");
    expect(seen[0].headers.get("authorization")).toBe("Bearer tok");
    expect(seen[0].body).toEqual({ model: GLM, messages: msgs, max_tokens: 10 });
  });
  test("Cloudflare error envelope -> ApiError with code", async () => {
    const { f } = fakeFetch([{ status: 500, json: cfErr(3046, "AiError: Request timeout") }]);
    const e = await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 10 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe(3046);
  });
  test("10000 auth error -> AuthError", async () => {
    const { f } = fakeFetch([{ status: 401, json: cfErr(10000, "Authentication error") }]);
    expect(await callOnce(direct, { model: GLM, messages: msgs, max_tokens: 1 }, f).catch((x) => x)).toBeInstanceOf(AuthError);
  });
});

describe("callOnce proxy transport", () => {
  test("posts to /fleet/junior with spawn token, parses padded JSON", async () => {
    const { f, seen } = fakeFetch([{ text: "      " + JSON.stringify({ content: "c", finish: "stop", usage: { in: 1, out: 1, neurons: null } }) }]);
    const r = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f);
    expect(r.content).toBe("c");
    expect(seen[0].url).toBe("https://w/fleet/junior");
    expect(seen[0].headers.get("x-fleet-spawn-token")).toBe("s".repeat(43));
  });
  test("plain-text 404 -> AuthError 'junior not enabled for this repo'", async () => {
    const { f } = fakeFetch([{ status: 404, text: "not found" }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain("junior not enabled for this repo");
  });
  test("plain-text 403 -> AuthError naming the maestro gate", async () => {
    const { f } = fakeFetch([{ status: 403, text: "junior not authorized for your current task" }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain("fleet task new --junior");
  });
  test("plain-text 401 -> AuthError unauthorized", async () => {
    const { f } = fakeFetch([{ status: 401, text: "unauthorized" }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toContain("unauthorized");
  });
  test("error body from Worker -> ApiError", async () => {
    const { f } = fakeFetch([{ text: "  " + JSON.stringify({ error: { code: 3040, message: "out of capacity" } }) }]);
    const e = await callOnce(proxy, { model: GLM, messages: msgs, max_tokens: 5 }, f).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe(3040);
  });
});

describe("callWithPolicy", () => {
  const run = (replies: Reply[]) => {
    const { f, seen } = fakeFetch(replies);
    const p = callWithPolicy({ transport: direct, models: [GLM, DEEPSEEK], messages: msgs, maxTokens: 64000, fetchImpl: f, sleep: noSleep });
    return { p, seen };
  };

  test("first success returns", async () => {
    const { p } = run([{ json: ok("done") }]);
    expect(await p).toMatchObject({ model: GLM, calls: 1, result: { content: "done" } });
  });
  test("3046 retries once on same model, then falls back", async () => {
    const { p, seen } = run([
      { status: 500, json: cfErr(3046, "timeout") }, { status: 500, json: cfErr(3046, "timeout") }, { json: ok("ds") },
    ]);
    expect(await p).toMatchObject({ model: DEEPSEEK, calls: 3 });
    expect(seen.map((s) => s.body.model)).toEqual([GLM, GLM, DEEPSEEK]);
  });
  test("3040 capacity retried once then succeeds", async () => {
    const { p } = run([{ status: 500, json: cfErr(3040, "capacity") }, { json: ok("ok") }]);
    expect(await p).toMatchObject({ model: GLM, calls: 2 });
  });
  test("finish=length retries once with double budget", async () => {
    const { p, seen } = run([{ json: ok("", "length") }, { json: ok("full") }]);
    expect((await p).result.content).toBe("full");
    expect(seen.map((s) => s.body.max_tokens)).toEqual([64000, 128000]);
  });
  test("length budget never exceeds cap", async () => {
    const { f, seen } = fakeFetch([{ json: ok("", "length") }, { json: ok("x") }]);
    await callWithPolicy({ transport: direct, models: [GLM], messages: msgs, maxTokens: 100000, fetchImpl: f, sleep: noSleep });
    expect(seen[1].body.max_tokens).toBe(128000);
  });
  test("empty output falls back", async () => {
    const { p } = run([{ json: ok("   ") }, { json: ok("ds") }]);
    expect(await p).toMatchObject({ model: DEEPSEEK });
  });
  test("429 backs off 10s then 20s, then fails", async () => {
    const waits: number[] = [];
    const { f } = fakeFetch([{ status: 429, json: cfErr(429, "rate limited") }, { status: 429, json: cfErr(429, "rate limited") }, { status: 429, json: cfErr(429, "rate limited") }]);
    const e = await callWithPolicy({ transport: direct, models: [GLM, DEEPSEEK], messages: msgs, maxTokens: 1, fetchImpl: f, sleep: async (ms) => { waits.push(ms); } }).catch((x) => x);
    expect(waits).toEqual([10000, 20000]);
    expect(e).toBeInstanceOf(ApiError);
  });
  test("auth error is not retried", async () => {
    const { p, seen } = run([{ status: 401, json: cfErr(10000, "Authentication error") }]);
    expect(await p.catch((x) => x)).toBeInstanceOf(AuthError);
    expect(seen.length).toBe(1);
  });
  test("all models failing -> ApiError naming the last failure", async () => {
    const { p } = run([{ json: ok("") }, { json: ok("") }]);
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toContain("all models failed");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && bun test test/bun/junior-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// skills/junior/src/client.ts
// One chat call to Workers AI, plus the retry/fallback policy measured in the
// 2026-09-28 replay eval (docs/superpowers/specs/2026-09-28-junior-workers-ai-design.md).

export const GLM = "@cf/zai-org/glm-5.3";
export const DEEPSEEK = "@cf/deepseek-ai/deepseek-v4-pro-0813";
export const MAX_TOKENS_CAP = 128_000;

export type Transport =
  | { kind: "proxy"; url: string; spawnToken: string }
  | { kind: "direct"; base: string; accountId: string; token: () => Promise<string>; source: "api-token" | "wrangler" };

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatRequest { model: string; messages: ChatMessage[]; max_tokens: number }
export interface ChatResult { content: string; finish: string | null; usage: { in: number; out: number; neurons: number | null } }

export class ApiError extends Error {
  constructor(readonly code: number, message: string, readonly httpStatus = 0) { super(message); }
}
export class AuthError extends Error {}

// deno-lint-ignore no-explicit-any
type Json = any;

export function normalize(json: Json): ChatResult {
  if (json && typeof json.content === "string" && !("choices" in json)) {
    return { content: json.content, finish: json.finish ?? null, usage: json.usage ?? { in: 0, out: 0, neurons: null } };
  }
  const c = json?.choices?.[0] ?? {};
  return {
    content: typeof c.message?.content === "string" ? c.message.content : "",
    finish: c.finish_reason ?? null,
    usage: {
      in: json?.usage?.prompt_tokens ?? 0,
      out: json?.usage?.completion_tokens ?? 0,
      neurons: json?.usage?.neurons ?? null,
    },
  };
}

function parseLoose(text: string): Json | undefined {
  try { return JSON.parse(text.trim()); } catch { return undefined; }
}

export async function callOnce(
  t: Transport, req: ChatRequest, fetchImpl: typeof fetch, signal?: AbortSignal,
): Promise<ChatResult> {
  const url = t.kind === "proxy" ? `${t.url}/fleet/junior` : `${t.base}/accounts/${t.accountId}/ai/v1/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (t.kind === "proxy") headers["X-Fleet-Spawn-Token"] = t.spawnToken;
  else headers.authorization = `Bearer ${await t.token()}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(req), signal });
  const text = await res.text();
  const json = parseLoose(text);
  if (json === undefined) {
    if (res.status === 404 && t.kind === "proxy") throw new AuthError("junior not enabled for this repo (FLEET_JUNIOR / JUNIOR_REPOS)");
    if (res.status === 403 && t.kind === "proxy") {
      throw new AuthError("junior not authorized for your current task: only the maestro enables it, by filing the task with `fleet task new --junior`");
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(`unauthorized (HTTP ${res.status})`);
    throw new ApiError(0, `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  const err = json.error ?? (json.success === false ? json.errors?.[0] : undefined);
  if (err || !res.ok) {
    const code = Number(err?.code ?? res.status);
    const message = String(err?.message ?? `HTTP ${res.status}`);
    if (code === 10000 || res.status === 401 || res.status === 403) throw new AuthError(message);
    throw new ApiError(code, message, res.status);
  }
  return normalize(json);
}

type Kind = "retry" | "rate" | "other";
function classify(e: ApiError): Kind {
  if (e.code === 3046 || e.code === 3040 || /timeout|capacity/i.test(e.message)) return "retry";
  if (e.code === 429 || e.httpStatus === 429 || /rate limit|too many requests/i.test(e.message)) return "rate";
  return "other";
}

export interface PolicyOpts {
  transport: Transport;
  models: string[];
  messages: ChatMessage[];
  maxTokens: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export async function callWithPolicy(o: PolicyOpts): Promise<{ result: ChatResult; model: string; calls: number }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let calls = 0;
  let last = "no model tried";
  for (const model of o.models) {
    let budget = o.maxTokens;
    let retried = false;
    let grown = false;
    let rateWaits = 0;
    while (true) {
      calls++;
      let r: ChatResult;
      try {
        r = await callOnce(o.transport, { model, messages: o.messages, max_tokens: budget }, fetchImpl, o.signal);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        last = `${model}: ${e.message}`;
        const k = classify(e);
        if (k === "rate") {
          if (rateWaits < 2) { rateWaits++; await sleep(10_000 * rateWaits); continue; }
          throw new ApiError(429, `rate limited: ${last}`, 429);
        }
        if (k === "retry" && !retried) { retried = true; continue; }
        break;
      }
      if (r.finish === "length" && !grown && budget < MAX_TOKENS_CAP) {
        grown = true;
        budget = Math.min(budget * 2, MAX_TOKENS_CAP);
        continue;
      }
      if (r.content.trim() === "") { last = `${model}: empty output (finish=${r.finish})`; break; }
      return { result: r, model, calls };
    }
  }
  throw new ApiError(0, `all models failed; last: ${last}`);
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/fleet && bun test test/bun/junior-client.test.ts`

- [ ] **Step 5: Commit**

```bash
git add skills/junior/src/client.ts apps/fleet/test/bun/junior-client.test.ts
git commit -m "feat(junior): chat client, transports, retry/fallback policy"
```

---

### Task 3: Transport selection (auth)

**Files:**
- Create: `skills/junior/src/auth.ts`
- Test: `apps/fleet/test/bun/junior-auth.test.ts`

**Interfaces:**
- Consumes: `Transport`, `AuthError` from `client.ts`.
- Produces:
  - `juniorConfigPath(home: string): string` → `${home}/.config/fleet/junior.json`
  - `interface JuniorConfig { accountId?: string }`
  - `resolveTransport(env: Record<string, string | undefined>, deps: { readConfig: () => JuniorConfig | null; wranglerToken: (accountId: string) => Promise<string> }): Transport`
  - `defaultAuthDeps(env): { readConfig; wranglerToken }` (real fs + `wrangler auth token`)

- [ ] **Step 1: Write failing tests**

```ts
// apps/fleet/test/bun/junior-auth.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTransport, juniorConfigPath } from "../../../../skills/junior/src/auth";
import { AuthError } from "../../../../skills/junior/src/client";

const deps = (cfg: { accountId?: string } | null = null, tok = "wr-tok") => ({
  readConfig: () => cfg,
  wranglerToken: async () => tok,
});

describe("resolveTransport", () => {
  test("studio env -> proxy, even when an API token is also set", () => {
    const t = resolveTransport({ FLEET_WORKER_URL: "https://w", FLEET_SPAWN_TOKEN: "s", CLOUDFLARE_API_TOKEN: "x" }, deps());
    expect(t).toEqual({ kind: "proxy", url: "https://w", spawnToken: "s" });
  });
  test("API token + account env -> direct api-token", async () => {
    const t = resolveTransport({ CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "a" }, deps());
    expect(t).toMatchObject({ kind: "direct", accountId: "a", source: "api-token", base: "https://api.cloudflare.com/client/v4" });
    if (t.kind === "direct") expect(await t.token()).toBe("x");
  });
  test("no API token -> wrangler, token fetched per call", async () => {
    let n = 0;
    const t = resolveTransport({}, { readConfig: () => ({ accountId: "cfg" }), wranglerToken: async () => `t${++n}` });
    expect(t).toMatchObject({ kind: "direct", accountId: "cfg", source: "wrangler" });
    if (t.kind === "direct") { expect(await t.token()).toBe("t1"); expect(await t.token()).toBe("t2"); }
  });
  test("env account beats config account", () => {
    const t = resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "env" }, deps({ accountId: "cfg" }));
    expect(t.kind === "direct" && t.accountId).toBe("env");
  });
  test("JUNIOR_API_BASE overrides base", () => {
    const t = resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "a", JUNIOR_API_BASE: "http://127.0.0.1:9" }, deps());
    expect(t.kind === "direct" && t.base).toBe("http://127.0.0.1:9");
  });
  test("no account anywhere -> AuthError telling how to fix", () => {
    expect(() => resolveTransport({}, deps())).toThrow(AuthError);
    expect(() => resolveTransport({}, deps())).toThrow("fleet junior enable --account <id>");
  });
});

test("config path", () => {
  expect(juniorConfigPath("/h")).toBe("/h/.config/fleet/junior.json");
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && bun test test/bun/junior-auth.test.ts`

- [ ] **Step 3: Implement**

```ts
// skills/junior/src/auth.ts
// Which road a junior call takes. Inside a studio: the fleet Worker proxy (the
// container holds no Cloudflare credential, by house rule). On a laptop: an
// API token if one is set, else a fresh `wrangler auth token` per call — the
// wrangler OAuth token expires after about an hour, so it is never cached.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AuthError, type Transport } from "./client";

export interface JuniorConfig { accountId?: string }
export const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

export function juniorConfigPath(home: string): string {
  return join(home, ".config", "fleet", "junior.json");
}

export function resolveTransport(
  env: Record<string, string | undefined>,
  deps: { readConfig: () => JuniorConfig | null; wranglerToken: (accountId: string) => Promise<string> },
): Transport {
  if (env.FLEET_WORKER_URL && env.FLEET_SPAWN_TOKEN) {
    return { kind: "proxy", url: env.FLEET_WORKER_URL, spawnToken: env.FLEET_SPAWN_TOKEN };
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || deps.readConfig()?.accountId;
  if (!accountId) {
    throw new AuthError("no Cloudflare account id: set CLOUDFLARE_ACCOUNT_ID or run `fleet junior enable --account <id>`");
  }
  const base = env.JUNIOR_API_BASE || DEFAULT_API_BASE;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (apiToken) return { kind: "direct", base, accountId, token: async () => apiToken, source: "api-token" };
  return { kind: "direct", base, accountId, token: () => deps.wranglerToken(accountId), source: "wrangler" };
}

export function defaultAuthDeps(env: Record<string, string | undefined>) {
  return {
    readConfig: (): JuniorConfig | null => {
      const p = juniorConfigPath(env.HOME ?? "");
      if (!existsSync(p)) return null;
      try { return JSON.parse(readFileSync(p, "utf8")) as JuniorConfig; } catch { return null; }
    },
    wranglerToken: async (accountId: string): Promise<string> => {
      const r = spawnSync("wrangler", ["auth", "token"], {
        encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      });
      const tok = (r.stdout ?? "").trim().split("\n").filter((l) => l.trim() !== "").pop()?.trim();
      if (r.status !== 0 || !tok || /\s/.test(tok)) {
        throw new AuthError("`wrangler auth token` failed: run `wrangler login`, or set CLOUDFLARE_API_TOKEN");
      }
      return tok;
    },
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd apps/fleet && bun test test/bun/junior-auth.test.ts`

- [ ] **Step 5: Commit**

```bash
git add skills/junior/src/auth.ts apps/fleet/test/bun/junior-auth.test.ts
git commit -m "feat(junior): transport selection — proxy, api token, wrangler"
```

---

### Task 4: Wrapper CLI + skill doc

**Files:**
- Create: `skills/junior/src/main.ts`, `skills/junior/junior.sh` (mode 755), `skills/junior/SKILL.md`
- Modify: `apps/fleet/test/bun/vendored-skills.test.ts` (add junior block)
- Test: `apps/fleet/test/bun/junior-cli.test.ts`

**Interfaces:**
- Consumes: `parseBlocks`, `applyBlocks`, `toUnifiedDiff` (Task 1); `callWithPolicy`, `GLM`, `DEEPSEEK`, `ApiError`, `AuthError`, `ChatMessage` (Task 2); `resolveTransport`, `defaultAuthDeps` (Task 3).
- Produces: `main(argv: string[], env: Record<string, string | undefined>, cwd: string): Promise<number>`; exit codes `EXIT = { OK: 0, USAGE: 2, API: 3, INVALID: 4, TIMEOUT: 5, AUTH: 6 }`.

- [ ] **Step 1: Write failing tests**

```ts
// apps/fleet/test/bun/junior-cli.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SH = join(import.meta.dir, "../../../../skills/junior/junior.sh");
let replies: Array<{ content: string; finish?: string; delayMs?: number }> = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      const r = replies.shift() ?? { content: "" };
      if (r.delayMs) await Bun.sleep(r.delayMs);
      return Response.json({
        choices: [{ message: { content: r.content }, finish_reason: r.finish ?? "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, neurons: 10 },
      });
    },
  });
});
afterAll(() => server.stop(true));

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "junior-cli-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}
async function run(dir: string, args: string[]) {
  const p = Bun.spawn(["bash", SH, ...args], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: dir, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", JUNIOR_API_BASE: `http://127.0.0.1:${server.port}` },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
const block = (path: string, s: string, r: string) => `${path}\n<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

describe("junior.sh", () => {
  test("edit mode prints an applicable diff, saves patch, prints telemetry", async () => {
    const dir = repo({ "a.ts": "const a = 1;\n" });
    replies = [{ content: block("a.ts", "const a = 1;", "const a = 2;") }];
    const r = await run(dir, ["--task", "bump a", "a.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("+const a = 2;");
    expect(r.err).toMatch(/^junior: model=glm-5\.3 secs=\d+ in=100 out=50 \$0\.0001 calls=1 status=ok$/m);
    writeFileSync(join(dir, "x.patch"), r.out);
    expect(spawnSync("git", ["apply", "--check", "x.patch"], { cwd: dir }).status).toBe(0);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const a = 1;\n");
    expect(readdirSync(join(dir, ".junior")).some((f) => f.endsWith(".patch"))).toBe(true);
    expect(readFileSync(join(dir, ".junior/.gitignore"), "utf8")).toBe("*\n");
  });

  test("bad SEARCH gets one repair turn", async () => {
    const dir = repo({ "a.ts": "const a = 1;\n" });
    replies = [{ content: block("a.ts", "nope", "x") }, { content: block("a.ts", "const a = 1;", "const a = 3;") }];
    const r = await run(dir, ["--task", "t", "a.ts"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("+const a = 3;");
  });

  test("repair also failing -> exit 4 with raw output on stderr", async () => {
    const dir = repo({ "a.ts": "const a = 1;\n" });
    replies = [{ content: block("a.ts", "nope", "x") }, { content: block("a.ts", "still nope", "x") }];
    const r = await run(dir, ["--task", "t", "a.ts"]);
    expect(r.code).toBe(4);
    expect(r.err).toContain("SEARCH matched 0 times");
    expect(r.err).toContain("still nope");
  });

  test("text mode prints content, no validation", async () => {
    const dir = repo({ "log.txt": "boom\n" });
    replies = [{ content: "The log shows one failure." }];
    const r = await run(dir, ["--mode", "text", "--task", "summarize", "log.txt"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("The log shows one failure.");
    expect(existsSync(join(dir, ".junior"))).toBe(false);
  });

  test("input over cap -> exit 2 before any call", async () => {
    const dir = repo({ "big.txt": "x".repeat(800_004) });
    replies = [];
    const r = await run(dir, ["--task", "t", "big.txt"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("split the task");
  });

  test("missing --task -> exit 2 usage", async () => {
    const r = await run(repo({}), ["a.ts"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: junior.sh");
  });

  test("missing input file -> exit 2", async () => {
    const r = await run(repo({}), ["--task", "t", "nope.ts"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("nope.ts");
  });

  test("wall timeout -> exit 5", async () => {
    const dir = repo({ "a.ts": "x\n" });
    replies = [{ content: "late", delayMs: 3000 }];
    const r = await run(dir, ["--timeout", "1", "--task", "t", "a.ts"]);
    expect(r.code).toBe(5);
  });

  test("--model deepseek puts deepseek first", async () => {
    const dir = repo({ "a.ts": "x\n" });
    replies = [{ content: "ok" }];
    const r = await run(dir, ["--mode", "text", "--model", "deepseek", "--task", "t", "a.ts"]);
    expect(r.err).toContain("model=deepseek-v4-pro-0813");
  });
});
```

Add to `apps/fleet/test/bun/vendored-skills.test.ts` (copy its i-have-adhd block shape):

```ts
describe("vendored skills/junior", () => {
  test("SKILL.md exists and names junior", () => {
    const md = readFileSync(join(SKILLS, "junior", "SKILL.md"), "utf8");
    const frontmatter = md.split("---")[1] ?? "";
    expect(/^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()).toBe("junior");
  });
  test("junior.sh is executable", () => {
    expect(statSync(join(SKILLS, "junior", "junior.sh")).mode & 0o111).not.toBe(0);
  });
});
```
(add `statSync` to that file's `node:fs` import.)

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && bun test test/bun/junior-cli.test.ts test/bun/vendored-skills.test.ts`
Expected: FAIL — `junior.sh` missing.

- [ ] **Step 3: Implement shim**

```bash
#!/usr/bin/env bash
# junior.sh — delegate a mechanical edit to a Workers AI model. See SKILL.md.
set -euo pipefail
exec bun "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src/main.ts" "$@"
```
Then `chmod 755 skills/junior/junior.sh`.

- [ ] **Step 4: Implement main.ts**

```ts
// skills/junior/src/main.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyBlocks, parseBlocks, toUnifiedDiff } from "./blocks";
import { ApiError, AuthError, callWithPolicy, DEEPSEEK, GLM, type ChatMessage, type ChatResult } from "./client";
import { defaultAuthDeps, resolveTransport } from "./auth";

export const EXIT = { OK: 0, USAGE: 2, API: 3, INVALID: 4, TIMEOUT: 5, AUTH: 6 } as const;
export const DEFAULT_MAX_TOKENS = 64_000;
export const INPUT_CAP_TOKENS = 200_000;
const USAGE = "usage: junior.sh --task \"<instruction>\" [--mode edit|text] [--model glm|deepseek] [--timeout <s>] file...";

export const SYSTEM_EDIT = `You are a careful junior engineer. A senior engineer reviews every change you propose.
Make exactly the change the task asks for. Nothing more: no unrelated edits, no reformatting, no renames the task did not ask for.
Output ONLY edit blocks, nothing else. Each block is:

path/to/file
<<<<<<< SEARCH
exact lines copied from the file
=======
replacement lines
>>>>>>> REPLACE

SEARCH must match the file exactly, including indentation, and must be unique in that file.
Keep SEARCH small: just enough lines to be unique.
To create a new file, leave SEARCH empty.`;

export const SYSTEM_TEXT = `You are a careful junior engineer. A senior engineer reviews your answer.
Answer the task directly and concisely. Do not invent facts that are not in the provided files.`;

interface Args { task: string; mode: "edit" | "text"; model: "glm" | "deepseek"; timeoutS: number; files: string[] }

function parseArgs(argv: string[]): Args | string {
  const a: Args = { task: "", mode: "edit", model: "glm", timeoutS: 300, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => argv[++i] ?? "";
    if (t === "--task") a.task = val();
    else if (t === "--mode") { const v = val(); if (v !== "edit" && v !== "text") return `bad --mode ${v}`; a.mode = v; }
    else if (t === "--model") { const v = val(); if (v !== "glm" && v !== "deepseek") return `bad --model ${v}`; a.model = v; }
    else if (t === "--timeout") { const n = Number(val()); if (!(n > 0)) return "bad --timeout"; a.timeoutS = n; }
    else if (t.startsWith("--")) return `unknown flag ${t}`;
    else a.files.push(t);
  }
  return a.task.trim() === "" ? "missing --task" : a;
}

function userPrompt(task: string, files: Map<string, string>): string {
  let s = `Task:\n${task}\n`;
  for (const [p, c] of files) s += `\nFile: ${p}\n\`\`\`\n${c}${c.endsWith("\n") ? "" : "\n"}\`\`\`\n`;
  return s;
}

function k(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function telemetry(model: string, startMs: number, r: ChatResult | null, calls: number, status: string): string {
  const secs = Math.round((Date.now() - startMs) / 1000);
  const cost = r?.usage.neurons != null ? `$${(r.usage.neurons * 0.011 / 1000).toFixed(4)}` : "$?";
  return `junior: model=${model.split("/").pop()} secs=${secs} in=${k(r?.usage.in ?? 0)} out=${k(r?.usage.out ?? 0)} ${cost} calls=${calls} status=${status}`;
}

export async function main(argv: string[], env: Record<string, string | undefined>, cwd: string): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") { console.error(`${args}\n${USAGE}`); return EXIT.USAGE; }

  const files = new Map<string, string>();
  for (const f of args.files) {
    const p = join(cwd, f);
    if (!existsSync(p)) { console.error(`junior: input file not found: ${f}`); return EXIT.USAGE; }
    files.set(f, readFileSync(p, "utf8"));
  }
  const chars = args.task.length + [...files.values()].reduce((n, c) => n + c.length, 0);
  if (chars / 4 > INPUT_CAP_TOKENS) {
    console.error(`junior: input too large (~${Math.round(chars / 4)} tokens > ${INPUT_CAP_TOKENS}); split the task`);
    return EXIT.USAGE;
  }

  const models = args.model === "glm" ? [GLM, DEEPSEEK] : [DEEPSEEK, GLM];
  const messages: ChatMessage[] = [
    { role: "system", content: args.mode === "edit" ? SYSTEM_EDIT : SYSTEM_TEXT },
    { role: "user", content: userPrompt(args.task, files) },
  ];
  const signal = AbortSignal.timeout(args.timeoutS * 1000);
  const start = Date.now();
  let calls = 0;
  let model = models[0];
  let last: ChatResult | null = null;

  try {
    const transport = resolveTransport(env, defaultAuthDeps(env));
    const first = await callWithPolicy({ transport, models, messages, maxTokens: DEFAULT_MAX_TOKENS, signal });
    calls += first.calls; model = first.model; last = first.result;

    if (args.mode === "text") {
      console.log(last.content.trim());
      console.error(telemetry(model, start, last, calls, "ok"));
      return EXIT.OK;
    }

    const exists = (p: string) => existsSync(join(cwd, p));
    let applied = applyBlocks(files, parseBlocks(last.content), exists);
    if (!applied.ok) {
      const repairMsgs: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: last.content },
        { role: "user", content: `Your edit blocks failed: ${applied.error}\nReply with the corrected complete set of edit blocks only.` },
      ];
      const orderedModels = [model, ...models.filter((m) => m !== model)];
      const second = await callWithPolicy({ transport, models: orderedModels, messages: repairMsgs, maxTokens: DEFAULT_MAX_TOKENS, signal });
      calls += second.calls; model = second.model; last = second.result;
      applied = applyBlocks(files, parseBlocks(last.content), exists);
    }
    if (!applied.ok) {
      console.error(`junior: invalid edit: ${applied.error}\n--- raw output ---\n${last.content}`);
      console.error(telemetry(model, start, last, calls, "invalid"));
      return EXIT.INVALID;
    }
    const diff = toUnifiedDiff(files, applied.after);
    if (diff === "") {
      console.error("junior: invalid edit: blocks produced no change");
      console.error(telemetry(model, start, last, calls, "invalid"));
      return EXIT.INVALID;
    }
    const dir = join(cwd, ".junior");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*\n");
    writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.patch`), diff);
    process.stdout.write(diff);
    console.error(telemetry(model, start, last, calls, "ok"));
    return EXIT.OK;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      console.error(`junior: timed out after ${args.timeoutS}s`);
      console.error(telemetry(model, start, last, calls, "timeout"));
      return EXIT.TIMEOUT;
    }
    if (e instanceof AuthError) { console.error(`junior: ${e.message}`); return EXIT.AUTH; }
    if (e instanceof ApiError) {
      console.error(`junior: ${e.message}`);
      console.error(telemetry(model, start, last, calls, "api-error"));
      return EXIT.API;
    }
    throw e;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), process.env, process.cwd()));
}
```

- [ ] **Step 5: Write SKILL.md**

````markdown
---
name: junior
description: Delegate mechanical, low-risk code edits or text chores to a Workers AI model (GLM-5.3) and review its diff before applying. Use for boilerplate, test scaffolds, renames, mechanical refactors, docstrings, log summaries, commit-message drafts. Never for auth, secrets, migrations, deploys or anything irreversible. You stay the senior and own every line that lands.
---

# Junior — Workers AI delegation

You are the senior. The junior is a Workers AI model with no tools. It cannot
read the repo, run commands or write files. It sees only the files you pass
and returns a proposed change. You review it, apply it, test it. You own it.

## When to delegate

- Boilerplate and test scaffolds from a clear pattern you name.
- Renames and mechanical refactors across the files you pass.
- Docstrings, comments, README tables.
- Summaries of long logs or test output (`--mode text`).
- Commit-message or PR-body drafts (`--mode text`).

## Never delegate

- Auth, secrets, credentials, permissions.
- Migrations, deploys, fleet state, anything irreversible.
- A change you could not fully review line by line.
- A task whose spec you cannot write precisely. A vague brief gets a vague diff.

## How

```bash
~/.claude/skills/junior/junior.sh --task "<precise instruction>" path/a.ts path/b.ts > /tmp/j.patch
git apply --check /tmp/j.patch && git diff --stat   # review
git apply /tmp/j.patch                              # only after reading every hunk
```

- `--mode text` for prose answers; no diff.
- `--model deepseek` to start on the fallback model.
- `--timeout <s>` (default 300).
- A call takes ~60s typically, up to ~3 min. Run it in the background and keep
  working; run several in parallel for independent files.
- stderr ends with one line: `junior: model=… secs=… in=… out=… $… calls=… status=…`.

## Exit codes

| code | meaning | your move |
|---|---|---|
| 0 | diff on stdout | review, apply, test |
| 2 | usage or input too large | fix args or split the task |
| 3 | API failed after retry + fallback | retry later or do it yourself |
| 4 | edit invalid after one repair turn | do it yourself |
| 5 | timed out | split the task or raise `--timeout` |
| 6 | auth / not enabled / not authorized | local: `fleet junior status`; studio: your task lacks the `junior` label — do the work yourself, never ask to bypass |

## In a studio: the maestro decides

You may call the junior only while working a task the maestro filed with
`fleet task new --junior` (the task carries label `junior`). The Worker checks
the board on every call and refuses otherwise. No label means the maestro chose
not to use a junior for this task — do the work yourself. Never ask anyone to
add the label; it is the maestro's call, made when it writes the task.

## Review contract

Junior output is untrusted input. Read every hunk. Reject anything outside the
task. Run the tests. If the diff is wrong, fix it or discard it — never apply
it to see what happens.
````

- [ ] **Step 6: Run, expect PASS**

Run: `cd apps/fleet && bun test test/bun/junior-cli.test.ts test/bun/vendored-skills.test.ts && bun scripts/english-check.ts ../../skills/junior`
Expected: all pass, english-check clean.

- [ ] **Step 7: Commit**

```bash
git add skills/junior apps/fleet/test/bun/junior-cli.test.ts apps/fleet/test/bun/vendored-skills.test.ts
git commit -m "feat(junior): wrapper CLI, repair turn, patch output, SKILL.md"
```

---

### Task 5: Maestro authorization — `junior` task label + maestro rulebook

**Files:**
- Modify: `apps/fleet/src/board/types.ts` (near `LIVE_TASK_STATES` ~line 31), `apps/fleet/src/board/brief.ts` (`TaskBrief` ~line 18, `parseBrief` after assignee ~line 123), `apps/fleet/src/board/board.ts` (`createTask` labels ~line 157; new helper after `resolveLatestAssignedBrief` ~line 900), `apps/fleet/src/studio/cli-args.ts` (`TaskBriefArgs` ~line 181, `parseTask` ~line 493, help text ~line 268), `apps/fleet/cli/task-format.ts` (`formatTaskTable` ~line 80, `formatTaskShow` ~line 122), `fleet/blueprint/studios/maestro/studio.md`
- Test: `apps/fleet/test/studio.cli-args.test.ts`, `apps/fleet/test/board.brief.test.ts`, `apps/fleet/test/board.board.test.ts`, `apps/fleet/test/cli.task-format.test.ts`, `apps/fleet/test/bun/junior-maestro-rule.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `export const JUNIOR_LABEL = "junior";`
  - `TaskBrief.junior?: boolean`, `TaskBriefArgs.junior?: true`
  - `board.ts`: `hasJuniorAuthorizedTask(api: BoardApi, repo: string, studioId: string): Promise<BoardResult<boolean>>`

- [ ] **Step 1: Write failing tests**

`test/studio.cli-args.test.ts` (reuse that file's shared `flags` array of required task-new flags):

```ts
  it("task new --junior is a bare boolean flag, anywhere after new", () => {
    const a = parseCliArgs(["task", "new", ...flags, "--junior"]);
    expect(a.cmd === "task-new" && a.brief.junior).toBe(true);
    const b = parseCliArgs(["task", "new", "--junior", ...flags]);
    expect(b.cmd === "task-new" && b.brief.junior).toBe(true);
    const c = parseCliArgs(["task", "new", ...flags]);
    expect(c.cmd === "task-new" && c.brief.junior).toBeUndefined();
    expect(parseCliArgs(["task", "ls", "--junior"]).cmd).toBe("usage");
  });
```

`test/board.brief.test.ts`:

```ts
  it("junior: true accepted, absent/false means not set, anything else is a 400", () => {
    const base = { title: "t", objective: "o", outputFormat: "f", boundaries: "b" };
    const ok = parseBrief({ ...base, junior: true });
    expect(ok.ok && ok.brief.junior).toBe(true);
    const off = parseBrief({ ...base, junior: false });
    expect(off.ok && off.brief.junior).toBeUndefined();
    const absent = parseBrief(base);
    expect(absent.ok && absent.brief.junior).toBeUndefined();
    expect(parseBrief({ ...base, junior: "yes" })).toEqual({ ok: false, message: "junior must be a boolean" });
  });
```

`test/board.board.test.ts` (reuse its `fakeApi()` and `task()` fixtures):

```ts
  it("createTask writes the junior label in the same single create call", async () => {
    const api = fakeApi();
    await createTask(api, "acme-org/websites", {
      title: "t", objective: "o", outputFormat: "f", boundaries: "b",
      assignee: "websites--web-studio", junior: true,
    });
    expect(vi.mocked(api.createIssue).mock.calls.length).toBe(1);
    expect(vi.mocked(api.createIssue).mock.calls[0][1].labels)
      .toEqual(["submitted", "studio:websites--web-studio", "junior"]);
  });

  describe("hasJuniorAuthorizedTask", () => {
    const S = "websites--web-studio";
    const withTasks = (tasks: BoardTask[]) => fakeApi({ listIssues: vi.fn(async () => tasks) });
    it("true for a live task assigned to the studio carrying junior", async () => {
      const api = withTasks([task({ state: "working", labels: ["working", studioLabel(S), "junior"], assignee: S })]);
      expect(await hasJuniorAuthorizedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: true });
    });
    it("false when the only junior task is completed", async () => {
      const api = withTasks([task({ state: "completed", open: false, labels: ["completed", studioLabel(S), "junior"], assignee: S })]);
      expect(await hasJuniorAuthorizedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: false });
    });
    it("false when the live task lacks junior", async () => {
      const api = withTasks([task({ state: "working", labels: ["working", studioLabel(S)], assignee: S })]);
      expect(await hasJuniorAuthorizedTask(api, "acme-org/websites", S)).toEqual({ ok: true, value: false });
    });
  });
```
(If `listIssues` filtering by label is done GitHub-side in `listTasks`, the fake returns whatever it is given; the helper must still check `assignee`/labels itself — keep the explicit `studioLabel(S)` check in the helper so a fake that ignores the filter cannot make the test pass for the wrong reason.)

`test/cli.task-format.test.ts` (reuse its task fixture):

```ts
  it("marks junior-authorized tasks in ls and show", () => {
    const t = { ...fixtureTask(), labels: [...fixtureTask().labels, "junior"] };
    expect(formatTaskTable([t])).toContain("[junior] ");
    expect(formatTaskShow({ task: t, comments: [] }).split("\n")[0]).toContain("junior: yes");
    expect(formatTaskShow({ task: fixtureTask(), comments: [] }).split("\n")[0]).not.toContain("junior");
  });
```
(`fixtureTask` = whatever that file names its BoardTask builder; use it.)

```ts
// apps/fleet/test/bun/junior-maestro-rule.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAESTRO = readFileSync(join(import.meta.dir, "../../../../fleet/blueprint/studios/maestro/studio.md"), "utf8");

test("maestro rulebook owns the junior decision", () => {
  expect(MAESTRO).toContain("## Junior — your call, per task");
  expect(MAESTRO).toContain("fleet task new");
  expect(MAESTRO).toContain("--junior");
  expect(MAESTRO).toContain("You never call the junior yourself");
});

test("maestro frontmatter does not list the junior skill", () => {
  const frontmatter = MAESTRO.split("---")[1] ?? "";
  expect(frontmatter).not.toMatch(/\bjunior\b/);
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && npx vitest run test/studio.cli-args.test.ts test/board.brief.test.ts test/board.board.test.ts test/cli.task-format.test.ts && bun test test/bun/junior-maestro-rule.test.ts`

- [ ] **Step 3: types.ts**

```ts
/** Junior (Workers AI delegation): a task carrying this label lets its
 *  assigned studio call /fleet/junior while the task is live. Written only by
 *  createTask, only when the maestro filed it with `fleet task new --junior`. */
export const JUNIOR_LABEL = "junior";
```

- [ ] **Step 4: brief.ts** — `TaskBrief` gains:

```ts
  /** Maestro's per-task authorization for the junior skill. Absent = not
   *  authorized. Becomes the `junior` label (types.ts JUNIOR_LABEL). */
  junior?: boolean;
```
In `parseBrief`, after the assignee block and before `const brief: TaskBrief = ...`:

```ts
  // Boolean only: a string "true" from a hand-rolled request is a caller bug,
  // and quietly treating it as yes would authorize a junior nobody chose.
  const rawJunior = body.junior;
  if (rawJunior !== undefined && rawJunior !== null && typeof rawJunior !== "boolean") {
    return { ok: false, message: "junior must be a boolean" };
  }
```
and build the brief as `{ title, objective, outputFormat, boundaries, milestone, assignee, ...(rawJunior === true ? { junior: true } : {}) }`.

- [ ] **Step 5: board.ts** — in `createTask`:

```ts
  const labels = brief.assignee === null ? [ENTRY_STATE] : [ENTRY_STATE, studioLabel(brief.assignee)];
  if (brief.junior === true) labels.push(JUNIOR_LABEL);
  const input: IssueInput = { title: brief.title, body: renderTaskBody(brief), labels };
```
Helper (next to `resolveLatestAssignedBrief`, same live-state rule):

```ts
/**
 * Junior gate: may `studioId` call /fleet/junior right now? Only while one of
 * its own tasks is live (LIVE_TASK_STATES, open, not drifted) and carries
 * JUNIOR_LABEL. The maestro sets that label when it files the task; nothing
 * else ever does. A board error is returned, never read as "yes".
 */
export async function hasJuniorAuthorizedTask(
  api: BoardApi, repo: string, studioId: string,
): Promise<BoardResult<boolean>> {
  const r = await listTasks(api, repo, { assignedTo: studioId });
  if (!r.ok) return r;
  const mine = studioLabel(studioId);
  return {
    ok: true,
    value: r.value.some((t) =>
      t.open && t.state !== null && LIVE_TASK_STATES.includes(t.state)
      && t.labels.includes(mine) && t.labels.includes(JUNIOR_LABEL)),
  };
}
```
Import `JUNIOR_LABEL`, `LIVE_TASK_STATES` from `./types` if not already.

- [ ] **Step 6: cli-args.ts** — `TaskBriefArgs` gains `junior?: true;`. In `parseTask`, before `parseFlags(rest, TASK_FLAGS[sub])`:

```ts
  // `--junior` is the one bare boolean on task new (parseFlags only takes
  // `--flag value` pairs). Pulled out first so it may sit anywhere; on any
  // other task verb it stays in and parseFlags rejects it as unexpected.
  const junior = sub === "new" && rest.includes("--junior");
  const flagArgs = junior ? rest.filter((a) => a !== "--junior") : rest;
  const parsed = parseFlags(flagArgs, TASK_FLAGS[sub]);
```
After building `brief`: `if (junior) brief.junior = true;`. In the `task new` help/summary text add: `--junior lets the assigned studio delegate mechanical parts to the junior skill (Workers AI) while this task is live — the maestro's call, off unless given`.

- [ ] **Step 7: task-format.ts**

In `formatTaskTable` title cell:

```ts
    truncate(`${t.labels.includes(JUNIOR_LABEL) ? "[junior] " : ""}${t.title.replace(/\s+/g, " ")}`, TITLE_WIDTH),
```
In `formatTaskShow` first line, append `${t.labels.includes(JUNIOR_LABEL) ? "  junior: yes" : ""}` after the open/closed cell. Import `JUNIOR_LABEL` from `../src/board/types`.

- [ ] **Step 8: Maestro rulebook** — append to `fleet/blueprint/studios/maestro/studio.md`, directly before the `## Supervision` heading:

```markdown
## Junior — your call, per task

Studios can hand mechanical work to a junior: a Workers AI model (GLM-5.3) reached through the fleet Worker. It proposes a diff. The studio reviews it, applies it, tests it, and owns every line. The junior has no tools and writes nothing on its own.

Whether a task gets a junior is your decision, and only yours. Say so when you file it: `fleet task new ... --junior`. That puts the `junior` label on the task. The Worker lets the assigned studio call the junior only while that task is live and labeled. No label, the Worker refuses — so a studio can never grant itself one. The operator's `FLEET_JUNIOR` flag sits above you as the master switch: with it off, `--junior` changes nothing. `fleet task ls` shows `[junior]` on the tasks you flagged.

Flag a task when it has clear mechanical parts: boilerplate, test scaffolds from a named pattern, renames across files, docstrings, README tables, summarizing long CI output. Name those parts in `--boundaries`: "junior may draft X; you own Y".

Never flag: auth, secrets, credentials, migrations, deploys, release or promotion work, fleet state, anything irreversible, or a task whose spec you cannot write precisely. A vague brief gets a vague diff.

Know what it buys. A junior call takes about a minute, up to three, and costs cents in Cloudflare credits. It saves Claude tokens, not wall time. Never flag a task just to make it go faster.

You never call the junior yourself. You write no code, and a junior diff is code.
```

- [ ] **Step 9: Run, expect PASS**

Run: `cd apps/fleet && npx vitest run test/studio.cli-args.test.ts test/board.brief.test.ts test/board.board.test.ts test/cli.task-format.test.ts test/board.fleet-routes.test.ts && bun test test/bun/junior-maestro-rule.test.ts test/bun/studio-skills-resolve.test.ts && bun scripts/english-check.ts ../../fleet/blueprint/studios/maestro/studio.md && npx tsc --noEmit -p . && npx tsc --noEmit -p cli`

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/board apps/fleet/src/studio/cli-args.ts apps/fleet/cli/task-format.ts fleet/blueprint/studios/maestro/studio.md apps/fleet/test
git commit -m "feat(junior): maestro authorizes per task — fleet task new --junior, junior label, rulebook"
```

---

### Task 6: Worker proxy `POST /fleet/junior` + flags

**Files:**
- Create: `apps/fleet/src/junior/gate.ts`, `apps/fleet/src/junior/route.ts`
- Modify: `apps/fleet/src/env.ts` (near `FLEET_DIRECTUS`, line ~33), `apps/fleet/src/index.ts` (before `/fleet/tasks` mount, line ~55), `apps/fleet/wrangler.example.jsonc` (vars block ~line 97), `README.md` (flag table ~line 73-85)
- Test: `apps/fleet/test/junior.route.test.ts`

**Interfaces:**
- Consumes: `hasJuniorAuthorizedTask` (Task 5, `src/board/board.ts`); `githubBoardApi`, `resolveStudioBoardRepo` (`src/board/routes.ts:68`, `:704`); `BoardApi` type; `isSpawnTokenShaped`, `resolveSpawnParent`, `SPAWN_TOKEN_HEADER` (`src/studio/spawn.ts`); `listStudios` (`src/studio/registry.ts`); `parseInstallCacheRepos` (`src/studio/install-cache.ts:110`); `hashSpawnToken`, `mintSpawnToken` (`src/studio/org.ts`, tests only).
- Produces:
  - `gate.ts`: `JUNIOR_MODELS: readonly string[]`, `juniorEnabled(env: Pick<Env, "FLEET_JUNIOR" | "JUNIOR_REPOS">, workRepoSlug: string | undefined): boolean`, `JUNIOR_HOUSE_RULE: string`
  - `route.ts`: `handleFleetJunior(req: Request, env: Env, api?: BoardApi, rows?: () => Promise<StudioStatus[]>, heartbeatMs?: number): Promise<Response>`, `normalizeAiResult(r: unknown)`, `JUNIOR_BODY_CAP = 2 * 1024 * 1024`
  - `env.ts`: `FLEET_JUNIOR?: string; JUNIOR_REPOS?: string; AI?: { run(model: string, input: unknown): Promise<unknown> }`

- [ ] **Step 1: Write failing tests**

```ts
// apps/fleet/test/junior.route.test.ts
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleFleetJunior, normalizeAiResult } from "../src/junior/route";
import { juniorEnabled } from "../src/junior/gate";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import type { BoardApi } from "../src/board/board";
import { studioLabel, type BoardTask } from "../src/board/types";

const REPO = "acme-org/websites";
const ME = "websites--web-studio";
function boardTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return { number: 7, url: "https://github.com/acme-org/websites/issues/7", title: "t", body: "b",
    state: "working", labels: ["working", studioLabel(ME), "junior"], assignee: ME, milestone: null,
    open: true, updatedAt: "2026-09-28T00:00:00Z", ...overrides };
}
function board(tasks: BoardTask[] | Error = [boardTask()]): BoardApi {
  const listIssues = vi.fn(async () => { if (tasks instanceof Error) throw tasks; return tasks; });
  return { listIssues } as unknown as BoardApi;
}
function row(id: string, hash: string, repoSlug: string | null = REPO): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug };
}
async function setup(overrides: Partial<Env> = {}, aiResult: unknown = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) {
  const token = mintSpawnToken();
  const rows = async () => [row(ME, await hashSpawnToken(token))];
  const run = vi.fn(async () => aiResult);
  const e = { ...env, AGENT_REPO: REPO, FLEET_JUNIOR: "on", AI: { run }, ...overrides } as unknown as Env;
  return { token, rows, run, e };
}
const req = (token: string | null, body: unknown, path = "/fleet/junior", method = "POST") =>
  new Request(`https://w${path}`, {
    method, headers: token ? { [SPAWN_TOKEN_HEADER]: token } : {},
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
const good = { model: "@cf/zai-org/glm-5.3", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };

describe("juniorEnabled", () => {
  it("off unless exactly 'on'", () => {
    expect(juniorEnabled({ FLEET_JUNIOR: undefined, JUNIOR_REPOS: undefined }, REPO)).toBe(false);
    expect(juniorEnabled({ FLEET_JUNIOR: "true", JUNIOR_REPOS: undefined }, REPO)).toBe(false);
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: undefined }, REPO)).toBe(true);
  });
  it("JUNIOR_REPOS narrows, case-insensitive", () => {
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: "Acme-Org/Websites" }, REPO)).toBe(true);
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: "acme-org/other" }, REPO)).toBe(false);
    expect(juniorEnabled({ FLEET_JUNIOR: "on", JUNIOR_REPOS: "acme-org/other" }, undefined)).toBe(false);
  });
});

describe("handleFleetJunior", () => {
  it("404 when flag off", async () => {
    const { token, rows, e } = await setup({ FLEET_JUNIOR: undefined });
    expect((await handleFleetJunior(req(token, good), e, board(), rows)).status).toBe(404);
  });
  it("404 when repo not listed", async () => {
    const { token, rows, e } = await setup({ JUNIOR_REPOS: "acme-org/other" });
    expect((await handleFleetJunior(req(token, good), e, board(), rows)).status).toBe(404);
  });
  it("404 when AI binding missing", async () => {
    const { token, rows, e } = await setup({ AI: undefined });
    expect((await handleFleetJunior(req(token, good), e, board(), rows)).status).toBe(404);
  });
  it("405 on GET", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetJunior(req(token, null, "/fleet/junior", "GET"), e, board(), rows)).status).toBe(405);
  });
  it("401 on missing or unknown token", async () => {
    const { rows, e } = await setup();
    expect((await handleFleetJunior(req(null, good), e, board(), rows)).status).toBe(401);
    expect((await handleFleetJunior(req(mintSpawnToken(), good), e, board(), rows)).status).toBe(401);
  });
  it("400 on model outside allowlist", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, { ...good, model: "@cf/openai/gpt-oss-120b" }), e, board(), rows);
    expect(r.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it("400 on bad JSON or missing messages", async () => {
    const { token, rows, e } = await setup();
    expect((await handleFleetJunior(req(token, "{nope"), e, board(), rows)).status).toBe(400);
    expect((await handleFleetJunior(req(token, { model: good.model }), e, board(), rows)).status).toBe(400);
  });
  it("413 over 2 MB", async () => {
    const { token, rows, e } = await setup();
    const big = { ...good, messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] };
    expect((await handleFleetJunior(req(token, big), e, board(), rows)).status).toBe(413);
  });
  it("200 streams normalized JSON and forwards the request to env.AI.run", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(r.status).toBe(200);
    expect(JSON.parse((await r.text()).trim())).toEqual({ content: "ok", finish: "stop", usage: { in: 1, out: 2, neurons: null } });
    expect(run).toHaveBeenCalledWith(good.model, { messages: good.messages, max_tokens: 100 });
  });
  it("AI error becomes an error body with a classified code", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(async () => { throw new Error("AiError: AiError: Request timeout (abc)"); });
    const r = await handleFleetJunior(req(token, good), e, board(), rows);
    expect(JSON.parse((await r.text()).trim())).toEqual({ error: { code: 3046, message: "AiError: AiError: Request timeout (abc)" } });
  });
  it("heartbeat spaces precede the JSON on slow calls", async () => {
    const { token, rows, e } = await setup();
    (e.AI as { run: ReturnType<typeof vi.fn> }).run = vi.fn(() => new Promise((res) => setTimeout(() => res({ response: "late" }), 50)));
    const r = await handleFleetJunior(req(token, good), e, board(), rows, 10);
    const text = await r.text();
    expect(text.startsWith(" ")).toBe(true);
    expect(JSON.parse(text.trim()).content).toBe("late");
  });
});

describe("handleFleetJunior — maestro authorization", () => {
  it("403 when no live task carries junior", async () => {
    const { token, rows, e, run } = await setup();
    const r = await handleFleetJunior(req(token, good), e, board([boardTask({ labels: ["working", studioLabel(ME)] })]), rows);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe("junior not authorized for your current task");
    expect(run).not.toHaveBeenCalled();
  });
  it("403 when the junior task is completed", async () => {
    const { token, rows, e } = await setup();
    const done = boardTask({ state: "completed", open: false, labels: ["completed", studioLabel(ME), "junior"] });
    expect((await handleFleetJunior(req(token, good), e, board([done]), rows)).status).toBe(403);
  });
  it("403 when the junior task belongs to another studio", async () => {
    const { token, rows, e } = await setup();
    const theirs = boardTask({ assignee: "websites--release-studio", labels: ["working", studioLabel("websites--release-studio"), "junior"] });
    expect((await handleFleetJunior(req(token, good), e, board([theirs]), rows)).status).toBe(403);
  });
  it("503 when the board read fails — fail closed", async () => {
    const { token, rows, e, run } = await setup();
    expect((await handleFleetJunior(req(token, good), e, board(new Error("github 500")), rows)).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });
  it("board is read for the studio's own id on its bound repo", async () => {
    const { token, rows, e } = await setup();
    const api = board();
    await (await handleFleetJunior(req(token, good), e, api, rows)).text();
    expect(vi.mocked(api.listIssues).mock.calls[0][0]).toBe(REPO);
  });
});

describe("normalizeAiResult", () => {
  it("legacy { response } shape", () => {
    expect(normalizeAiResult({ response: "r" })).toEqual({ content: "r", finish: null, usage: { in: 0, out: 0, neurons: null } });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && npx vitest run test/junior.route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: env.ts fields** — add after `FLEET_DIRECTUS?: string;`:

```ts
  /** Junior (Workers AI delegation, docs/superpowers/specs/2026-09-28-junior-workers-ai-design.md):
   *  `/fleet/junior` answers and studios get the `junior` skill only when this
   *  is exactly "on". Absent = off. */
  FLEET_JUNIOR?: string;
  /** Optional comma list of "owner/repo" narrowing FLEET_JUNIOR, same format
   *  as INSTALL_CACHE_REPOS. Absent/empty = every repo when FLEET_JUNIOR is on. */
  JUNIOR_REPOS?: string;
  /** Workers AI binding (`"ai": { "binding": "AI" }`). Only junior uses it. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
```

- [ ] **Step 4: gate.ts**

```ts
// apps/fleet/src/junior/gate.ts
import type { Env } from "../env";
import { parseInstallCacheRepos } from "../studio/install-cache";

/** Measured 2026-09-28 replay eval: the only two models that scored >= 2.9/3
 *  with zero harmful edits. Anything else is refused at the Worker. */
export const JUNIOR_MODELS: readonly string[] = ["@cf/zai-org/glm-5.3", "@cf/deepseek-ai/deepseek-v4-pro-0813"];

export function juniorEnabled(
  env: Pick<Env, "FLEET_JUNIOR" | "JUNIOR_REPOS">, workRepoSlug: string | undefined,
): boolean {
  if (env.FLEET_JUNIOR !== "on") return false;
  // Same flat "owner/repo" list grammar as INSTALL_CACHE_REPOS.
  const list = parseInstallCacheRepos(env.JUNIOR_REPOS);
  if (list.length === 0) return true;
  return workRepoSlug !== undefined && list.includes(workRepoSlug.toLowerCase());
}

export const JUNIOR_HOUSE_RULE = [
  "## House rules — junior",
  "",
  "The `junior` skill is installed: `~/.claude/skills/junior/junior.sh` sends",
  "a mechanical task to a Workers AI model and returns a diff. You may use it",
  "ONLY while your current task carries the `junior` label — the maestro's",
  "call, made when it filed the task. No label: do the work yourself and never",
  "ask for one. When allowed, use it for boilerplate, scaffolds, renames,",
  "docstrings, log summaries. You are the senior: read every hunk, apply it",
  "yourself, run the tests. You own every line that lands. It goes through the",
  "fleet Worker; no Cloudflare credential exists in this container and none is",
  "needed.",
].join("\n");
```

- [ ] **Step 5: route.ts**

```ts
// apps/fleet/src/junior/route.ts
// POST /fleet/junior — the studio's road to Workers AI. Spawn-token auth, same
// as /fleet/tasks (board/routes.ts's handleFleetBoard). The Worker's own AI
// binding makes the call, so the container never holds a Cloudflare
// credential (house rule "deploy credentials", blueprint.ts).
import type { Env } from "../env";
import { isSpawnTokenShaped, resolveSpawnParent, SPAWN_TOKEN_HEADER } from "../studio/spawn";
import { listStudios } from "../studio/registry";
import type { StudioStatus } from "../studio/types";
import { JUNIOR_MODELS, juniorEnabled } from "./gate";
import { hasJuniorAuthorizedTask, type BoardApi } from "../board/board";
import { githubBoardApi, resolveStudioBoardRepo } from "../board/routes";

export const JUNIOR_BODY_CAP = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

// deno-lint-ignore no-explicit-any
type Json = any;

export function normalizeAiResult(r: Json) {
  if (r && Array.isArray(r.choices)) {
    const c = r.choices[0] ?? {};
    return {
      content: typeof c.message?.content === "string" ? c.message.content : "",
      finish: c.finish_reason ?? null,
      usage: { in: r.usage?.prompt_tokens ?? 0, out: r.usage?.completion_tokens ?? 0, neurons: r.usage?.neurons ?? null },
    };
  }
  return {
    content: typeof r?.response === "string" ? r.response : "",
    finish: r?.finish_reason ?? null,
    usage: { in: r?.usage?.prompt_tokens ?? 0, out: r?.usage?.completion_tokens ?? 0, neurons: null },
  };
}

function aiErrorCode(message: string): number {
  if (/timeout/i.test(message)) return 3046;
  if (/capacity/i.test(message)) return 3040;
  if (/rate limit|too many/i.test(message)) return 429;
  return 0;
}

const text = (body: string, status: number) => new Response(body, { status });

export async function handleFleetJunior(
  req: Request, env: Env,
  api: BoardApi = githubBoardApi(env),
  rows: () => Promise<StudioStatus[]> = () => listStudios(env),
  heartbeatMs = HEARTBEAT_MS,
): Promise<Response> {
  if (new URL(req.url).pathname !== "/fleet/junior") return text("not found", 404);
  if (env.FLEET_JUNIOR !== "on" || !env.AI) return text("not found", 404);
  if (req.method !== "POST") return text("method not allowed", 405);

  const presented = req.headers.get(SPAWN_TOKEN_HEADER);
  if (!isSpawnTokenShaped(presented)) return text("unauthorized", 401);
  const studio = await resolveSpawnParent(await rows(), presented);
  if (!studio) return text("unauthorized", 401);
  if (!juniorEnabled(env, studio.repoSlug ?? env.AGENT_REPO)) return text("not found", 404);

  // The maestro's gate: only a live task it filed with `--junior` lets this
  // studio through. Read fresh every call — a completed or reassigned task
  // must stop authorizing at once. A board error fails CLOSED.
  const repo = resolveStudioBoardRepo(studio.repoSlug, env.AGENT_REPO, undefined);
  if (!repo.ok) return text("junior not authorized for your current task", 403);
  let authorized;
  try { authorized = await hasJuniorAuthorizedTask(api, repo.value, studio.id); }
  catch { return text("board unavailable", 503); }
  if (!authorized.ok) return text("board unavailable", 503);
  if (!authorized.value) return text("junior not authorized for your current task", 403);

  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > JUNIOR_BODY_CAP) return text("payload too large", 413);
  let body: Json;
  try { body = JSON.parse(raw); } catch { return text("bad json", 400); }
  if (!JUNIOR_MODELS.includes(body?.model)) return text("model not allowed", 400);
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return text("messages required", 400);
  const maxTokens = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 64_000;

  const ai = env.AI;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const beat = setInterval(() => { void w.write(enc.encode(" ")); }, heartbeatMs);
  void (async () => {
    let out: string;
    try {
      out = JSON.stringify(normalizeAiResult(await ai.run(body.model, { messages: body.messages, max_tokens: maxTokens })));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out = JSON.stringify({ error: { code: aiErrorCode(message), message } });
    } finally {
      clearInterval(beat);
    }
    await w.write(enc.encode(out));
    await w.close();
  })();
  return new Response(readable, { status: 200, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 6: Mount in index.ts** — directly before `if (url.pathname.startsWith("/fleet/tasks"))`:

```ts
    // Junior (Workers AI delegation): spawn-token authenticated like
    // /fleet/tasks, before the /fleet/ catch-all. 404s itself unless
    // FLEET_JUNIOR is on for the calling studio's repo; 403 unless the
    // studio's live task carries the maestro's `junior` label.
    if (url.pathname === "/fleet/junior") return handleFleetJunior(req, env);
```
Add import `import { handleFleetJunior } from "./junior/route";`.

- [ ] **Step 7: wrangler.example.jsonc + README**

In `wrangler.example.jsonc`, top-level (sibling of `vars`): `"ai": { "binding": "AI" },` with comment `// Workers AI — only /fleet/junior uses it; harmless while FLEET_JUNIOR is off.` In the feature-flag comment block add:

```jsonc
    // FLEET_JUNIOR gates the junior skill (Workers AI delegation, see
    // skills/junior/SKILL.md): studios get the skill and /fleet/junior
    // answers only when "on". JUNIOR_REPOS optionally narrows it to a comma
    // list of owner/repo. Needs the "ai" binding above.
    "FLEET_JUNIOR": "off",
    // "JUNIOR_REPOS": "<your-org>/<your-repo>",
```
(keep JSON valid: add comma after the previous last var.)

In `README.md` flag table add row: `| FLEET_JUNIOR | off | "on" = studios get the junior skill (Workers AI delegation) and /fleet/junior answers. JUNIOR_REPOS narrows to owner/repo list. Needs "ai" binding. |`. Under the local-setup section add: `fleet junior enable --account <id>` enables it on your Mac; `fleet junior disable` removes it.

- [ ] **Step 8: Run, expect PASS**

Run: `cd apps/fleet && npx vitest run test/junior.route.test.ts test/index.test.ts && npx tsc --noEmit -p .`
`board/routes.ts` does not import `junior/route.ts`, so the new import is one-way. Confirm the bundle still builds: `npx wrangler deploy --dry-run -c wrangler.test.jsonc`.
Expected: pass, no type errors. `index.test.ts` must still pass (route ordering).

- [ ] **Step 9: Commit**

```bash
git add apps/fleet/src/junior apps/fleet/src/env.ts apps/fleet/src/index.ts apps/fleet/wrangler.example.jsonc apps/fleet/test/junior.route.test.ts README.md
git commit -m "feat(junior): /fleet/junior Worker proxy — AI binding, flags, maestro task gate"
```

---

### Task 7: Provision — skill + house rule only when enabled

**Files:**
- Modify: `apps/fleet/src/studio/provision.ts` (ProvisionDeps ~line 122; `resolveBringupEnv` studio path ~line 1736-1745), `apps/fleet/src/studio/do.ts` (the `deps()` literal holding `opsRepo,` ~line 4409)
- Test: `apps/fleet/test/junior.provision.test.ts`

**Interfaces:**
- Consumes: `juniorEnabled`, `JUNIOR_HOUSE_RULE` (Task 6 `gate.ts`).
- Produces: `ProvisionDeps.juniorEnabled?: (workRepoSlug: string) => boolean`.

- [ ] **Step 1: Write failing tests**

```ts
// apps/fleet/test/junior.provision.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveBringupEnv, type ProvisionDeps } from "../src/studio/provision";
import { JUNIOR_HOUSE_RULE } from "../src/junior/gate";

const FLEET_JSON = JSON.stringify({ blueprint: { repo: "o/blueprint", ref: "main" }, roles: ["web-studio", "maestro"], instance_type: "standard-2" });
const STUDIO_MD = "---\nname: web-studio\ntitle: Web Studio\nlead: Web Designer\nskills: []\nsecrets: []\nmcp: []\nallowedTools: Bash(fleet *)\nkeep_alive: false\n---\nyou are the lead\n";
const files: Record<string, string> = { "fleet.json": FLEET_JSON, "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD };
const decode = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

function deps(juniorEnabled?: (slug: string) => boolean): ProvisionDeps {
  return {
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: vi.fn(async () => {}),
    now: () => "2026-09-28T00:00:00.000Z",
    fetchBlueprintFile: vi.fn(async (_r: string, path: string) => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`fetch ${path} failed (404): Not Found`);
      return hit;
    }),
    memoryRepo: null,
    ...(juniorEnabled ? { juniorEnabled } : {}),
  } as unknown as ProvisionDeps;
}

describe("junior at provision", () => {
  it("port absent: no skill, no rule (every pre-junior fixture)", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });
  it("enabled for the work repo: skill + rule", async () => {
    const seen: string[] = [];
    const { bringupEnv } = await resolveBringupEnv(deps((s) => { seen.push(s); return true; }), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect(seen).toEqual(["o/websites"]);
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain(JUNIOR_HOUSE_RULE);
  });
  it("disabled: neither", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(() => false), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });
  it("maestro never gets the skill or the rule, even when enabled", async () => {
    const MAESTRO_MD = STUDIO_MD.replace("name: web-studio", "name: maestro");
    files["fleet/blueprint/studios/maestro/studio.md"] = MAESTRO_MD;
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "maestro" }, "o/fleet", "o/websites");
    expect((bringupEnv as { STUDIO_SKILLS: string }).STUDIO_SKILLS.split(",")).not.toContain("junior");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).not.toContain("House rules — junior");
  });
  it("the no-Cloudflare-credential house rule survives with junior on", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(() => true), { repo: "websites", role: "web-studio" }, "o/fleet", "o/websites");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain("No Cloudflare");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && npx vitest run test/junior.provision.test.ts`
Expected: "enabled" case FAILS (no skill); others pass.

- [ ] **Step 3: ProvisionDeps port** — add after `opsRepo?: string | null;`:

```ts
  /**
   * Junior (Workers AI delegation): true when FLEET_JUNIOR is on for this
   * work repo (src/junior/gate.ts's juniorEnabled). do.ts wires it from env.
   * Optional like opsRepo, and absent means off: every existing fixture keeps
   * getting no junior skill and no junior house rule.
   */
  juniorEnabled?: (workRepoSlug: string) => boolean;
```

- [ ] **Step 4: resolveBringupEnv studio path** — replace the `studioBringupEnv(` call's first and third args:

```ts
  if (studio !== null) {
    const members = await listStudioMembers(deps, fleet.blueprint.repo, cfg.role, ref);
    // The maestro authorizes junior use; it never uses it. Its own session
    // gets neither the skill nor the rule (studio.md "Junior — your call").
    const junior = studio.name !== "maestro" && deps.juniorEnabled?.(workRepoSlug) === true;
    return {
      bringupEnv: {
        ...studioBringupEnv(
          junior ? { ...studio, skills: [...studio.skills, "junior"] } : studio,
          members,
          composePromptBlocks(composePromptBlocks(junior ? JUNIOR_HOUSE_RULE : undefined, cfg.projectCard), briefPrompt),
          await resolveMemoryIndex(deps),
          opsOverlay.text,
        ),
        BLUEPRINT_REPO: fleet.blueprint.repo,
      },
```
Add import `import { JUNIOR_HOUSE_RULE } from "../junior/gate";`. Role path unchanged: roles carry no skill list (`roleBringupEnv`), and provision takes the studio path whenever a `studio.md` exists.

- [ ] **Step 5: do.ts wiring** — in the `deps()` literal next to `opsRepo,`:

```ts
      juniorEnabled: (slug: string) => juniorEnabled(this.env, slug),
```
Import `import { juniorEnabled } from "../junior/gate";`.

- [ ] **Step 6: Run, expect PASS**

Run: `cd apps/fleet && npx vitest run test/junior.provision.test.ts test/houserules.prompt.test.ts test/memory.prompt.test.ts test/studio.provision.test.ts && npx tsc --noEmit -p .`

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/src/studio/provision.ts apps/fleet/src/studio/do.ts apps/fleet/test/junior.provision.test.ts
git commit -m "feat(junior): studios (never maestro) get junior skill + house rule only when enabled"
```

---

### Task 8: Local CLI — `fleet junior enable|disable|status`

**Files:**
- Create: `apps/fleet/cli/junior.ts`
- Modify: `apps/fleet/src/studio/cli-args.ts` (`CliCommand` union ~line 34, `VERBS` ~line 224, `parseCliArgs` switch ~line 544), `apps/fleet/cli/fleet.ts` (before `loadCredentials()` ~line 2182)
- Test: `apps/fleet/test/studio.cli-args.test.ts` (add cases), `apps/fleet/test/bun/junior-local-cli.test.ts`

**Interfaces:**
- Consumes: `juniorConfigPath` (Task 3) — imported in the bun test only, to pin both sides to one path.
- Produces:
  - `CliCommand` member `{ cmd: "junior"; action: "enable" | "disable" | "status"; account?: string }`
  - `cli/junior.ts`: `interface JuniorPaths { skillLink: string; config: string; skillSrc: string }`, `juniorPaths(home: string, repoRoot: string): JuniorPaths`, `juniorEnable(p: JuniorPaths, account?: string): { ok: boolean; lines: string[] }`, `juniorDisable(p): { ok: boolean; lines: string[] }`, `juniorStatus(p, env): { ok: boolean; lines: string[] }`, `cmdJunior(parsed): number`

- [ ] **Step 1: Write failing tests**

Add to `test/studio.cli-args.test.ts`:

```ts
  it("junior verbs", () => {
    expect(parseCliArgs(["junior", "enable"])).toEqual({ cmd: "junior", action: "enable" });
    expect(parseCliArgs(["junior", "enable", "--account", "abc"])).toEqual({ cmd: "junior", action: "enable", account: "abc" });
    expect(parseCliArgs(["junior", "disable"])).toEqual({ cmd: "junior", action: "disable" });
    expect(parseCliArgs(["junior", "status"])).toEqual({ cmd: "junior", action: "status" });
    expect(parseCliArgs(["junior"]).cmd).toBe("usage");
    expect(parseCliArgs(["junior", "nuke"]).cmd).toBe("usage");
    expect(parseCliArgs(["junior", "enable", "--acount", "x"]).cmd).toBe("usage");
  });
```

```ts
// apps/fleet/test/bun/junior-local-cli.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { juniorPaths, juniorEnable, juniorDisable, juniorStatus } from "../../cli/junior";
import { juniorConfigPath } from "../../../../skills/junior/src/auth";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "junior-home-"));
  const repo = mkdtempSync(join(tmpdir(), "junior-repo-"));
  mkdirSync(join(repo, "skills/junior"), { recursive: true });
  return { home, repo, p: juniorPaths(home, repo) };
}

describe("fleet junior", () => {
  test("config path agrees with the wrapper's reader", () => {
    const { home, p } = fixture();
    expect(p.config).toBe(juniorConfigPath(home));
  });
  test("enable links the skill and stores the account", () => {
    const { p } = fixture();
    const r = juniorEnable(p, "acct1");
    expect(r.ok).toBe(true);
    expect(readlinkSync(p.skillLink)).toBe(p.skillSrc);
    expect(JSON.parse(readFileSync(p.config, "utf8"))).toEqual({ accountId: "acct1" });
  });
  test("enable twice is idempotent", () => {
    const { p } = fixture();
    juniorEnable(p, "a");
    expect(juniorEnable(p).ok).toBe(true);
    expect(JSON.parse(readFileSync(p.config, "utf8"))).toEqual({ accountId: "a" });
  });
  test("enable refuses to clobber a foreign skill dir", () => {
    const { p } = fixture();
    mkdirSync(p.skillLink, { recursive: true });
    const r = juniorEnable(p, "a");
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("already exists");
    expect(lstatSync(p.skillLink).isDirectory()).toBe(true);
  });
  test("enable without any account warns", () => {
    const { p } = fixture();
    expect(juniorEnable(p).lines.join("\n")).toContain("--account");
  });
  test("disable removes only our symlink, keeps config", () => {
    const { p } = fixture();
    juniorEnable(p, "a");
    expect(juniorDisable(p).ok).toBe(true);
    expect(existsSync(p.skillLink)).toBe(false);
    expect(existsSync(p.config)).toBe(true);
  });
  test("disable when not enabled is a no-op success", () => {
    const { p } = fixture();
    expect(juniorDisable(p).ok).toBe(true);
  });
  test("status reports enabled, account and auth path", () => {
    const { p } = fixture();
    juniorEnable(p, "acct9");
    const lines = juniorStatus(p, {}).lines.join("\n");
    expect(lines).toContain("enabled: yes");
    expect(lines).toContain("account: acct9");
    expect(lines).toContain("auth: wrangler");
    expect(juniorStatus(p, { CLOUDFLARE_API_TOKEN: "x" }).lines.join("\n")).toContain("auth: api-token");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && npx vitest run test/studio.cli-args.test.ts && bun test test/bun/junior-local-cli.test.ts`

- [ ] **Step 3: cli-args.ts** — union member:

```ts
  | { cmd: "junior"; action: "enable" | "disable" | "status"; account?: string }
```
VERBS entry:

```ts
  junior: {
    args: "enable [--account <id>] | disable | status",
    summary: "Opt this Mac into the junior skill (Workers AI delegation, skills/junior/SKILL.md). enable symlinks ~/.claude/skills/junior to this checkout and stores the Cloudflare account id in ~/.config/fleet/junior.json; disable removes only that symlink; status prints whether it is on, the account, and which auth path a call would take. Local only — never touches the Worker or any studio.",
  },
```
Parse case:

```ts
    case "junior": {
      const action = argv[1];
      if (action !== "enable" && action !== "disable" && action !== "status") {
        return { cmd: "usage", message: "usage: fleet junior enable [--account <id>] | disable | status" };
      }
      const rest = argv.slice(2);
      if (action !== "enable" || rest.length === 0) {
        return rest.length === 0 ? { cmd: "junior", action } : { cmd: "usage", message: `fleet junior ${action}: takes no arguments` };
      }
      if (rest.length === 2 && rest[0] === "--account" && rest[1] !== "") return { cmd: "junior", action, account: rest[1] };
      return { cmd: "usage", message: "usage: fleet junior enable [--account <id>]" };
    }
```
(Check the existing `usage` variant's field name in the union and match it.)

- [ ] **Step 4: cli/junior.ts**

```ts
// apps/fleet/cli/junior.ts — `fleet junior enable|disable|status`.
// Local opt-in for the junior skill. Nothing is installed until enable runs.
// The config path must equal skills/junior/src/auth.ts's juniorConfigPath —
// pinned by test/bun/junior-local-cli.test.ts.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface JuniorPaths { skillLink: string; config: string; skillSrc: string }
type Out = { ok: boolean; lines: string[] };

export function juniorPaths(home: string, repoRoot: string): JuniorPaths {
  return {
    skillLink: join(home, ".claude", "skills", "junior"),
    config: join(home, ".config", "fleet", "junior.json"),
    skillSrc: join(repoRoot, "skills", "junior"),
  };
}

function readConfig(p: JuniorPaths): { accountId?: string } {
  try { return JSON.parse(readFileSync(p.config, "utf8")); } catch { return {}; }
}

function linkState(p: JuniorPaths): "absent" | "ours" | "foreign" {
  if (!existsSync(p.skillLink) && !isSymlink(p.skillLink)) return "absent";
  return isSymlink(p.skillLink) && readlinkSync(p.skillLink) === p.skillSrc ? "ours" : "foreign";
}
function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function juniorEnable(p: JuniorPaths, account?: string): Out {
  const state = linkState(p);
  if (state === "foreign") return { ok: false, lines: [`${p.skillLink} already exists and is not this checkout's junior skill; remove it first`] };
  if (state === "absent") {
    mkdirSync(dirname(p.skillLink), { recursive: true });
    symlinkSync(p.skillSrc, p.skillLink);
  }
  const cfg = readConfig(p);
  if (account) {
    mkdirSync(dirname(p.config), { recursive: true });
    writeFileSync(p.config, `${JSON.stringify({ ...cfg, accountId: account })}\n`);
  }
  const lines = [`junior enabled: ${p.skillLink} -> ${p.skillSrc}`];
  if (!account && !cfg.accountId) lines.push("no account id stored: rerun with --account <id> or set CLOUDFLARE_ACCOUNT_ID");
  return { ok: true, lines };
}

export function juniorDisable(p: JuniorPaths): Out {
  const state = linkState(p);
  if (state === "foreign") return { ok: false, lines: [`${p.skillLink} is not this checkout's junior symlink; left alone`] };
  if (state === "ours") unlinkSync(p.skillLink);
  return { ok: true, lines: [state === "ours" ? "junior disabled" : "junior was not enabled"] };
}

export function juniorStatus(p: JuniorPaths, env: Record<string, string | undefined>): Out {
  const state = linkState(p);
  const account = env.CLOUDFLARE_ACCOUNT_ID || readConfig(p).accountId || "(none)";
  const auth = env.FLEET_WORKER_URL && env.FLEET_SPAWN_TOKEN ? "proxy" : env.CLOUDFLARE_API_TOKEN ? "api-token" : "wrangler";
  return { ok: true, lines: [`enabled: ${state === "ours" ? "yes" : state === "foreign" ? "no (foreign dir in the way)" : "no"}`, `account: ${account}`, `auth: ${auth}`] };
}

export function cmdJunior(parsed: { action: "enable" | "disable" | "status"; account?: string }): number {
  const p = juniorPaths(process.env.HOME ?? "", join(import.meta.dir, "../../.."));
  const out = parsed.action === "enable" ? juniorEnable(p, parsed.account)
    : parsed.action === "disable" ? juniorDisable(p) : juniorStatus(p, process.env);
  for (const l of out.lines) (out.ok ? console.log : console.error)(l);
  return out.ok ? 0 : 1;
}
```

- [ ] **Step 5: fleet.ts dispatch** — before `const creds = await loadCredentials();`:

```ts
  // Junior: purely local (a symlink + one config file), so like onboard it
  // must work on a machine with no ~/.fleet/credentials at all.
  if (parsed.cmd === "junior") {
    process.exitCode = cmdJunior(parsed);
    return;
  }
```
Import `import { cmdJunior } from "./junior";`.

- [ ] **Step 6: Run, expect PASS**

Run: `cd apps/fleet && npx vitest run test/studio.cli-args.test.ts && bun test test/bun/junior-local-cli.test.ts && npx tsc --noEmit -p cli`

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/cli/junior.ts apps/fleet/cli/fleet.ts apps/fleet/src/studio/cli-args.ts apps/fleet/test/studio.cli-args.test.ts apps/fleet/test/bun/junior-local-cli.test.ts
git commit -m "feat(junior): fleet junior enable|disable|status, local opt-in"
```

---

### Task 9: Replay eval kept — `scripts/junior-eval/`

**Files:**
- Create: `scripts/junior-eval/eval.ts`, `scripts/junior-eval/README.md`
- Test: `apps/fleet/test/bun/junior-eval.test.ts`

**Interfaces:**
- Consumes: `parseBlocks`, `applyBlocks`, `toUnifiedDiff` (Task 1); `callOnce`, `ApiError` (Task 2); `resolveTransport`, `defaultAuthDeps` (Task 3); `SYSTEM_EDIT` (Task 4 `main.ts`).
- Produces: `aggregate(results: EvalResult[], verdicts: Verdict[]): Row[]` (pure), CLI `bun scripts/junior-eval/eval.ts run|packets|score`.

- [ ] **Step 1: Write failing test**

```ts
// apps/fleet/test/bun/junior-eval.test.ts
import { expect, test } from "bun:test";
import { aggregate } from "../../../../scripts/junior-eval/eval";

test("aggregate: mean, perfect, harmful, failed, p50, cost; timeouts count as 0", () => {
  const results = [
    { model: "m1", commit: "c1", status: "ok", secs: 10, neurons: 1000 },
    { model: "m1", commit: "c2", status: "api-error", secs: 300, neurons: 0 },
    { model: "m2", commit: "c1", status: "ok", secs: 5, neurons: 100 },
  ];
  const verdicts = [
    { model: "m1", commit: "c1", s: 3, harmful: false },
    { model: "m2", commit: "c1", s: 2, harmful: true },
  ];
  expect(aggregate(results, verdicts)).toEqual([
    { model: "m2", n: 1, mean: 2, perfect: 0, harmful: 1, failed: 0, p50: 5, costPerTask: 0.0011 },
    { model: "m1", n: 2, mean: 1.5, perfect: 1, harmful: 0, failed: 1, p50: 300, costPerTask: 0.0055 },
  ].sort((a, b) => b.mean - a.mean));
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/fleet && bun test test/bun/junior-eval.test.ts`

- [ ] **Step 3: Implement eval.ts**

```ts
// scripts/junior-eval/eval.ts — replay real commits against Workers AI models.
// Manual, never CI. See README.md next to this file.
//   run     --models a,b --commits h1,h2 | --auto 10  --out <dir>
//   packets --out <dir>     (blind, shuffled judge packets + key.json)
//   score   --out <dir>     (reads <dir>/judge/*.json verdicts, prints table)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyBlocks, parseBlocks, toUnifiedDiff } from "../../skills/junior/src/blocks";
import { ApiError, callOnce } from "../../skills/junior/src/client";
import { defaultAuthDeps, resolveTransport } from "../../skills/junior/src/auth";
import { SYSTEM_EDIT } from "../../skills/junior/src/main";

export interface EvalResult { model: string; commit: string; status: string; secs: number; neurons: number; text?: string }
export interface Verdict { model: string; commit: string; s: number; harmful: boolean }
export interface Row { model: string; n: number; mean: number; perfect: number; harmful: number; failed: number; p50: number; costPerTask: number }

export function aggregate(results: EvalResult[], verdicts: Verdict[]): Row[] {
  const by = new Map<string, { r: EvalResult; v?: Verdict }[]>();
  for (const r of results) {
    const v = verdicts.find((x) => x.model === r.model && x.commit === r.commit);
    by.set(r.model, [...(by.get(r.model) ?? []), { r, v }]);
  }
  const rows: Row[] = [];
  for (const [model, xs] of by) {
    const n = xs.length;
    const secs = xs.map((x) => x.r.secs).sort((a, b) => a - b);
    rows.push({
      model, n,
      mean: xs.reduce((s, x) => s + (x.v?.s ?? 0), 0) / n,
      perfect: xs.filter((x) => x.v?.s === 3).length,
      harmful: xs.filter((x) => x.v?.harmful).length,
      failed: xs.filter((x) => x.r.status !== "ok").length,
      p50: secs[Math.floor(n / 2)],
      costPerTask: Number((xs.reduce((s, x) => s + x.r.neurons, 0) / n * 0.011 / 1000).toFixed(4)),
    });
  }
  return rows.sort((a, b) => b.mean - a.mean);
}

const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 }).stdout;

function pickCommits(n: number): string[] {
  const out: string[] = [];
  for (const h of git("log", "--no-merges", "--format=%h", "-400").trim().split("\n")) {
    const stat = git("show", "--numstat", "--format=", h).trim().split("\n");
    if (stat.length !== 1) continue;
    const [add, del, f] = stat[0].split("\t");
    const t = Number(add) + Number(del);
    if (!(t >= 3 && t <= 40) || !/\.(ts|js|mjs|sh)$/.test(f)) continue;
    const size = git("show", `${h}^:${f}`).split("\n").length;
    if (size > 1 && size < 1500) out.push(h);
    if (out.length === n) break;
  }
  return out;
}

function task(h: string) {
  const f = git("show", "--name-only", "--format=", h).trim();
  return { h, f, msg: git("log", "-1", "--format=%B", h).trim(), pre: git("show", `${h}^:${f}`) };
}

async function run(models: string[], commits: string[], out: string) {
  mkdirSync(join(out, "raw"), { recursive: true });
  const transport = resolveTransport(process.env, defaultAuthDeps(process.env));
  const tasks = commits.map(task);
  const results: EvalResult[] = [];
  await Promise.all(models.map(async (model) => {
    for (const t of tasks) {
      const start = Date.now();
      let rec: EvalResult;
      try {
        const user = `Task (the commit message describing the change to make):\n${t.msg}\n\nFile: ${t.f}\n\`\`\`\n${t.pre}\`\`\``;
        const r = await callOnce(transport, { model, messages: [{ role: "system", content: SYSTEM_EDIT }, { role: "user", content: user }], max_tokens: 64_000 }, fetch);
        const applied = applyBlocks(new Map([[t.f, t.pre]]), parseBlocks(r.content), () => false);
        rec = { model, commit: t.h, status: applied.ok ? "ok" : applied.error, secs: Math.round((Date.now() - start) / 1000), neurons: r.usage.neurons ?? 0, text: r.content };
      } catch (e) {
        rec = { model, commit: t.h, status: `api-error: ${e instanceof ApiError ? e.message : String(e)}`, secs: Math.round((Date.now() - start) / 1000), neurons: 0 };
      }
      results.push(rec);
      console.log(JSON.stringify({ ...rec, text: undefined }));
    }
  }));
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
}

function packets(out: string) {
  const results: EvalResult[] = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  mkdirSync(join(out, "packets"), { recursive: true });
  const key: Record<string, Record<string, string>> = {};
  for (const h of [...new Set(results.map((r) => r.commit))]) {
    const t = task(h);
    const cands = results.filter((r) => r.commit === h).map((r) => {
      const a = applyBlocks(new Map([[t.f, t.pre]]), parseBlocks(r.text ?? ""), () => false);
      return { model: r.model, diff: a.ok ? toUnifiedDiff(new Map([[t.f, t.pre]]), a.after) : `(EDIT FAILED: ${r.status})\n${(r.text ?? "").slice(0, 3000)}` };
    }).sort(() => Math.random() - 0.5);
    key[h] = Object.fromEntries(cands.map((c, i) => [String.fromCharCode(65 + i), c.model]));
    const md = [`# Commit ${h}`, "", "## Task given to candidates", t.msg, "", "## Reference diff", "```diff", git("show", "--format=", h), "```",
      ...cands.flatMap((c, i) => ["", `## Candidate ${String.fromCharCode(65 + i)}`, "```diff", c.diff, "```"])].join("\n");
    writeFileSync(join(out, "packets", `${h}.md`), md);
  }
  writeFileSync(join(out, "key.json"), JSON.stringify(key, null, 1));
  console.log(`packets: ${Object.keys(key).length} in ${join(out, "packets")}. Judge them per README.md, verdicts into ${join(out, "judge")}/*.json`);
}

function score(out: string) {
  const results: EvalResult[] = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  const key: Record<string, Record<string, string>> = JSON.parse(readFileSync(join(out, "key.json"), "utf8"));
  const verdicts: Verdict[] = [];
  const dir = join(out, "judge");
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")) : []) {
    const j: Record<string, Record<string, { s: number; harmful: boolean }>> = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const [h, byLetter] of Object.entries(j)) {
      for (const [L, v] of Object.entries(byLetter)) verdicts.push({ model: key[h][L], commit: h, s: v.s, harmful: v.harmful });
    }
  }
  console.table(aggregate(results, verdicts));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const out = flag("--out") ?? "junior-eval-out";
  if (cmd === "run") {
    const commits = flag("--commits")?.split(",") ?? pickCommits(Number(flag("--auto") ?? 10));
    await run((flag("--models") ?? "@cf/zai-org/glm-5.3,@cf/deepseek-ai/deepseek-v4-pro-0813").split(","), commits, out);
  } else if (cmd === "packets") packets(out);
  else if (cmd === "score") score(out);
  else { console.error("usage: eval.ts run|packets|score [--out dir] [--models a,b] [--commits h1,h2 | --auto N]"); process.exit(2); }
}
```

- [ ] **Step 4: README.md**

````markdown
# junior-eval

Replays small real commits against Workers AI models to decide the junior
default. Manual only. Rerun when Cloudflare adds models.

1. `bun scripts/junior-eval/eval.ts run --auto 10 --models <a,b,...> --out /tmp/je`
   (auth as `skills/junior` — `CLOUDFLARE_API_TOKEN` or wrangler login; ~60s per call)
2. `bun scripts/junior-eval/eval.ts packets --out /tmp/je`
3. Senior Claude dispatches blind judge subagents, 2 packets each, with this brief:

   > Blind judge. Read packets <paths>. Score each candidate vs the INTENT of
   > the reference diff, not its wording. 3 = merge as-is. 2 = correct core,
   > minor gap. 1 = partial/wrong detail. 0 = wrong, broken, failed to apply.
   > harmful = introduces bug, unrelated edits, or deletes beyond task.
   > Return ONLY JSON: {"<commit>": {"<letter>": {"s": n, "harmful": bool, "why": "<=12 words"}}}

   Save each judge's JSON to `/tmp/je/judge/<n>.json`.
4. `bun scripts/junior-eval/eval.ts score --out /tmp/je`

Switch the default (`skills/junior/src/client.ts` GLM/DEEPSEEK and
`apps/fleet/src/junior/gate.ts` JUNIOR_MODELS) only on a clear win: higher
mean, zero harmful, no more failures.
````

- [ ] **Step 5: Run, expect PASS**

Run: `cd apps/fleet && bun test test/bun/junior-eval.test.ts && bun scripts/english-check.ts ../../scripts/junior-eval`

- [ ] **Step 6: Commit**

```bash
git add scripts/junior-eval apps/fleet/test/bun/junior-eval.test.ts
git commit -m "feat(junior): replay eval harness kept, manual only"
```

---

### Task 10: Full-suite gate, live smoke, rollout notes

**Files:**
- Modify: none in code. Record smoke results in the PR body.

- [ ] **Step 1: Full suites under the shared lock**

```bash
cd apps/fleet
lockf -k /tmp/fleetflare-gate.lock sh -c 'npx vitest run && bun test test/bun && npx tsc --noEmit -p . && bun scripts/english-check.ts ../..'
```
Expected: all green. Any red → `superpowers:systematic-debugging` before touching code.

- [ ] **Step 2: Live smoke, local wrangler path (manual, not CI)**

```bash
REPO=$(git rev-parse --show-toplevel)   # run from the branch checkout first
cd /tmp && rm -rf jsmoke && mkdir jsmoke && cd jsmoke && git init -q
printf 'export function getUser(id: string) { return id }\nexport const x = getUser("1")\n' > u.ts
CLOUDFLARE_ACCOUNT_ID=<account-id> \
  "$REPO"/skills/junior/junior.sh --task "Rename getUser to fetchUser everywhere in this file." u.ts > p.patch
git apply --check p.patch && cat p.patch
```
Expected: exit 0, diff renames both sites, stderr telemetry `model=glm-5.3 ... status=ok`.

- [ ] **Step 3: Live smoke, text mode**

```bash
"$REPO"/skills/junior/junior.sh --mode text --task "Summarize in one line." u.ts
```
Expected: one line, exit 0.

- [ ] **Step 4: Push + PR** (flags stay off; zero behavior change on merge)

```bash
git push -u origin junior/workers-ai
gh pr create --title "feat(junior): opt-in Workers AI delegation skill + /fleet/junior proxy" --body-file /tmp/junior-pr.md
```
Write `/tmp/junior-pr.md` first: summary, eval table from spec, smoke output, rollout steps below, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Rollout (operator, after merge — not part of this PR)**

1. Ops clone: verify clean == origin (memory: ops clone clobbered by reviewer). Add `"ai": { "binding": "AI" }` and vars `"FLEET_JUNIOR": "on"`, `"JUNIOR_REPOS": "rafarc21/fleetflare"` to ops `wrangler.jsonc`. `scripts/deploy.sh` — Worker-only deploy, no container churn.
2. `fleet junior enable --account <account-id>` on the Mac.
3. Maestro files one small mechanical task with `fleet task new ... --junior`; `fleet task ls` shows `[junior]`. In the studio that takes it: `ls ~/.claude/skills/junior`, run the Step 2 smoke — expect proxy path, telemetry line, exit 0.
3a. Negative check: a task filed WITHOUT `--junior` — the same smoke from its studio exits 6 with "junior not authorized for your current task". Maestro session: `ls ~/.claude/skills/junior` → absent.
3b. Local maestro (operator's own Claude session): add to `~/.claude/CLAUDE.md` under "Agent Dispatch", matching the cloud rulebook — "Junior: maestro-only call, per task. `fleet task new --junior` when a task has clear mechanical parts; never for auth/secrets/migrations/deploys/irreversible; name junior parts in boundaries; never call junior yourself." Caveman, per that file's rule.
4. After a week of sane telemetry, widen `JUNIOR_REPOS`.

---

## Deviations from this plan (execution record, Tasks 1-9 + Task 10 Steps 1/4)

Every deviation below is a fresh-context review finding against the plan's
own literal sample code, fixed same-task with a RED/GREEN test, per the
Execution notes' "Deviation needed? Note it in PR body with reason. Never
silently redesign." No task was silently redesigned; each deviation is a
narrow behavior fix or a stricter check than the sample code shipped with.

**Task 1 (edit blocks):** `blocks.ts`, copied verbatim from the plan's Task
1 Step 3 sample, had two real bugs found on review, both fixed with a
RED-first test: (1) `count()` advanced by `needle.length` instead of `1`,
silently under-counting self-overlapping SEARCH strings (e.g. two spaces
inside `"a   b"`) as one match instead of two, violating the "must match
exactly once" invariant; (2) `BLOCK_RE`'s `^`+`/m` anchor let a blank/missing
path line above `<<<<<<< SEARCH` capture path `""` instead of erroring,
which either produced a confusing error message or, for an empty-SEARCH
new-file block, silently wrote a `""`-keyed entry that crashed
`toUnifiedDiff` with `EISDIR`. Fixed by rejecting blank-path blocks up
front with a clear "block N: missing file path" error.

**Task 2 (chat client):** review found a text-based error-classification
fallback misclassifying some permanent (non-retryable) errors as
retryable, and a rate-limit backoff sleep that ignored an abort signal.
Fixed by scoping the text fallback to 5xx-only and making the backoff
abortable.

**Task 3 (transport selection/auth):** review found `wranglerToken`
validation (`/\s/.test(tok)`) caught whitespace-containing garbage but let
a short single-word non-token string (e.g. `"NotLoggedIn"`) through to
fail obscurely at the HTTP layer instead of clearly at the auth boundary.
Added a minimum-length floor (20 chars; real wrangler/Cloudflare tokens
run 40+) as a cheap, low-risk tightening. Also closed a real coverage gap:
`defaultAuthDeps`'s `wranglerToken` and `readConfig` had zero direct test
coverage (only exercised indirectly through hand-injected fake deps).

**Task 4 (wrapper CLI):** review found an unexpected network-level `fetch`
throw crashed the wrapper instead of exiting 3 (the documented api-error
exit code); mapped it explicitly. Also one doc-only fix: corrected the
scope described by a catch-all comment in `main.ts`.

**Task 5 (maestro authorization / `--junior` flag):** review found
`parseTask`'s `rest.includes("--junior")` matched the literal string
anywhere in argv, including inside another flag's VALUE slot (e.g.
`--boundaries "--junior"`), which silently set `brief.junior = true` for a
task that never asked for it. Fixed by walking `rest` position-aware,
tracking which tokens are known value-taking flag NAMES so only a
standalone `--junior` token is treated as the bare boolean flag.

**Task 6 (Worker proxy `/fleet/junior`):** review found two issues: (1)
heartbeat interval writes were unguarded — a client disconnect mid-call
left every subsequent 15s tick rejecting into a dead writer with no catch;
fixed by clearing the interval the moment a heartbeat write fails; (2)
`max_tokens` was only capped client-side (`skills/junior/src/client.ts`);
added a server-side clamp to the documented 128,000 ceiling before the
Worker's own `env.AI.run` call, since the Worker's AI binding is the real
trust boundary.

**Task 7 (provision — skill + house rule):** deviation from the plan's own
sample code — the maestro-exclusion check uses `cfg.role === "maestro" ||
studio.name === "maestro"`, not `studio.name` alone as the plan's sample
implied. `studio.name` is unenforced frontmatter content (nothing in
`provision.ts` actually checks it matches the directory name it is
documented to match), so a `studio.md` fetched via role `"maestro"` whose
frontmatter name field drifted would defeat a name-only check while still
being the actual maestro. `cfg.role` is the identifier that selected this
file in the first place and is already used elsewhere in the same
spawn/provision path to gate maestro behavior. Also found and fixed: a
blueprint-declared `"junior"` skill in a studio's own frontmatter could
bypass the maestro/flag exclusion entirely — fixed by unconditionally
stripping `"junior"` from the blueprint's declared skill list before
conditionally re-adding it only when actually enabled.

**Task 8 (local CLI `fleet junior enable|disable|status`):** no logic bugs
found; review closed test-coverage gaps only — foreign/dangling symlink
cases for `linkState`, a real end-to-end spawn of `cli/fleet.ts` proving
`cmdJunior`'s `import.meta.dir`-based `repoRoot` arithmetic actually
resolves to this checkout's `skills/junior`, and a clearer `juniorStatus`
message ("auth: (no account — see above)" instead of naming a specific
auth path `resolveTransport` can never reach with no account configured).

**Task 9 (replay eval harness):** no logic bugs found. Review added a
regression test locking in `aggregate()`'s existing tie-break behavior
(Array.sort is spec-stable, so ties are broken by first-appearance order)
since the plan's own sample fixture never produces a tie. Separately (this
final pass, pre-Task-10): added a doc comment + README note flagging that
`p50` is the upper of the two middle values for an even sample count, not
an averaged median — the tool's own `--auto 10` default always produces an
even count.

**Task 10:** per this plan's own Execution notes ("Skip Task 10 Steps 2,
3, 5"), only Steps 1 (full-suite gate) and 4 (push confirmation) were run.
Step 1's combined command was run via `flock` (this sandbox has no `lockf`;
the Execution notes themselves say "Ignore `lockf` (Mac-only)"), against
the shared fleet-wide gate lock rather than a project-local one, since no
other lock file convention was documented for this sandbox. One real,
pre-existing (not this branch's) issue surfaced and was confirmed
out-of-scope by diffing against `origin/main`: `test/bun/deploy-ops-guard.test.ts`
(6 failures) fails identically on a fresh `origin/main` checkout — an
environment-level git-push guard hook present in this sandbox, unrelated
to any junior-branch code. One additional failure
(`test/bun/rescue-push.test.ts`, an off-by-one-second budget assertion)
occurred only when run concurrently with the full vitest suite under one
combined command and passed cleanly in isolation on the same branch — a
timing-sensitive flake from resource contention, not a regression; the
test file itself has zero diff against `origin/main`.
