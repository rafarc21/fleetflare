// apps/fleet/src/creds/test-creds.ts
// GET /fleet/creds/<name> — issue #279. A studio fetches ONE staging test
// login (a non-admin account, say) without ever holding an Infisical
// credential: the Worker holds a machine identity (Universal Auth), logs in,
// reads the one allowlisted secret and hands back its value. Spawn-token auth,
// same as /fleet/tasks and /fleet/junior.
//
// Three rules this file exists to keep:
//   - Per-repo allowlist (TEST_CREDS_BY_REPO). A studio gets only names listed
//     under the repo the Worker bound it to, never another repo's.
//   - The guard: a config holding ANY entry outside a staging-like
//     environment or outside /test-accounts, or anything admin-looking, is
//     refused whole. Fail closed — no partial serving of a config someone
//     got wrong.
//   - Audit every call, never the value. The value exists in exactly one
//     place on the way out: the 200 body to the studio that asked.
import type { Env } from "../env";
import { isSpawnTokenShaped, resolveSpawnParent, SPAWN_TOKEN_HEADER } from "../studio/spawn";
import { listStudios } from "../studio/registry";
import type { StudioStatus } from "../studio/types";

export const CREDS_PREFIX = "/fleet/creds/";
const DEFAULT_API_URL = "https://app.infisical.com";
/** Refresh this long before Infisical's own expiry, so a token never dies mid-read. */
const TOKEN_MARGIN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface TestCredEntry {
  workspaceId: string;
  environment: string;
  secretPath: string;
  key: string;
}
/** repo slug -> credential name -> where it lives. Null-prototype maps. */
export type TestCredsConfig = Record<string, Record<string, TestCredEntry>>;

const ALLOWED_ENVIRONMENTS = new Set(["staging", "dev", "development", "test"]);
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Leading alnum: a key of `.` or `..` would turn `/raw/<key>` into another endpoint.
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TEST_ROOT = "/test-accounts";

/** Every segment after the root a plain name: no `..`, `.`, or empty segment. */
function isTestAccountsPath(p: string): boolean {
  if (p === TEST_ROOT) return true;
  if (!p.startsWith(`${TEST_ROOT}/`)) return false;
  return p.slice(TEST_ROOT.length + 1).split("/").every((s) => /^[A-Za-z0-9_-]+$/.test(s));
}

