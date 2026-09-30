/**
 * Issue #101 — rate-limit panes for the failover detector. Shared by the vitest
 * lane (test/studio.failover-fixtures.test.ts) and the real-shell lane
 * (test/bun/claude-account-switch.test.ts).
 *
 * Measured 2026-09-24 ~12:20Z: the fleet's single claude account hit its limit
 * and #53 failover never fired. PROVENANCE differs per fixture, and each one
 * says which it is:
 *   - V1 is VERBATIM — a saved `tmux capture-pane -p` of a real pane.
 *   - V2 and V3 are REBUILT around lines coordinators QUOTED from real panes;
 *     the quoted lines are exact, everything around them is reconstructed.
 *   - the #53 org-spend modal is the fixture #53 itself shipped.
 *   - the two usage-limit panes are NOT MEASURED at all.
 *
 * A fixture that must be detected is a wording claude prints; a detector change
 * that stops matching one is a regression by definition. The NOT_DETECTED
 * panes are what an idle lead's own output looks like when it talks ABOUT the
 * limit — every one of them fired against PR #102's first detector (review
 * verdict BLOCK), which matched substrings anywhere in the tail.
 */

/** Current claude input chrome: a ❯ prompt between two rules, then the footer. */
export const RULE_PROMPT = [
  "─".repeat(68),
  "❯ ",
  "─".repeat(68),
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
];

/** Older claude input chrome: an empty `>` prompt in a box. */
export const BOX_PROMPT = [
  "╭────────────────────────────────────────────────────────────────╮",
  "│ >                                                              │",
  "╰────────────────────────────────────────────────────────────────╯",
];

/**
 * V1, fleetflare--web-studio, 2026-09-24. VERBATIM: the whole 127-line visible
 * pane. No "You've hit ..." headline anywhere on screen — the modal is the
 * only evidence, so the modal alone must be enough.
 */
