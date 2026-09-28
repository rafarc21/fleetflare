import type { FleetEvent } from "./schema";

export const CTO_ID = "cto";

export type Decision =
  | { allow: true; toHuman: boolean }
  | { allow: false; reason: string };

/**
 * Identity for escalation collapsing: case- and whitespace-insensitive on the
 * body, scoped to project and thread.
 *
 * JSON-encoded rather than concatenated. A bare separator lets
 * (thread "T1", body "x::y broke") and (thread "T1::x", body "y broke")
 * produce the same key, which would suppress a real question and report the
 * misleading reason "duplicate escalation on this thread".
 *
 * `project` is part of the identity because the fleet is multi-tenant: the
 * same generic question on two projects is two questions.
 */
export function dedupeKey(e: FleetEvent): string {
  const body = e.body.trim().toLowerCase().replace(/\s+/g, " ");
  return JSON.stringify([e.project, e.thread, body]);
}

export function routeDecision(e: FleetEvent, recent: FleetEvent[]): Decision {
  // Dedupe first, and for every author. "Deduplicate, never filter" is about
  // collapsing the same question arriving from several directions; the CTO is
  // one of those directions.
  if (e.kind === "escalation") {
    const key = dedupeKey(e);
    const dup = recent.some((r) => r.kind === "escalation" && dedupeKey(r) === key);
    if (dup) return { allow: false, reason: "duplicate escalation on this thread" };
  }

  // One rule for who may address the human, applied to every kind. Previously
  // the escalation branch returned above this check, so a CTO escalation was
  // silently downgraded to toHuman:false and the operator never saw it.
  if (e.to === "human") {
    if (e.from !== CTO_ID) {
      return { allow: false, reason: "only the CTO may address the human" };
    }
    return { allow: true, toHuman: true };
  }

  return { allow: true, toHuman: false };
}
