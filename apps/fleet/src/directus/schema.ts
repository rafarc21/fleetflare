/**
 * THE ESTATE SCHEMA, declared as code.
 *
 * P5 design §7 splits five stores by who writes them and how they change.
 * This file is the whole of the Directus half's shape:
 *
 *   Repo          conventions, docs, infra-as-code — changes WITH the code
 *   Issues        units of work with state — already built (src/board)
 *   Directus      THE ESTATE — this file
 *   Fleet memory  how-to-work learnings — blueprint repo
 *   Infisical     every secret; the other four hold secret NAMES only
 *
 * The line, restated because it is the thing that keeps drifting: repo docs
 * describe THIS PROJECT, Directus describes THE ESTATE, fleet memory
 * describes HOW TO WORK. §7's own worked example — `wrangler.jsonc` is repo
 * (it IS the infra), "prod is on the Demosite CF account" is Directus (spans
 * repos, outlives them), "merged is not served" is fleet memory (true of the
 * fleet, not of one project).
 *
 * WHY THE SHAPE LIVES IN THE REPO AND NOT IN A UI
 * -----------------------------------------------
 * Directus will happily let a human click a collection into existence. That
 * makes the estate's shape a thing only the running instance knows, which
 * means: no review, no diff, no rebuild after a bad migration, and a
 * client.ts whose field names are asserted against nothing. Declaring it
 * here makes the shape reviewable in a PR, and lets the reader types in
 * types.ts be checked against it by test (test/directus.schema.test.ts) —
 * a field renamed in one place and not the other is a failing test, not a
 * runtime `undefined` in a project card.
 *
 * scripts/directus-schema.ts turns this declaration into collections and
 * fields against a live instance. That script is the ONLY writer of
 * structure; nothing at request time ever creates a collection.
 *
 * NAMING: every collection is `estate_`-prefixed. the operator's Directus already
 * carries an AgencyOS install whose collections are `os_*`, and a shared
 * instance where two systems both want a "projects" collection is a merge
 * conflict with no merge tool. The prefix is not decoration.
 */

/** Directus field types this schema uses. Narrow on purpose — an unbounded
 *  string here would let a typo ("boolen") reach the apply script and fail
 *  against a live instance instead of against `tsc`. */
export type FieldType =
  | "uuid" | "string" | "text" | "integer" | "boolean"
  | "date" | "timestamp" | "json";

export interface FieldDef {
  field: string;
  type: FieldType;
  /** Directus `schema.is_nullable`. Defaults true; the apply script writes
   *  it explicitly either way so a re-apply is idempotent. */
  nullable?: boolean;
  unique?: boolean;
  /** Present iff this is an m2o: the collection this field points at. Every
   *  value here is asserted to name a declared collection by test — a
   *  relation to a collection nobody declared is the failure mode a
   *  hand-clicked schema hides until a query returns nothing. */
  relatedCollection?: string;
  /** Allowed values for a constrained string. Mirrored by the row types in
   *  types.ts, and asserted equal by test. */
  choices?: readonly string[];
  note: string;
}

export interface CollectionDef {
  collection: string;
  /** Directus `meta.note` — what a human clicking around the admin UI sees.
   *  Kept short; the reasoning lives in this file's comments. */
  note: string;
  /** Field ordering the admin UI shows. The `id` primary key is implicit and
   *  never listed — the apply script creates it. */
  fields: readonly FieldDef[];
}

// --- 1. project registry ----------------------------------------------------
// "Which repo, which account, which URLs" — the half of the project card that
// is pure fact. `key` is the join every other collection and every card
// lookup goes through, and it is deliberately the STUDIO ID's repo segment
// (`<repo>--<role>`, src/studio/ids.ts), not a Directus uuid: the Worker
// knows a studio's repo segment at provision time and knows nothing else
// about the estate, so that segment has to be the handle or there is no
// lookup at all.

