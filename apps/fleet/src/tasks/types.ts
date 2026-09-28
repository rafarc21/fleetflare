export type GateAction = "merge_staging" | "deploy_staging" | "merge_main" | "deploy_prod";

export const GATE_ACTIONS: GateAction[] = [
  "merge_staging", "deploy_staging", "merge_main", "deploy_prod",
];

export function isGateAction(v: string): v is GateAction {
  return (GATE_ACTIONS as string[]).includes(v);
}

/** Human-facing label for the approval message. */
export const GATE_LABELS: Record<GateAction, string> = {
  merge_staging: "Merge into staging",
  deploy_staging: "Deploy staging",
  merge_main: "Merge into main",
  deploy_prod: "Deploy production",
};

export type TaskState = "idle" | "running" | "done" | "failed";

export interface Milestone {
  ts: number;
  text: string;
}

export interface PendingApproval {
  action: GateAction;
  params: Record<string, string>;
}

/** Exactly what the agent container's GET /status returns. */
export interface TaskStatus {
  state: TaskState;
  taskId: string | null;
  milestones: Milestone[];
  pendingApproval: PendingApproval | null;
  result: string | null;
  error: string | null;
  costUsd: number | null;
}
