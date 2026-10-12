export type GateAction = "merge_staging" | "deploy_staging" | "merge_main" | "deploy_prod";

/** Human-facing label for the approval message. */
export const GATE_LABELS: Record<GateAction, string> = {
  merge_staging: "Merge into staging",
  deploy_staging: "Deploy staging",
  merge_main: "Merge into main",
  deploy_prod: "Deploy production",
};

type TaskState = "idle" | "running" | "done" | "failed";

interface Milestone {
  ts: number;
  text: string;
}

interface PendingApproval {
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
