export type EventKind =
  | "task"
  | "question"
  | "report"
  | "decision"
  | "escalation"
  | "human"
  | "approval_request"
  | "approval";

export interface FleetEvent {
  id: string;
  ts: number;
  from: string;
  to: string;
  kind: EventKind;
  project: string;
  ref: string | null;
  thread: string | null;
  body: string;
  requiresAck: boolean;
}

export interface NewEvent {
  from: string;
  to: string;
  kind: EventKind;
  project: string;
  body: string;
  ref?: string | null;
  thread?: string | null;
  requiresAck?: boolean;
}

export function makeEvent(input: NewEvent, now: number, rand: string): FleetEvent {
  return {
    id: `evt_${now.toString(36)}_${rand}`,
    ts: now,
    from: input.from,
    to: input.to,
    kind: input.kind,
    project: input.project,
    ref: input.ref ?? null,
    thread: input.thread ?? null,
    body: input.body,
    requiresAck: input.requiresAck ?? false,
  };
}