export const PROJECTS: CollectionDef = {
  collection: "estate_projects",
  note: "Project registry: repo, CF account, domains, Infisical project, URLs.",
  fields: [
    {
      field: "key", type: "string", nullable: false, unique: true,
      note: "Join key. MUST equal the studio id's repo segment (`<repo>--<role>`), e.g. `beta`, `websites`, `hm3`.",
    },
    { field: "name", type: "string", nullable: false, note: "Human name, e.g. \"BETA landing\"." },
    {
      field: "status", type: "string", nullable: false, choices: ["active", "paused", "archived"],
      note: "Archived projects stay queryable; the estate outlives the engagement.",
    },
    { field: "repo", type: "string", note: "`owner/name`. The work repo a studio clones." },
    {
      field: "cf_account", type: "string",
      note: "Cloudflare account NAME (e.g. \"Demosite\"). Not an id, not a token — see this file's header on Infisical.",
    },
    {
      field: "infisical_project", type: "string",
      note: "Infisical project SLUG. A pointer to where the secrets are, never a secret.",
    },
    { field: "domains", type: "json", note: "Array of hostnames this project owns." },
    { field: "staging_url", type: "string", note: "Where a merged PR is served before promotion." },
    { field: "prod_url", type: "string", note: "Where the client looks." },
    { field: "notes", type: "text", note: "Estate-level gotchas that span repos. NOT repo docs." },
  ],
} as const;

// --- 2. contract ------------------------------------------------------------
// TIERED, and the tiering is the point. §7's ruling: stakes are injected into
// every studio; commercial terms reach Maestro only. the operator's standing rule
// (from the proposal work) is that cost and margin never reach a
// client-facing surface — and a studio's system prompt is a surface, because
// what a studio knows it can write into a PR body, an issue comment, or a
// page. So the split is enforced in TWO places that must agree: the field
// allow-lists below (which become the `?fields=` a read actually requests)
// and the row types in types.ts (which make a commercial field
// unassignable to the card renderer).
//
// A fixed-price contract with penalties is also exactly the context in which
// a studio must NOT gold-plate. That is why stakes are injected rather than
// available on demand: a lead that never asks still has to know.

export const CONTRACTS: CollectionDef = {
  collection: "estate_contracts",
  note: "Contract terms. Stakes tier is injected into every studio; commercial tier is Maestro-only.",
  fields: [
    {
      field: "project", type: "uuid", nullable: false, relatedCollection: "estate_projects",
      note: "One contract per project in practice; modelled m2o so a renegotiation is a second row, not an edit.",
    },
    // --- stakes tier: every studio sees these ---
    { field: "go_live", type: "date", note: "STAKES. The date. A studio that does not know it cannot pace itself." },
    { field: "fixed_price", type: "boolean", note: "STAKES. Yes/no only — never the amount." },
    {
      field: "penalties", type: "boolean",
      note: "STAKES. Whether bugs and delays carry penalties. The card says that they do, never how much.",
    },
    {
      field: "scope_boundary", type: "text",
      note: "STAKES. What is explicitly OUT. The single most useful line for stopping scope creep by a helpful agent.",
    },
    // --- commercial tier: Maestro only ---
    { field: "price_cents", type: "integer", note: "COMMERCIAL. Maestro only." },
    { field: "currency", type: "string", note: "COMMERCIAL. ISO code for price_cents." },
    { field: "margin_pct", type: "integer", note: "COMMERCIAL. Maestro only. Never leaves the Worker for a studio card." },
    { field: "payment_terms", type: "text", note: "COMMERCIAL. Maestro only." },
    { field: "penalty_terms", type: "text", note: "COMMERCIAL. The AMOUNTS. Maestro only; `penalties` above is the studio-visible half." },
  ],
} as const;

/**
 * The stakes allow-list — what a studio-bound read is permitted to request.
 * Sent as Directus's own `?fields=` so the commercial columns are never in
 * the response body at all, and re-applied as a strip after parsing so a
 * Directus that ignores `fields` (a misconfigured collection preset, a
 * proxy, a future version) still cannot leak. Two independent defences
 * because one of them is on the server side of a boundary we do not own.
 */
