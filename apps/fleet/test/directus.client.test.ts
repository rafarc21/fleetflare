import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  directusConfig, fetchProjectByKey, fetchContractStakes, fetchContractCommercial,
  listRequirements, listOpenDecisions, listRequests, fetchProjectEstate, stripCommercial,
  DIRECTUS_MAX_BYTES, REQUIREMENTS_PAGE_LIMIT, type DirectusConfig,
} from "../src/directus/client";
import type { Env } from "../src/env";

const CFG: DirectusConfig = { url: "https://estate.example.com", token: "tok-secret" };

let calls: { url: string; headers: Record<string, string> }[] = [];
let realFetch: typeof globalThis.fetch;
/** Keyed by the collection segment of the request path. */
let responder: (url: string) => Response;

beforeEach(() => {
  calls = [];
  responder = () => Response.json({ data: [] });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return responder(url);
  }) as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const q = (i = 0): URLSearchParams => new URL(calls[i].url).searchParams;
const env = (over: Partial<Env>): Env => over as Env;

describe("directusConfig — the single named config gap", () => {
  it("returns null when nothing is configured, which is P5c's shipped state", () => {
    expect(directusConfig(env({}))).toBeNull();
  });

  it("returns null when only one half is present — a URL without a token is not usable", () => {
    expect(directusConfig(env({ DIRECTUS_URL: "https://e.example.com" }))).toBeNull();
    expect(directusConfig(env({ DIRECTUS_TOKEN: "t" }))).toBeNull();
  });

  it("treats whitespace-only values as absent", () => {
    expect(directusConfig(env({ DIRECTUS_URL: "  ", DIRECTUS_TOKEN: "  " }))).toBeNull();
  });

  it("refuses a non-https URL rather than putting the bearer token in the clear", () => {
    expect(directusConfig(env({ DIRECTUS_URL: "http://estate.example.com", DIRECTUS_TOKEN: "t" }))).toBeNull();
    // No localhost exemption: a Worker cannot reach a developer's localhost,
    // so the exemption could only ever excuse a real misconfiguration.
    expect(directusConfig(env({ DIRECTUS_URL: "http://localhost:8055", DIRECTUS_TOKEN: "t" }))).toBeNull();
  });

  it("returns null for an unparseable URL instead of throwing at config time", () => {
    expect(directusConfig(env({ DIRECTUS_URL: "not a url", DIRECTUS_TOKEN: "t" }))).toBeNull();
  });

  it("normalises trailing slashes so paths never double up", () => {
    const cfg = directusConfig(env({ FLEET_DIRECTUS: "on", DIRECTUS_URL: "https://e.example.com///", DIRECTUS_TOKEN: " t " }));
    expect(cfg).toEqual({ url: "https://e.example.com", token: "t" });
  });
});

describe("fetchProjectByKey", () => {
  it("filters on the studio id's repo segment and authenticates with a bearer token", async () => {
    responder = () => Response.json({ data: [{ id: "p1", key: "beta", name: "BETA" }] });
    const row = await fetchProjectByKey(CFG, "beta");
    expect(row?.name).toBe("BETA");
    expect(new URL(calls[0].url).pathname).toBe("/items/estate_projects");
    expect(q().get("filter[key][_eq]")).toBe("beta");
    expect(q().get("limit")).toBe("1");
    expect(calls[0].headers.authorization).toBe("Bearer tok-secret");
  });

  it("returns null for an unregistered repo — the fleet works on repos with no contract", async () => {
    expect(await fetchProjectByKey(CFG, "nope")).toBeNull();
  });

  it("validates the domains JSON column instead of casting it", async () => {
    // A string here would otherwise render as individual characters in the card.
    responder = () => Response.json({ data: [{ id: "p1", key: "beta", domains: "beta.example.com" }] });
    expect((await fetchProjectByKey(CFG, "beta"))?.domains).toBeNull();

    responder = () => Response.json({ data: [{ id: "p1", key: "beta", domains: ["a.com", 7, "b.com"] }] });
    expect((await fetchProjectByKey(CFG, "beta"))?.domains).toEqual(["a.com", "b.com"]);
  });
});

describe("contract tiering at the read boundary", () => {
  it("asks Directus for the stakes fields only — the price is never on the wire", async () => {
    responder = () => Response.json({ data: [{ id: "c1", go_live: "2026-09-15" }] });
    await fetchContractStakes(CFG, "p1");
    const fields = q().get("fields")!.split(",");
    expect(fields).toEqual(["id", "project", "go_live", "fixed_price", "penalties", "scope_boundary"]);
    for (const f of ["price_cents", "margin_pct", "payment_terms", "penalty_terms", "currency"]) {
      expect(fields).not.toContain(f);
    }
  });

  it("strips commercial fields from a server that ignored `fields` anyway", async () => {
    // Defence 2. `fields=` is honoured by a server we do not own: a collection
    // preset, a query-rewriting proxy, or a Directus version change would each
    // defeat defence 1 silently.
    responder = () => Response.json({
      data: [{
        id: "c1", go_live: "2026-09-15", fixed_price: true, penalties: true,
        scope_boundary: "landing only",
        price_cents: 1_500_000, currency: "BRL", margin_pct: 62,
        payment_terms: "50/50", penalty_terms: "R$500/day",
      }],
    });
    const stakes = await fetchContractStakes(CFG, "p1") as unknown as Record<string, unknown>;
    expect(stakes.go_live).toBe("2026-09-15");
    expect(stakes.penalties).toBe(true);
    for (const f of ["price_cents", "currency", "margin_pct", "payment_terms", "penalty_terms"]) {
      expect(f in stakes).toBe(false);
    }
    expect(JSON.stringify(stakes)).not.toContain("1500000");
  });

  it("stripCommercial walks the declaration, so a new commercial column is covered by construction", () => {
    const out = stripCommercial({ id: "c1", penalties: true, margin_pct: 62 }) as unknown as Record<string, unknown>;
    expect(out).toEqual({ id: "c1", penalties: true });
  });

  it("returns null when a project has no contract row yet", async () => {
    expect(await fetchContractStakes(CFG, "p1")).toBeNull();
  });

  it("gives the Maestro tier the whole contract in one request", async () => {
    responder = () => Response.json({ data: [{ id: "c1", price_cents: 1_500_000, margin_pct: 62 }] });
    const c = await fetchContractCommercial(CFG, "p1");
    expect(c?.price_cents).toBe(1_500_000);
    expect(q().get("fields")!.split(",")).toContain("margin_pct");
    expect(q().get("fields")!.split(",")).toContain("scope_boundary");
  });
});

