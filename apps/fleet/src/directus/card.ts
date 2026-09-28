/**
 * THE PROJECT CARD — 10-20 lines injected into a studio's lead prompt at
 * provision. NOT a document dump (§7: "Worker fetches at provision, injects
 * a compact project card — 10-20 lines, never a document dump").
 *
 * It answers five questions and nothing else:
 *   which repo · which account · which URLs · what is at stake ·
 *   which decisions are open
 *
 * Everything else is a different tier. The full requirement text with
 * acceptance criteria is fetched on demand (client.ts's `listRequirements`)
 * because a lead needs it at done-time, not at boot; the commercial terms are
 * Maestro's and appear here under no circumstances.
 *
 * WHY A CARD AND NOT A LINK: a studio boots into a fresh context with no
 * habit of looking anything up. A fact that is not in the prompt is a fact
 * the lead will invent — which repo it should push to, whether prod is on the
 * same account as staging, whether there is a deadline. Those inventions are
 * expensive and confident. Five lines of fact are cheaper than one wrong
 * assumption, and 200 lines of contract would be skimmed and ignored.
 *
 * TIERING (§7, ruled, non-negotiable):
 *   stakes       ~5 lines, IN THIS CARD          every studio
 *   requirements numbered, text, acceptance      any studio, on demand
 *   commercial   price, margin, terms, penalty   MAESTRO ONLY
 *                amounts
 *
 * the operator's standing rule underneath it: never ship cost or margin to a
 * client-facing surface, and never inject it into a studio that does not need
 * it. `renderProjectCard` takes `ProjectEstate`, whose `contract` member is
 * `ContractStakes` — a type with no commercial members — so a price cannot be
 * rendered here even by mistake.
 */

import type { Env } from "../env";
import { directusConfig, fetchProjectEstate } from "./client";
import type { DirectusConfig } from "./client";
import type { ProjectEstate } from "./types";

/**
 * Upper bound §7 names outright. Asserted by test against the fullest card
 * the renderer can produce — every optional block present, decisions at their
 * cap. The renderer does not truncate to fit; it is CONSTRUCTED to fit, so a
 * future block that would blow the budget fails a test instead of silently
 * eating the tail of the card.
 */
export const CARD_MAX_LINES = 20;

/**
 * How many open decisions ride in the card. Three, because that is what fits
 * beside everything else — and because a project with more than three open
 * decisions has a sprint-meeting problem, not a card problem. The overflow is
 * COUNTED in the line, never dropped silently: a lead that reads "3 of 7
 * shown" knows to ask.
 */
export const CARD_DECISION_LIMIT = 3;

/**
 * How many open decisions the READ pulls. Larger than CARD_DECISION_LIMIT on
 * purpose: the card reports "3 of 7", and it can only do that honestly if the
 * fetch saw all seven. Fetching exactly `LIMIT + 1` would cap every overflow
 * report at "3 of 4" — technically true, materially misleading, and the
 * misleading direction is the dangerous one (a lead under-asks).
 */
export const CARD_DECISION_FETCH_LIMIT = 20;

/** Per-field ceiling for anything a human typed into Directus. Long enough
 *  for a real scope boundary, short enough that one verbose field cannot take
 *  the card past its line budget. */
const FIELD_MAX_CHARS = 220;

/**
 * Flattens and caps one free-text field.
 *
 * Newlines are collapsed, not preserved: the line budget is the whole point
 * of the card, and a `notes` column with fifteen paragraphs would otherwise
 * silently become a fifteen-line card. It also removes the cheapest form of
 * prompt injection through an estate field — a client-editable row cannot
 * open a new instruction block in a lead's system prompt if it cannot start a
 * new line.
 */
function oneLine(value: string | null | undefined, max = FIELD_MAX_CHARS): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `a · b · c`, skipping anything absent — so a project with no Infisical
 *  entry gets a shorter line, not a line with a hole in it. */