export const CONTRACT_STAKES_FIELDS = [
  "id", "project", "go_live", "fixed_price", "penalties", "scope_boundary",
] as const;

/** Maestro's tier. Deliberately a SUPERSET including the stakes fields: a
 *  Maestro read wants the whole contract in one request, and the disjointness
 *  that matters is COMMERCIAL_ONLY_FIELDS vs. CONTRACT_STAKES_FIELDS. */
export const CONTRACT_COMMERCIAL_FIELDS = [
  ...CONTRACT_STAKES_FIELDS,
  "price_cents", "currency", "margin_pct", "payment_terms", "penalty_terms",
] as const;

/**
 * The fields that must NEVER appear on a studio-bound surface. Exported (and
 * asserted disjoint from CONTRACT_STAKES_FIELDS by test) because it is what
 * client.ts's defensive strip iterates and what the card test asserts
 * against: adding a commercial column to CONTRACTS without adding it here is
 * caught by a test that walks the declaration, not by a reviewer's memory.
 */
export const COMMERCIAL_ONLY_FIELDS = [
  "price_cents", "currency", "margin_pct", "payment_terms", "penalty_terms",
] as const;

// --- 3. requirements --------------------------------------------------------
// FIRST-CLASS ROWS, ruled in §7. Not a document, not a markdown list in the
// repo. The ruling is load-bearing for four separate mechanisms, and each one
// is a reason a document would not have worked:
//
//   - a task brief CITES the requirements it satisfies      -> needs a stable ref
//   - verification intent (§4) names which requirement       -> needs a stable ref
//     each step proves
//   - the checklist (§5) GROUPS by requirement — the operator ticks  -> needs to enumerate
//     "R-7 satisfied", not "some page looks right"              and group
//   - a fix-task cites the requirement it FAILED             -> needs per-row state
//
// `ref` is the citable handle and the thing all four mechanisms speak. It is
// a human-authored string ("R-7"), not the uuid, because it appears in issue
// bodies and in a checklist the operator reads on a phone.
//
// Discipline this imposes, recorded because it is a process cost and not a
// technical one: requirements must exist BEFORE work starts, or tasks have
// nothing to cite and the checklist has nothing to group by. §7 assigns that
// to the sprint meeting.

export const REQUIREMENTS: CollectionDef = {
  collection: "estate_requirements",
  note: "Requirements as rows. Cited by task briefs, verification intent, checklist groups and fix-tasks.",
  fields: [
    { field: "project", type: "uuid", nullable: false, relatedCollection: "estate_projects", note: "Owner project." },
    {
      field: "ref", type: "string", nullable: false,
      note: "The citable handle, e.g. `R-7`. Unique WITHIN a project (enforced by the apply script's composite index, not by `unique` — two projects both having R-1 is correct).",
    },
    { field: "text", type: "text", nullable: false, note: "What was agreed, in the client's terms." },
    {
      field: "acceptance", type: "text",
      note: "Acceptance criteria. This is what a verification step is written AGAINST — vague here means an unverifiable checklist line later.",
    },
    {
      field: "status", type: "string", nullable: false,
      choices: ["proposed", "agreed", "in_progress", "satisfied", "waived"],
      note: "`satisfied` is set only after the operator ticks the checklist line for it — same gate as a client-visible Delivered (see portal.ts).",
    },
    { field: "sort", type: "integer", note: "Display order. `ref` is the identity; this is only ordering." },
    {
      field: "issue_number", type: "integer",
      note: "The GitHub issue that carries this requirement's work, once one exists. The lineage a fix-task walks back.",
    },
  ],
} as const;

// --- 4. decision log --------------------------------------------------------
// Decisions outlive the repo that provoked them and frequently span repos
// ("prod is on the Demosite CF account; beta is unreachable from the others" is
// §7's own example). OPEN decisions are the part that goes in the project
// card: a studio that does not know a decision is open will make it silently,
// and that is the expensive kind of wrong.