describe("requirements — the on-demand tier", () => {
  it("orders by sort then ref and pulls the citable handle plus acceptance criteria", async () => {
    responder = () => Response.json({
      data: [{ id: "r1", ref: "R-1", text: "hero", acceptance: "loads < 2s", status: "agreed" }],
    });
    const { rows, truncated } = await listRequirements(CFG, "p1");
    expect(rows[0].ref).toBe("R-1");
    expect(rows[0].acceptance).toBe("loads < 2s");
    expect(truncated).toBe(false);
    expect(q().get("sort")).toBe("sort,ref");
    expect(q().get("limit")).toBe(String(REQUIREMENTS_PAGE_LIMIT));
    expect(q().get("filter[project][_eq]")).toBe("p1");
  });

  it("reports truncation rather than silently shortening the list a checklist groups by", async () => {
    const full = Array.from({ length: REQUIREMENTS_PAGE_LIMIT }, (_, i) => ({ id: `r${i}`, ref: `R-${i}` }));
    responder = () => Response.json({ data: full });
    expect((await listRequirements(CFG, "p1")).truncated).toBe(true);
  });
});

describe("decisions and requests", () => {
  it("fetches OPEN decisions only, capped for the card's line budget", async () => {
    responder = () => Response.json({ data: [{ id: "d1", ref: "D-3", title: "Which CF account owns prod DNS" }] });
    const rows = await listOpenDecisions(CFG, "p1", 3);
    expect(rows[0].title).toBe("Which CF account owns prod DNS");
    expect(q().get("filter[status][_eq]")).toBe("open");
    expect(q().get("limit")).toBe("3");
  });

  it("reads client requests newest-first (read path only — P5c builds no writer)", async () => {
    responder = () => Response.json({ data: [{ id: "q1", status: "submitted" }] });
    await listRequests(CFG, "p1");
    expect(new URL(calls[0].url).pathname).toBe("/items/estate_requests");
    expect(q().get("sort")).toBe("-submitted_at");
  });
});

describe("failures surface loudly here — fail-open is card.ts's job, not this layer's", () => {
  it("names the status and passes Directus's own words through", async () => {
    responder = () => new Response('{"errors":[{"message":"Forbidden"}]}', { status: 403 });
    await expect(fetchProjectByKey(CFG, "beta")).rejects.toThrow(/estate_projects failed \(403\).*Forbidden/);
  });

  it("never echoes the token in an error message", async () => {
    responder = () => new Response("nope", { status: 500 });
    await expect(fetchProjectByKey(CFG, "beta")).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("tok-secret") }) as Error,
    );
  });

  it("names the real problem when an auth proxy answers 200 with HTML", async () => {
    responder = () => new Response("<!doctype html><title>Login</title>", { status: 200 });
    await expect(fetchProjectByKey(CFG, "beta")).rejects.toThrow(/non-JSON/);
  });

  it("refuses a body with no `data` envelope", async () => {
    responder = () => Response.json({ errors: [] });
    await expect(fetchProjectByKey(CFG, "beta")).rejects.toThrow(/no `data` envelope/);
  });

  it("caps the response size — this text can reach a studio's system prompt", async () => {
    responder = () => Response.json({ data: [{ id: "p1", key: "beta", notes: "x".repeat(DIRECTUS_MAX_BYTES) }] });
    await expect(fetchProjectByKey(CFG, "beta")).rejects.toThrow(/exceeds the 262144-byte cap/);
  });
});

describe("fetchProjectEstate", () => {
  it("assembles the card bundle and counts satisfied requirements", async () => {
    responder = (url) => {
      if (url.includes("estate_projects")) return Response.json({ data: [{ id: "p1", key: "beta", name: "BETA", repo: "o/beta" }] });
      if (url.includes("estate_contracts")) return Response.json({ data: [{ id: "c1", go_live: "2026-09-15", fixed_price: true }] });
      if (url.includes("estate_decisions")) return Response.json({ data: [{ id: "d1", ref: "D-3", title: "DNS owner" }] });
      return Response.json({
        data: [
          { id: "r1", ref: "R-1", status: "satisfied" },
          { id: "r2", ref: "R-2", status: "agreed" },
          { id: "r3", ref: "R-3", status: "satisfied" },
        ],
      });
    };
    const estate = await fetchProjectEstate(CFG, "beta", 3);
    expect(estate?.project.name).toBe("BETA");
    expect(estate?.contract?.go_live).toBe("2026-09-15");
    expect(estate?.openDecisions).toHaveLength(1);
    expect(estate?.requirementCount).toBe(3);
    expect(estate?.requirementsSatisfied).toBe(2);
  });

  it("stops after the registry miss — an unregistered repo costs one request, not four", async () => {
    expect(await fetchProjectEstate(CFG, "nope", 3)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
