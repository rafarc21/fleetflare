import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractShellFunc, runSnippet } from "./exec-snippet";

/**
 * Issue #293, end to end: the playwright server the REAL bring-up config
 * describes is spawned exactly as claude would spawn it (command + args, no
 * shell), spoken to over MCP stdio, and asked to navigate to a local page.
 * Before the fix every call failed with
 *   "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome".
 *
 * Linux + an installed chromium only (CI links one at /usr/local/bin/chromium,
 * same as Dockerfile.studio); skipped elsewhere. Fetches the pinned
 * @playwright/mcp through `bun x`, so it needs the registry like the studio does.
 */
const BRINGUP = readFileSync(join(import.meta.dir, "../../container/studio-bringup.sh"), "utf8");

function findChromium(): string | null {
  if (process.platform !== "linux") return null;
  const candidates = [process.env.FLEET_MCP_CHROMIUM, "/usr/local/bin/chromium"];
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), ".cache/ms-playwright")]) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root).filter((n) => /^chromium-\d+$/.test(n))) {
      for (const sub of ["chrome-linux64", "chrome-linux"]) candidates.push(join(root, d, sub, "chrome"));
    }
  }
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

const CHROMIUM = findChromium();

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

type Server = { command: string; args: string[] };

/** The playwright entry the real fleet_mcp_config writes for this chromium. */
function bringupPlaywright(chromium: string): Server {
  const home = mkdtempSync(join(tmpdir(), "fleet-mcp-live-"));
  dirs.push(home);
  const file = join(home, "fleet-mcp.json");
  const r = runSnippet({
    shell: "bash",
    env: { HOME: home, FLEET_MCP_CHROMIUM: chromium },
    script: `set -euo pipefail\n${extractShellFunc(BRINGUP, "fleet_mcp_config")}\nfleet_mcp_config "${file}" playwright\n`,
  });
  expect(r.code).toBe(0);
  return (JSON.parse(readFileSync(file, "utf8")) as { mcpServers: { playwright: Server } }).mcpServers.playwright;
}

describe.skipIf(!CHROMIUM)("playwright MCP from the bring-up config navigates (issue #293)", () => {
  test(
    "browser_navigate to a local page returns its title, not a missing-chrome error",
    async () => {
      const server = bringupPlaywright(CHROMIUM as string);
      expect(server.args).toContain("--executable-path");

      const page = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("<title>fleet-mcp-293</title><h1>ok</h1>", { headers: { "content-type": "text/html" } }),
      });
      const cwd = mkdtempSync(join(tmpdir(), "fleet-mcp-cwd-"));
      dirs.push(cwd);
      const proc = Bun.spawn([server.command, ...server.args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        const reader = proc.stdout.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const send = (msg: unknown) => {
          proc.stdin.write(`${JSON.stringify(msg)}\n`);
          proc.stdin.flush();
        };
        const recv = async (id: number): Promise<{ result?: { content: { text: string }[]; isError?: boolean } }> => {
          for (;;) {
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              const msg = JSON.parse(line);
              if (msg.id === id) return msg;
              continue;
            }
            const { value, done } = await reader.read();
            if (done) throw new Error(`MCP server exited before answering request ${id}`);
            buf += dec.decode(value);
          }
        };

        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fleet-test", version: "0" } },
        });
        await recv(1);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "browser_navigate", arguments: { url: `http://127.0.0.1:${page.port}/` } },
        });
        const res = await recv(2);
        const text = res.result?.content.map((c) => c.text).join("\n") ?? "";
        expect(text).not.toContain("is not found at");
        expect(res.result?.isError).toBeFalsy();
        expect(text).toContain("fleet-mcp-293");
      } finally {
        proc.kill();
        await proc.exited;
        page.stop(true);
      }
    },
    180_000,
  );
});