export const DECISIONS: CollectionDef = {
  collection: "estate_decisions",
  note: "Decision log. Open decisions ride in the project card; ruled ones are the estate's memory.",
  fields: [
    {
      field: "project", type: "uuid", relatedCollection: "estate_projects",
      note: "NULLABLE on purpose: an estate-wide ruling belongs to no single project.",
    },
    { field: "ref", type: "string", note: "Citable handle, e.g. `D-3`. Same role `ref` plays on a requirement." },
    { field: "title", type: "string", nullable: false, note: "One line. This is what the project card prints." },
    { field: "decision", type: "text", note: "What was ruled. Empty while status is `open`." },
    { field: "rationale", type: "text", note: "Why. The half that stops a ruling being re-litigated every sprint." },
    {
      field: "status", type: "string", nullable: false, choices: ["open", "ruled", "superseded"],
      note: "`open` is the card-visible set.",
    },
    { field: "decided_at", type: "timestamp", note: "When it was ruled. Null while open." },
    {
      field: "supersedes", type: "uuid", relatedCollection: "estate_decisions",
      note: "Self-relation: a reversal points at what it replaced instead of editing history.",
    },
  ],
} as const;

// --- 5. client requests (the portal's inbound side) -------------------------
// §8. DESIGN ONLY in P5c — the inbound path (cron notices, Maestro triage
// verbs, issue mirroring) is a later task. The shape is declared now because
// the two-vocabulary mapping in portal.ts has to be written against real
// field names, and because a schema that gains collections later is a
// migration while a schema that gains ROWS later is just Tuesday.
//
// portal.ts holds the lifecycle and the mapping. Read it before implementing
// the inbound path; the `Delivered` rule in particular is not reconstructible
// from these field notes alone.

export const REQUESTS: CollectionDef = {
  collection: "estate_requests",
  note: "Client portal inbound requests. Prose from a non-technical person; Maestro triages into task specs.",
  fields: [
    { field: "project", type: "uuid", nullable: false, relatedCollection: "estate_projects", note: "Owner project." },
    { field: "submitted_at", type: "timestamp", nullable: false, note: "When the client sent it." },
    { field: "submitted_by", type: "string", note: "Client contact name. Not a fleet identity." },
    { field: "body", type: "text", nullable: false, note: "The client's own prose. NEVER a task spec — Maestro writes those." },
    {
      field: "status", type: "string", nullable: false,
      choices: ["submitted", "backlog", "working", "completed", "failed", "canceled"],
      note: "INTERNAL vocabulary. The client never sees these words — portal.ts maps them.",
    },
    {
      field: "client_status", type: "string",
      note: "CLIENT vocabulary, written by the Worker only (portal.ts's clientStatus). A stored mirror so the portal UI needs no logic of its own.",
    },
    {
      field: "issue_number", type: "integer", unique: true,
      note: "The issue this request became. UNIQUE — this is the structural dedup that makes converting the same request twice impossible.",
    },
    {
      field: "verification_url", type: "string",
      note: "The checklist link published WITH Delivered. Its presence is half the Delivered gate — see portal.ts.",
    },
    {
      field: "delivered_at", type: "timestamp",
      note: "Set ONLY when the operator ticks the checklist. Never on issue close. The other half of the Delivered gate.",
    },
  ],
} as const;

/** Every collection, in apply order — projects first, since four of the five
 *  hold an m2o pointing at it and Directus rejects a relation to a
 *  collection that does not exist yet. */
export const ESTATE_SCHEMA: readonly CollectionDef[] = [
  PROJECTS, CONTRACTS, REQUIREMENTS, DECISIONS, REQUESTS,
] as const;

/** Collection-name constants, so a query never spells one by hand. */
export const COLLECTIONS = {
  projects: PROJECTS.collection,
  contracts: CONTRACTS.collection,
  requirements: REQUIREMENTS.collection,
  decisions: DECISIONS.collection,
  requests: REQUESTS.collection,
} as const;
