/**
 * Worker-side Directus client. READ PATH ONLY in P5c.
 *
 * Two rules this file exists to hold, both from the P5 design:
 *
 * 1. THE WORKER WRITES; CONTAINERS NEVER HOLD DIRECTUS CREDENTIALS. §8's
 *    "single-writer extends to Directus" — Maestro decides, the Worker
 *    writes. Nothing in container/ imports this module, and the token is
 *    never threaded into a studio's environment (contrast
 *    ProvisionDeps/StudioDO.envVars, which is where a credential WOULD leak
 *    if someone added one). A studio that wants estate data asks the Worker.
 *
 * 2. TIERED EXPOSURE IS ENFORCED HERE, NOT AT THE CALL SITE. `?fields=` is
 *    built from schema.ts's allow-lists, so a studio-bound read does not put
 *    a price on the wire in the first place; the parsed object is then
 *    stripped again on the way out, because `fields=` is honoured by a server
 *    we do not own. See `fetchContractStakes`.
 *
 * FAIL-OPEN IS NOT THIS FILE'S JOB. Every function here throws on failure,
 * loudly and with the status in the message — that is what a Maestro-facing
 * route wants. card.ts's `resolveProjectCard` is the one place that swallows,
 * because provisioning is the one caller that must not be blockable. Mixing
 * the two policies into one layer is how a real outage becomes an invisible
 * empty card everywhere.
 */

import type { Env } from "../env";
import {
  COLLECTIONS, CONTRACT_STAKES_FIELDS, CONTRACT_COMMERCIAL_FIELDS, COMMERCIAL_ONLY_FIELDS,
} from "./schema";
import type {
  ContractCommercial, ContractStakes, EstateDecision, EstateProject,
  EstateRequest, EstateRequirement, Id, ProjectEstate,
} from "./types";

export interface DirectusConfig {
  /** Origin + optional base path, no trailing slash. */
  url: string;
  /** Static access token. Bearer-only; never logged, never in an error. */
  token: string;
}

/**
 * Hard ceiling on a single Directus response body. Same shape of guard
 * src/github/api.ts's BLUEPRINT_FILE_MAX_BYTES and paste.ts's
 * PASTE_MAX_BYTES already apply, and for the same reason: this text can end
 * up in a studio's system prompt, and "however much the upstream felt like
 * sending" is not a bound. Generous by orders of magnitude for a project
 * registry row (hundreds of bytes) — it exists to stop a pathological case,
 * not to trim.
 */
export const DIRECTUS_MAX_BYTES = 262_144; // 256KB

/**
 * Per-request timeout. Load-bearing on the provision path specifically: a
 * Directus that hangs (rather than refusing) would otherwise hold a studio's
 * bring-up open for the full subrequest budget, which is the "fifth store
 * blocks provisioning" failure the design forbids. Short enough that a card
 * lookup costs at most a few seconds even when everything is wrong; the
 * caller that cares (card.ts) then proceeds without a card.
 */
export const DIRECTUS_TIMEOUT_MS = 4_000;

/** How many requirement rows one list read will pull. Directus's own default
 *  limit is 100; a project with more requirements than this has a process
 *  problem before it has a paging problem, and a silent truncation is worse
 *  than a visible ceiling — `listRequirements` reports when it hits it. */
export const REQUIREMENTS_PAGE_LIMIT = 200;

/**
 * Resolves the two config values, or `null` for "Directus is not configured".
 *
 * `null` is a FIRST-CLASS, expected outcome, not an error: P5c ships without
 * a credential (the operator has not issued one), and everything downstream must work
 * in that state. Callers branch on null; nothing throws.
 *
 * Refuses a non-HTTPS URL outright. The token is a bearer credential, and a
 * Worker fetching `http://` puts it on the wire in the clear — a
 * misconfiguration worth failing closed on, since the failure mode of
 * proceeding is silent credential disclosure rather than a missing card.
 * (There is no localhost exemption: a Worker cannot reach the developer's
 * localhost anyway, so the exemption would only ever excuse a real mistake.)
 */
export function directusConfig(env: Env): DirectusConfig | null {
  // Board #334: operator-specific integration — off unless explicitly on,
  // whatever else is configured. One gate for every call site.
  if (env.FLEET_DIRECTUS !== "on") return null;
  const url = env.DIRECTUS_URL?.trim();
  const token = env.DIRECTUS_TOKEN?.trim();
  if (!url || !token) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn("directus: DIRECTUS_URL is not a valid URL — estate reads disabled");
    return null;
  }
  if (parsed.protocol !== "https:") {
    console.warn(`directus: DIRECTUS_URL must be https (got ${parsed.protocol}) — estate reads disabled`);
    return null;
  }
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * One GET against `/items/<collection>`, returning the unwrapped `data`.
 *
 * Errors carry the status and a truncated body, the same "pass the upstream's
 * own words through" convention src/github/api.ts uses — Directus's error
 * envelope names the missing collection or the failed permission check better
 * than we would. The TOKEN never appears in a message, and neither does any
 * request header; the only thing echoed is the response.
 */
