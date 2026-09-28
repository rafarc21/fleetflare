import { describe, it, expect } from "vitest";
import {
  applyEstateSchema, collectionPayload, fieldPayload, relationPayload,
  primaryKeyField, fieldMismatch, type AdminConfig, type FetchLike,
} from "../src/directus/schema-apply";
import { PROJECTS, REQUIREMENTS, REQUESTS, ESTATE_SCHEMA, type FieldDef } from "../src/directus/schema";

const CFG: AdminConfig = { url: "https://estate.example.com", token: "admin-tok" };

/** A fake Directus that starts empty and remembers what was created. */
function fakeDirectus(present: Set<string> = new Set()): {
  fetchLike: FetchLike; calls: { method: string; path: string; body: any }[];
} {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    const path = url.replace(CFG.url, "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === "GET") {
      return present.has(path)
        ? Response.json({ data: { type: "string", schema: {} } })
        : new Response("not found", { status: 404 });
    }
    return Response.json({ data: {} });
  };
  return { fetchLike, calls };
}

const field = (name: string, def: typeof PROJECTS): FieldDef =>
  def.fields.find((f) => f.field === name)!;

describe("payloads", () => {
  it("gives every collection a generated uuid primary key, not a sequential id", () => {
    // These ids reach issue bodies, checklists and client portal URLs. A
    // guessable sequential id on a client-facing surface invites enumeration.
    const pk = primaryKeyField();
    expect(pk).toMatchObject({ field: "id", type: "uuid" });
    expect((pk.schema as any).is_primary_key).toBe(true);
    expect((pk.schema as any).has_auto_increment).toBe(false);
    expect(collectionPayload(PROJECTS).fields).toEqual([pk]);
  });

  it("carries the declaration's note onto the collection a human clicks around in", () => {
    expect((collectionPayload(PROJECTS).meta as any).note).toBe(PROJECTS.note);
  });

  it("marks a non-nullable field required and a unique field unique", () => {
    const key = fieldPayload(field("key", PROJECTS));
    expect((key.meta as any).required).toBe(true);
    expect((key.schema as any).is_nullable).toBe(false);
    expect((key.schema as any).is_unique).toBe(true);

    const notes = fieldPayload(field("notes", PROJECTS));
    expect((notes.meta as any).required).toBe(false);
    expect((notes.schema as any).is_nullable).toBe(true);
    expect((notes.schema as any).is_unique).toBe(false);
  });

  it("renders a constrained string as a dropdown, so a human on a phone cannot typo a status", () => {
    const status = fieldPayload(REQUESTS.fields.find((f) => f.field === "status")!);
    expect((status.meta as any).interface).toBe("select-dropdown");
    expect((status.meta as any).options.choices).toEqual([
      { text: "submitted", value: "submitted" },
      { text: "backlog", value: "backlog" },
      { text: "working", value: "working" },
      { text: "completed", value: "completed" },
      { text: "failed", value: "failed" },
      { text: "canceled", value: "canceled" },
    ]);
  });

  it("uses SET NULL on every relation, never CASCADE", () => {
    // Deleting a project must not silently take its contract, requirements
    // and decision log with it — the estate outlives the engagement.
    for (const def of ESTATE_SCHEMA) {
      for (const f of def.fields) {
        if (f.relatedCollection === undefined) continue;
        expect((relationPayload(def.collection, f).schema as any).on_delete).toBe("SET NULL");
      }
    }
  });

  it("points a relation at the collection the declaration names", () => {
    const p = relationPayload(REQUIREMENTS.collection, field("project", REQUIREMENTS as any));
    expect(p.collection).toBe("estate_requirements");
    expect(p.field).toBe("project");
    expect(p.related_collection).toBe("estate_projects");
  });
});

describe("fieldMismatch — reported, never rewritten", () => {
  const key = field("key", PROJECTS);

  it("is silent when the live field agrees", () => {
    expect(fieldMismatch(key, { type: "string", schema: { is_nullable: false, is_unique: true } })).toBeNull();
  });

  it("names a type change", () => {
    expect(fieldMismatch(key, { type: "text", schema: { is_nullable: false, is_unique: true } }))
      .toContain("type text != declared string");
  });

  it("names a nullability change and a uniqueness change", () => {
    const diff = fieldMismatch(key, { type: "string", schema: { is_nullable: true, is_unique: false } })!;
    expect(diff).toContain("is_nullable true != declared false");
    expect(diff).toContain("is_unique false != declared true");
  });

  it("ignores what the live object does not report", () => {
    expect(fieldMismatch(key, {})).toBeNull();
  });
});

