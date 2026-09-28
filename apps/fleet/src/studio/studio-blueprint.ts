// Studio parsing — P4a-1. Same contract as blueprint.ts: raw text in, typed
// Studio out, BlueprintError names bad field. Flat frontmatter only; studio
// nesting = directory structure (members/, hooks/), never syntax.
import { appendBrief, appendHouseRules, appendMemoryIndex, BlueprintError, parseSimpleArray, parseBoolean, VALID_EFFORT_LEVELS, base64EncodeUtf8 } from "./blueprint";

export interface Studio {
  /** Studio identifier — matches its directory name under
   *  `blueprint/studios/<name>/` (nesting is directory structure, never
   *  frontmatter syntax — see this file's own header). Machine id, e.g.
   *  "web-studio". */
  name: string;
  /** Human-readable studio title for display (dashboards, phone digest) —
   *  distinct from `name` above, which is the machine identifier. */
  title: string;
  /** Display name of the studio's lead, e.g. "Web Designer" — prose, not a
   *  machine id: it shows up verbatim in the lead's own system prompt
   *  ("You are the Web Designer, lead of Web Studio..."). The lead is the
   *  only agent in a studio that ever exchanges messages outward; members
   *  are dispatched, never addressed directly. */
  lead: string;
  /** Tier-1 domain skills for the lead (e.g. "frontend-design", "qa") —
   *  deliberately the studio's own delta, not its full resolved skill set:
   *  Tier 0 (the baseline every lead gets) is added downstream, at
   *  bring-up, not listed here. */
  skills: string[];
  /** Infisical secret NAMES the lead needs at bring-up (e.g.
   *  "UNSPLASH_KEY") — names only, never values: this parser only sees the
   *  studio file's text, never a secrets store. Resolving name -> value is
   *  provisioning's job, same boundary blueprint.ts's own header draws for
   *  role files. */
  secrets: string[];
  /** MCP server names to enable for this studio (e.g. ["playwright"]) —
   *  names only; resolved against the fleet's own MCP registry downstream.
   *  This parser makes no claim the named servers exist. */
  mcp: string[];
  /** Lead's tool allowlist, held verbatim — same "do not helpfully
   *  pre-split" contract Role.allowedTools carries in blueprint.ts's own
   *  roleBringupEnv: claude's paren-aware tokenizer is what splits a rule
   *  like "Bash(git *)", not this parser. */
  allowedTools: string;
  /** Same optional `--effort` override as Role.effort (blueprint.ts):
   *  absent means "no opinion" (stays undefined, no default applied at
   *  parse time); present must be one of VALID_EFFORT_LEVELS or
   *  parseStudioFile throws BlueprintError naming it. */
  effort?: string;
  /** Optional model override for the lead agent — absent means "use the
   *  fleet's own default model". Present but blank is rejected (see
   *  parseStudioFile's own check), not silently accepted as "no
   *  override". */
  model?: string;
  /** Defaults to `true` when absent — the studio's lead (the maestro)
   *  stays resident so members can be dispatched without a cold spawn per
   *  task, same "studios burn credits deliberately" reasoning
   *  Role.keep_alive already carries in blueprint.ts, and the same never-
   *  `boolean | undefined` shape: a real default exists, so there is no
   *  third "unset" state to preserve. */
  keep_alive: boolean;
  /** The lead's system prompt — everything after the closing `---`,
   *  trimmed. Never empty, see parseStudioFile's own "empty body" check.
   *  Plays the same role Role.prompt does: handed to
   *  `--append-system-prompt` at bring-up. */
  prompt: string;
}

// skills/secrets/mcp are required keys but legally empty — "[]" is a real,
// expected value for all three (a studio can decline extra skills, secrets,
// or MCP servers). Same required-but-emptiable split
// REQUIRED_ROLE_FIELDS/REQUIRED_NONEMPTY_ROLE_FIELDS draw in blueprint.ts,
// for the same reason.
const REQUIRED = ["name", "title", "lead", "skills", "secrets", "mcp", "allowedTools"] as const;
const REQUIRED_NONEMPTY = ["name", "title", "lead", "allowedTools"] as const;

