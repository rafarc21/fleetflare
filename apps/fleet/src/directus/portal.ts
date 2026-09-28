/**
 * THE CLIENT PORTAL (design §8).
 *
 * P5c ships the READ side and the vocabulary mapping. It deliberately builds
 * NO inbound path: no cron, no `request` verbs, no writer, no issue mirror.
 * This header is the specification the next agent implements against, written
 * out in full so none of it has to be re-derived from the design doc.
 *
 * ============================================================================
 * THE LIFECYCLE
 * ============================================================================
 *
 *   client submits          -> estate_requests row, status `submitted`
 *   Worker cron notices     -> surfaces to Maestro as an inbox
 *   Maestro triages         -> writes a REAL task spec
 *   Worker files the issue  -> links back: request.issue_number = N
 *   issue moves             -> Worker mirrors state -> request.status
 *   client watches          -> without emailing the operator
 *
 * MAESTRO TRIAGES; NOTHING AUTO-CONVERTS. A request is prose from a
 * non-technical person — "the booking page feels slow on my phone" — and is
 * never a task spec. Turning one into an issue mechanically produces a task
 * whose acceptance criteria are the client's adjectives, which a studio then
 * satisfies to its own satisfaction and nobody else's. §8 rules this: Maestro
 * triages. The triage IS the work; the plumbing around it is not the hard
 * part.
 *
 * MAESTRO'S VERBS (not built here):
 *   request ls                  the inbox
 *   request accept <id>         triage into a task spec, file the issue, link
 *   request reject <id> <why>   status -> canceled, with a reason
 *   request link <id> <issue>   attach to work that already exists (duplicate)
 *
 * DEDUP IS STRUCTURAL, NOT PROCEDURAL. `estate_requests.issue_number` is
 * UNIQUE (schema.ts). Converting the same request twice is a constraint
 * violation, not a race the triage code has to remember to guard.
 *
 * SINGLE-WRITER EXTENDS TO DIRECTUS. Maestro DECIDES; the WORKER WRITES. Same
 * rule the board already follows (§10: "All agents — never write state.
 * Worker only"), one more target. No container holds a Directus credential;
 * see client.ts's header.
 *
 * ============================================================================
 * THE TWO VOCABULARIES
 * ============================================================================
 *
 * Internal states leak the wrong story:
 *
 *   - a client reading `failed` hears "your team failed", when it almost
 *     always means SUPERSEDED — the task was replaced, re-scoped, or folded
 *     into another one.
 *   - a request moving to `completed` in 40 minutes tells the client exactly
 *     what the operator's client-facing rules say never to reveal: how fast this was.
 *     Speed reads as "that was trivial, why did it cost that", and it prices
 *     every future request down.
 *
 *   internal              client sees
 *   ------------------    -----------------------------------
 *   submitted / backlog   Received
 *   working               In progress
 *   completed             Delivered — with the verification link
 *   failed / canceled     nothing (or "superseded")
 *
 * The mapping lives HERE, in the Worker. The client never sees fleet
 * mechanics — not issue numbers, not studio ids, not labels, not the internal
 * word. `clientView` below is the projection; nothing else may be sent to a
 * portal surface.
 *
 * ============================================================================
 * THE DELIVERED GATE (ruled)
 * ============================================================================
 *
 * DELIVERED PUBLISHES ONLY AFTER THE OPERATOR TICKS THE CHECKLIST. Never on
 * issue close.
 *
 * Publishing on close is the claimed-done-wasn't failure — the one this whole
 * design exists to remove — aimed at a PAYING CLIENT instead of at the operator. An
 * issue closes when a studio says it is finished. A checklist tick happens
 * when a human looked. Between those two events sits every regression the
 * §5 flow exists to catch.
 *
 * So `clientStatus` requires BOTH halves and treats either alone as not yet
 * delivered:
 *   - `delivered_at`      the tick happened
 *   - `verification_url`  the evidence the client can open
 *
 * Conservative on purpose. A Delivered that appears an hour late is a
 * nuisance; a Delivered the client opens and finds broken costs the
 * relationship. When in doubt this function says "In progress".
 */

import type { ClientFacingStatus, EstateRequest } from "./types";

/**
 * The client-facing projection of one request. EVERYTHING a portal surface
 * may show, and nothing else.
 *
 * Note what is absent and stays absent: `issue_number`, the internal
 * `status`, any studio id, any label, any timing that reveals how long the
 * work took. `submittedAt` is the client's OWN timestamp — they already know
 * when they sent it — while there is deliberately no `completedAt`, because
 * the gap between the two is the thing the operator's client-facing rules say never
 * to reveal.
 */
export interface ClientRequestView {
  id: string;
  status: ClientFacingStatus;
  /** The client's own words, unchanged. */
  body: string;
  /** The client's own submission time. */
  submittedAt: string | null;
  /** Present only alongside `Delivered` — §8's "with the verification
   *  link". */
  verificationUrl: string | null;
}

/**
 * Internal status -> client vocabulary. `null` means PUBLISH NOTHING: the
 * request drops off the client's view entirely rather than showing them a
 * word that reads as blame.
 *
 * The `completed` branch is the ruled one — see this file's DELIVERED GATE
 * header. `completed` alone is NOT Delivered.
 */
export function clientStatus(request: EstateRequest): ClientFacingStatus | null {
  switch (request.status) {
    case "submitted":
    case "backlog":
      // Backlog is deliberately indistinguishable from just-arrived. A client
      // told "backlog" asks when; a client told "Received" waits.
      return "Received";
    case "working":
      return "In progress";
    case "completed":
      return isDelivered(request) ? "Delivered" : "In progress";
    case "failed":
    case "canceled":
      // §8: "nothing (or 'superseded')". Nothing is the safer default —
      // "superseded" invites "superseded by what?", which is a fleet-mechanics
      // conversation. Maestro says it in prose when it is worth saying.
      return null;
    default:
      // An unrecognised internal state (a hand-edited row, a state added
      // later and not mapped here) publishes NOTHING rather than guessing.
      // Guessing here means guessing "Delivered" for a client.
      return null;
  }
}

/**
 * The gate, extracted so it is one testable predicate rather than a condition
 * buried in a switch. Both halves required — the tick AND the evidence.
 */
export function isDelivered(request: EstateRequest): boolean {
  return typeof request.delivered_at === "string" && request.delivered_at !== ""
    && typeof request.verification_url === "string" && request.verification_url !== "";
}

/**
 * Projects one request for a client surface. Returns `null` for anything that
 * publishes nothing (failed/canceled/unmapped) so a caller cannot
 * accidentally render an empty shell.
 *
 * The verification link is attached ONLY on Delivered. A request still in
 * progress may already carry a `verification_url` (the checklist exists
 * before it is ticked), and handing that to a client early is handing them an
 * unverified page and calling it the delivery.
 */
export function clientView(request: EstateRequest): ClientRequestView | null {
  const status = clientStatus(request);
  if (status === null) return null;
  return {
    id: request.id,
    status,
    body: request.body ?? "",
    submittedAt: request.submitted_at ?? null,
    verificationUrl: status === "Delivered" ? request.verification_url ?? null : null,
  };
}

/** The whole portal list for one project — every request that publishes
 *  something, in the order given. Filtering happens here rather than in the
 *  Directus query so the internal states stay queryable by Maestro through
 *  the same rows. */
export function clientViews(requests: EstateRequest[]): ClientRequestView[] {
  return requests.map(clientView).filter((v): v is ClientRequestView => v !== null);
}
