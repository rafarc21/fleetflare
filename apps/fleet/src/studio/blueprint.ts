// Blueprint parsing — the ONLY thing this file does is turn raw text (a role
// file's frontmatter+prompt, or fleet.json's JSON) into a typed object, or
// throw BlueprintError naming the field that's wrong. No network, no
// filesystem, no @cloudflare/sandbox import: pure functions, directly
// unit-testable (test/studio.blueprint.test.ts). Fetching the raw text and
// deciding WHAT to fetch (which repo, which ref, which path) is provision.ts's
// job, not this file's — see that file's own header for the wiring.
//
// Frontmatter format (hand-rolled, deliberately not YAML — brief's own
// ruling): `---` delimited, `key: value` lines, and a minimal `[a, b]` /
// `[]` array syntax for the three list-shaped fields (skills/may_spawn/
// gates). No nested structures, no multi-line values — the blueprint's role
// files are meant to stay this simple.

export class BlueprintError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`blueprint ${field}: ${message}`);
    this.name = "BlueprintError";
    this.field = field;
  }
}

export interface Role {
  name: string;
  skills: string[];
  allowedTools: string;
  may_spawn: string[];
  reports_to: string;
  gates: string[];
  /**
   * Fleet Spawn P3 (R-P3-3): per-role instance-size override — falls back
   * to fleet.json's own `instance_type` when absent. Optional with no
   * parse-time default (unlike keep_alive below): "absent" and "explicitly
   * set to fleet.json's value" are different authoring choices even though
   * they resolve the same size.
   *
   * Task 4 RULING (binding, not a placeholder): this field is parsed and
   * carried on `Role` for the operator's own reference — it is deliberately
   * NEVER read by provisioning or any other runtime code path. The
   * container platform fixes instance size (CPU/memory class) per Durable
   * Object CONTAINER CLASS at deploy time (wrangler.jsonc's `containers[].
   * instance_type`, one value for every StudioDO regardless of which role
   * provisions into it) — there is no per-DO-instance override the SDK
   * exposes, so a runtime "apply this role's instance_type" knob would have
   * nothing real to turn. Sizing a role differently means giving it its own
   * container class (a wrangler.jsonc/Dockerfile change, a deploy, and a
   * provision-time class selection this feature does not add), which is
   * deploy-config work, not something a role file can express. See
   * docs/superpowers/OPERATOR-FINISH-LIST.md's P3 section for the operator
   * framing of this same ruling.
   */
  instance_type?: string;
  /**
   * Fleet CTO effort default (operator directive 2026-08-19): per-role
   * override of claude's `--effort` flag. Optional with no parse-time
   * default (same shape as instance_type above, unlike keep_alive below) —
   * validated against claude's own accepted levels (low/medium/high/xhigh/
   * max) when present, else BlueprintError; absent stays `undefined`. The
   * cto→"max" default is deliberately NOT applied here: it is resolved in
   * roleBringupEnv (below), the one place that already knows the role's
   * name, so an explicit frontmatter value and "no opinion, defer to the
   * role-based default" stay distinguishable right up to that point.
   */
  effort?: string;
  /** Fleet Spawn P3 (R-P3-6): per-role keepAlive policy. Defaults to `true`
   *  when the frontmatter omits it — "studios burn credits deliberately"
   *  (design spec) — so existing role files with no opinion on this keep
   *  today's always-on behavior unchanged. Unlike instance_type, this DOES
   *  have a real default: there is no third "unset" state provisioning
   *  needs to distinguish, so the type stays a plain `boolean`, not
   *  `boolean | undefined` — same reasoning as may_spawn's own `string[]`
   *  (never `string[] | undefined`) below. */
  keep_alive: boolean;
  /** The role file's body (everything after the closing `---`), trimmed —
   *  this IS the Claude Code system prompt handed to `--append-system-prompt`
   *  (via roleBringupEnv below). Never empty — see parseRoleFile's own
   *  "empty body" check. */
  prompt: string;
}

export interface FleetConfig {
  blueprint: { repo: string; ref: string };
  roles: string[];
  instance_type: string;
}

const REQUIRED_ROLE_FIELDS = ["name", "skills", "allowedTools", "reports_to", "gates"] as const;
// Subset of REQUIRED_ROLE_FIELDS that must be non-empty, not just present.
// Deliberately excludes skills/gates: `[]` is a legitimate, expected value
// for those two (pilot.md ships both empty) — only the three scalar fields
// have no valid empty form.
const REQUIRED_NONEMPTY_ROLE_FIELDS = ["name", "allowedTools", "reports_to"] as const;

