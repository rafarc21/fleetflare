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
async function run(dir: string, args: string[], apiBase = `http://127.0.0.1:${server.port}`) {
  const p = Bun.spawn(["bash", SH, ...args], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: dir, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", JUNIOR_API_BASE: apiBase },
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

  // Regression: a network-level failure (connection refused, DNS failure —
  // anything that never reaches callOnce's response handling) is neither an
  // ApiError, an AuthError, nor named TimeoutError/AbortError. main() used to
  // let it fall through to a bare `throw`, crashing with an unhandled
  // exception, a raw stack trace on stderr, and exit code 1 — outside the
  // documented contract of EXIT.{OK,USAGE,API,INVALID,TIMEOUT,AUTH}. It must
  // exit 3 (API) with a clean one-line message instead.
  test("network-level fetch failure -> exit 3, not an unhandled crash", async () => {
    const dir = repo({ "a.ts": "x\n" });
    replies = [];
    const r = await run(dir, ["--mode", "text", "--task", "t", "a.ts"], "http://127.0.0.1:1");
    expect(r.code).toBe(3);
    expect(r.err).toContain("junior:");
    expect(r.err).not.toContain("at async callOnce");
  });
});
