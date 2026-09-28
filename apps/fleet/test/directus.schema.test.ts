import { describe, it, expect } from "vitest";
import {
  ESTATE_SCHEMA, COLLECTIONS, PROJECTS, CONTRACTS, REQUIREMENTS, DECISIONS, REQUESTS,
  CONTRACT_STAKES_FIELDS, CONTRACT_COMMERCIAL_FIELDS, COMMERCIAL_ONLY_FIELDS,
  type CollectionDef,
} from "../src/directus/schema";
import type {
  EstateProject, ContractStakes, ContractCommercial, EstateRequirement,
  EstateDecision, EstateRequest,
} from "../src/directus/types";

const names = (c: CollectionDef): string[] => c.fields.map((f) => f.field);

describe("estate schema declaration", () => {
  it("declares exactly the five stores §7 rules Directus owns", () => {
    expect(ESTATE_SCHEMA.map((c) => c.collection)).toEqual([
      "estate_projects", "estate_contracts", "estate_requirements",
      "estate_decisions", "estate_requests",
    ]);
    expect(Object.values(COLLECTIONS).sort())
      .toEqual(ESTATE_SCHEMA.map((c) => c.collection).sort());
  });

  it("prefixes every collection, so a shared instance's os_* (AgencyOS) cannot collide", () => {
    for (const c of ESTATE_SCHEMA) expect(c.collection.startsWith("estate_")).toBe(true);
  });

  it("puts projects first — four collections hold an m2o at it and Directus rejects a forward relation", () => {
    expect(ESTATE_SCHEMA[0].collection).toBe("estate_projects");
  });

  it("points every relation at a collection that is actually declared", () => {
    const declared = new Set(ESTATE_SCHEMA.map((c) => c.collection));
    for (const c of ESTATE_SCHEMA) {
      for (const f of c.fields) {
        if (f.relatedCollection === undefined) continue;
        expect(declared.has(f.relatedCollection)).toBe(true);
      }
    }
  });

  it("names every field once per collection and documents every one", () => {
    for (const c of ESTATE_SCHEMA) {
      expect(new Set(names(c)).size).toBe(c.fields.length);
      expect(names(c)).not.toContain("id"); // implicit pk, created by the apply script
      for (const f of c.fields) expect(f.note.length).toBeGreaterThan(10);
    }
  });
});

describe("contract tiering (§7 ruling: commercial is Maestro-only)", () => {
  it("keeps the stakes allow-list and the commercial-only set disjoint", () => {
    const stakes = new Set<string>(CONTRACT_STAKES_FIELDS);
    for (const f of COMMERCIAL_ONLY_FIELDS) expect(stakes.has(f)).toBe(false);
  });

  it("accounts for EVERY declared contract column in exactly one tier", () => {
    // The guard that matters: adding a `margin_usd` column to CONTRACTS
    // without adding it to COMMERCIAL_ONLY_FIELDS fails HERE, not in a
    // review, and not in a studio prompt that quotes it.
    const tiered = new Set<string>([...CONTRACT_STAKES_FIELDS, ...COMMERCIAL_ONLY_FIELDS]);
    for (const f of names(CONTRACTS)) expect(tiered.has(f)).toBe(true);
    expect(tiered.size).toBe(names(CONTRACTS).length + 1); // +1 for the implicit `id`
  });

  it("makes the Maestro field list the union, so one request fetches the whole contract", () => {
    expect(new Set(CONTRACT_COMMERCIAL_FIELDS))
      .toEqual(new Set([...CONTRACT_STAKES_FIELDS, ...COMMERCIAL_ONLY_FIELDS]));
  });

  it("keeps price, margin, payment terms and penalty AMOUNTS out of the stakes tier", () => {
    for (const forbidden of ["price_cents", "margin_pct", "payment_terms", "penalty_terms", "currency"]) {
      expect(CONTRACT_STAKES_FIELDS as readonly string[]).not.toContain(forbidden);
    }
    // ...while keeping the studio-visible HALF of penalties in it: a lead
    // must know penalties exist without learning what they cost.
    expect(CONTRACT_STAKES_FIELDS as readonly string[]).toContain("penalties");
  });
});

describe("row types track the declaration", () => {
  // Each list is annotated `(keyof T)[]`, so a field renamed in types.ts and
  // not in schema.ts is a tsc error; the runtime set-equality catches the
  // other direction. Neither alone is enough.
  const check = <T,>(c: CollectionDef, keys: readonly (keyof T & string)[]): void => {
    expect(new Set(keys)).toEqual(new Set(["id", ...names(c)]));
  };

  it("EstateProject matches estate_projects", () => {
    check<EstateProject>(PROJECTS, [
      "id", "key", "name", "status", "repo", "cf_account", "infisical_project",
      "domains", "staging_url", "prod_url", "notes",
    ]);
  });

  it("ContractStakes matches the stakes tier only", () => {
    const keys: readonly (keyof ContractStakes & string)[] = [
      "id", "project", "go_live", "fixed_price", "penalties", "scope_boundary",
    ];
    expect(new Set(keys)).toEqual(new Set<string>(CONTRACT_STAKES_FIELDS));
  });

  it("ContractCommercial matches the whole contract", () => {
    check<ContractCommercial>(CONTRACTS, [
      "id", "project", "go_live", "fixed_price", "penalties", "scope_boundary",
      "price_cents", "currency", "margin_pct", "payment_terms", "penalty_terms",
    ]);
  });

  it("EstateRequirement matches estate_requirements", () => {
    check<EstateRequirement>(REQUIREMENTS, [
      "id", "project", "ref", "text", "acceptance", "status", "sort", "issue_number",
    ]);
  });

  it("EstateDecision matches estate_decisions", () => {
    check<EstateDecision>(DECISIONS, [
      "id", "project", "ref", "title", "decision", "rationale", "status",
      "decided_at", "supersedes",
    ]);
  });

  it("EstateRequest matches estate_requests", () => {
    check<EstateRequest>(REQUESTS, [
      "id", "project", "submitted_at", "submitted_by", "body", "status",
      "client_status", "issue_number", "verification_url", "delivered_at",
    ]);
  });
});

describe("requirements are first-class rows (§7 ruling)", () => {
  it("carries the citable ref, the acceptance criteria and per-row state the four mechanisms need", () => {
    // brief cites -> ref; verification intent names -> ref; checklist groups
    // -> ref + status; fix-task cites what it failed -> ref + issue_number.
    const f = names(REQUIREMENTS);
    for (const need of ["ref", "text", "acceptance", "status", "issue_number"]) {
      expect(f).toContain(need);
    }
  });

  it("does not mark `ref` globally unique — two projects may both have R-1", () => {
    const ref = REQUIREMENTS.fields.find((x) => x.field === "ref");
    expect(ref?.unique).toBeUndefined();
    expect(ref?.nullable).toBe(false);
  });

  it("makes estate_requests.issue_number unique — the structural dedup §8 relies on", () => {
    expect(REQUESTS.fields.find((x) => x.field === "issue_number")?.unique).toBe(true);
  });
});
