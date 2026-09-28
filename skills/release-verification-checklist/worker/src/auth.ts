import type { Env } from "./types";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export interface TokenAuth {
  kind: "read" | "write";
  /** Repo namespace this token may reach; null = unscoped (every release). */
  prefix: string | null;
}

/** Parse REVIEW_READ_TOKENS ({"<token>":"<repo-prefix>"}). Malformed = fail closed. */
function scopedReadTokens(env: Env): [string, string][] {
  if (!env.REVIEW_READ_TOKENS) return [];
  try {
    const m = JSON.parse(env.REVIEW_READ_TOKENS) as Record<string, string>;
    return Object.entries(m).filter(
      ([t, p]) => typeof t === "string" && typeof p === "string" && t && p
    );
  } catch {
    return [];
  }
}

export function tokenKind(req: Request, env: Env): TokenAuth | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tok = m[1];
  if (env.REVIEW_READ_TOKEN && safeEqual(tok, env.REVIEW_READ_TOKEN)) return { kind: "read", prefix: null };
  if (env.REVIEW_WRITE_TOKEN && safeEqual(tok, env.REVIEW_WRITE_TOKEN)) return { kind: "write", prefix: null };
  for (const [t, prefix] of scopedReadTokens(env)) {
    if (safeEqual(tok, t)) return { kind: "read", prefix };
  }
  return null;
}

export function allow(auth: TokenAuth | null, need: "read" | "write"): boolean {
  if (!auth) return false;
  if (auth.kind === "read") return true;   // read token is a superset
  return need === "write";
}

/**
 * Namespace gate. A token scoped to "acme" reaches "acme--<x>" and nothing
 * else — the separator must be present, or "acme-evil--x" would pass a bare
 * startsWith. Unscoped tokens (prefix null) reach every release, which is what
 * keeps legacy unprefixed ids readable.
 */
export function inScope(auth: TokenAuth | null, release: string): boolean {
  if (!auth) return false;
  if (auth.prefix === null) return true;
  return release.startsWith(auth.prefix + "--");
}
