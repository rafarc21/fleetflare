// skills/junior/test/main.test.ts
// Issue #218: main() writes a local usage-log line for a direct-transport
// (laptop) call, since that call never reaches the fleet Worker — but NOT for
// a proxy-transport (in-studio) call, which is already recorded server-side.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
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
    expect(row).toMatchObject({ mode: "text", ok: true, input_tokens: 7, output_tokens: 3 });
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