describe("applyEstateSchema", () => {
  it("creates every collection, field and relation against an empty instance", async () => {
    const { fetchLike, calls } = fakeDirectus();
    const report = await applyEstateSchema(CFG, fetchLike);

    expect(report.collectionsCreated).toEqual([
      "estate_projects", "estate_contracts", "estate_requirements",
      "estate_decisions", "estate_requests",
    ]);
    const declaredFields = ESTATE_SCHEMA.reduce((n, c) => n + c.fields.length, 0);
    expect(report.fieldsCreated).toHaveLength(declaredFields);
    const declaredRelations = ESTATE_SCHEMA
      .flatMap((c) => c.fields).filter((f) => f.relatedCollection !== undefined).length;
    expect(report.relationsCreated).toHaveLength(declaredRelations);
    expect(report.mismatched).toEqual([]);

    // Every collection exists before the first relation is created — a
    // self-relation and any forward reference both need that second pass.
    const firstRelation = calls.findIndex((c) => c.method === "POST" && c.path === "/relations");
    const lastCollection = calls.map((c) => c.method === "POST" && c.path === "/collections").lastIndexOf(true);
    expect(lastCollection).toBeLessThan(firstRelation);
  });

  it("authenticates every request with the admin token and JSON content type on writes", async () => {
    const seen: RequestInit[] = [];
    const fetchLike: FetchLike = async (_url, init) => {
      seen.push(init);
      return init.method === "GET" ? new Response("x", { status: 404 }) : Response.json({ data: {} });
    };
    await applyEstateSchema(CFG, fetchLike, [PROJECTS]);
    for (const init of seen) {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer admin-tok");
    }
    const post = seen.find((i) => i.method === "POST")!;
    expect((post.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("is idempotent — a full re-run writes nothing", async () => {
    const present = new Set<string>();
    for (const c of ESTATE_SCHEMA) {
      present.add(`/collections/${c.collection}`);
      for (const f of c.fields) {
        present.add(`/fields/${c.collection}/${f.field}`);
        if (f.relatedCollection) present.add(`/relations/${c.collection}/${f.field}`);
      }
    }
    const { fetchLike, calls } = fakeDirectus(present);
    const report = await applyEstateSchema(CFG, fetchLike);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(report.collectionsCreated).toEqual([]);
    expect(report.fieldsCreated).toEqual([]);
    expect(report.relationsCreated).toEqual([]);
  });

  it("adds only what is missing when one field was declared later", async () => {
    const present = new Set<string>();
    for (const f of PROJECTS.fields) present.add(`/fields/estate_projects/${f.field}`);
    present.delete("/fields/estate_projects/notes");
    present.add("/collections/estate_projects");

    const { fetchLike, calls } = fakeDirectus(present);
    const report = await applyEstateSchema(CFG, fetchLike, [PROJECTS]);
    expect(report.fieldsCreated).toEqual(["estate_projects.notes"]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("reports a drifted field instead of altering it — a type change can discard data", async () => {
    const fetchLike: FetchLike = async (url, init) => {
      const path = url.replace(CFG.url, "");
      if (init.method !== "GET") return Response.json({ data: {} });
      if (path === "/collections/estate_projects") return Response.json({ data: {} });
      if (path === "/fields/estate_projects/key") {
        return Response.json({ data: { type: "text", schema: { is_nullable: true, is_unique: false } } });
      }
      return new Response("x", { status: 404 });
    };
    const report = await applyEstateSchema(CFG, fetchLike, [PROJECTS]);
    expect(report.mismatched).toHaveLength(1);
    expect(report.mismatched[0]).toContain("estate_projects.key");
    expect(report.mismatched[0]).toContain("type text != declared string");
  });

  it("treats a 403 as absent (an admin token cannot see what does not exist)", async () => {
    const fetchLike: FetchLike = async (_url, init) =>
      init.method === "GET" ? new Response("forbidden", { status: 403 }) : Response.json({ data: {} });
    const report = await applyEstateSchema(CFG, fetchLike, [PROJECTS]);
    expect(report.collectionsCreated).toEqual(["estate_projects"]);
  });

  it("refuses to guess on a 500 — reading an outage as 'missing' would recreate a live collection", async () => {
    const fetchLike: FetchLike = async () => new Response("boom", { status: 500 });
    await expect(applyEstateSchema(CFG, fetchLike, [PROJECTS])).rejects.toThrow(/GET \/collections\/estate_projects failed \(500\)/);
  });

  it("surfaces Directus's own words when a create is rejected", async () => {
    const fetchLike: FetchLike = async (_url, init) =>
      init.method === "GET"
        ? new Response("x", { status: 404 })
        : new Response('{"errors":[{"message":"Invalid field type"}]}', { status: 400 });
    await expect(applyEstateSchema(CFG, fetchLike, [PROJECTS])).rejects.toThrow(/Invalid field type/);
  });
});