export const V1_FULL_PANE = [
  "root@cloudchamber:/workspace# cd /workspace/fleetflare && claude --dangerously-s",
  "kip-permissions --continue --append-system-prompt $'You are the Web Designer, le",
  "ad of Web Studio. Full-stack client sites and web apps — design IS code here, no",
  " separate design handoff.\\n\\nEphemeral. Spawn, execute, report, die. Take ONE co",
  "llision-free group of related tasks — never two that touch the same files, and n",
  "ever two unrelated ones. Related work shares context and is cheaper in one sessi",
  "on; unrelated or colliding work pollutes it and is why atomic teams exist. When",
  "grouped, deliver and report each task\\'s OWN envelope separately, one per board",
  "task — a grouped session is still one deliverable per envelope.\\n\\nYour members:",
  " Frontend Developer, Backend Developer (Directus, APIs, Workers, D1/KV), Code Re",
  "viewer (fresh-context, read-only), QA Engineer (browser, console, network). Disp",
  "atch by name.\\n\\nNever implement. Never touch Edit or Write yourself — a hook re",
  "fuses those calls and tells you to dispatch instead. It refuses Bash commands th",
  "at write files too: redirects, tee, sed -i, mv, cp. That Bash half is a blocklis",
  "t of known write forms, not a wall — a clever enough command still lands, so the",
  " rule is yours to keep, not the hook\\'s to guarantee. Every implementation step",
  "goes to a Developer, never you.\\n\\nTask arrives as a board issue. Classify scope",
  " first — spike, bounded, architectural. Bigger scope: brainstorm and design befo",
  "re planning. Every scope: plan before dispatch, TDD through implementation, veri",
  "fy before done. Not optional, every task.\\n\\nA Stop hook refuses your completion",
  " until two things are true, so build them as you go rather than at the end. Firs",
  "t, the plan doc is committed — a file in the repo, named in the record below. Se",
  "cond, the repo has `.fleet/done.json`:\\n\\n    {\"plan\": \"<repo-relative path of t",
  "hat committed plan doc>\",\\n     \"verification\": [{\"cmd\": \"bun run test\", \"exit\":",
  " 0, \"output\": \"<real tail>\"}]}\\n\\nOne entry per build/lint/check/test script the",
  " repo\\'s package.json declares, each exit 0, each carrying the real output. Disp",
  "atch a member to write that file — your own Write is refused. A fix task skips t",
  "he brainstorm, never the plan and never the verification.\\n\\nPlan the steps. Dis",
  "patch each to Frontend or Backend Developer. Implementation done: dispatch Code",
  "Reviewer — fresh context, no shared history, real review not a rubber stamp. Fin",
  "dings go back to the Developer, not around them. Dispatch QA Engineer to verify",
  "in browser before calling anything done.\\n\\nReview and QA both pass: open the PR",
  " yourself. Comment the envelope on the board issue — result, evidence, artifacts",
  ", status. That comment is your report. Never message the Maestro directly, board",
  " only, both directions.\\n\\nNever merge, never deploy — staging or prod, gated al",
  "ways. Tempted to run one: print this fenced block, exactly this shape, then stop",
  ".\\n```\\nAPPROVAL REQUEST: <merge_staging|deploy_staging|merge_main|deploy_prod>",
  "— <what and why>\\n```\\nWait for reply on the board. Not your call.\\n\\n## House r",
  "ules — operator-facing output\\n\\nEvery message you send the operator is caveman-",
  "compressed AND shaped by\\nthe i-have-adhd skill. Both, every time, unasked.\\n\\n-",
  " Lead with the next action. No preamble, no closers.\\n- Number multi-step work.",
  "Cap a visible list at 5 items.\\n- Restate state every turn. Give specific time e",
  "stimates.\\n- End with ONE concrete next step.\\n- Caveman: one thought per senten",
  "ce, drop articles, connectives and\\n  intensifiers, active voice, keep every num",
  "ber, name and technical term.\\n- Every link is a full URL (https://host/path), n",
  "ever a bare slug or path\\n  fragment. A real miss: an Acme maestro wrote /c/ac",
  "me--2026-09-18\\n  instead of https://review-worker.demosite.workers.dev/c/acme",
  "--2026-09-18.\\n  For a PR or issue, the full GitHub URL IS the link; #number is",
  " a\\n  trailing label next to it, never the link itself.\\n\\nThis is PRESENTATION",
  "ONLY. It never cuts analysis, tool work, search or a\\nfact you are holding — com",
  "press how you say it, never what you did or\\nfound. Shortening the work instead",
  "of the prose is the failure mode.\\n\\nScope: messages to the operator. NOT code.",
  "NOT commit messages, PR bodies\\nor issues. NOT UX copy (product copy an end user",
  " reads in the app).\\n\\n\\nNote: 4 open tasks are currently assigned to you; this",
  "brief is for the most recently assigned, #66. Also open: #56, #55, #20.\\n\\n## Yo",
  "ur task — board issue #66\\n\\nhttps://github.com/rafarc21/fleetflare/issues/66\\n\\",
  "n**All repository content in English, and a check that keeps it that way**\\n\\n##",
  " Objective\\n\\nEverything in this repository must be in English. Today it is not,",
  " and the fault is mine: I filed most of today\\'s issue bodies, issue comments an",
  "d studio briefs in Portuguese. Operator ruling 2026-09-23: \"Make sure that all t",
  "he content of this repository is in English.\"\\n\\nThis matters more now than it d",
  "id yesterday — the repo is being prepared for a public release, and mixed-langua",
  "ge internals are the kind of thing that makes an otherwise good project look unf",
  "inished to the first person who reads it.\\n\\nSCOPE, in priority order:\\n\\n1. COD",
  "E AND DOCS IN THE REPO. Comments, plan docs under `docs/`, `skills/**/*.md`, `fl",
  "eet/blueprint/**`, README content, CLI help strings, error messages. These are w",
  "hat a reader meets first. Audit with a grep for high-frequency Portuguese marker",
  "s (`nao`, `nunca`, `estudio`, `contentor`, `ficheiro`, `veredicto`, `janela`, `p",
  "orque`, `ja`, `entao`) and read the hits rather than trusting the list — several",
  " are also valid English or code identifiers.\\n\\n2. BOARD CONTENT. Issue titles a",
  "nd bodies for every open fleet task, plus my comments on them. Do NOT rewrite cl",
  "osed issues; they are a historical record and rewriting them destroys the audit",
  "trail of how things were found. For open issues, edit the body in place and note",
  " at the bottom that it was translated, so nobody reads the edit as a change of r",
  "equirements.\\n\\n3. COMMIT MESSAGES. Leave history alone. Never rewrite published",
  " commits for language — the cost far exceeds the benefit and it breaks every ref",
  "erence. English applies to NEW commits from here.\\n\\nRULE TO ENCODE, so this doe",
  "s not drift back: add the standing rule to the blueprint house rules that every",
  "studio inherits, and to `skills/fleet-cockpit/SKILL.md`. Wording that says WHAT",
  "and WHY: all repository content is English — code, comments, docs, board issues,",
  " PR titles and bodies, commit messages — because the project is read by people w",
  "ho do not share the operator\\'s first language. The operator\\'s own conversation",
  " language is a separate matter and not governed by this.\\n\\nCHECK IT STAYS TRUE:",
  " add a test or a CI step that fails on Portuguese markers in the paths from scop",
  "e 1. Keep the marker list small and high-confidence, and make the failure messag",
  "e name the file and line, so a false positive is cheap to see and fix. A check t",
  "hat is noisy gets disabled, which is worse than no check.\\n\\nDo NOT translate `.",
  "fleet/done.json` learning entries or `fleet/memory/**` harvested content in this",
  "",
  "",
  "● Architecture mapped. Writing task breakdown now, dispatching plan authoring to Backend Developer (11 tasks, all touch",
  "  points grounded in real code).",
  "",
  "● backend-developer(Write plan doc for #85 PR1)",
  "  ⎿  Done (90 tool uses · 281.2k tokens · 18m 53s)",
  "",
  "",
  "❯ WAKE TASK ASSIGNED #98 \"House rule: members push after the first RED test and after every commit\" | read it: fleet",
  "  task show 98",
  "",
  "❯ WAKE TASK ASSIGNED #90 \"The first claude launch on a cold container often misses the 20s budget, so the heal's single",
  "  attempt is not enough\" | read it: fleet task show 90",
  "",
  "  Ran 2 shell commands",
  "",
  "● 4 tasks now: #82 done (PR #97). #85 PR1 mid-execution, plan written. #90 new — root cause found, touches same",
  "  provision.ts as #85, maestro says land #85 PR1 first, then rebase #90 onto it. #98 new — blueprint-only, zero code",
  "  collision, running now in parallel.",
  "",
  "  Ran 1 shell command",
  "",
  "● backend-developer(Fix #98 blueprint push rule)",
  "  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)",
  "",
  "● #98 dispatched in background (own worktree, PR-bound). Back to #85 — reviewing the plan doc now before execution.",
  "",
  "  Searched for 2 patterns, read 1 file",
  "",
  "● Plan reviewed in depth (Tasks 1,2,3,4,6,7,8) — rigorous, grounded in real code, corrections documented. Trusting",
  "  remaining tasks 5/9/10/11. Executing now in 3 batches to keep each dispatch's context fresh.",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Upgrade your plan",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

/** V1's last 18 lines: the modal and the 11 lines of transcript above it. */
export const V1_STOP_AND_WAIT_PANE = V1_FULL_PANE.split("\n").slice(-18).join("\n");

/**
 * Issue #241, claude 2.1.281: a THIRD option this modal now offers alongside
 * "Stop and wait" / "Upgrade your plan" — "Add funds to continue with usage
 * credits". REBUILT, not verbatim-captured — no real capture of this modal
 * exists in the repo: the option texts and both orderings come from claude
 * 2.1.281's own rate-limit-options builder, per the #239 review's own reading
 * of that builder. The frame/transcript rows around the options were copied
 * from the existing V3_ADD_FUNDS_PANE fixture below (itself not a fresh real
 * capture either).
 */
export const V1_THREE_OPTION_PANE = [
  "⏺ Running the migration dry-run before the release.",
  "",
  "⏺ Bash(bun run migrate:dry)",
  "  ⎿  3 migrations pending",
  "",
  "▔".repeat(120),
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Add funds to continue with usage credits",
  "     3. Upgrade your plan",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

/** Same three options, reordered — the rate-limit-options BUILDER's own
 *  "flag-on" order (spend-related options listed first), not a guess about
 *  account state. Same three texts, different numbering, still a select
 *  modal, never inline. */
export const V1_THREE_OPTION_FLIPPED_PANE = [
  "⏺ Running the migration dry-run before the release.",
  "",
  "⏺ Bash(bun run migrate:dry)",
  "  ⎿  3 migrations pending",
  "",
  "▔".repeat(120),
  "   What do you want to do?",
  "",
  "   ❯ 1. Add funds to continue with usage credits",
  "     2. Upgrade your plan",
  "     3. Stop and wait for limit to reset",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

/**
 * V2, demosite-life--pilot and demosite-life--web-studio. REBUILT: the two limit
 * lines are the beta coordinator's quote, verbatim; the transcript above and the
 * prompt below are reconstructed. Not a dialog — claude prints the limit inline
 * and returns to its input box. Both prompt shapes, since which one a studio
 * draws depends on its claude version.
 */
const V2_BODY = [
  "⏺ Opening the PR for the pilot fix.",
  "",
  "⏺ Bash(gh pr create --fill)",
  "  ⎿  https://github.com/rafarc21/demosite-life/pull/12",
  "",
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "     /upgrade to increase your usage limit.",
  "",
];
export const V2_SESSION_LIMIT_PANE = [...V2_BODY, ...BOX_PROMPT].join("\n");
export const V2_SESSION_LIMIT_RULE_PANE = [...V2_BODY, ...RULE_PROMPT].join("\n");

/**
 * V3, acme-os--web-studio. REBUILT: the option list is the Acme
 * coordinator's quote ("1. Stop and wait" / "2. Add funds" / "3. Upgrade"),
 * drawn in V1's modal frame. Headline not captured, so none is drawn.
 */
export const V3_ADD_FUNDS_PANE = [
  "⏺ Running the migration dry-run before the release.",
  "",
  "⏺ Bash(bun run migrate:dry)",
  "  ⎿  3 migrations pending",
  "",
  "▔".repeat(120),
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait",
  "     2. Add funds",
  "     3. Upgrade",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

/** 2026-09-23, all four live studios (issue #53): the `/rate-limit-options` modal. */
export const ORG_SPEND_LIMIT_PANE = [
  "⏺ Read(docs/release.md)",
  "  ⎿  Read 42 lines",
  "",
  "╭────────────────────────────────────────────────────────────────╮",
  "│ You've hit your org's monthly spend limit                      │",
  "│                                                                │",
  "│ Run /rate-limit-options to see what you can do.                │",
  "│                                                                │",
  "│ ❯ 1. Upgrade your plan                                         │",
  "│   2. Not now                                                   │",
  "╰────────────────────────────────────────────────────────────────╯",
].join("\n");

/**
 * NOT MEASURED: the personal-plan headlines #53 listed alongside the org one.
 * Drawn in the 09-23 modal frame so every RATE_LIMIT_HEADLINES entry is pinned
 * by a fixture; replace with a real capture when one is seen.
 */
export const USAGE_LIMIT_PANE = ORG_SPEND_LIMIT_PANE.replace(
  "You've hit your org's monthly spend limit", "You've hit your usage limit              ",
);
export const USAGE_LIMIT_REACHED_PANE = ORG_SPEND_LIMIT_PANE.replace(
  "You've hit your org's monthly spend limit", "Claude usage limit reached               ",
);

// --- must NOT be detected ---------------------------------------------------
// Letters match the PR #102 review brief. Each is an IDLE lead (static pane)
// whose own output talks about the limit.

export const NOT_DETECTED: Record<string, string> = {
  "(a) prose naming the headline and the /upgrade prefix": [
    "⏺ PR #102 open. Detection now matches `You've hit your session limit` and the",
    "  `/upgrade` prefix. Tests green both lanes.",
    "", ...BOX_PROMPT,
  ].join("\n"),
  "(b) V2's two lines quoted in a report": [
    "⏺ Root cause for #101: the pane printed",
    "  \"You've hit your session limit · resets 1:30pm (UTC)\" and",
    "  \"/upgrade to increase your usage limit.\" — neither string was known.",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(c) git diff of the new wording, then a ⏺ line": [
    "⏺ Bash(git diff origin/main -- apps/fleet/src/studio/failover.ts | head -20)",
    "  ⎿  +  \"You've hit your session limit\",",
    "     +  \"/upgrade\",",
    "     +  \"Add funds\",",
    "     … +12 lines (ctrl+o to expand)",
    "", "⏺ Diff looks right. Waiting on CI.", "", ...RULE_PROMPT,
  ].join("\n"),
  "(d) V3's options as a numbered list": [
    "⏺ acme-os showed a third variant:",
    "  1. Stop and wait",
    "  2. Add funds",
    "  3. Upgrade",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(e) V1's options as a numbered list": [
    "⏺ fleetflare--web-studio's modal offered:",
    "  1. Stop and wait for limit to reset",
    "  2. Upgrade your plan",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(f) a single 'Stop and wait for limit to reset' list line": [
    "⏺ Checklist for #99 tests:",
    "  1. Stop and wait for limit to reset",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(g) a plan: '1. Stop and wait' / '2. Upgrade'": [
    "⏺ Two options for the deploy freeze:",
    "  1. Stop and wait",
    "  2. Upgrade",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(h) V1's modal quoted in prose, then more output": [
    "⏺ The V1 pane, verbatim:",
    "   What do you want to do?",
    "   ❯ 1. Stop and wait for limit to reset",
    "     2. Upgrade your plan",
    "   Enter to confirm · Esc to cancel",
    "  Filing #101 now.",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(i) V2's block, then a new turn after the reset": [
    "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
    "     /upgrade to increase your usage limit.",
    "",
    "❯ WAKE: limit reset, continue #85",
    "",
    "⏺ Resumed. #85 PR1 batch 2 dispatched in background.",
    "",
    "● backend-developer(Execute #85 batch 2)",
    "  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(j) the headline in prose, plus docs/upgrade.md": [
    "⏺ Searched transcripts: \"You've hit your session limit\" appears 58 times.",
    "  Also read docs/upgrade.md for the wrangler bump.",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "idle prose saying limit, upgrade and /upgrade": [
    "⏺ Done. The API rate limit is 5 req/s, so I added backoff. Next step is to",
    "  upgrade wrangler; run /upgrade in the SDK repo if the usage limit bites.",
    "  Stop and wait for CI before merging.",
    "", ...BOX_PROMPT,
  ].join("\n"),
  "a numbered plan starting with the option words": [
    "⏺ Plan for the release:",
    "  1. Stop and wait for CI to finish",
    "  2. Upgrade wrangler to 4.x",
    "  3. Add funds report to the dashboard",
    "", ...BOX_PROMPT,
  ].join("\n"),
};

// --- issue #106 ---------------------------------------------------------------
// PROVENANCE: the two RESUMED panes are VERBATIM `tmux capture-pane -p` of
// `claude --resume <id>` (2.1.281, 160x50, no prompt sent) on two dead local
// sessions whose jsonl ends in a rate_limit entry, 2026-09-24. They prove
// claude REDRAWS a persisted limit block, hint included, after a relaunch.
// The headline wordings are exact: counted from rate_limit entries in local
// ~/.claude/projects transcripts. The hint lines are exact strings from the
// claude 2.1.281 binary. Everything else around them is reconstructed.

/** Measured: session 1dabc3de resumed. Block redrawn TWICE; not last output. */
export const RESUMED_SESSION_LIMIT_PANE = [
  "⏺ Bash(DIRECTUS_URL=https://painel.exampleorg.com bunx astro dev --host 127.0.0.1 --port 41240 > /tmp/dev41240.log 2>&1)",
  "  ⎿  Running in the background (↓ to manage)",
  "  ⎿  You've hit your session limit · resets 5:50pm (Europe/Madrid)",
  "     /usage-credits to adjust your monthly spend limit.",
  "",
  "✻ Brewed for 7m 21s · done Monday, Sep 7 at 3:42 PM",
  "",
  "⏺ Background command \"DIRECTUS_URL=https://painel.exampleorg.com bunx astro dev --host 127.0.0.1 --port 41240 > /tmp/dev41240.log 2>&1\" completed (exit",
  "code 0)",
  "  ⎿  You've hit your session limit · resets 5:50pm (Europe/Madrid)",
  "     /usage-credits to adjust your monthly spend limit.",
  "",
  "✻ Churned for 1s · done Monday, Sep 7 at 3:43 PM",
  "",
  "⏺ Remote Control disconnected — signed-in claude.ai account or organization changed on this machine — run /remote-control to start a session for the",
  "  current account, or /login to switch back, then /remote-control",
  "",
  "─".repeat(160),
  "❯ ",
  "─".repeat(160),
  "  [CAVEMAN]",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 20 agents",
].join("\n");

/** Measured: session 53e64c5d resumed. The monthly-spend headline WRAPS: its tz sits on the next line. */
export const RESUMED_MONTHLY_SPEND_BLOCK = [
  "  ⎿  You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Sep 11 at 1am",
  "     (Europe/Madrid)",
  "     /usage-credits to adjust your monthly spend limit.",
];

/** A limit block as the turn's last output, then the ❯ prompt. */
function inlineBlock(block: string[]): string {
  return ["⏺ Opening the PR for the pilot fix.", "", ...block, "", ...RULE_PROMPT].join("\n");
}

export const MONTHLY_SPEND_WRAPPED_PANE = inlineBlock(RESUMED_MONTHLY_SPEND_BLOCK);

/**
 * Issue #241, verbatim from the reviewer's report: a DIFFERENT wrap shape from
 * RESUMED_MONTHLY_SPEND_BLOCK above — that one wraps its "(zone)" alone onto a
 * second row; this one wraps the headline itself across TWO rows (the url
 * clause splits mid-sentence) before a THIRD row carries the reset. Three rows
 * before the hint, not two — inlineLimitBlock's own block() already joins
 * however many rows its forward scan needs, but issue #232's position-free
 * veto (inlineLimitCandidate) only ever tried a 1- or 2-row join, so it never
 * reached this reset at all.
 */
export const MONTHLY_SPEND_THREE_ROW_WRAP_BLOCK = [
  "  ⎿  You've hit your monthly spend limit · raise it at",
  "     claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit",
  "     resets Sep 26 at 1am (Europe/Madrid)",
  "     /usage-credits to adjust your monthly spend limit.",
];

/** Bottom-anchored: the block ends the turn, straight into the idle input box. */
export const MONTHLY_SPEND_THREE_ROW_WRAP_PANE = [
  "⏺ Opening the PR for the pilot fix.", "",
  ...MONTHLY_SPEND_THREE_ROW_WRAP_BLOCK,
  "", "✻ Worked for 3s", "", ...RULE_PROMPT,
].join("\n");

/**
 * The SAME block, still physically on screen, but no longer bottom-anchored:
 * a resumed turn ran above the ruled box (`❯ go on` … `✻ Cooked for 2m 1s`),
 * so only the position-free veto can still see it.
 */
export const MONTHLY_SPEND_THREE_ROW_WRAP_MIDTURN_PANE = [
  "⏺ Opening the PR for the pilot fix.", "",
  ...MONTHLY_SPEND_THREE_ROW_WRAP_BLOCK,
  "", "✻ Worked for 3s", "",
  "❯ go on", "",
  "⏺ Resumed; batch 2 running.", "",
  "✻ Cooked for 2m 1s", "",
  ...RULE_PROMPT,
].join("\n");

export const MONTHLY_SPEND_SESSION_PANE = inlineBlock([
  "  ⎿  You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 1:30pm (Europe/Madrid)",
  "     /usage-credits to adjust your monthly spend limit.",
]);
export const WEEKLY_LIMIT_PANE = inlineBlock([
  "  ⎿  You've hit your weekly limit · resets Sep 26 at 12pm (Europe/Madrid)",
  "     /upgrade to increase your usage limit.",
]);
export const OUT_OF_CREDITS_PANE = inlineBlock([
  "  ⎿  You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
  "     /usage-credits to finish what you're working on.",
]);
export const SESSION_LIMIT_LOGIN_HINT_PANE = inlineBlock([
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "     /login to switch to an API usage-billed account.",
]);

/**
 * Issue #141 — the org-disabled-subscription line. Never resets (not a rate
 * limit at all: a human outside this fleet has to re-enable the account), and
 * not a select-style modal (no numbered options, no Enter/Esc footer) — one
 * self-contained `⎿` line, then straight back to claude's own idle input box.
 * NOT MEASURED verbatim against a real pane; the line itself is the exact
 * wording named in the board issue.
 */
export const ORG_DISABLED_PANE = inlineBlock([
  "  ⎿  Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead",
]);

/** Issue #141: a lead reporting ON this feature must never look like a lead
 *  that HIT it — same "idle prose talking about the limit" discipline as the
 *  main NOT_DETECTED map above, kept as its own small export so the new
 *  detector's own test file can pull in just this one fixture. */
export const NOT_DETECTED_141: Record<string, string> = {
  "prose reporting on issue #141, not the pane": [
    "⏺ Filed #141: some accounts print \"Your organization has disabled Claude",
    "  subscription access for Claude Code\" instead of resetting.",
    "", ...BOX_PROMPT,
  ].join("\n"),
};

/** Issue #106 item 4: a #53 headline quoted in prose ABOVE a real V2 block. */
export const ORG_HEADLINE_PROSE_ABOVE_V2_PANE = [
  "⏺ Yesterday's modal said You've hit your org's monthly spend limit, today's",
  "  is the session one.",
  "", ...V2_BODY, ...RULE_PROMPT,
].join("\n");

export const NOT_DETECTED_106: Record<string, string> = {
  "(k) #53 headline and 'Upgrade your plan' in prose": [
    "⏺ The #53 modal read:",
    "  You've hit your org's monthly spend limit",
    "  and offered Upgrade your plan or /rate-limit-options.",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(l) #53 headline then its options as a numbered list": [
    "⏺ The 09-23 modal, from memory:",
    "  You've hit your org's monthly spend limit",
    "  1. Upgrade your plan",
    "  2. Not now",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(m) weekly block quoted in prose, then more prose": [
    "⏺ Fleet saw the weekly wording:",
    "  You've hit your weekly limit · resets Sep 26 at 12pm (Europe/Madrid)",
    "  /upgrade to increase your usage limit.",
    "  Adding it to the detector now.",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(n) git diff of the new wordings": [
    "⏺ Bash(git diff origin/main -- apps/fleet/src/studio/failover.ts | head -20)",
    "  ⎿  +  \"You're out of usage credits.\",",
    "     +  \"You've hit your monthly spend limit · raise it at \",",
    "     +  \"/usage-credits\",",
    "     … +12 lines (ctrl+o to expand)",
    "", "⏺ Diff looks right. Waiting on CI.", "", ...RULE_PROMPT,
  ].join("\n"),
  "(o) the new wordings as a numbered list": [
    "⏺ Wordings to add:",
    "  1. You've hit your weekly limit · resets Sep 26 at 12pm (Europe/Madrid)",
    "  2. You're out of usage credits.",
    "  3. /login to switch to an API usage-billed account.",
    "", ...RULE_PROMPT,
  ].join("\n"),
  "(p) out-of-credits line with no hint under it": [
    "⏺ Checked the billing page.",
    "  ⎿  You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
    "", ...RULE_PROMPT,
  ].join("\n"),
};

// --- PR #112 review, fix pass A ----------------------------------------------
// VERBATIM limit rows from real studio panes (reviewer's capture set); the
// input chrome under them is RULE_PROMPT, since the real panes end in a turn
// line (`✻ Churned for 0s`) that shape B does not accept yet (fix pass B).

/** 2026-09-23 16:17Z, default 80-col pane: "raise it at" ends its row, trailing space trimmed by tmux. */
export const REAL_MONTHLY_SPEND_80COL_PANE = [
  "⏺ Opening the PR for the pilot fix.", "",
  "  ⎿  You've hit your monthly spend limit · raise it at",
  "     claude.ai/settings/usage?from=cc_cli_limit_message",
  "     /upgrade or /usage-credits to finish what you’re working on.",
  "", ...RULE_PROMPT,
].join("\n");

/** 2026-09-18, Linux claude: the dated reset with a comma, no " at ". */
export const REAL_WEEKLY_COMMA_DATE_PANE = [
  "  DIRECTO a #7 sem parar no prompt.",
  "  ⎿  You've hit your weekly limit · resets Sep 17, 8pm (UTC)",
  "     /upgrade to increase your usage limit.",
  "", ...RULE_PROMPT,
].join("\n");

/** Reviewer probe9 O1–O3: the out-of-credits sentence in a lead's own prose, a hint-like row under it. */
export const NOT_DETECTED_OUT_OF_CREDITS_PROSE: Record<string, string> = {
  "O1 prose sentence, next row /login": [
    "⏺ Pilot is idle. Its pane says why:", "  You're out of usage credits. Next step: top up, or run",
    "  /login to switch it to the API account.", "", ...RULE_PROMPT,
  ].join("\n"),
  "O2 prose sentence alone, next row /usage-credits": [
    "⏺ Billing check for #106:", "  You're out of usage credits.",
    "  /usage-credits opens the billing page; I did not run it.", "", ...RULE_PROMPT,
  ].join("\n"),
  "O3 prose sentence, a wrapped middle row, then /usage-credits": [
    "⏺ Summary:", "  You're out of usage credits. That is why the pilot", "  stopped mid-task; nothing else is wrong. Fix:",
    "  /usage-credits, then wake it.", "", ...RULE_PROMPT,
  ].join("\n"),
};

// --- issue #106 fix pass B: REAL studio panes ---------------------------------
// VERBATIM `tmux capture-pane -p` of four limited studios (PR #112 review's
// capture set), capture instants in REAL_PANE_CAPTURED_AT. The only edit: the
// weekly-dated pane's three rows of non-English task text are replaced by one
// English row of the same indent. Every real block is followed by a
// `✻ <Verb>ed for <dur>` turn line; two carry queued prompt text; two have no
// hint row. Shape B matched none of them before fix pass B.

export const REAL_PILOT_PANE = [
  "",
  "● Corrected the misunderstanding (it was waiting on a background-bash notification that doesn't exist). Waiting for real",
  "  completion this time.",
  "",
  "● Task 7 implementer had a real bug (waiting on a background-bash notification that never fires) — corrected and resumed. Next",
  "  check ~10 min.",
  "",
  "✻ Waiting for 1 background agent to finish",
  "",
  "● Agent \"Implement Task 7: gallery slice desktop+mobile\" failed: Agent terminated early due to an API error: You've hit your",
  "session limit · resets 1:30pm (UTC)",
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "",
  "✻ Baked for 1h 26m 31s",
  "",
  "✻ Claude resuming /loop wakeup (Sep 24 12:26pm)",
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "     /upgrade to increase your usage limit.",
  "",
  "✻ Cogitated for 0s",
  "",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ keep going",
  "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

export const REAL_WEBSTUDIO_PANE = [
  "",
  "● Agent \"Fresh-context review of Track A diff\" failed: Agent terminated early",
  "due to an API error: You've hit your session limit · resets 1:30pm (UTC)",
  "  ⎿  You've hit your session limit · resets 1:30pm (UTC)",
  "",
  "✻ Cooked for 36m 35s · 7 shells still running",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ check on task 2 progress",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on · 7 shells · ← for agents · ↓ to manage",
  "",
  "  ● main",
  "  ◯ frontend-developer  Track A e2e harness tasks 1… 1h 1m 15s · ↑ 225.5k tokens",
].join("\n");

export const REAL_WEEKLY_DATED_PANE = [
  "  Read fleet task 6 and 7 before starting; run both test suites before calling it green.",
  "  ⎿  You've hit your weekly limit · resets Sep 17, 8pm (UTC)",
  "     /upgrade to increase your usage limit.",
  "✻ Churned for 0s",
  "                      tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

export const REAL_WEEKLY_TIMEONLY_PANE = [
  "✻ Brewed for 5m 45s",
  "  No compl tion record was found for background agent \"Implement fleet destroy v rb\" from the previous s ssion. It may",
  "have been stopped, or it may have been running when the previous Claude Code process exited — either way its transcript",
  "is saved on disk, so its progress is not lost. Resume it by sending it a message with SendMessage, or check its",
  "worktree/output for partial work before assuming the task landed.",
  "  ⎿  You've hit your weekly limit · resets 8pm (UTC)",
  "✻ Baked for 0s",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

/** When each real pane was captured. */
export const REAL_PANE_CAPTURED_AT = {
  pilot: "2026-09-24T12:28:38.146Z",
  webstudio: "2026-09-24T12:28:52.932Z",
  weeklyDated: "2026-09-18T09:59:12.855Z",
  weeklyTimeOnly: "2026-09-17T15:27:48.069Z",
} as const;
