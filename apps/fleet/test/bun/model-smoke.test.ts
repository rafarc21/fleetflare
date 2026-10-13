// apps/fleet/test/bun/model-smoke.test.ts — argument-parsing / usage-error
// behavior of scripts/model-smoke.ts that does NOT need live Cloudflare
// credentials (this container has none — see that script's own header).
// The live smoke checks themselves (tool call, multi-turn, stream) are
// exercised only by the maestro, against real Workers AI, outside this
// suite.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/model-smoke.ts");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  // Explicit allowlist, never the live container's own env verbatim: proves
  // every assertion below holds with no Cloudflare credentials present,
  // regardless of what happens to be set outside this test.
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  const proc = Bun.spawnSync({
    cmd: ["bun", SCRIPT, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("scripts/model-smoke.ts — argument parsing", () => {
  test("no args: exits 2 with a usage message", () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: bun scripts/model-smoke.ts glm|kimi|deepseek");
  });

  test("unknown model key: exits 2 with the same usage message", () => {
    const r = run(["gpt4"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: bun scripts/model-smoke.ts glm|kimi|deepseek");
  });

  test("known key but no credentials: exits 2, never reaches the network", () => {
    const r = run(["glm"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required");
  });
});
