// skills/junior/test/main.test.ts
// Issue #218: main() writes a local usage-log line for a direct-transport
// (laptop) call, since that call never reaches the fleet Worker — but NOT for
// a proxy-transport (in-studio) call, which is already recorded server-side.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "../src/main";

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      return Response.json({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, neurons: 1 },
      });
    },
  });
});
afterAll(() => server.stop(true));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-main-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
function usageLogPath(home: string): string {
  return join(home, ".local", "share", "fleet", "junior-usage.jsonl");
}

describe("main() local usage recording", () => {
  test("direct transport: a successful call writes a local usage-log line", async () => {
    const home = mkdtempSync(join(tmpdir(), "junior-main-home-"));
    const env = {
      HOME: home,
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
      JUNIOR_API_BASE: `http://127.0.0.1:${server.port}`,
    };
    const code = await main(["--task", "say hi", "--mode", "text"], env, repo());
    expect(code).toBe(0);
    const lines = readFileSync(usageLogPath(home), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row).toMatchObject({ mode: "text", ok: true, input_tokens: 7, output_tokens: 3, calls: 1 });
  });

  test("direct transport, edit mode: a repair round-trip sums BOTH calls' tokens into the local usage row, not just the repair call's", async () => {
    const home = mkdtempSync(join(tmpdir(), "junior-main-home-"));
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "hello\n");
    let requests = 0;
    const repairServer = Bun.serve({
      port: 0,
      async fetch() {
        requests++;
        if (requests === 1) {
          // No edit blocks at all -> applyBlocks fails -> a repair call fires.
          return Response.json({
            choices: [{ message: { content: "sorry, I cannot help with that" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 3, neurons: 1 },
          });
        }
        return Response.json({
          choices: [{
            message: {
              content: "a.txt\n<<<<<<< SEARCH\nhello\n=======\ngoodbye\n>>>>>>> REPLACE",
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 11, completion_tokens: 5, neurons: 2 },
        });
      },
    });
    try {
      const env = {
        HOME: home,
        PATH: process.env.PATH,
        CLOUDFLARE_API_TOKEN: "t",
        CLOUDFLARE_ACCOUNT_ID: "a",
        JUNIOR_API_BASE: `http://127.0.0.1:${repairServer.port}`,
      };
      const code = await main(["--task", "say hi", "--mode", "edit", "a.txt"], env, dir);
      expect(code).toBe(0);
      expect(requests).toBe(2);
      const lines = readFileSync(usageLogPath(home), "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
      const row = JSON.parse(lines[0]);
      // SUM of both calls: in = 7 + 11 = 18, out = 3 + 5 = 8 — not just the
      // repair (second) call's 11/5.
      expect(row).toMatchObject({ mode: "edit", ok: true, input_tokens: 18, output_tokens: 8, calls: 2 });
    } finally {
      repairServer.stop(true);
    }
  });

  test("proxy transport: a successful call does NOT write a local usage-log line (recorded server-side already)", async () => {
    const home = mkdtempSync(join(tmpdir(), "junior-main-home-"));
    const env = {
      HOME: home,
      PATH: process.env.PATH,
      FLEET_WORKER_URL: `http://127.0.0.1:${server.port}`,
      FLEET_SPAWN_TOKEN: "s".repeat(43),
    };
    const code = await main(["--task", "say hi", "--mode", "text"], env, repo());
    expect(code).toBe(0);
    expect(existsSync(usageLogPath(home))).toBe(false);
  });
});
