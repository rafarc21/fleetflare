/**
 * Issue #7: POST /fleet/gh -- a studio's gh writes on a public repo.
 *
 * The studio's own token is read-only in proxy mode (mode.ts), so the gh
 * wrapper hands these verbs to fleet-gh-proxy (container/gh-proxy.ts), which
 * posts one op here. The Worker validates the op against a closed allowlist,
 * scans every string in it with the ops denylist (board/leak.ts's leakGuard:
 * fail closed, pattern index only), then calls GitHub with its OWN token on
 * the studio's own work repo.
 *
 * Deliberately fixed ops, not a REST or GraphQL passthrough: gh's writes are
 * GraphQL mutations (a real allowlist would need a GraphQL parser, and aliases
 * obfuscate), and a REST passthrough reaches base64 bodies (contents, blobs,
 * release assets) a text scan cannot read.
 */
import type { Env } from "../env";
import { LeakGateError, leakGuard, type LeakCheck } from "../board/leak";
import { realLeakDeps } from "../board/routes";
import { listStudios } from "../studio/registry";
import type { StudioStatus } from "../studio/types";
import { mintRepoToken, repoOwner, repoToken, resolveRepoAuthKind } from "../github/auth";
import { USER_AGENT } from "../github/app";
import { studioFromRequest, studioWorkRepo } from "./studio-auth";
import { readCapped } from "./git-route";

export const GH_OP_BODY_CAP = 1024 * 1024;

export type GhOp = { repo?: string } & (
  | { op: "pr-create"; title: string; body: string; head: string; base: string; draft: boolean }
  | { op: "pr-edit"; number: number; title?: string; body?: string; base?: string }
  | { op: "pr-ready"; number: number }
  | { op: "comment"; number: number; body: string }
  | { op: "issue-create"; title: string; body: string; labels: string[] }
  | { op: "issue-edit"; number: number; title?: string; body?: string }
  | { op: "pr-review"; number: number; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string });

export class GhOpError extends Error {}

type Kind = "string" | "string?" | "number" | "boolean" | "strings" | "event";

/** Every op may name the repo the caller meant (gh -R, an issue URL). A
 *  repo other than the studio's own is refused, never silently rewritten. */
const COMMON: Record<string, Kind> = { repo: "string?" };
const SHAPES: Record<GhOp["op"], Record<string, Kind>> = {
  "pr-create": { title: "string", body: "string", head: "string", base: "string", draft: "boolean" },
  "pr-edit": { number: "number", title: "string?", body: "string?", base: "string?" },
  "pr-ready": { number: "number" },
  "comment": { number: "number", body: "string" },
  "issue-create": { title: "string", body: "string", labels: "strings" },
  "issue-edit": { number: "number", title: "string?", body: "string?" },
  "pr-review": { number: "number", event: "event", body: "string" },
};

function fits(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "string": return typeof v === "string";
    case "string?": return v === undefined || typeof v === "string";
    case "number": return typeof v === "number" && Number.isInteger(v) && v > 0;
    case "boolean": return typeof v === "boolean";
    case "strings": return Array.isArray(v) && v.every((s) => typeof s === "string");
    case "event": return v === "COMMENT" || v === "APPROVE" || v === "REQUEST_CHANGES";
  }
}

/** The op, or GhOpError: unknown op, a missing/extra field, a wrong type, an
 *  edit that changes nothing. */
export function parseGhOp(raw: unknown): GhOp {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new GhOpError("body must be a JSON object");
  const obj = raw as Record<string, unknown>;
  const op = obj.op;
  if (typeof op !== "string" || !Object.hasOwn(SHAPES, op)) throw new GhOpError(`unsupported op ${JSON.stringify(op)}`);
  const shape = { ...SHAPES[op as GhOp["op"]], ...COMMON };
  for (const key of Object.keys(obj)) {
    if (key !== "op" && !Object.hasOwn(shape, key)) throw new GhOpError(`unexpected field ${JSON.stringify(key)}`);
  }
  for (const [key, kind] of Object.entries(shape)) {
    if (!fits(kind, obj[key])) throw new GhOpError(`field ${JSON.stringify(key)} must be ${kind}`);
  }
  if ((op === "pr-edit" || op === "issue-edit") && Object.keys(obj).filter((k) => k !== "repo").length <= 2) {
    throw new GhOpError(`${op} changes nothing`);
  }
  return obj as unknown as GhOp;
}

/** Every string the op would write. */
function opTexts(op: GhOp): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(op)) {
    if (k === "op" || k === "repo") continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...v);
  }
  return out;
}

export interface GhCall { method: "GET" | "POST" | "PATCH"; path: string; body: unknown }

const READY_MUTATION =
  "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }";

