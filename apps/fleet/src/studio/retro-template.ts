// Board issue #165: `fleet task new --template retro`'s fixed brief — the
// weekly retro turns learnings (merged PRs, review findings, board envelopes'
// own `learnings` field, harvested ops memory) into environment changes
// (checks/standards/navigation/tool-economy fixes/bloat trims/prunes). See
// skills/retro-ritual/SKILL.md for the full ritual this brief points at.
//
// Pure data, no I/O — mirrors cli-args.ts's own TaskBriefArgs' four required
// fields exactly, so cli-args.ts can use this object as a per-field fallback
// when --template retro is given without the matching --title/--objective/
// --output/--boundaries flag.
//
// Title is STATIC, deliberately not datestamped: the GitHub issue number is
// the uniqueness key for every board task (same as any other `fleet task
// new` call), and a `new Date()` baked in here would only make this module's
// own parse tests non-deterministic for no real benefit — "weekly" lives in
// the cadence the operator/maestro runs this at, not in the title string.
export const RETRO_TASK_TEMPLATE: {
  title: string;
  objective: string;
  outputFormat: string;
  boundaries: string;
} = {
  title: "retro: weekly learnings pass",
  objective:
    "Weekly retro. Read: the last N merged PRs (gh pr list --repo <owner/name> --state merged --limit N), " +
    "their review findings (PR review comments / code-review skill output), board envelopes' own `learnings` " +
    "field on recent tasks (fleet task show <n>), and harvested ops memory (fleet memory ls — empty when " +
    "FLEET_OPS_REPO is unset; that is not a reason to refuse the retro, just an empty source). See " +
    "skills/retro-ritual/SKILL.md for the full procedure.",
  outputFormat:
    "A numbered decision sheet, same shape sprint-ritual's explorers already produce: each line names the " +
    "candidate, a recommended action, the cost of getting it wrong, and a citation to the concrete PR/issue/" +
    "session moment it traces to. No candidate without a citation. Categories: new deterministic checks, " +
    "standards entries, navigation pointers, tool-economy fixes, bloat, prunes (a check silent 30 days " +
    "straight, or allowlisted more than N times).",
  boundaries:
    "Proposes only — this task never files the fix tasks itself. The operator picks candidates by number; " +
    "converting a picked number into a board task is a separate `fleet task new`, done afterward by whoever " +
    "is running the retro.",
};