function entryProblem(name: string, raw: unknown): string | null {
  if (!NAME_RE.test(name)) return `name "${name}" is not [a-z0-9_-]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "entry is not an object";
  const e = raw as Record<string, unknown>;
  for (const f of ["workspaceId", "environment", "secretPath", "key"] as const) {
    if (typeof e[f] !== "string" || e[f] === "") return `${f} missing or not a string`;
  }
  const { environment, secretPath, key } = e as unknown as TestCredEntry;
  // Exact match: Infisical environment slugs are case-sensitive.
  if (!ALLOWED_ENVIRONMENTS.has(environment)) {
    return `environment "${environment}" is not staging/dev/test`;
  }
  if (!isTestAccountsPath(secretPath)) return `secretPath "${secretPath}" is outside ${TEST_ROOT}`;
  if (!KEY_RE.test(key)) return "key must start alphanumeric, then [A-Za-z0-9_.-]";
  if ([name, key, secretPath].some((s) => /admin/i.test(s))) return "admin credentials are out of scope";
  return null;
}

/**
 * Parses and guards TEST_CREDS_BY_REPO. Any one bad entry refuses the whole
 * config, and the error names where (repo/name), never a value — the config
 * holds only locations, but the message is still logged.
 */
export function parseTestCredsConfig(raw: string): { ok: true; value: TestCredsConfig } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: "not JSON" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "top level must be an object of repo -> names" };
  }
  const out: TestCredsConfig = Object.create(null);
  for (const [repo, names] of Object.entries(parsed)) {
    if (!SLUG_RE.test(repo)) return { ok: false, error: `"${repo}" is not owner/repo` };
    if (typeof names !== "object" || names === null || Array.isArray(names)) {
      return { ok: false, error: `${repo}: must be an object of name -> entry` };
    }
    const byName: Record<string, TestCredEntry> = Object.create(null);
    for (const [name, entry] of Object.entries(names)) {
      const problem = entryProblem(name, entry);
      if (problem) return { ok: false, error: `${repo}/${name}: ${problem}` };
      const { workspaceId, environment, secretPath, key } = entry as TestCredEntry;
      byName[name] = { workspaceId, environment, secretPath, key };
    }
    out[repo.toLowerCase()] = byName;
  }
  return { ok: true, value: out };
}

/** The entry `name` under `repo`, or null. Own keys only — never a prototype hit. */
export function lookupTestCred(cfg: TestCredsConfig, repo: string, name: string): TestCredEntry | null {
  const byName = Object.hasOwn(cfg, repo.toLowerCase()) ? cfg[repo.toLowerCase()] : undefined;
  if (!byName || !Object.hasOwn(byName, name)) return null;
  return byName[name];
}

// --- Infisical ---------------------------------------------------------------

/** Module-level, so it lives as long as the isolate. Keyed by identity + host. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function __resetInfisicalTokenCacheForTests(): void {
  tokenCache.clear();
}

type Upstream = { ok: true; value: string } | { ok: false; status: number; message: string };

interface InfisicalIdentity { baseUrl: string; clientId: string; clientSecret: string }

async function login(id: InfisicalIdentity, f: typeof fetch, now: number): Promise<Upstream> {
  const cacheKey = `${id.baseUrl}\n${id.clientId}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return { ok: true, value: hit.token };
  let res: Response;
  try {
    res = await f(`${id.baseUrl}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: id.clientId, clientSecret: id.clientSecret }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, message: "infisical unreachable" };
  }
  // The upstream body is never read into a response or a log: an auth error
  // body may echo what was sent.
  if (!res.ok) return { ok: false, status: 502, message: `infisical login failed (${res.status})` };
  const body = await res.json().catch(() => null) as { accessToken?: unknown; expiresIn?: unknown } | null;
  if (typeof body?.accessToken !== "string" || body.accessToken === "") {
    return { ok: false, status: 502, message: "infisical login returned no token" };
  }
  const ttlMs = typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn * 1000 : 0;
  tokenCache.set(cacheKey, { token: body.accessToken, expiresAt: now + ttlMs - TOKEN_MARGIN_MS });
  return { ok: true, value: body.accessToken };
}

async function readSecret(id: InfisicalIdentity, entry: TestCredEntry, f: typeof fetch, now: number): Promise<Upstream> {
  const token = await login(id, f, now);
  if (!token.ok) return token;
  const url = new URL(`${id.baseUrl}/api/v3/secrets/raw/${encodeURIComponent(entry.key)}`);
  url.searchParams.set("workspaceId", entry.workspaceId);
  url.searchParams.set("environment", entry.environment);
  url.searchParams.set("secretPath", entry.secretPath);
  // An import or a ${ref} could resolve to a value outside /test-accounts,
  // past the path guard. Both off, explicitly, never left to the default.
  url.searchParams.set("include_imports", "false");
  url.searchParams.set("expandSecretReferences", "false");
  let res: Response;
  try {
    res = await f(url.toString(), {
      headers: { authorization: `Bearer ${token.value}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, message: "infisical unreachable" };
  }
  if (res.status === 401 || res.status === 403) {
    // A revoked or expired token: drop it so the next call logs in fresh.
    tokenCache.delete(`${id.baseUrl}\n${id.clientId}`);
    return { ok: false, status: 502, message: `infisical refused the read (${res.status})` };
  }
  if (res.status === 404) return { ok: false, status: 404, message: "credential not found in infisical" };
  if (!res.ok) return { ok: false, status: 502, message: `infisical read failed (${res.status})` };
  const body = await res.json().catch(() => null) as
    { secret?: { secretValue?: unknown; secretValueHidden?: unknown } } | null;
  // A hidden value is Infisical's placeholder, never the password.
  if (body?.secret?.secretValueHidden === true) {
    return { ok: false, status: 403, message: "infisical identity cannot read secret values" };
  }
  const value = body?.secret?.secretValue;
  if (typeof value !== "string") return { ok: false, status: 502, message: "infisical returned no value" };
  return { ok: true, value };
}

