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