async function directusGet<T>(
  cfg: DirectusConfig, collection: string, params: URLSearchParams,
): Promise<T> {
  const target = `${cfg.url}/items/${collection}?${params.toString()}`;
  const res = await fetch(target, {
    headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(DIRECTUS_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `directus ${collection} failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  }
  const text = await res.text();
  if (new TextEncoder().encode(text).length > DIRECTUS_MAX_BYTES) {
    throw new Error(`directus ${collection} response exceeds the ${DIRECTUS_MAX_BYTES}-byte cap`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A Directus behind a login page or an auth proxy answers 200 with HTML.
    // Naming that specifically beats "Unexpected token < in JSON".
    throw new Error(`directus ${collection} returned non-JSON (${text.slice(0, 120)})`);
  }
  if (body === null || typeof body !== "object" || !("data" in body)) {
    throw new Error(`directus ${collection} returned no \`data\` envelope`);
  }
  return (body as { data: T }).data;
}

/** The `?fields=`/`?filter=`/`?sort=` triple every read below builds. */
function query(fields: readonly string[], extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams();
  p.set("fields", fields.join(","));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

/** Directus JSON columns come back as whatever was stored. Validate, never
 *  cast — a `domains` column holding a string would otherwise render as
 *  individual characters in the project card. */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === 0 ? null : out;
}

/**
 * The project registry lookup. `key` is the STUDIO ID's repo segment (see
 * schema.ts's PROJECTS.key) — the only estate handle the Worker holds at
 * provision time.
 *
 * `null` means "no such project", which is the normal state for a repo nobody
 * has registered yet and must never be an error: the fleet works on repos
 * that have no contract.
 */
export async function fetchProjectByKey(
  cfg: DirectusConfig, key: string,
): Promise<EstateProject | null> {
  const rows = await directusGet<EstateProject[]>(cfg, COLLECTIONS.projects, query(
    ["id", "key", "name", "status", "repo", "cf_account", "infisical_project",
      "domains", "staging_url", "prod_url", "notes"],
    { "filter[key][_eq]": key, limit: "1" },
  ));
  const row = rows?.[0];
  if (!row) return null;
  return { ...row, domains: asStringArray(row.domains) };
}

/**
 * STAKES TIER. What every studio may see.
 *
 * Two independent defences, deliberately redundant:
 *   1. `?fields=` is CONTRACT_STAKES_FIELDS, so the commercial columns are
 *      not in the response body.
 *   2. every COMMERCIAL_ONLY_FIELDS key is deleted from the parsed object
 *      anyway, because (1) depends on a server we do not own honouring a
 *      query parameter. A collection preset, a proxy that rewrites the query
 *      string, or a Directus version that changes `fields` semantics would
 *      each silently defeat (1) alone.
 *
 * The return type is `ContractStakes`, which has no commercial members, so
 * card.ts cannot render one even if both defences were removed. Three layers
 * for one rule because the rule is the operator's standing one — never ship cost or
 * margin to a client-facing surface — and a studio prompt is a surface.
 */
export async function fetchContractStakes(
  cfg: DirectusConfig, projectId: Id,
): Promise<ContractStakes | null> {
  const rows = await directusGet<Record<string, unknown>[]>(cfg, COLLECTIONS.contracts, query(
    CONTRACT_STAKES_FIELDS, { "filter[project][_eq]": projectId, limit: "1" },
  ));
  const row = rows?.[0];
  if (!row) return null;
  return stripCommercial(row);
}

/** Defence (2) above, extracted so the test can aim a hostile response
 *  straight at it. Iterates the DECLARATION, not a hand-copied list. */
export function stripCommercial(row: Record<string, unknown>): ContractStakes {
  const clean: Record<string, unknown> = { ...row };
  for (const field of COMMERCIAL_ONLY_FIELDS) delete clean[field];
  return clean as unknown as ContractStakes;
}

/**
 * COMMERCIAL TIER — MAESTRO ONLY (§7 ruling).
 *
 * Price, margin, payment terms, penalty amounts. Maestro gets them because it
 * is the interface and must not gold-plate a fixed-price job; nothing else
 * has a reason, and "no reason" is the whole test.
 *
 * There is no route wired to this in P5c. Whatever route eventually calls it
 * MUST be Access-gated and MUST NOT be reachable by a spawn token — a
 * container presenting a spawn token is exactly the caller this tier exists
 * to exclude. Its result must never be folded into a bring-up env var.
 */
export async function fetchContractCommercial(
  cfg: DirectusConfig, projectId: Id,
): Promise<ContractCommercial | null> {
  const rows = await directusGet<ContractCommercial[]>(cfg, COLLECTIONS.contracts, query(
    CONTRACT_COMMERCIAL_FIELDS, { "filter[project][_eq]": projectId, limit: "1" },
  ));
  return rows?.[0] ?? null;
}

/**
 * The on-demand tier: full requirement rows, ordered by `sort` then `ref`.
 *
 * Any studio may fetch these when checking its own work — they are what a
 * verification step is written against. They are NOT injected: the numbered
 * list with acceptance criteria is far past the project card's 10-20 line
 * budget, and a lead reads them when it needs them, which is at done-time.
 *
 * `truncated` is returned rather than swallowed. A silently short list would
 * make a checklist silently miss a requirement, which is the exact failure
 * (claimed-done-wasn't) this whole design is built against.
 */
export async function listRequirements(
  cfg: DirectusConfig, projectId: Id,
): Promise<{ rows: EstateRequirement[]; truncated: boolean }> {
  const rows = await directusGet<EstateRequirement[]>(cfg, COLLECTIONS.requirements, query(
    ["id", "project", "ref", "text", "acceptance", "status", "sort", "issue_number"],
    { "filter[project][_eq]": projectId, sort: "sort,ref", limit: String(REQUIREMENTS_PAGE_LIMIT) },
  ));
  const list = rows ?? [];
  return { rows: list, truncated: list.length >= REQUIREMENTS_PAGE_LIMIT };
}

/**
 * OPEN decisions only, newest first, capped — this feeds the project card,
 * and an unbounded decision log would eat the whole line budget.
 *
 * Ruled decisions are deliberately not fetched here. A studio needs to know
 * what is STILL OPEN (so it does not decide it silently); what was already
 * ruled is either in the repo docs, in the card's own facts, or askable.
 */
export async function listOpenDecisions(
  cfg: DirectusConfig, projectId: Id, limit: number,
): Promise<EstateDecision[]> {
  const rows = await directusGet<EstateDecision[]>(cfg, COLLECTIONS.decisions, query(
    ["id", "project", "ref", "title", "status"],
    {
      "filter[project][_eq]": projectId, "filter[status][_eq]": "open",
      sort: "ref", limit: String(limit),
    },
  ));
  return rows ?? [];
}

/**
 * Client portal requests. READ ONLY — P5c builds no inbound path, no triage
 * verb, and no writer. See portal.ts for the lifecycle the next agent
 * implements; this is the read half it will need.
 */
export async function listRequests(
  cfg: DirectusConfig, projectId: Id, limit = 50,
): Promise<EstateRequest[]> {
  const rows = await directusGet<EstateRequest[]>(cfg, COLLECTIONS.requests, query(
    ["id", "project", "submitted_at", "submitted_by", "body", "status",
      "client_status", "issue_number", "verification_url", "delivered_at"],
    { "filter[project][_eq]": projectId, sort: "-submitted_at", limit: String(limit) },
  ));
  return rows ?? [];
}

/**
 * Assembles everything the project card needs, in the fewest round trips the
 * shape allows: one lookup for the project (which yields the id the rest
 * filter on), then the contract, open decisions and requirement counts in
 * parallel.
 *
 * Requirements are pulled as full rows and counted locally rather than via
 * Directus's aggregate endpoint — the same rows are what the on-demand tier
 * serves, the counts are two `filter` calls saved, and `/items` is the one
 * Directus surface this client has to understand.
 *
 * Throws on any failure. The fail-open decision belongs to card.ts, which is
 * the only caller on the provisioning path.
 */
export async function fetchProjectEstate(
  cfg: DirectusConfig, key: string, decisionLimit: number,
): Promise<ProjectEstate | null> {
  const project = await fetchProjectByKey(cfg, key);
  if (!project) return null;

  const [contract, openDecisions, requirements] = await Promise.all([
    fetchContractStakes(cfg, project.id),
    listOpenDecisions(cfg, project.id, decisionLimit),
    listRequirements(cfg, project.id),
  ]);

  return {
    project,
    contract,
    openDecisions,
    requirementCount: requirements.rows.length,
    requirementsSatisfied: requirements.rows.filter((r) => r.status === "satisfied").length,
  };
}
