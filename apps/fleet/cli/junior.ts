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

// lstat, never stat: a DANGLING symlink (its target moved or was deleted)
// still exists as a symlink, and readlinkSync still reports what it points
// at. stat here would follow the (broken) link, throw ENOENT, and this would
// misreport "absent" — letting enable call symlinkSync on top of a path that
// already has an inode, which throws EEXIST instead of doing anything useful.
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
  // resolveTransport (Task 3) throws AuthError before ever reaching wrangler
  // when no account id is configured anywhere, so naming "wrangler" here in
  // that case would claim a path that can never actually be taken.
  const auth = account === "(none)" ? "(no account — see above)"
    : env.FLEET_WORKER_URL && env.FLEET_SPAWN_TOKEN ? "proxy" : env.CLOUDFLARE_API_TOKEN ? "api-token" : "wrangler";
  return { ok: true, lines: [`enabled: ${state === "ours" ? "yes" : state === "foreign" ? "no (foreign dir in the way)" : "no"}`, `account: ${account}`, `auth: ${auth}`] };
}

export function cmdJunior(parsed: { action: "enable" | "disable" | "status"; account?: string }): number {
  const p = juniorPaths(process.env.HOME ?? "", join(import.meta.dir, "../../.."));
  const out = parsed.action === "enable" ? juniorEnable(p, parsed.account)
    : parsed.action === "disable" ? juniorDisable(p) : juniorStatus(p, process.env);
  for (const l of out.lines) (out.ok ? console.log : console.error)(l);
  return out.ok ? 0 : 1;
}