// Fleet Spawn P3, Task 1: may_spawn moved OUT of REQUIRED_ROLE_FIELDS —
// R-P3-6's blueprint extension makes it optional, default `[]`, same as
// instance_type/keep_alive below (all three are new-in-P3 and none has an
// existing role file depending on required-presence, may_spawn included:
// pilot.md declares it, but an omitted one must now parse cleanly rather
// than throw). Handled separately from parseSimpleArray's REQUIRED callers
// (skills/gates, still in REQUIRED_ROLE_FIELDS) since "absent -> default"
// and "present -> parse" are two different code paths, not a validation
// rule parseSimpleArray itself should grow.

/**
 * `[]` or `[a, b, "c"]` -> string[]. Deliberately minimal: comma-split,
 * each element trimmed and stripped of one optional wrapping quote pair — no
 * escaping, no nested brackets, no commas-inside-quoted-elements support.
 * Good enough for role names/skill tags; not a general array-literal parser.
 */
export function parseSimpleArray(value: string, field: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new BlueprintError(field, `expected a simple array like [] or [a, b], got: ${value}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
}

/**
 * `"true"` / `"false"` -> boolean, for keep_alive (the frontmatter format
 * has no native boolean literal — see this file's own header on why it's
 * hand-rolled key:value text, not YAML). Anything else throws
 * BlueprintError naming the field, same "no silent wrong value" contract
 * parseSimpleArray and the required-nonempty checks below already keep.
 */
export function parseBoolean(value: string, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BlueprintError(field, `expected "true" or "false", got: ${value}`);
}

/** claude's own accepted `--effort` levels, for Role.effort's present-value
 *  validation below (Fleet CTO effort default, operator directive
 *  2026-08-19). */
type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const VALID_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Parses one `fleet/blueprint/roles/<name>.md` file: `---`-delimited
 * frontmatter (all five of REQUIRED_ROLE_FIELDS required, in any order,
 * plus the three optional Fleet Spawn P3 fields — may_spawn/instance_type/
 * keep_alive, each defaulted when absent, see Role's own doc comments) plus
 * a non-empty body. Throws BlueprintError naming the exact field that's
 * missing/malformed — never a generic "parse failed".
 */
export function parseRoleFile(md: string): Role {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new BlueprintError("frontmatter", "role file must start with a --- delimiter");
  }
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) {
    throw new BlueprintError("frontmatter", "role file frontmatter has no closing --- delimiter");
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

  for (const field of REQUIRED_ROLE_FIELDS) {
    if (!(field in fields)) {
      throw new BlueprintError(field, `role frontmatter is missing required field "${field}"`);
    }
  }
  // Review finding: presence (`field in fields`) alone let `allowedTools:`
  // (present, empty) through as `role.allowedTools = ""` with no error —
  // silently defeating the parser's own "throws BlueprintError naming the
  // bad field" contract. requireString (below, for fleet.json) already
  // rejects empty; the three scalar role fields need the same rule.
  for (const field of REQUIRED_NONEMPTY_ROLE_FIELDS) {
    if (fields[field] === "") {
      throw new BlueprintError(field, `role frontmatter field "${field}" must not be empty`);
    }
  }

  const prompt = lines.slice(closeIdx + 1).join("\n").trim();
  if (prompt === "") {
    throw new BlueprintError("prompt", "role body (system prompt) is empty");
  }

  // Fix round (Minor, folded): instance_type is optional (absent ->
  // undefined is fine, "no override" — see Role's own doc comment), but a
  // PRESENT-and-blank value is wrong the same way the three
  // REQUIRED_NONEMPTY_ROLE_FIELDS scalars already are — `fields.instance_type
  // ?? fleetInstanceType` (provisioning's own fallback) does NOT fall back
  // on "" (`??` only triggers on null/undefined), so a blank value would
  // silently survive as a real, empty instance_type instead of correctly
  // deferring to fleet.json. Distinct from REQUIRED_NONEMPTY_ROLE_FIELDS
  // itself since instance_type is never required to be present at all —
  // only non-empty WHEN it is.
  if (fields.instance_type === "") {
    throw new BlueprintError("instance_type", 'role frontmatter field "instance_type" must not be empty when present');
  }

  // Fleet CTO effort default (operator directive 2026-08-19): effort is
  // optional (absent is fine — see Role.effort's own doc comment), but a
  // PRESENT value must be one of claude's own accepted levels, same
  // "no silently-wrong value" contract instance_type's blank check above
  // already enforces — checked against a fixed set here instead of merely
  // non-empty, so this also catches a present-but-blank value (`""` is not
  // one of the five levels) without a separate blank-only check.
  if (fields.effort !== undefined && !VALID_EFFORT_LEVELS.includes(fields.effort as EffortLevel)) {
    throw new BlueprintError("effort", `expected one of ${VALID_EFFORT_LEVELS.join(", ")}, got: ${fields.effort}`);
  }

  return {
    name: fields.name,
    skills: parseSimpleArray(fields.skills, "skills"),
    allowedTools: fields.allowedTools,
    // Fleet Spawn P3, Task 1: optional, default [] — see this file's own
    // comment above REQUIRED_ROLE_FIELDS for why "absent" and "present"
    // are two different code paths here rather than one more entry in
    // REQUIRED_ROLE_FIELDS.
    may_spawn: fields.may_spawn !== undefined ? parseSimpleArray(fields.may_spawn, "may_spawn") : [],
    reports_to: fields.reports_to,
    gates: parseSimpleArray(fields.gates, "gates"),
    // Optional, no default — undefined means "no override", see Role's own
    // doc comment (provisioning falls back to fleet.json's instance_type).
    instance_type: fields.instance_type,
    // Optional, no default — undefined means "no explicit opinion"; the
    // cto→"max" default is applied downstream, in roleBringupEnv, not here
    // (see Role.effort's own doc comment).
    effort: fields.effort,
    // Optional, default true — see Role's own doc comment.
    keep_alive: fields.keep_alive !== undefined ? parseBoolean(fields.keep_alive, "keep_alive") : true,
    prompt,
  };
}

function requireString(obj: Record<string, unknown>, key: string, field: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BlueprintError(field, "missing or not a non-empty string");
  }
  return value;
}

