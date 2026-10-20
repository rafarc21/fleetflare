// The milestone helpers shared by the sprint verbs and task filing. Pure — no
// I/O, no Env, no token — so every rule below is unit-tested directly.

// The backlog milestone: the one implicit milestone the board will create.
// §5 says a sprint is a deliberate open; the backlog is the opposite — the
// place tasks go when no sprint claims them yet. Its title is a fixed string
// so "which milestone is the backlog" is answerable without a convention
// nobody documented.
export const BACKLOG_MILESTONE_TITLE = "backlog";

// The milestone description `fleet sprint open` writes, so the owner and
// goal survive in the only structured-ish field GitHub milestones carry.
export function renderMilestoneDescription(args: { owner: string; goal: string }): string {
  return `Owner: ${args.owner}\nGoal: ${args.goal}`;
}

// Reads the owner back out of a milestone description written by
// renderMilestoneDescription. Returns null when the line is absent.
export function parseMilestoneOwner(description: string): string | null {
  const match = description.match(/^Owner: (.+)$/m);
  return match === null ? null : match[1].trim();
}