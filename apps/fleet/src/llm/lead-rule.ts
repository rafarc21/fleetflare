// apps/fleet/src/llm/lead-rule.ts
//
// Issue #302: brief discipline for a `leadType: "glm"` studio's lead. A live
// GLM-lead run made 57 calls/hour at ~60s each with context growing 5.6k ->
// 54.7k, and one member spent 45+ calls writing a plan doc whose content was
// already in its brief. Members of a glm-led studio run on the same GLM
// backend (same ANTHROPIC_BASE_URL), so every open-ended brief and every
// extra parallel member multiplies that cost.
//
// Issue #347: brevity rules — verbosity is GLM's top review finding.
//
// Appended to the lead prompt by provision.ts's resolveBringupEnv, glm-led
// studios only — same composePromptBlocks channel as junior's
// JUNIOR_HOUSE_RULE, so it sits before the task brief.
export const GLM_LEAD_HOUSE_RULE = [
  "## House rules — GLM lead",
  "",
  "You and your members run on GLM (Workers AI), not Claude: each call takes",
  "about a minute and context grows fast. Brief so a member finishes in a few",
  "calls:",
  "- Concrete briefs only. When you already know the content, give it and say",
  "  \"write this content verbatim to <path>\". Never send a member to research,",
  "  explore, or work out something you can state yourself.",
  "- One outcome per brief: exact file path(s), what to write, how to check it.",
  "- Small fan-out: one member at a time, at most two in parallel. Wait for a",
  "  result before briefing the next.",
  "- A member still going after a handful of calls on a small step: stop it and",
  "  re-brief narrower.",
  "- Code comments: 1-2 lines of WHY only — never history, never plan or task",
  "  numbers.",
  "- Plan doc at most 40 lines. The PR body carries the evidence; no evidence",
  "  files.",
].join("\n");

// Issue #1112 layer 1: an OSS lead (glm/kimi/deepseek behind the glm-lead
// Messages route) did ONE step, printed a state line, and ended its turn with
// TodoWrite items still pending. Each step then waited for an external wake.
// The route appends this rule to the lead's system prompt on every lead call.
export const OSS_LEAD_CONTINUE_RULE =
  "Never end your turn while your todo list has pending or in_progress items, unless you need operator input or are blocked. After each step, continue with the next tool call.";

type Json = any;

/** Append OSS_LEAD_CONTINUE_RULE to an Anthropic Messages body's `system`. Pure: returns a new body, never mutates. Idempotent. */
export function withOssLeadContinueRule(body: Json): Json {
  const sys = body.system;
  if (typeof sys === "string") {
    if (sys.includes(OSS_LEAD_CONTINUE_RULE)) return { ...body };
    return { ...body, system: sys.length > 0 ? `${sys}\n\n${OSS_LEAD_CONTINUE_RULE}` : OSS_LEAD_CONTINUE_RULE };
  }
  if (Array.isArray(sys)) {
    if (sys.some((b) => b?.text === OSS_LEAD_CONTINUE_RULE)) return { ...body };
    return { ...body, system: [...sys, { type: "text", text: OSS_LEAD_CONTINUE_RULE }] };
  }
  return { ...body, system: OSS_LEAD_CONTINUE_RULE };
}