/**
 * Parses one `blueprint/studios/<name>/studio.md` file: `---`-delimited
 * frontmatter (all of REQUIRED present, REQUIRED_NONEMPTY also non-blank,
 * effort validated against VALID_EFFORT_LEVELS when present) plus a
 * non-empty body (the lead's system prompt). Throws BlueprintError naming
 * the exact field that's missing/malformed — same contract parseRoleFile
 * keeps for role files.
 */
export function parseStudioFile(md: string): Studio {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new BlueprintError("frontmatter", "studio file must start with a --- delimiter");
  }
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) {
    throw new BlueprintError("frontmatter", "studio file frontmatter has no closing --- delimiter");
  }

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closeIdx)) {
    if (line.trim() === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) {
      throw new BlueprintError("frontmatter", `malformed line (expected "key: value"): ${line}`);
    }
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }

  for (const field of REQUIRED) {
    if (!(field in fields)) {
      throw new BlueprintError(field, `studio frontmatter is missing required field "${field}"`);
    }
  }
  for (const field of REQUIRED_NONEMPTY) {
    if (fields[field] === "") {
      throw new BlueprintError(field, `studio frontmatter field "${field}" must not be empty`);
    }
  }

  // Same "present must be valid, blank counts as invalid" rule Role.effort's
  // own check enforces in blueprint.ts — checked against the fixed level set
  // rather than merely non-empty, so a present-but-blank value is also
  // caught without a separate blank check.
  if (fields.effort !== undefined && !VALID_EFFORT_LEVELS.includes(fields.effort as never)) {
    throw new BlueprintError("effort", `expected one of ${VALID_EFFORT_LEVELS.join(", ")}, got: ${fields.effort}`);
  }
  // model has no REQUIRED_NONEMPTY entry (absent is a legal "no override"),
  // but present-and-blank would silently defeat that same "no override"
  // meaning by parsing to Studio.model = "" — reject it instead, same
  // "no silently-wrong value" rule instance_type's own blank check keeps in
  // blueprint.ts.
  if (fields.model === "") {
    throw new BlueprintError("model", "must not be empty when present");
  }

  const prompt = lines.slice(closeIdx + 1).join("\n").trim();
  if (prompt === "") {
    throw new BlueprintError("prompt", "lead system prompt (studio body) is empty");
  }

  return {
    name: fields.name,
    title: fields.title,
    lead: fields.lead,
    skills: parseSimpleArray(fields.skills, "skills"),
    secrets: parseSimpleArray(fields.secrets, "secrets"),
    mcp: parseSimpleArray(fields.mcp, "mcp"),
    allowedTools: fields.allowedTools,
    effort: fields.effort,
    model: fields.model,
    // Optional, default true — see Studio.keep_alive's own doc comment.
    keep_alive: fields.keep_alive !== undefined ? parseBoolean(fields.keep_alive, "keep_alive") : true,
    prompt,
  };
}

// Member files = verbatim Claude Code subagent format. We copy bytes, never
// rewrite — validation only guards the copy. 12-tool cap = spec §2.8.
const MEMBER_TOOL_CAP = 12;

/** `tools` is the member frontmatter's own string, held verbatim and
 *  unsplit — same "do not helpfully pre-split" rule Studio.allowedTools
 *  keeps. Absent when the member declares none (which means "inherit every
 *  tool", not "no tools"), so `undefined` and `""` are deliberately not the
 *  same value here. Read by `writesCode` below; the tool CAP check further
 *  down already parsed it, so this only stops the parse being thrown away. */
export interface MemberFile { name: string; raw: string; tools?: string }