function joinFacts(parts: (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null && p !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

/**
 * Renders the card. PURE — no fetch, no env, no clock. Everything that can
 * fail happens in `resolveProjectCard` below, so this function is fully
 * testable against a literal and can never be the reason a studio fails to
 * boot.
 *
 * Shape is deliberately flat text, not markdown headings beyond one: it is
 * appended to a lead's system prompt (via ProvisionConfig.projectCard ->
 * appendBrief -> ROLE_PROMPT_B64), where competing heading levels read as
 * structure the lead then tries to obey.
 */
export function renderProjectCard(estate: ProjectEstate): string {
  const { project: p, contract: c } = estate;
  const lines: string[] = [];

  lines.push(`## Estate — ${oneLine(p.name, 60) ?? p.key} (project key \`${p.key}\`)`);

  const infra = joinFacts([
    p.repo ? `repo ${p.repo}` : null,
    p.cf_account ? `Cloudflare account ${p.cf_account}` : null,
    p.infisical_project ? `Infisical project ${p.infisical_project} (names only — the Worker holds no secret for you)` : null,
  ]);
  if (infra) lines.push(infra);

  const urls = joinFacts([
    p.staging_url ? `staging ${p.staging_url}` : null,
    p.prod_url ? `prod ${p.prod_url}` : null,
  ]);
  if (urls) lines.push(urls);

  if (p.domains && p.domains.length > 0) lines.push(`domains ${p.domains.join(", ")}`);

  // --- stakes -------------------------------------------------------------
  // Five lines at most, and every one of them is a thing a lead would
  // otherwise guess. "Fixed price" without "do not gold-plate" is a fact a
  // helpful agent will cheerfully act against, so the consequence is spelled
  // out rather than left as an inference.
  lines.push("");
  if (c === null) {
    lines.push("STAKES: no contract on file. Confirm scope with Maestro before expanding it.");
  } else {
    const stakes = joinFacts([
      c.go_live ? `go-live ${c.go_live}` : null,
      c.fixed_price === true ? "fixed price" : c.fixed_price === false ? "time and materials" : null,
      c.penalties === true ? "bugs and delays carry penalties" : null,
    ]);
    lines.push(stakes ? `STAKES: ${stakes}.` : "STAKES: contract on file, terms not recorded yet.");
    const scope = oneLine(c.scope_boundary);
    if (scope) lines.push(`Out of scope: ${scope}`);
    if (c.fixed_price === true) {
      lines.push("Fixed-price job: do not gold-plate and do not widen scope on your own judgment.");
    }
  }

  // --- open decisions -----------------------------------------------------
  // The card's highest-value block. A studio that does not know a decision is
  // open makes it silently, and silent decisions are the ones that get
  // discovered after they are expensive to reverse.
  const open = estate.openDecisions.slice(0, CARD_DECISION_LIMIT);
  if (open.length > 0) {
    const overflow = estate.openDecisions.length - open.length;
    lines.push("");
    lines.push(
      overflow > 0
        ? `OPEN DECISIONS (${open.length} of ${estate.openDecisions.length} — raise, never settle one silently):`
        : "OPEN DECISIONS — raise these, never settle one silently:",
    );
    for (const d of open) {
      const ref = oneLine(d.ref, 12);
      lines.push(`- ${ref ? `${ref} ` : ""}${oneLine(d.title, 100) ?? "(untitled)"}`);
    }
  }

  // --- requirements pointer -----------------------------------------------
  // Counts, not content. The point of these two lines is to establish that
  // requirements EXIST as citable rows, so the lead cites them instead of
  // paraphrasing the brief — §7's four consequences (brief cites,
  // verification intent names, checklist groups, fix-task cites) all depend
  // on the lead knowing the refs are real.
  lines.push("");
  if (estate.requirementCount === 0) {
    lines.push("REQUIREMENTS: none recorded yet. Do not invent them — ask Maestro before assuming scope.");
  } else {
    lines.push(
      `REQUIREMENTS: ${estate.requirementCount} rows in the estate store, ` +
      `${estate.requirementsSatisfied} satisfied.`,
    );
    lines.push("Cite refs (R-1, R-2, …) in your brief, your verification intent and any fix-task.");
    lines.push("Full text and acceptance criteria are on demand from the Worker — never invent them.");
  }

  return lines.join("\n");
}

/** The seam the fail-open test aims a hostile Directus at. Defaults to the
 *  real client; a test supplies a thrower, a hanger, or a null. */
export interface CardDeps {
  fetchEstate: (cfg: DirectusConfig, key: string, decisionLimit: number) => Promise<ProjectEstate | null>;
}

const realDeps: CardDeps = { fetchEstate: fetchProjectEstate };

/**
 * FAIL-OPEN, and this is the ONLY function in src/directus that is.
 *
 * §7's ruling, quoted because it is the whole contract of this function:
 * "Directus must be optional at boot: a studio still comes up when it is
 * unreachable. A fifth store that can block provisioning is a fifth way to
 * have no fleet."
 *
 * So every one of these produces `null` — no card, provisioning proceeds:
 *   - DIRECTUS_URL or DIRECTUS_TOKEN absent (P5c's shipped state)
 *   - the URL is not https (client.ts refuses it)
 *   - Directus unreachable, hung past DIRECTUS_TIMEOUT_MS, 4xx, 5xx
 *   - a body that is not JSON, or has no `data` envelope, or is oversized
 *   - the repo simply is not registered in the estate
 *   - anything at all thrown by the renderer
 *
 * Two silence levels, deliberately different: an ABSENT credential logs
 * nothing (it is a configuration state, and a per-provision warning would
 * train the operator to ignore the log), while a CONFIGURED-but-failing
 * Directus logs a warning naming the project key — the operator has said they
 * want this store, so its failure is news.
 *
 * Never rethrows. A `throw` from here would land in runProvision's own
 * try/catch and mark the studio DEGRADED, which is exactly the "fifth way to
 * have no fleet" outcome the ruling forbids.
 */
export async function resolveProjectCard(
  env: Env, projectKey: string, deps: CardDeps = realDeps,
): Promise<string | null> {
  const cfg = directusConfig(env);
  if (cfg === null) return null;

  try {
    const estate = await deps.fetchEstate(cfg, projectKey, CARD_DECISION_FETCH_LIMIT);
    if (estate === null) return null;
    return renderProjectCard(estate);
  } catch (err) {
    console.warn(
      `directus: project card for "${projectKey}" unavailable, provisioning without it —`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
