// apps/fleet/cli/lead-model.ts — which model a studio's lead runs on, read
// from data the Worker already holds (issue #1074 ask 1: "lead model must be
// verifiable without reading screens"). Pure: no node:*/Bun imports, so the
// test suite imports it directly, same as readiness-format.ts.
//
// Two facts decide it. `StudioStatus.leadType` says whether the studio's lead
// is Claude or a non-Claude (glm-translated) model. For a non-Claude studio,
// the `lead-model:<studioId>` flag (src/llm/model-store.ts, read through
// GET /studio/models) names which pool model it is pinned to. A claude-led
// studio carries no model id anywhere the CLI can read, so its leadModel is
// null by design, not by omission.
import { POOL } from "../src/llm/models";
import type { StudioStatus } from "../src/studio/types";

export interface LeadModel {
  /** claude, glm, or a pool key (kimi, deepseek) when the studio is pinned to one. */
  leadType: string;
  /** The Workers AI model id's last path segment (kimi-k2.7-code), or null. */
  leadModel: string | null;
}

/** The short form of a Workers AI model id: "@cf/moonshotai/kimi-k2.7-code" -> "kimi-k2.7-code". */
function shortModelId(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/**
 * The lead model of one studio. `assignments` is the GET /studio/models
 * `assignments` map (studio id -> Workers AI model id); absent or empty means
 * "no assignment known", which a glm studio reads as plain glm with no model.
 */
export function leadModelOf(s: StudioStatus, assignments: Record<string, string> = {}): LeadModel {
  if (s.leadType !== "glm") return { leadType: "claude", leadModel: null };
  const assigned = assignments[s.id];
  if (assigned === undefined) return { leadType: "glm", leadModel: null };
  const pool = POOL.find((m) => m.id === assigned);
  return { leadType: pool?.key ?? "glm", leadModel: shortModelId(assigned) };
}

/**
 * The ACCOUNT cell of a non-Claude lead (#1074 review): `glm:glm-5.3`,
 * `kimi:kimi-k2.7-code`. A glm studio runs no Claude account, so its ACCOUNT
 * cell names the lead's model instead of a Claude token name. Claude leads
 * never reach this (formatAccount keeps their cell).
 */
export function leadAccountLabel(lead: LeadModel): string {
  return lead.leadModel === null ? lead.leadType : `${lead.leadType}:${lead.leadModel}`;
}
