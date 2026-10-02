#!/usr/bin/env bun
// Issue #204: wrangler auto-loads `.env`/`.env.local` (and, with an env,
// `.env.<env>`/`.env.<env>.local`) from ITS OWN cwd into process.env BEFORE
// it reads the config or authenticates. scripts/deploy.sh `cd`s into the app
// dir before `exec`-ing wrangler, so a stray CLOUDFLARE_* or WRANGLER_* var
// left in that app dir's `.env` -- e.g. a CLOUDFLARE_ACCOUNT_ID left over
// from local `wrangler dev` against a sandbox account -- silently overrides
// whatever the operator exported on the command line. Reported symptom:
// `d1 migrations apply fleet --remote` failed with Cloudflare API error
// [code: 7403] "account not authorized", while the identical bare
// `wrangler d1 migrations apply fleet --remote` (a different cwd, so no
// .env ever loaded) worked.
//
// scripts/deploy-target.ts already carried this exact scan (issue #36/#48),
// but only runs for the subset of commands that replace the studio
// containers (replaces_containers in deploy.sh) -- never for `d1`, `secret`,
// `kv`, `r2`, or any other non-read-only wrangler subcommand. This module is
// the shared, de-duplicated scan: deploy-target.ts calls it for its own
// gated commands, and scripts/deploy.sh calls this file's CLI directly for
// EVERY non-read-only command, closing that gap.
//
// Usage (from scripts/deploy.sh only): bun deploy-env-guard.ts <appDir> [envName]
// Exit 0: no CLOUDFLARE_*/WRANGLER_* var found in any dotenv file wrangler
// would load from appDir. Exit 1: one was found (message on stderr).
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure. Scans, in order, `.env`, `.env.local`, and — when `envName` is given
 * — `.env.<envName>`, `.env.<envName>.local` inside `appDir` (the same
 * files, same order, wrangler itself loads from its cwd). Returns the first
 * `CLOUDFLARE_*`/`WRANGLER_*` key found (case-insensitive) and the absolute
 * path of the file that sets it, or `null` if none of the files exist or set
 * one.
 */
export function findDotenvVar(appDir: string, envName?: string): { file: string; key: string } | null {
  const dotenvFiles = [".env", ".env.local", ...(envName ? [`.env.${envName}`, `.env.${envName}.local`] : [])];
  for (const f of dotenvFiles) {
    const file = join(appDir, f);
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hit = body
      .split(/\r?\n/)
      .map((l) => /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/.exec(l)?.[1])
      .find((k) => k !== undefined && /^(CLOUDFLARE_|WRANGLER_)/i.test(k));
    if (hit) return { file, key: hit };
  }
  return null;
}

if (import.meta.main) {
  const [appDir, envName] = process.argv.slice(2);
  const hit = findDotenvVar(appDir, envName || undefined);
  if (hit) {
    console.error(
      `deploy-env-guard: ${hit.file} sets ${hit.key}. Wrangler auto-loads this file into its environment from its ` +
        "own cwd BEFORE reading the config or authenticating, so a CLOUDFLARE_*/WRANGLER_* var in it can silently " +
        "retarget a deploy to the wrong, unauthorized account (issue #204: a stray CLOUDFLARE_ACCOUNT_ID sent a " +
        'real D1 migration to the wrong account, Cloudflare API error [code: 7403] "account not authorized").',
    );
    console.error(`deploy-env-guard: move ${hit.key} to the shell environment, or remove it from ${hit.file}.`);
    process.exit(1);
  }
  process.exit(0);
}