function restCall(op: Exclude<GhOp, { op: "pr-ready" }>, repo: string): GhCall {
  const r = `/repos/${repo}`;
  switch (op.op) {
    case "pr-create": { const { op: _, repo: _r, ...body } = op; return { method: "POST", path: `${r}/pulls`, body }; }
    case "issue-create": { const { op: _, repo: _r, ...body } = op; return { method: "POST", path: `${r}/issues`, body }; }
    case "pr-edit": { const { op: _, repo: _r, number, ...body } = op; return { method: "PATCH", path: `${r}/pulls/${number}`, body }; }
    case "issue-edit": { const { op: _, repo: _r, number, ...body } = op; return { method: "PATCH", path: `${r}/issues/${number}`, body }; }
    case "comment": return { method: "POST", path: `${r}/issues/${op.number}/comments`, body: { body: op.body } };
    case "pr-review": return { method: "POST", path: `${r}/pulls/${op.number}/reviews`, body: { event: op.event, body: op.body } };
  }
}

export interface GhProxyPorts {
  rows: () => Promise<StudioStatus[]>;
  defaultRepo: string;
  /** One GitHub API call with the Worker's write token for `repo`. */
  github: (call: GhCall, repo: string) => Promise<Response>;
  check: LeakCheck;
}

const text = (body: string, status: number) => new Response(body, { status });


export async function handleGhProxy(req: Request, ports: GhProxyPorts): Promise<Response> {
  const studio = await studioFromRequest(req, await ports.rows());
  if (!studio) return text("unauthorized", 401);
  if (req.method !== "POST") return text("method not allowed", 405);
  const bytes = await readCapped(req.body, GH_OP_BODY_CAP);
  if (bytes === null) return text("payload too large", 413);
  const raw = new TextDecoder().decode(bytes);
  let op: GhOp;
  try {
    op = parseGhOp(JSON.parse(raw));
  } catch (err) {
    return text(`fleet: /fleet/gh: ${err instanceof GhOpError ? err.message : "bad json"}`, 400);
  }
  const repo = studioWorkRepo(studio, ports.defaultRepo);
  if (op.repo !== undefined && op.repo.toLowerCase() !== repo) {
    return text(`fleet: this studio writes only its own work repo ${repo}, not ${op.repo}`, 403);
  }
  try {
    await ports.check(repo, opTexts(op));
  } catch (err) {
    if (err instanceof LeakGateError) return text(err.message, err.status);
    return text("fleet: leak gate: scanner error -- refusing (fail closed)", 503);
  }
  if (op.op !== "pr-ready") {
    const res = await ports.github(restCall(op, repo), repo);
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  }
  // gh pr ready is GraphQL-only: the PR's node id, then one fixed mutation.
  const pr = await ports.github({ method: "GET", path: `/repos/${repo}/pulls/${op.number}`, body: undefined }, repo);
  if (!pr.ok) return new Response(await pr.text(), { status: pr.status });
  const { node_id, html_url } = (await pr.json()) as { node_id?: string; html_url?: string };
  if (typeof node_id !== "string") return text("fleet: /fleet/gh: pull request has no node id", 502);
  const res = await ports.github({ method: "POST", path: "/graphql", body: { query: READY_MUTATION, variables: { id: node_id } } }, repo);
  const out = (await res.json().catch(() => null)) as { errors?: { message?: string }[] } | null;
  if (!res.ok || out === null || (out.errors?.length ?? 0) > 0) {
    return text(`fleet: /fleet/gh: pr-ready failed: ${out?.errors?.map((e) => e.message).join("; ") ?? res.status}`, 502);
  }
  return Response.json({ ok: true, html_url });
}

/** The Worker's write credential for `repo`: never reaches a container. */
export async function workerWriteToken(env: Env, repo: string, permissions?: Record<string, string>): Promise<string> {
  if (resolveRepoAuthKind(env, repo) === "token") return repoToken(env, repoOwner(repo)) as string;
  return mintRepoToken(env, repo, permissions ? { permissions } : undefined);
}

export async function handleFleetGh(req: Request, env: Env): Promise<Response> {
  let token: Promise<string> | null = null;
  const readToken = (repo: string) => mintRepoToken(env, repo, { permissions: { contents: "read" } });
  return handleGhProxy(req, {
    rows: () => listStudios(env),
    defaultRepo: env.AGENT_REPO,
    check: leakGuard(realLeakDeps(env, readToken)),
    github: async (call, repo) => {
      token ??= workerWriteToken(env, repo, { pull_requests: "write", issues: "write" });
      return fetch(`https://api.github.com${call.path}`, {
        method: call.method,
        headers: {
          authorization: `Bearer ${await token}`, accept: "application/vnd.github+json",
          "user-agent": USER_AGENT, "content-type": "application/json",
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      });
    },
  });
}
