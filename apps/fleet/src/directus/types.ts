/**
 * Reader types for the estate collections declared in schema.ts.
 *
 * Kept in a separate file from the schema declaration on purpose: the schema
 * is DATA (walked by the apply script and by tests), these are TYPES (erased
 * at runtime). test/directus.schema.test.ts is what ties them together — it
 * walks ESTATE_SCHEMA and asserts every declared field has a counterpart
 * here, so a column renamed on one side and not the other fails `bun run
 * test` rather than producing an `undefined` in a project card.
 *
 * Everything is optional except identity. A read requests a `?fields=` subset
 * and Directus omits what was not asked for; modelling that as "present but
 * possibly null" would be a lie the card renderer then has to un-tell.
 */

/** Directus primary keys are uuids on every collection here. */
export type Id = string;

export interface EstateProject {
  id: Id;
  key: string;
  name?: string;
  status?: "active" | "paused" | "archived";
  repo?: string | null;
  cf_account?: string | null;
  infisical_project?: string | null;
  /** JSON column. Directus returns whatever was stored, so this is validated
   *  (not cast) at the read boundary — see client.ts's `asStringArray`. */
  domains?: string[] | null;
  staging_url?: string | null;
  prod_url?: string | null;
  notes?: string | null;
}

/**
 * The STAKES tier — the only contract shape a studio-bound surface ever
 * holds. Structurally incapable of carrying a price: `ContractStakes` has no
 * commercial members, so `renderProjectCard` (which takes this type) cannot
 * be handed a `ContractCommercial` field by accident, and an object literal
 * with one is rejected outright by excess-property checking.
 *
 * That is the TYPE-level half of the tiering. The RUNTIME half is client.ts's
 * `?fields=` allow-list plus its defensive strip — a value that arrives over
 * the wire is `unknown` until parsed, and types alone stop nothing there.
 */
export interface ContractStakes {
  id: Id;
  project?: Id | null;
  /** ISO date. The go-live. */
  go_live?: string | null;
  fixed_price?: boolean | null;
  /** WHETHER penalties exist. The amounts are `penalty_terms`, Maestro-only. */
  penalties?: boolean | null;
  scope_boundary?: string | null;
}

/**
 * MAESTRO ONLY. §7's ruling, and the operator's standing rule beneath it: never ship
 * cost or margin to a client-facing surface, and never inject it into a
 * studio that does not need it. Maestro is the interface and must not
 * gold-plate a fixed-price job, which is the one job that needs the number.
 *
 * Nothing that renders a studio-visible string accepts this type. If a future
 * caller needs to widen that, it is a design decision, not a refactor.
 */
export interface ContractCommercial extends ContractStakes {
  price_cents?: number | null;
  currency?: string | null;
  margin_pct?: number | null;
  payment_terms?: string | null;
  penalty_terms?: string | null;
}

export type RequirementStatus =
  | "proposed" | "agreed" | "in_progress" | "satisfied" | "waived";

export interface EstateRequirement {
  id: Id;
  project?: Id | null;
  /** The citable handle — `R-7`. What a brief, a verification step, a
   *  checklist group and a fix-task all name. */
  ref: string;
  text?: string | null;
  acceptance?: string | null;
  status?: RequirementStatus | null;
  sort?: number | null;
  issue_number?: number | null;
}

export type DecisionStatus = "open" | "ruled" | "superseded";

export interface EstateDecision {
  id: Id;
  project?: Id | null;
  ref?: string | null;
  title: string;
  decision?: string | null;
  rationale?: string | null;
  status?: DecisionStatus | null;
  decided_at?: string | null;
  supersedes?: Id | null;
}

/** INTERNAL vocabulary. Never rendered for a client — portal.ts maps it. */
export type RequestStatus =
  | "submitted" | "backlog" | "working" | "completed" | "failed" | "canceled";

/** CLIENT vocabulary. The only request words a client ever reads.
 *  `null` is a real outcome: `failed`/`canceled` publish nothing. */
export type ClientFacingStatus = "Received" | "In progress" | "Delivered";

export interface EstateRequest {
  id: Id;
  project?: Id | null;
  submitted_at?: string | null;
  submitted_by?: string | null;
  body?: string | null;
  status?: RequestStatus | null;
  client_status?: string | null;
  issue_number?: number | null;
  verification_url?: string | null;
  /** Set ONLY when the operator ticks the checklist. Gate for Delivered. */
  delivered_at?: string | null;
}

/**
 * Everything the project card needs, in one bundle — assembled by client.ts's
 * `fetchProjectEstate` and consumed by card.ts's `renderProjectCard`.
 *
 * `contract` is `ContractStakes`, never `ContractCommercial`. That single
 * type choice is what makes "a price in a studio prompt" a compile error
 * rather than a review catch.
 *
 * Every member is nullable/empty-able because Directus being partially
 * populated is the NORMAL state of a new project, and a card that refuses to
 * render without a contract would be a card nobody gets on day one.
 */
export interface ProjectEstate {
  project: EstateProject;
  contract: ContractStakes | null;
  /** Only `status: "open"` rows. The card prints these; ruled ones are
   *  history a studio can ask for but does not need injected. */
  openDecisions: EstateDecision[];
  /** COUNTS, not text. The card says how many requirements exist and how
   *  many are satisfied; the full list is the on-demand tier (§7) and would
   *  blow the 10-20 line budget on its own. */
  requirementCount: number;
  requirementsSatisfied: number;
}
