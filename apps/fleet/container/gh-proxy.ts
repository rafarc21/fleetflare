#!/usr/bin/env bun
/**
 * Issue #7: fleet-gh-proxy. In write-proxy mode the gh wrapper hands gh's
 * write verbs here. This translates gh's argv into one fixed op and POSTs it
 * to the Worker's /fleet/gh route, which scans every string and calls GitHub
 * with its own write token. The studio's own token is read-only.
 */
import { readFileSync } from "node:fs";

export class UsageError extends Error {}

export type GhOp =
  | { op: "pr-create"; title: string; body: string; head: string; base: string; draft: boolean }
  | { op: "pr-edit"; number: number; title?: string; body?: string; base?: string }
  | { op: "pr-ready"; number: number }
  | { op: "comment"; number: number; body: string }
  | { op: "issue-create"; title: string; body: string; labels: string[] }
  | { op: "issue-edit"; number: number; title?: string; body?: string }
  | { op: "pr-review"; number: number; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string };

export interface TranslateCtx {
  readFile(path: string): string;
  stdin(): string;
  currentBranch(): string;
  prNumber(selector?: string): number;
  defaultBranch(): string;
}

const SUPPORTED = "pr create|edit|ready|comment|review, issue create|edit|comment";

type Key = "title" | "body" | "body-file" | "base" | "head" | "draft" | "label" | "approve" | "comment" | "request-changes";

// Per-verb flag tables: long name -> key, short -> key. `-c` means
// --comment only under `pr review`, so each verb gets its own table.
const F: Record<Key, { short?: string; bool?: boolean }> = {
  title: { short: "t" },
  body: { short: "b" },
  "body-file": { short: "F" },
  base: { short: "B" },
  head: { short: "H" },
  draft: { short: "d", bool: true },
  label: { short: "l" },
  approve: { short: "a", bool: true },
  comment: { short: "c", bool: true },
  "request-changes": { short: "r", bool: true },
};

const VERBS: Record<string, Key[]> = {
  "pr create": ["title", "body", "body-file", "base", "head", "draft"],
  "pr edit": ["title", "body", "body-file", "base"],
  "pr ready": [],
  "pr comment": ["body", "body-file"],
  "pr review": ["body", "body-file", "approve", "comment", "request-changes"],
  "issue create": ["title", "body", "body-file", "label"],
  "issue edit": ["title", "body", "body-file"],
  "issue comment": ["body", "body-file"],
};

/** Strip the global -R/--repo (studio is bound to one repo; Worker enforces). */
function stripRepo(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-R" || a === "--repo") { i++; continue; }
    if (a.startsWith("--repo=") || (a.startsWith("-R") && a.length > 2)) continue;
    out.push(a);
  }
  return out;
}