export function validateMemberFile(filename: string, md: string): MemberFile {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") throw new BlueprintError("member", `${filename}: must start with ---`);
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) throw new BlueprintError("member", `${filename}: no closing ---`);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closeIdx)) {
    if (line.trim() === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue; // CC agent frontmatter may carry lines we don't model; copy is verbatim
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  if (!fields.name) throw new BlueprintError("member", `${filename}: missing "name"`);
  if (!fields.description) throw new BlueprintError("member", `${filename}: missing "description"`);
  if (filename !== `${fields.name}.md`) {
    throw new BlueprintError("member", `${filename}: filename must match name "${fields.name}"`);
  }
  if (fields.tools) {
    const count = fields.tools.split(",").map((t) => t.trim()).filter(Boolean).length;
    if (count > MEMBER_TOOL_CAP) {
      throw new BlueprintError("member", `${filename}: ${count} tools exceeds cap ${MEMBER_TOOL_CAP}`);
    }
  }
  if (lines.slice(closeIdx + 1).join("\n").trim() === "") {
    throw new BlueprintError("member", `${filename}: body (member prompt) is empty`);
  }
  return { name: fields.name, raw: md, tools: fields.tools };
}

// Tier 0 — locked skills, EVERY studio, non-removable (spec §4). Names =
// skill dir names materialized by bringup (Task 4). Caveman + superpowers
// process spine + delivery gate.
export const TIER0_SKILLS: readonly string[] = [
  "caveman",
  "brainstorming",
  "writing-plans",
  "executing-plans",
  "test-driven-development",
  "systematic-debugging",
  "verification-before-completion",
  "requesting-code-review",
  "using-git-worktrees",
  "delivery-standards",
];

/**
 * The three tools that structurally write files. Same three the lead gate
 * blocks outright (container/studio-bringup.sh's matcher), read here from the
 * other end: a member HOLDING one is what makes its studio a studio that
 * writes code.
 */
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/**
 * Does this roster write code? Spec §4's Tier-0 "no completion without
 * verification" row applies to the studios that implement, and NOT to the
 * Maestro, which never does — a Stop-gate demanding a committed plan doc and
 * green build output would wedge a coordination-only studio on its very first
 * turn.
 *
 * DERIVED, never declared. The one honest source is the roster itself: spec
 * §2.11 puts implementation tools ONLY in member subagents, so a studio writes
 * code exactly when one of its members holds a write tool. A `gates:` field in
 * studio.md would be a second source that can disagree with the first.
 *
 * Split on commas and compared whole — `WriteReview` is not `Write`. A member
 * declaring no `tools` at all inherits everything, write tools included, so it
 * counts (that is what claude's own agent format means by an absent `tools`).
 */
export function writesCode(members: MemberFile[]): boolean {
  return members.some((m) => {
    if (m.tools === undefined) return true;
    const held = m.tools.split(",").map((t) => t.trim());
    return WRITE_TOOLS.some((w) => held.includes(w));
  });
}

/**
 * Env vars the container's studio-bringup.sh consumes to provision a lead agent
 * and dispatch its members (Task 4's contract). Mirrors roleBringupEnv from
 * blueprint.ts (see that function's doc comment for the effort precedence rule
 * and prompt-encoding rationale); the three ROLE_* fields are verbatim
 * re-reads by studio-bringup.sh, so renaming breaks the existing launch path.
 *
 * Members ship as STUDIO_MEMBERS_B64 = b64(JSON: {filename: b64(raw)}) — one
 * env var, arbitrary UTF-8 member bodies survive round-trip, members stay
 * verbatim per spec §2.9.
 *
 * ROLE_EFFORT precedence: explicit Studio.effort wins; absent on maestro
 * rolls to "max" (T0 ruling: maestro leads broad initiatives, deserves capped
 * reasoning); absent on every other studio is "" (pass no --effort flag, claude
 * uses its own default).
 *
 * STUDIO_LEAD_DISALLOWED is an INSTALL SWITCH, not a matcher and not a CLI
 * flag value. studio-bringup.sh reads it as a boolean only ("is there a lead
 * restriction to enforce"): non-empty installs the PreToolUse lead-gate hook,
 * "" skips it entirely and thereby defeats spec decision 11, so this function
 * always sets it. The matcher itself is HARDCODED in studio-bringup.sh, not
 * derived from this value — it has to be, because the gate treats Bash
 * differently from Edit/Write/NotebookEdit (Bash is inspected for file-write
 * forms rather than blocked outright, fix wave Critical #1), which no flat
 * space-separated list can express. The value's content is human-readable
 * documentation of what the gate blocks, nothing more; a space-separated
 * string would in any case be an invalid claude matcher (they are
 * `|`-separated).
 *
 * --disallowedTools was disqualified outright because it is session-global
 * and starves member subagents — T0 spike, .superpowers/spike-lead-tools.md.
 */
export interface StudioBringupEnv {
  ROLE_PROMPT_B64: string;
  ROLE_ALLOWED_TOOLS: string;
  ROLE_EFFORT: string;
  STUDIO_NAME: string;
  STUDIO_SKILLS: string;
  STUDIO_MEMBERS_B64: string;
  STUDIO_MCP: string;
  STUDIO_LEAD_DISALLOWED: string;
  /** Install switch for the Tier-0 completion gate (Stop hook), read as a
   *  BOOLEAN by studio-bringup.sh exactly like STUDIO_LEAD_DISALLOWED above:
   *  non-empty installs, "" skips. Derived by `writesCode` from the roster —
   *  see its doc comment for why a studio file must not declare this itself. */
  STUDIO_COMPLETION_GATE: string;
}

/**
 * Turns a parsed Studio and its members into the env vars container
 * studio-bringup.sh consumes (Task 4's contract). See StudioBringupEnv's doc
 * comment for the ROLE_* reuse rationale, members bundle shape, and effort
 * precedence rule.
 *
 * `briefPrompt` (P4a-2) rides in the SAME ROLE_PROMPT_B64 the lead prompt
 * already travels in — see blueprint.ts's appendBrief for why that is one
 * mechanism and not two.
 */
export function studioBringupEnv(
  studio: Studio, members: MemberFile[], briefPrompt?: string, memoryIndex?: string | null,
  operatorHouseRules?: string | null,
): StudioBringupEnv {
  const skills = [...new Set([...TIER0_SKILLS, ...studio.skills])];
  const bundle: Record<string, string> = {};
  for (const m of members) bundle[`${m.name}.md`] = base64EncodeUtf8(m.raw);
  return {
    // House rules (neutral default + optional operator overlay), then memory
    // index, then brief — one channel. See blueprint.ts's appendMemoryIndex
    // for the memory/brief ordering rule and why there is no second var, and
    // appendHouseRules for why the rules (and any operator overlay of them)
    // go innermost. Wired here as well as in roleBringupEnv because a studio
    // NEVER passes through that function: provision.ts picks the studio path
    // whenever a studio.md exists, so covering only the role path would leave
    // every real studio without the rules.
    ROLE_PROMPT_B64: base64EncodeUtf8(
      appendBrief(appendMemoryIndex(appendHouseRules(studio.prompt, operatorHouseRules), memoryIndex), briefPrompt),
    ),
    ROLE_ALLOWED_TOOLS: studio.allowedTools,
    ROLE_EFFORT: studio.effort ?? (studio.name === "maestro" ? "max" : ""),
    STUDIO_NAME: studio.name,
    STUDIO_SKILLS: skills.join(","),
    STUDIO_MEMBERS_B64: base64EncodeUtf8(JSON.stringify(bundle)),
    STUDIO_MCP: studio.mcp.join(","),
    // Install switch — read as a boolean by bringup, never as a matcher. See
    // StudioBringupEnv's own doc comment. "Bash" is listed because the gate
    // now inspects it too (write forms only), which is exactly why this
    // string can't BE the matcher.
    STUDIO_LEAD_DISALLOWED: "Edit Write NotebookEdit Bash(write-forms)",
    // Same install-switch shape, same boolean reading. "" for a studio with
    // no implementing member (maestro, solo) — see writesCode.
    STUDIO_COMPLETION_GATE: writesCode(members) ? "1" : "",
  };
}
