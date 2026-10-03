// apps/fleet/cli/junior.ts — `fleet junior enable|disable|status|stats`.
// enable/disable/status: local opt-in for the junior skill. Nothing is
// installed until enable runs. The config path must equal
// skills/junior/src/auth.ts's juniorConfigPath — pinned by
// test/bun/junior-local-cli.test.ts.
// stats (issue #218): the ONE action here that is not purely local — it
// calls the Worker's `GET /studio/junior/usage` (Access-JWT authenticated,
// apps/fleet/src/junior/usage.ts's handleJuniorUsageStats) and merges that
// with this machine's own local usage log (skills/junior/src/usage.ts's
// recordUsageLocal writes it; same jsonl path, read here directly rather
// than duplicating the path literal).
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credentials } from "./fleet";
import { juniorUsageLogPath } from "../../../skills/junior/src/usage";

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

// ---------------------------------------------------------------------------
// fleet junior stats — issue #218

export interface JuniorStatsRow { id: string; calls: number; inputTokens: number; outputTokens: number }

interface RemoteUsageAggregate {
  rows: { studioId: string; calls: number; inputTokens: number; outputTokens: number }[];
  totals: { calls: number; inputTokens: number; outputTokens: number };
}

/**
 * `--since <dur|date>` -> an epoch-ms cutoff. `\d+[hd]` is hours/days ago
 * from now; anything else is handed to `Date` as an ISO date/datetime. No
 * `--since` at all means "all time" (0). A string neither shape can parse
 * is reported as `{error}`, never silently treated as "all time".
 */
export function parseSinceArg(since: string | undefined): number | { error: string } {
  if (since === undefined) return 0;
  const dur = /^(\d+)([hd])$/.exec(since);
  if (dur) {
    const n = Number(dur[1]);
    const unitMs = dur[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return Date.now() - n * unitMs;
  }
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return { error: `bad --since value ${JSON.stringify(since)} (expected e.g. 24h, 7d, or an ISO date)` };
  return t;
}

/** Reads this machine's own usage log (never a crash on a missing file —
 *  no local calls ever made is the ordinary, not an error, case), filters to
 *  `ts >= sinceMs`, and aggregates per `id` (normally just one: this
 *  machine's own hostname — recordUsageLocal's only writer). */
function readLocalUsage(sinceMs: number): JuniorStatsRow[] {
  const path = juniorUsageLogPath(process.env.HOME || homedir());
  if (!existsSync(path)) return [];
  const byId = new Map<string, JuniorStatsRow>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: { ts: number; id: string; input_tokens: number; output_tokens: number };
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (row.ts < sinceMs) continue;
    const agg = byId.get(row.id) ?? { id: row.id, calls: 0, inputTokens: 0, outputTokens: 0 };
    agg.calls += 1;
    agg.inputTokens += row.input_tokens;
    agg.outputTokens += row.output_tokens;
    byId.set(row.id, agg);
  }
  return [...byId.values()];
}

/** Same column-table house style as task-format.ts's formatTaskTable: a
 *  header row, one row per id, widths computed from the longest cell in each
 *  column, padded with two spaces between columns. A TOTAL row closes it. */
export function formatJuniorStats(rows: JuniorStatsRow[]): string {
  const totals = rows.reduce(
    (acc, r) => ({ calls: acc.calls + r.calls, inputTokens: acc.inputTokens + r.inputTokens, outputTokens: acc.outputTokens + r.outputTokens }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );
  const headers = ["ID", "CALLS", "INPUT TOKENS", "OUTPUT TOKENS"];
  const body = rows.map((r) => [r.id, String(r.calls), String(r.inputTokens), String(r.outputTokens)]);
  const totalRow = ["TOTAL", String(totals.calls), String(totals.inputTokens), String(totals.outputTokens)];
  const allRows = [...body, totalRow];
  const widths = headers.map((h, i) => Math.max(h.length, ...allRows.map((r) => r[i].length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...allRows.map(line)].join("\n");
}

/**
 * `fleet junior stats [--since <dur|date>]`. Fetches the Worker's aggregate
 * (one row per studio) and merges it with this machine's own local rows
 * (laptop/direct-transport calls, never recorded server-side). A Worker
 * failure (network error, non-ok response) is reported to stderr but does
 * NOT fail the command — this is a read/reporting verb, and local data is
 * still worth printing when the Worker cannot be reached.
 */
export async function cmdJuniorStats(creds: Credentials, since?: string): Promise<void> {
  const sinceResult = parseSinceArg(since);
  if (typeof sinceResult !== "number") {
    console.error(`fleet junior stats: ${sinceResult.error}`);
    process.exit(1);
  }
  const sinceMs = sinceResult;
  const localRows = readLocalUsage(sinceMs);

  let remoteRows: JuniorStatsRow[] = [];
  try {
    const url = new URL("/studio/junior/usage", creds.workerUrl);
    url.searchParams.set("since", String(sinceMs));
    const res = await fetch(url.toString(), {
      headers: { "CF-Access-Client-Id": creds.accessClientId, "CF-Access-Client-Secret": creds.accessClientSecret },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as RemoteUsageAggregate;
    remoteRows = body.rows.map((r) => ({ id: r.studioId, calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens }));
  } catch (e) {
    console.error(`fleet junior stats: fleet-wide stats unavailable (${e instanceof Error ? e.message : String(e)}) — showing local-only`);
  }

  console.log(formatJuniorStats([...remoteRows, ...localRows]));
}