/**
 * Parses a `fleet.json` (per-repo, non-secret — spec's "Per-repo" line):
 * which blueprint repo/ref to pull role files from, which roles are
 * enabled, and instance size. Throws BlueprintError naming the exact
 * missing/malformed field, same contract as parseRoleFile.
 */
export function parseFleetJson(s: string): FleetConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch (err) {
    throw new BlueprintError("fleet.json", `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BlueprintError("fleet.json", "must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const blueprintRaw = obj.blueprint;
  if (typeof blueprintRaw !== "object" || blueprintRaw === null || Array.isArray(blueprintRaw)) {
    throw new BlueprintError("blueprint", "missing or not an object");
  }
  const bp = blueprintRaw as Record<string, unknown>;

  const roles = obj.roles;
  if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string")) {
    throw new BlueprintError("roles", "missing or not an array of strings");
  }

  return {
    blueprint: {
      repo: requireString(bp, "repo", "blueprint.repo"),
      ref: requireString(bp, "ref", "blueprint.ref"),
    },
    roles,
    instance_type: requireString(obj, "instance_type", "instance_type"),
  };
}

/**
 * Cross-check between an already-parsed fleet.json and the role a caller is
 * about to provision: fleet.json's `roles` array is the enable-list (spec's
 * "enabled roles" — a blueprint repo can define more roles than any one
 * client repo turns on). Throws BlueprintError naming the requested role
 * when it isn't on that list, instead of proceeding to fetch a role file
 * fleet.json itself never declared.
 */
export function assertRoleInFleet(fleet: FleetConfig, role: string): void {
  if (!fleet.roles.includes(role)) {
    throw new BlueprintError("role", `role "${role}" is not declared in fleet.json roles [${fleet.roles.join(", ")}]`);
  }
}

// Chunked (0x8000/chunk) the same way sandbox-api.ts's bytesToBase64 is —
// avoids a call-stack blowup on a long prompt, and goes through
// TextEncoder first so multi-byte UTF-8 round-trips losslessly (a bare
// btoa(prompt) throws outright on any character outside Latin1).
const B64_CHUNK = 0x8000;

export function base64EncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

/**
 * Turns a parsed Role into the three env vars the container's bring-up
 * script consumes (Task 8's contract, container/studio-bringup.sh): base64
 * the prompt (the script itself does `base64 -d`), pass allowedTools through
 * verbatim — the script hands the WHOLE string to `--allowedTools` as one
 * argv element and lets claude's own paren-aware tokenizer split it, so a
 * rule containing spaces ("Bash(git *)") survives intact. Do not "helpfully"
 * pre-split it here either. Kept alongside the Role type rather than in provision.ts so the
 * "how do I turn a Role into bring-up env" transform is directly
 * unit-testable without any network/exec mocking.
 *
 * Fleet CTO effort default (operator directive 2026-08-19): ROLE_EFFORT
 * resolves here, the one place that already knows both the role's explicit
 * `effort` (or its absence) AND its `name` — an explicit frontmatter value
 * always wins; absent on the cto role defaults to "max" (the human argues
 * with the CTO agent, so it gets capped at its own best reasoning by
 * default); absent on every other role is "", which studio-bringup.sh's own
 * `${ROLE_EFFORT:-}` guard reads as "pass no --effort flag, use claude's own
 * default" — never a wrong-but-present value.
 */
/**
 * P4a-2 (brief pickup): the task brief, appended to the role/studio prompt so
 * a studio provisioned FOR a task starts with that task in hand.
 *
 * The SAME env var, deliberately — not a second mechanism. ROLE_PROMPT_B64 is
 * already the one channel a lead's instructions travel through
 * (container/studio-bringup.sh decodes it into `--append-system-prompt`), it
 * already survives a restart via ROLE_ENV_KEY, and it needs no change to the
 * bring-up script at all. A separate TASK_BRIEF_B64 would have meant a second
 * decode path in a shell script, a second thing to forget, and two places a
 * lead's instructions could disagree.
 *
 * Absent brief -> the prompt is returned untouched, byte for byte, which is
 * every studio that predates this feature and every studio spawned without a
 * task.
 */
export function appendBrief(prompt: string, briefPrompt: string | undefined): string {
  return briefPrompt === undefined || briefPrompt.trim() === "" ? prompt : `${prompt}\n\n${briefPrompt.trim()}\n`;
}

/**
 * P5d (memory read side, spec §7/§9): the fleet memory INDEX, appended to the
 * role/studio prompt so a studio boots knowing what the fleet has learned.
 *
 * The SAME channel and the same shape as appendBrief above, deliberately — see
 * that function's own doc comment for why one env var beats two. Composed
 * BEFORE the brief at both call sites, so the task the studio was spawned for
 * stays last and most salient; memory is context, the brief is the job.
 *
 * Null/empty returns the prompt byte for byte, which is every studio
 * provisioned while the blueprint repo has no index yet and every studio whose
 * index fetch failed. Memory never blocks a bring-up (§7's own rule for the
 * optional stores: a store that can block provisioning is another way to have
 * no fleet).
 */
export function appendMemoryIndex(prompt: string, memoryIndex: string | null | undefined): string {
  return memoryIndex === undefined || memoryIndex === null || memoryIndex.trim() === ""
    ? prompt
    : `${prompt}\n\n${memoryIndex.trim()}\n`;
}

/**
 * Neutral, product-wide default house rules: what EVERY operator running this
 * fleet software gets, unconditionally, regardless of which repo they run it
 * against. Issue #330 (public-release prep) split this constant from a prior
 * version that also baked in ONE specific operator's own preferences as a
 * hardcoded default — this doc comment records what moved out and why, and
 * where it went, so the split doesn't silently re-drift back together.
 *
 * MOVED OUT (now optional, operator-owned content — see appendHouseRules's
 * second parameter and provision.ts's OPS_HOUSE_RULES_PATH/
 * resolveOperatorHouseRules below):
 *   - The entire "operator-facing output" section: a caveman-compressed +
 *     i-have-adhd communication-STYLE mandate for how a studio talks TO one
 *     particular operator, including a broken-URL example naming that
 *     operator's own infra ("an Acme maestro", a demosite.workers.dev URL).
 *     Real and worth keeping for that operator, but not a generic default a
 *     new operator would want imposed on them.
 *   - The "GitHub Actions is disabled, read the local-ci commit status
 *     instead" paragraph that used to live inside "repository language"
 *     (board issue #267): one operator's own CI infrastructure choice, not a
 *     universal default — plenty of operators run this software with GitHub
 *     Actions enabled.
 *   - Every hardcoded literal `rafarc21/fleetflare` repo slug: actively WRONG
 *     copy for any operator working on a different repo, which is every
 *     other operator's normal case. Where the underlying rule was still
 *     universal (the English-content rule below), the text was genericized
 *     to drop the repo name rather than deleted.
 *
 * Round 2 (maestro review item 1): the overlay this content moved TO no
 * longer lives in the blueprint repo either — `fleet.blueprint.repo`
 * resolves to `rafarc21/fleetflare`, which the public-release plan makes
 * PUBLIC, so an operator override committed there would ship in the open
 * repo. It now lives in a SEPARATE, PRIVATE repo named by `FLEET_OPS_REPO`
 * (env.ts) — see provision.ts's OPS_HOUSE_RULES_PATH and src/ops-repo.ts's resolveOpsRepo for the
 * mechanism, and this issue's PR body for the deploy prerequisite (the
 * maestro creates that repo and lands today's exact removed content there
 * BEFORE this ships, or the operator's studios silently lose it).
 *
 * ALSO RESTORED (round 2, maestro review item 4): "every link is a full
 * URL" was swept out in the SAME diff hunk as the caveman/i-have-adhd
 * content above, by mistake — the RULE itself is generic engineering
 * communication discipline, not one operator's preference. Only that
 * hunk's own broken-URL EXAMPLE (naming the same Acme/demosite infra) was
 * operator-specific; it stays out, the rule is back in, genericized.
 *
 * STAYED (genuinely repo-agnostic engineering discipline, unchanged in
 * substance): the repository-language rule (issue #66, minus the repo-named
 * CI/Actions specifics above); the heavy gate budget (#160/#171); no
 * Cloudflare deploy credentials in a studio container (#235); studios never
 * push the default branch; one branch per studio (#269); and (round 2) full
 * URLs for every link.
 *
 * Text in the system prompt, not a declared skill — unchanged reasoning from
 * before the split.
 *
 * Caveman reaches a studio a SEPARATE way, as a baked plugin whose hooks fire
 * on their own (container/Dockerfile.studio). That default also moved from
 * unconditional to an operator opt-in for the same #330 reason — see that
 * file's own ENABLE_CAVEMAN_PLUGIN build arg and comment. An operator turns
 * it on with `containers[].image_vars` in the wrangler config they deploy
 * from their private ops repo; wrangler.example.jsonc ships it "false".
 */
export const HOUSE_RULES = [
  // Round 2 (maestro review item 4): restored after round 1 accidentally
  // deleted it alongside the genuinely operator-specific caveman/i-have-adhd
  // output-style mandate (same diff hunk) — this rule is universal
  // engineering communication discipline, not one operator's preference.
  // The original text's broken-URL EXAMPLE named that operator's own infra
  // ("an Acme maestro", a demosite.workers.dev URL); the example is
  // dropped, the rule stays.
  "## House rules — links are full URLs",
  "",
  "Every link you write is a full URL (https://host/path), never a bare",
  "slug or path fragment. For a PR or issue, the full GitHub URL IS the",
  "link; #number is a trailing label next to it, never the link itself.",
  "",
  // Board issue #66 — the language of what a studio writes into a repo and
  // onto the board (English, UX copy exempt).
  //
  // Round 2 (maestro review item 7): the CI-enforcement sentence used to
  // read "This project's own CI enforces it via its english-check gate." —
  // a BLANKET claim that every deployment of this software runs the same
  // english-check CI gate rafarc21/fleetflare does, which is false for a
  // stranger who clones this software and wires no such gate. Reworded to
  // describe CI enforcement as something a deployment MAY have, never as a
  // universal fact — the repo-named form ("In rafarc21/fleetflare, CI
  // enforces it") stays out of the neutral default for the same reason any
  // other hardcoded repo slug does (see this constant's own doc comment
  // above, "MOVED OUT").
  "## House rules — repository language",
  "",
  "All repository content is English: code, comments, docs, board issues,",
  "PR titles and bodies, commit messages. The project is read by people who",
  "do not share the operator's first language. The operator's own",
  "conversation language is a separate matter and not governed by this.",
  "NOT UX copy: product copy an end user reads stays in the",
  "product's own language.",
  "Some deployments enforce this in CI (an english-check gate); others may",
  "not. Either way, the rule applies.",
  "",
  // Issue #1: the fleet itself now develops in a public repo. Worded
  // conditionally: this default reaches studios on private repos too.
  "## House rules — public repositories",
  "",
  "If the repo you work in is public, everything you write there is",
  "world-readable: code, tests, commit messages, PR bodies, issues and",
  "comments. Never write client names, operator ids, emails, internal",
  "hostnames or tokens into it. Tests use fake names.",
  "",
  "A studio's leak gate refuses a push or a gh write that matches the",
  "operator's private denylist. The refusal names a pattern number, never",
  "the term. Rewrite the text; never route around the gate.",
  "",
  "If the operator routes your repo through the fleet Worker, your GitHub",
  "token is read-only. `git push` and `gh pr create|edit|ready|comment|review`",
  "/ `gh issue create|edit|comment` then go through the Worker, which runs the",
  "same check server-side and refuses pushes over 16 MiB. Other gh writes",
  "(merge, api, release) fail there: ask the maestro.",
  "",
  // Board issue #160 — another standing rule. #98 said "one heavy gate at a
  // time" and was read as a rule about the DIFF: a one-line diff looked cheap,
  // so its gate budget looked spent on nothing. The cost lives in the
  // VERIFICATION that one line demands, which #98 never named.
  //
  // #171: the section now OPENS with #98's own rule and the list of what a
  // heavy gate is, instead of amending a rule stated nowhere here. This text
  // is the only always-on copy maestro, pilot and scratch ever get — they have
  // no studio.md gate paragraph behind it — so a reader who never saw #98 has
  // to be able to learn the base rule from this section alone.
  "## House rules — heavy gate budget",
  "",
  "One heavy gate at a time: full test suite, vite build, repo-wide tsc,",
  "e2e, pre-push hooks.",
  "",
  "The verification a task demands counts toward the gate budget, not just",
  "the diff. A RED/GREEN mutation test of a heavy check runs that check",
  "twice. Run such verification one step at a time, never in parallel,",
  "never alongside another gate. A task author names heavy verification in",
  "the task's Boundaries (e.g. \"verifying X runs <heavy gate> twice\").",
  "Measured 2026-09-24 18:45Z: a one-line task mutation-tested one repo",
  "invariant; that invariant file runs two full vite builds, so RED+GREEN",
  "= FOUR builds in one container. Hit the 11.65 GiB memory ceiling and",
  "wedged. Recovered only by `recycle --discard-unsynced`, losing 22 min of",
  "conversation.",
  "",
  // Issue #70 ask 3: that ceiling, as a rule rather than an anecdote.
  "This container has a memory ceiling of about 11.6 GiB. The full test",
  "suite together with two bundler builds exceeds it and wedges the studio.",
  "Never run the full test suite and a bundler build at the same time. Run",
  "the tests your change touches; leave the full set to CI or the merge gate.",
  "",
  // Issue #85: lead deadlocks, the most common failure of a ~30-studio night
  // run (2026-09-29/30). One rule per measured deadlock.
  "## House rules — never block on nothing",
  "",
  "Never end a turn waiting for a notification. A scheduled wake can fail",
  "and never arrive. To learn how a job went, read the background task's",
  "output file and the screen yourself. If nothing is still running, act.",
  "",
  "Before you wait on a job, check it is alive. Its shell or process must",
  "still exist. A dead job is rerun or reported, never waited on.",
  "",
  "Never use AskUserQuestion (or any menu that waits for an answer) in a",
  "studio. Nobody is at this terminal to answer it. Write the blocker into",
  "the task's issue and move to the next piece of work.",
  "",
  "Run the tests your change touches, then push with `LEFTHOOK=0 git push`.",
  "The full suite belongs to CI or the merge gate. `LEFTHOOK=0` skips only",
  "the repo's own lefthook hooks; the fleet's own push checks still run.",
  "Never use it to get past a push that was refused.",
  "",
  // Board issue #235, measured 2026-09-25 by the BETA maestro: a studio
  // container carries neither CLOUDFLARE_API_TOKEN (what wrangler reads) nor
  // CLOUDFLARE_DEPLOY_TOKEN (env.ts, do.ts, deploy-server.ts — the fleet's
  // own deploy secret, held only by the Worker-side deploy container), so a
  // task telling a studio to `wrangler deploy` or `d1 migrations apply
  // --remote` cannot be completed inside one. BETA PR #829 hit exactly this;
  // its release-studio found the gap, searched its own env, and correctly
  // stopped — but only after burning minutes rediscovering it. State it here
  // so no lead has to again.
  "## House rules — deploy credentials",
  "",
  "No studio ever holds Cloudflare deploy credentials. No Cloudflare",
  "credential exists in any studio container: no CLOUDFLARE_API_TOKEN",
  "(what wrangler reads) and no CLOUDFLARE_DEPLOY_TOKEN (the fleet's",
  "deploy secret, held only by the Worker-side deploy container). If a",
  "task tells you to `wrangler deploy` or `d1 migrations apply --remote`,",
  "stop and say so — it cannot be done from inside a studio.",
  "",
  "Deploys run Worker-side through `fleet`, on the operator's own",
  "credential, or by the operator directly — never on a credential inside",
  "this container. A studio's job after a deploy happens is verification:",
  "check the deployed URL yourself, in a browser, not deploy it.",
  "",
  // Board issue #253, measured 2026-09-25 06:02Z: a fleetflare--web-studio
  // member committed onto a local `main` in a worktree, and that branch
  // carried `origin/main` as its upstream (branch.autoSetupMerge, git's own
  // default, sets that up silently for any branch cut off a remote-tracking
  // ref), so a bare `git push` had a real, name-matching upstream to push
  // INTO — 6 commits landed with zero PR, zero review, zero CI.
  //
  // NOT push.default: measured in the review of PR #259 (Linux, git 2.43),
  // the `push.default=simple` git already defaults to REFUSES a bare push
  // whose upstream branch is named differently from the local one, exit 128.
  // It was the same-named local `main` tracking `origin/main` that made this
  // push legal, and no push.default value stops that on its own — only a
  // guard that inspects the push's actual TARGET does.
  //
  // Provision-time git config plus the /usr/local/bin/git wrapper
  // (credentials.ts's studioGitSafetyCmd) now close the mechanism, but a
  // studio that works around its own tooling — a fresh clone outside
  // /workspace, calling /usr/bin/git directly — can still reach the same
  // outcome, so the rule is stated here too, in the always-on prompt text
  // every role and studio carries, not only enforced by config a studio
  // could route around.
  "## House rules — studios never push the default branch",
  "",
  "Every change to the default branch goes through a pull request: open one",
  "and let review + CI land it. Never push the default branch directly —",
  "not with a bare `git push`, not with an explicit `git push origin",
  "HEAD:main` (or whatever this repo's default branch is named), regardless",
  "of how trivial or test-only the change looks.",
  "",
  "If a push is refused, that refusal is the answer: open a PR. Never reach",
  "for `--no-verify` around it, and never call `/usr/bin/git` (or any other",
  "path) to get around the `git` on your PATH. Never wrap a push in a `!`",
  "shell alias, a `git rebase -x` step, a `git hook`, a `submodule foreach`",
  "or a `git bisect run` command either. Every one of those is a way of",
  "pushing something nobody reviewed, which is the one thing this rule",
  "forbids.",
  "",
  // Maestro round 3 of PR #259, item 6. The guard is a `git` wrapper on PATH:
  // it cannot see a command that never resolves through PATH, never runs git,
  // or runs on GitHub's side instead. Those routes are out of scope for it BY
  // CONSTRUCTION — no wrapper change closes them — so naming them here is the
  // only cover they have. Only `send-pack`/`http-push` are actually refused
  // or intercepted by the wrapper (issue #310 nit: `/usr/bin/git` is NOT —
  // an absolute-path call skips PATH, and the wrapper only ever sits on PATH
  // — this is exactly the "some routes go around a wrapper by construction"
  // case the prose two paragraphs down already says out loud; the rule
  // naming it here is its only cover).
  "Some routes go around a `git` wrapper by construction, so nothing in the",
  "container can refuse them — they are forbidden by this rule alone. Never",
  "run the real git by absolute path (`/usr/bin/git`,",
  "`/usr/lib/git-core/git-push`), and never reach for the push plumbing",
  "(`git send-pack`, `git http-push`). Never land a change on the default",
  "branch with a tool that skips git either: no `gh api` call that updates a",
  "ref, no `gh repo sync`, no `gh pr merge` of your own PR. Landing a change",
  "on the default branch is review's job, never yours.",
  "",
  // Board issue #269: a repo can now run more than one studio per role
  // (`<repo>--<role>--2`, `--3`, ...), which is the whole point of the
  // feature — and the collision it exists to avoid comes straight back if two
  // of them pick the same branch name. Each instance has its own container and
  // its own checkout, so "its own branch" costs nothing and is the only thing
  // that keeps two leads' commits apart; a shared branch turns every push into
  // a race and every force-push into someone else's lost work.
  "## House rules — one branch per studio",
  "",
  "Your repo checkout follows the same convention every studio's does, and",
  "a repo can be running several studios of your role at once",
  "(`<repo>--<role>`, `<repo>--<role>--2`, `<repo>--<role>--3`, ...). Each",
  "one has its own container and its own checkout.",
  "",
  "Never share a branch with another studio. Work on your own branch,",
  "always, even when another instance of your role is working on the same",
  "repo or the same area of it. Two leads committing and pushing to one",
  "branch is exactly the collision multiple instances exist to avoid: the",
  "pushes race, a force-push destroys the other's work, and neither PR",
  "describes what it contains. If a task seems to need another studio's",
  "branch, say so and stop — do not commit onto it.",
].join("\n");

/**
 * The house rules, appended to the role/studio prompt so EVERY prompt the
 * blueprint builds carries them.
 *
 * The SAME channel and the same shape as appendBrief/appendMemoryIndex above
 * — see appendBrief's own doc comment for why one env var beats two.
 *
 * Composed INNERMOST at both call sites, i.e. first after the role's own
 * text and before both the memory index and the brief. Two reasons. It is
 * standing policy, a property of being a studio at all, so it belongs with
 * the identity the role file states rather than with the job; and the
 * ordering appendMemoryIndex already documents — memory is context, the brief
 * is the job, the brief stays last and most salient — must survive this
 * change untouched. Appending house rules last would have displaced the task
 * a studio was spawned for from the most-salient position to buy recency for
 * rules that govern prose and language, not work.
 *
 * The neutral HOUSE_RULES block has NO absent branch, unlike its two
 * neighbours. There is no studio this does not apply to — that
 * unconditionality IS the feature. Wiring it here, at the two functions that
 * build a bring-up env, rather than into the studio.md files means a role or
 * studio authored next year cannot silently miss it.
 *
 * `operatorHouseRules` (issue #330, round 2) IS optional, like
 * memoryIndex/briefPrompt — it is the operator's own overlay, fetched from
 * their configured PRIVATE ops repo's OPS_HOUSE_RULES_PATH (env.ts's
 * FLEET_OPS_REPO, provision.ts's resolveOperatorHouseRules/resolveOpsRepo),
 * never a product default and never the (soon-public) blueprint repo. Absent
 * (undefined, null, or blank — the same three "nothing here" shapes
 * appendBrief/appendMemoryIndex already treat identically, covering both
 * "caller passed nothing" and "the ops repo file 404d, or FLEET_OPS_REPO was
 * never set at all") leaves the prompt exactly as it was before this
 * parameter existed:
 * neutral HOUSE_RULES only, byte for byte. Present, it is appended
 * immediately AFTER the neutral block and still BEFORE the memory index and
 * brief — same "standing policy is innermost" reasoning as the neutral block
 * itself, and additive (never replacing) so an operator's overlay extends the
 * product default rather than silently overriding safety-relevant rules
 * (deploy credentials, no-push-default-branch) they may not have restated.
 */
export function appendHouseRules(prompt: string, operatorHouseRules?: string | null): string {
  const withDefault = `${prompt}\n\n${HOUSE_RULES}\n`;
  return operatorHouseRules === undefined || operatorHouseRules === null || operatorHouseRules.trim() === ""
    ? withDefault
    : `${withDefault}\n${operatorHouseRules.trim()}\n`;
}

export function roleBringupEnv(
  role: Role, briefPrompt?: string, memoryIndex?: string | null, operatorHouseRules?: string | null,
): { ROLE_PROMPT_B64: string; ROLE_ALLOWED_TOOLS: string; ROLE_EFFORT: string } {
  return {
    ROLE_PROMPT_B64: base64EncodeUtf8(
      appendBrief(appendMemoryIndex(appendHouseRules(role.prompt, operatorHouseRules), memoryIndex), briefPrompt),
    ),
    ROLE_ALLOWED_TOOLS: role.allowedTools,
    ROLE_EFFORT: role.effort ?? (role.name === "cto" ? "max" : ""),
  };
}