// --- Route -------------------------------------------------------------------

export type CredsOutcome =
  | "allowed" | "denied" | "unauthorized" | "not_configured" | "config_invalid" | "not_found" | "upstream_error";

export interface CredsAudit { event: "fleet_creds"; studio: string | null; name: string; outcome: CredsOutcome; at: string }

export interface CredsDeps {
  rows?: () => Promise<StudioStatus[]>;
  fetch?: typeof fetch;
  now?: () => number;
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "cache-control": "no-store" } });

export async function handleFleetCreds(req: Request, env: Env, deps: CredsDeps = {}): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  if (!pathname.startsWith(CREDS_PREFIX)) return text("not found", 404);
  if (req.method !== "GET") return text("method not allowed", 405);
  const name = pathname.slice(CREDS_PREFIX.length);
  const now = deps.now ?? Date.now;
  // The one place a call is recorded. Built from fields the Worker resolved;
  // there is no value field to forget to strip.
  const audit = (studio: string | null, outcome: CredsOutcome) => {
    const rec: CredsAudit = { event: "fleet_creds", studio, name: name.slice(0, 64), outcome, at: new Date(now()).toISOString() };
    console.log(JSON.stringify(rec));
  };

  const presented = req.headers.get(SPAWN_TOKEN_HEADER);
  const studio = isSpawnTokenShaped(presented)
    ? await resolveSpawnParent(await (deps.rows ?? (() => listStudios(env)))(), presented)
    : null;
  if (!studio) {
    audit(null, "unauthorized");
    return text("unauthorized", 401);
  }
  if (!NAME_RE.test(name)) {
    audit(studio.id, "denied");
    return text("bad credential name", 400);
  }

  if (!env.INFISICAL_CLIENT_ID || !env.INFISICAL_CLIENT_SECRET || !env.TEST_CREDS_BY_REPO) {
    audit(studio.id, "not_configured");
    return text("test creds not configured", 503);
  }
  const cfg = parseTestCredsConfig(env.TEST_CREDS_BY_REPO);
  const baseUrl = (env.INFISICAL_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  if (!cfg.ok || !baseUrl.startsWith("https://")) {
    console.error(`fleet_creds: config refused: ${cfg.ok ? "INFISICAL_API_URL must be https" : cfg.error}`);
    audit(studio.id, "config_invalid");
    return text("test creds config invalid — see Worker logs", 503);
  }

  const repo = studio.repoSlug ?? env.AGENT_REPO;
  const entry = lookupTestCred(cfg.value, repo, name);
  if (!entry) {
    audit(studio.id, "denied");
    return text(`"${name}" is not an allowlisted test credential for this studio's repo`, 403);
  }

  // Resolved at call time, not import time, so a test's spy on the global sees it.
  const f = deps.fetch ?? ((input, init) => fetch(input, init));
  const got = await readSecret(
    { baseUrl, clientId: env.INFISICAL_CLIENT_ID, clientSecret: env.INFISICAL_CLIENT_SECRET }, entry, f, now(),
  );
  if (!got.ok) {
    audit(studio.id, got.status === 404 ? "not_found" : "upstream_error");
    return text(got.message, got.status);
  }
  audit(studio.id, "allowed");
  return new Response(JSON.stringify({ name, value: got.value }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