export function translate(argv: string[], ctx: TranslateCtx): GhOp {
  const [group, verb, ...rest] = stripRepo(argv);
  const name = `${group ?? ""} ${verb ?? ""}`;
  const allowed = VERBS[name];
  if (!allowed) throw new UsageError(`unsupported command: gh ${name.trim()}`);

  const vals: Partial<Record<Key, string>> = {};
  const bools = new Set<Key>();
  const labels: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("-") || a === "-") { positionals.push(a); continue; }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flagName = eq >= 0 ? a.slice(0, eq) : a;
    const key = allowed.find((k) => flagName === `--${k}` || (F[k].short && flagName === `-${F[k].short}`));
    if (!key) throw new UsageError(`unsupported flag ${flagName}`);
    if (F[key].bool) {
      if (eq >= 0) throw new UsageError(`flag ${flagName} takes no value`);
      bools.add(key);
      continue;
    }
    let v: string | undefined;
    if (eq >= 0) v = a.slice(eq + 1);
    else { v = rest[++i]; if (v === undefined) throw new UsageError(`flag ${flagName} needs a value`); }
    if (key === "label") labels.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
    else vals[key] = v;
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`);

  let body = vals.body;
  if (vals["body-file"] !== undefined) {
    const p = vals["body-file"];
    body = p === "-" ? ctx.stdin() : ctx.readFile(p);
  }

  const sel = positionals[0];
  const number = (): number => {
    if (sel === undefined) {
      if (group === "issue") throw new UsageError(`gh issue ${verb} needs an issue number or URL`);
      return ctx.prNumber();
    }
    if (/^\d+$/.test(sel)) return Number(sel);
    const m = sel.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)(?:[/?#].*)?$/);
    if (m) return Number(m[2]);
    if (group === "issue") throw new UsageError(`not an issue number or URL: ${sel}`);
    return ctx.prNumber(sel);
  };

  switch (name) {
    case "pr create":
    case "issue create": {
      if (sel !== undefined) throw new UsageError(`unexpected argument ${sel}`);
      if (vals.title === undefined) throw new UsageError("pass --title and --body");
      if (group === "issue") return { op: "issue-create", title: vals.title, body: body ?? "", labels };
      return {
        op: "pr-create",
        title: vals.title,
        body: body ?? "",
        head: vals.head ?? ctx.currentBranch(),
        base: vals.base ?? ctx.defaultBranch(),
        draft: bools.has("draft"),
      };
    }
    case "pr edit":
    case "issue edit": {
      const n = number();
      const changes: { title?: string; body?: string; base?: string } = {};
      if (vals.title !== undefined) changes.title = vals.title;
      if (body !== undefined) changes.body = body;
      if (vals.base !== undefined) changes.base = vals.base;
      if (Object.keys(changes).length === 0) throw new UsageError(`gh ${name}: nothing to change`);
      return group === "pr" ? { op: "pr-edit", number: n, ...changes } : { op: "issue-edit", number: n, ...changes };
    }
    case "pr ready":
      return { op: "pr-ready", number: number() };
    case "pr comment":
    case "issue comment": {
      if (body === undefined) throw new UsageError("pass --body or --body-file");
      return { op: "comment", number: number(), body };
    }
    case "pr review": {
      const events = (["approve", "comment", "request-changes"] as const).filter((k) => bools.has(k));
      if (events.length !== 1) throw new UsageError("pass exactly one of --approve, --comment, --request-changes");
      const event = events[0] === "approve" ? "APPROVE" : events[0] === "comment" ? "COMMENT" : "REQUEST_CHANGES";
      return { op: "pr-review", number: number(), event, body: body ?? "" };
    }
  }
  throw new UsageError(`unsupported command: gh ${name}`);
}

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

async function main(): Promise<number> {
  const url = process.env.FLEET_WORKER_URL;
  const token = process.env.FLEET_SPAWN_TOKEN;
  if (!url || !token) {
    console.error("fleet-gh-proxy: FLEET_WORKER_URL and FLEET_SPAWN_TOKEN must be set");
    return 1;
  }
  const ctx: TranslateCtx = {
    readFile: (p) => readFileSync(p, "utf8"),
    stdin: () => readFileSync(0, "utf8"),
    currentBranch: () => run(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
    prNumber: (sel) => {
      const n = Number(run(["/usr/bin/gh", "pr", "view", ...(sel ? [sel] : []), "--json", "number", "-q", ".number"]));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`could not resolve PR number${sel ? ` for ${sel}` : ""}`);
      return n;
    },
    defaultBranch: () => run(["/usr/bin/gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]),
  };

  let op: GhOp;
  try {
    op = translate(process.argv.slice(2), ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`fleet-gh-proxy: ${e.message} (write proxy supports: ${SUPPORTED}; flags -t -b -F -B -H -d -l --approve --comment --request-changes)`);
      return 2;
    }
    console.error(`fleet-gh-proxy: ${(e as Error).message}`);
    return 1;
  }

  const res = await fetch(`${url.replace(/\/+$/, "")}/fleet/gh`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Fleet-Spawn-Token": token },
    body: JSON.stringify(op),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`fleet-gh-proxy: ${text}`);
    return 1;
  }
  let htmlUrl: unknown;
  try { htmlUrl = (JSON.parse(text) as { html_url?: unknown }).html_url; } catch { /* non-JSON 2xx: nothing to print */ }
  if (typeof htmlUrl === "string") console.log(htmlUrl);
  return 0;
}

if (import.meta.main) process.exit(await main());
