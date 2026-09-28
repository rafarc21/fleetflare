# P4a-1 Studio Harness Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studio files (dir per studio: lead + members + hooks) parse, validate, and materialize into a container as a full harness — members as native `.claude/agents`, tiered skills, mcp config, lead tool restrictions.

**Architecture:** New pure parser module (`studio-blueprint.ts`) beside the existing role parser; studio = directory in the blueprint repo (`fleet/blueprint/studios/<name>/`), members are verbatim Claude Code subagent files; bringup script materializes everything; provision fetches the directory and persists the widened env record. Existing role path (pilot/scratch) keeps working untouched.

**Tech Stack:** Bun + TypeScript (Worker side), bash (container bringup), Claude Code CLI pinned 2.1.224, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-19-fleet-atomic-teams-p4-design.md` (§3, §4, §9, §11-P4a)

## Global Constraints

- `bun` only — never npm/npx/pnpm (repo CLAUDE.md).
- All new persistent text (comments, docs, commits) caveman-compressed; code identifiers normal.
- Conventional commits; small commits per task.
- Pinned claude CLI 2.1.224 in both container images — any CLI-flag claim must be verified against IT, not docs.
- Containers hold NO Cloudflare creds; merge/deploy stay Worker-gated (never weaken).
- ≤12 tools per member (spec §2.8); Tier-0 skills non-removable (spec §4).
- Frontmatter format stays flat `key: value` + `[a, b]` arrays — no YAML, no nesting (blueprint.ts header ruling). Nesting is expressed by DIRECTORY structure, not syntax.
- Test suite green = `bun run test` (repo root) + `bun run check`.

---

### Task 0: SPIKE — lead tool-restriction mechanism

Decision 11 (leads never implement) needs a mechanism that blocks Edit/Write for the LEAD session while members keep them. Risk: `--disallowedTools` may apply session-globally, killing member writes too. Output = a ruling, not kept code.

**Files:**
- Create: `.superpowers/spike-lead-tools.md` (findings; throwaway label)

**Interfaces:**
- Produces: ruling consumed by Task 3 (`STUDIO_LEAD_DISALLOWED` env semantics) and Task 4 (bringup flag vs hook).

- [ ] **Step 1: Build the pinned-CLI probe container**

Run: `docker build -f apps/fleet/container/Dockerfile.studio -t studio-spike apps/fleet/container`
Expected: image builds (same base already proven in skipperm smoke).

- [ ] **Step 2: Probe A — does `--disallowedTools` starve subagents?**

Inside the container (`docker run --rm -it studio-spike bash`):

```bash
mkdir -p /tmp/probe/.claude/agents && cd /tmp/probe
cat > .claude/agents/writer.md <<'EOF'
---
name: writer
description: writes one file when asked
tools: Write
---
You are writer. When dispatched, Write the exact file requested, then reply "written".
EOF
claude --dangerously-skip-permissions --disallowedTools "Edit Write NotebookEdit" \
  -p 'Dispatch the writer subagent to create hello.txt containing "hi". Do not write it yourself.' \
  --output-format json
ls hello.txt
```

Expected outcomes (record which): (a) `hello.txt` exists → disallow is lead-scoped, use the flag; (b) missing + permission denial in transcript → disallow is global, flag unusable.

- [ ] **Step 3: Probe B — can a PreToolUse hook distinguish lead from member calls?**

```bash
mkdir -p /tmp/probe2/.claude && cd /tmp/probe2
cat > .claude/settings.json <<'EOF'
{"hooks":{"PreToolUse":[{"matcher":"Write|Edit","hooks":[{"type":"command","command":"cat >> /tmp/hookcalls.jsonl; exit 0"}]}]}}
EOF
cp -r /tmp/probe/.claude/agents .claude/agents
claude --dangerously-skip-permissions \
  -p 'First Write lead.txt containing "lead" yourself. Then dispatch the writer subagent to create member.txt containing "member".' \
  --output-format json
cat /tmp/hookcalls.jsonl
```

Inspect the two hook payloads: any field differing between the lead's Write and the member's Write (`transcript_path` sidechain path, agent id, anything stable)? Record exact field + values.

- [ ] **Step 4: Write ruling to `.superpowers/spike-lead-tools.md`**

Ruling picks ONE: (a) flag (if lead-scoped); (b) PreToolUse hook keyed on the discriminating field (block Edit/Write when lead, exit 2 with reason "dispatch a member — leads never implement"); (c) NEITHER works → prompt-level rule + Stop-gate note, flagged to the operator as a spec deviation needing sign-off. Include raw probe outputs.

- [ ] **Step 5: Commit**

```bash
git add .superpowers/spike-lead-tools.md
git commit -m "spike(fleet): lead tool-restriction mechanism ruling"
```

---

### Task 1: Studio types + parseStudioFile

**Files:**
- Create: `apps/fleet/src/studio/studio-blueprint.ts`
- Modify: `apps/fleet/src/studio/blueprint.ts` (export three existing helpers)
- Test: `apps/fleet/test/studio.studio-blueprint.test.ts`

**Interfaces:**
- Consumes: `BlueprintError`, `parseSimpleArray`, `parseBoolean`, `base64EncodeUtf8` from `blueprint.ts` (currently module-private — add `export` keyword to the last three, no other change).
- Produces:
  ```ts
  export interface Studio {
    name: string;            // "web-studio"
    title: string;           // "Web Studio"
    lead: string;            // "Web Designer" — display name of lead
    skills: string[];        // Tier-1 domain skills (Tier 0 added downstream)
    secrets: string[];       // Infisical secret NAMES
    mcp: string[];           // mcp server names, e.g. ["playwright"]
    allowedTools: string;    // lead's allowlist, verbatim string
    effort?: string;         // same validation as Role.effort
    model?: string;          // optional model override for lead
    keep_alive: boolean;     // default true (maestro), same parseBoolean
    prompt: string;          // lead system prompt (body)
  }
  export function parseStudioFile(md: string): Studio
  ```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { parseStudioFile } from "../src/studio/studio-blueprint";
import { BlueprintError } from "../src/studio/blueprint";

const VALID = `---
name: web-studio
title: Web Studio
lead: Web Designer
skills: [frontend-design, qa]
secrets: [UNSPLASH_KEY]
mcp: [playwright]
allowedTools: Bash(git *) Read
---
You are the Web Designer, lead of Web Studio. Dispatch members; never implement.`;

describe("parseStudioFile", () => {
  test("parses a valid studio file", () => {
    const s = parseStudioFile(VALID);
    expect(s.name).toBe("web-studio");
    expect(s.title).toBe("Web Studio");
    expect(s.lead).toBe("Web Designer");
    expect(s.skills).toEqual(["frontend-design", "qa"]);
    expect(s.secrets).toEqual(["UNSPLASH_KEY"]);
    expect(s.mcp).toEqual(["playwright"]);
    expect(s.keep_alive).toBe(true);
    expect(s.prompt).toContain("never implement");
  });
  test("empty secrets/mcp arrays are legal", () => {
    const s = parseStudioFile(VALID.replace("secrets: [UNSPLASH_KEY]", "secrets: []").replace("mcp: [playwright]", "mcp: []"));
    expect(s.secrets).toEqual([]);
    expect(s.mcp).toEqual([]);
  });
  test("missing required field names the field", () => {
    expect(() => parseStudioFile(VALID.replace("title: Web Studio\n", ""))).toThrow(BlueprintError);
    try { parseStudioFile(VALID.replace("title: Web Studio\n", "")); } catch (e) {
      expect((e as BlueprintError).field).toBe("title");
    }
  });
  test("invalid effort rejected", () => {
    expect(() => parseStudioFile(VALID.replace("---\nYou", "effort: turbo\n---\nYou"))).toThrow(BlueprintError);
  });
  test("empty body rejected", () => {
    const noBody = VALID.slice(0, VALID.lastIndexOf("---") + 3);
    expect(() => parseStudioFile(noBody)).toThrow(BlueprintError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fleet && bun test test/studio.studio-blueprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

In `blueprint.ts`: add `export` before `function parseSimpleArray`, `function parseBoolean`, `function base64EncodeUtf8`. Also export `VALID_EFFORT_LEVELS` (currently private const — add `export`).

`studio-blueprint.ts` (structure mirrors parseRoleFile — same delimiter walk, required/nonempty lists, effort check; comments caveman):

```ts
// Studio parsing — P4a-1. Same contract as blueprint.ts: raw text in, typed
// Studio out, BlueprintError names bad field. Flat frontmatter only; studio
// nesting = directory structure (members/, hooks/), never syntax.
import { BlueprintError, parseSimpleArray, parseBoolean, VALID_EFFORT_LEVELS } from "./blueprint";

export interface Studio { /* as in Interfaces block above, with doc comments */ }

const REQUIRED = ["name", "title", "lead", "skills", "secrets", "mcp", "allowedTools"] as const;
const REQUIRED_NONEMPTY = ["name", "title", "lead", "allowedTools"] as const;

export function parseStudioFile(md: string): Studio {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") throw new BlueprintError("frontmatter", "studio file must start with ---");
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) throw new BlueprintError("frontmatter", "no closing ---");
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, closeIdx)) {
    if (line.trim() === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) throw new BlueprintError("frontmatter", `malformed line: ${line}`);
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  for (const f of REQUIRED) if (!(f in fields)) throw new BlueprintError(f, `missing required field "${f}"`);
  for (const f of REQUIRED_NONEMPTY) if (fields[f] === "") throw new BlueprintError(f, `field "${f}" must not be empty`);
  if (fields.effort !== undefined && !VALID_EFFORT_LEVELS.includes(fields.effort as never)) {
    throw new BlueprintError("effort", `expected one of ${VALID_EFFORT_LEVELS.join(", ")}, got: ${fields.effort}`);
  }
  if (fields.model === "") throw new BlueprintError("model", "must not be empty when present");
  const prompt = lines.slice(closeIdx + 1).join("\n").trim();
  if (prompt === "") throw new BlueprintError("prompt", "lead prompt body is empty");
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
    keep_alive: fields.keep_alive !== undefined ? parseBoolean(fields.keep_alive, "keep_alive") : true,
    prompt,
  };
}
```

- [ ] **Step 4: Run tests — pass; run `bun run check`**

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/studio/studio-blueprint.ts apps/fleet/src/studio/blueprint.ts apps/fleet/test/studio.studio-blueprint.test.ts
git commit -m "feat(fleet): studio file parser (P4a-1 T1)"
```

---

### Task 2: Member file validation

Members are VERBATIM Claude Code subagent files — materialization copies bytes. Validation only guards the copy: frontmatter present, `name`+`description` present, body non-empty, tool-count budget.

**Files:**
- Modify: `apps/fleet/src/studio/studio-blueprint.ts`
- Test: `apps/fleet/test/studio.studio-blueprint.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  export interface MemberFile { name: string; raw: string }
  export function validateMemberFile(filename: string, md: string): MemberFile
  ```

- [ ] **Step 1: Failing tests**

```ts
const MEMBER = `---
name: frontend-developer
description: implements frontend steps dispatched by the lead
tools: Read, Edit, Write, Bash
---
You are the Frontend Developer of Web Studio. Implement exactly the dispatched step.`;

describe("validateMemberFile", () => {
  test("valid member passes, returns name + raw untouched", () => {
    const m = validateMemberFile("frontend-developer.md", MEMBER);
    expect(m.name).toBe("frontend-developer");
    expect(m.raw).toBe(MEMBER);
  });
  test("filename/name mismatch rejected", () => {
    expect(() => validateMemberFile("qa-engineer.md", MEMBER)).toThrow(BlueprintError);
  });
  test("missing description rejected", () => {
    expect(() => validateMemberFile("frontend-developer.md", MEMBER.replace(/description:.*\n/, ""))).toThrow(BlueprintError);
  });
  test("more than 12 tools rejected", () => {
    const fat = MEMBER.replace(/tools:.*/, "tools: " + Array.from({length: 13}, (_, i) => `T${i}`).join(", "));
    expect(() => validateMemberFile("frontend-developer.md", fat)).toThrow(BlueprintError);
  });
});
```

- [ ] **Step 2: Run — fail (function missing)**

- [ ] **Step 3: Implement**

```ts
// Member files = verbatim Claude Code subagent format. We copy bytes, never
// rewrite — validation only guards the copy. 12-tool cap = spec §2.8.
const MEMBER_TOOL_CAP = 12;

export interface MemberFile { name: string; raw: string }

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
  return { name: fields.name, raw: md };
}
```

- [ ] **Step 4: Tests pass + `bun run check`**

- [ ] **Step 5: Commit** — `feat(fleet): member file validation (P4a-1 T2)`

---

### Task 3: Tier-0 constant + studioBringupEnv

**Files:**
- Modify: `apps/fleet/src/studio/studio-blueprint.ts`
- Test: `apps/fleet/test/studio.studio-blueprint.test.ts` (append)

**Interfaces:**
- Consumes: `Studio`, `MemberFile`, `base64EncodeUtf8`, Task 0 ruling (shape of `STUDIO_LEAD_DISALLOWED`).
- Produces:
  ```ts
  export const TIER0_SKILLS: readonly string[];
  export interface StudioBringupEnv {
    ROLE_PROMPT_B64: string;        // lead prompt — SAME var names bringup already reads
    ROLE_ALLOWED_TOOLS: string;
    ROLE_EFFORT: string;            // maestro→"max" default (replaces cto rule for studios)
    STUDIO_NAME: string;
    STUDIO_SKILLS: string;          // comma-joined tier0+domain, deduped
    STUDIO_MEMBERS_B64: string;     // b64(JSON: {filename: b64(raw)})
    STUDIO_MCP: string;             // comma-joined server names
    STUDIO_LEAD_DISALLOWED: string; // "Edit Write NotebookEdit" or "" per Task 0 ruling
  }
  export function studioBringupEnv(studio: Studio, members: MemberFile[]): StudioBringupEnv
  ```

- [ ] **Step 1: Failing tests**

```ts
describe("studioBringupEnv", () => {
  const studio = parseStudioFile(VALID);
  const members = [validateMemberFile("frontend-developer.md", MEMBER)];
  test("tier0 always present, deduped, before domain skills", () => {
    const env = studioBringupEnv(studio, members);
    const skills = env.STUDIO_SKILLS.split(",");
    for (const t0 of TIER0_SKILLS) expect(skills).toContain(t0);
    expect(skills).toContain("frontend-design");
    expect(new Set(skills).size).toBe(skills.length);
  });
  test("members round-trip through the b64 bundle", () => {
    const env = studioBringupEnv(studio, members);
    const bundle = JSON.parse(atob(env.STUDIO_MEMBERS_B64)) as Record<string, string>;
    expect(atob(bundle["frontend-developer.md"])).toBe(MEMBER);
  });
  test("maestro defaults to effort max, others empty", () => {
    const maestro = parseStudioFile(VALID.replace("name: web-studio", "name: maestro"));
    expect(studioBringupEnv(maestro, []).ROLE_EFFORT).toBe("max");
    expect(studioBringupEnv(studio, members).ROLE_EFFORT).toBe("");
  });
  test("explicit effort beats the maestro default", () => {
    const m = parseStudioFile(VALID.replace("name: web-studio", "name: maestro").replace("---\nYou", "effort: high\n---\nYou"));
    expect(studioBringupEnv(m, []).ROLE_EFFORT).toBe("high");
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```ts
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

export function studioBringupEnv(studio: Studio, members: MemberFile[]): StudioBringupEnv {
  const skills = [...new Set([...TIER0_SKILLS, ...studio.skills])];
  const bundle: Record<string, string> = {};
  for (const m of members) bundle[`${m.name}.md`] = base64EncodeUtf8(m.raw);
  return {
    ROLE_PROMPT_B64: base64EncodeUtf8(studio.prompt),
    ROLE_ALLOWED_TOOLS: studio.allowedTools,
    ROLE_EFFORT: studio.effort ?? (studio.name === "maestro" ? "max" : ""),
    STUDIO_NAME: studio.name,
    STUDIO_SKILLS: skills.join(","),
    STUDIO_MEMBERS_B64: base64EncodeUtf8(JSON.stringify(bundle)),
    STUDIO_MCP: studio.mcp.join(","),
    STUDIO_LEAD_DISALLOWED: "Edit Write NotebookEdit", // Task 0 ruling may change to "" + hook
  };
}
```

Note: `atob` in tests decodes ASCII-safe payloads here; member/prompt content is UTF-8 — tests using non-ASCII must decode via `Buffer.from(s, "base64").toString("utf8")`. Use Buffer form in tests from the start.

- [ ] **Step 4: Tests pass + `bun run check`**

- [ ] **Step 5: Commit** — `feat(fleet): tier0 skills + studio bringup env (P4a-1 T3)`

---

### Task 4: Bringup materialization

**Files:**
- Modify: `apps/fleet/container/studio-bringup.sh` (insert BEFORE the claude-launch block, after workspace clone section)

**Interfaces:**
- Consumes: `STUDIO_MEMBERS_B64`, `STUDIO_SKILLS`, `STUDIO_MCP`, `STUDIO_LEAD_DISALLOWED`, existing `ROLE_*` vars; `BLUEPRINT_REPO` env (already present for role fetch — verify name in script, else add from provision).
- Produces: `~/.claude/agents/*.md` (members), `~/.claude/skills/<name>` (symlinks into blueprint clone), `/workspace/.mcp.json`, extra claude args.

- [ ] **Step 1: Add materialization block**

```bash
# --- P4a-1 studio materialization (no-op when STUDIO_NAME unset: role path) ---
if [ -n "${STUDIO_NAME:-}" ]; then
  # members -> native .claude/agents files, bytes verbatim
  mkdir -p ~/.claude/agents
  base64 -d <<< "${STUDIO_MEMBERS_B64:-}" | python3 - <<'PYEOF'
import json,sys,base64,os
bundle=json.load(sys.stdin)
os.makedirs(os.path.expanduser("~/.claude/agents"),exist_ok=True)
for fn,b64 in bundle.items():
    with open(os.path.expanduser(f"~/.claude/agents/{fn}"),"wb") as f:
        f.write(base64.b64decode(b64))
PYEOF

  # skills: shallow-clone blueprint repo once, symlink listed skills.
  # blueprint repo = fleetflare-agency (skills/ + plugins vendored). Installation
  # token must cover it — checked at provision, not here.
  if [ ! -d /opt/blueprint ]; then
    git clone --depth 1 "https://x-access-token:${GH_TOKEN}@github.com/${BLUEPRINT_REPO}.git" /opt/blueprint
  fi
  mkdir -p ~/.claude/skills
  IFS=',' read -ra SKILL_LIST <<< "${STUDIO_SKILLS:-}"
  for s in "${SKILL_LIST[@]}"; do
    [ -d "/opt/blueprint/skills/$s" ] && ln -sfn "/opt/blueprint/skills/$s" ~/.claude/skills/"$s"
  done

  # mcp: fixed server templates keyed by name; secrets already in env
  if [ -n "${STUDIO_MCP:-}" ]; then
    python3 - <<'PYEOF'
import json,os
known={"playwright":{"command":"bunx","args":["@playwright/mcp@latest"]}}
names=[n for n in os.environ.get("STUDIO_MCP","").split(",") if n]
cfg={"mcpServers":{n:known[n] for n in names if n in known}}
with open("/workspace/.mcp.json","w") as f: json.dump(cfg,f)
PYEOF
  fi
fi
# --- end studio materialization ---
```

And in the claude_args block, after the `--effort` line:

```bash
  # Decision 11: lead never implements. Task 0 ruling picks flag vs hook.
  [ -n "${STUDIO_LEAD_DISALLOWED:-}" ] && claude_args+=(--disallowedTools "$STUDIO_LEAD_DISALLOWED")
```

Check first (Read the script): exact name of the GH token + blueprint repo env vars used by the existing clone section — reuse those names verbatim; if the blueprint repo is not already passed, add `BLUEPRINT_REPO` to provision's env in Task 7. `python3` exists in the image (verify with `docker run --rm studio-spike python3 --version`; if absent add `python3` to the apt-get line in Dockerfile.studio in Task 5).

- [ ] **Step 2: Verify by container build + exec**

```bash
docker build -f apps/fleet/container/Dockerfile.studio -t studio-mat apps/fleet/container
docker run --rm -e STUDIO_NAME=web-studio \
  -e STUDIO_MEMBERS_B64="$(python3 -c 'import base64,json;m=open("fleet/blueprint/studios/web-studio/members/frontend-developer.md","rb").read();print(base64.b64encode(json.dumps({"frontend-developer.md":base64.b64encode(m).decode()}).encode()).decode())')" \
  studio-mat bash -c 'bash /studio-bringup.sh || true; ls ~/.claude/agents/'
```

Expected: `frontend-developer.md` listed. (Full script may exit early on missing tmux session pieces — the materialization block runs before those; `|| true` tolerates.)

- [ ] **Step 3: Commit** — `feat(fleet): bringup materializes members/skills/mcp (P4a-1 T4)`

---

### Task 5: Image additions

**Files:**
- Modify: `apps/fleet/container/Dockerfile.studio`

**Interfaces:**
- Produces: image with superpowers+caveman plugins pre-installed, chromium+playwright deps, sshd+mosh+tailscale binaries, python3.

- [ ] **Step 1: Add layers**

After the existing apt-get/dep section (match its style; ONE new RUN per concern, keep pinned base):

```dockerfile
# P4a-1: python3 (bringup materialization), sshd+mosh (Moshi phone path),
# chromium deps (playwright sweep/self-check). Tailscale installer already
# staged below — leave as is.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 openssh-server mosh chromium \
    && rm -rf /var/lib/apt/lists/*

# P4a-1: plugins baked at build — superpowers + caveman from the official
# marketplace cache format claude expects. Version-pin by commit for
# reproducible image.
RUN mkdir -p /root/.claude/plugins && \
    git clone --depth 1 https://github.com/anthropics/claude-plugins-official /root/.claude/plugins/marketplace-cache
```

- [ ] **Step 2: VERIFY plugin install mechanism before trusting the RUN above**

The exact on-disk layout claude 2.1.224 loads plugins from must be probed, not assumed: run `docker run --rm studio-mat bash -c 'claude --dangerously-skip-permissions -p "/plugin list" --output-format json'` and inspect. If plugins need `claude plugin install`, replace the git clone with the CLI invocation that works headless; record what worked in the Dockerfile comment. This step ends with a container where `Skill` tool lists `superpowers:brainstorming` and caveman hooks fire.

- [ ] **Step 3: Build + smoke**

```bash
docker build -f apps/fleet/container/Dockerfile.studio -t studio-p4a apps/fleet/container
docker run --rm studio-p4a bash -c 'python3 --version && mosh-server --version | head -1 && chromium --version && which sshd'
```

Expected: four version/path lines, no errors.

- [ ] **Step 4: Commit** — `feat(fleet): studio image gains plugins, chromium, sshd/mosh, python3 (P4a-1 T5)`

---

### Task 6: Author the three studio directories

**Files:**
- Create: `fleet/blueprint/studios/maestro/studio.md` + `members/` (empty dir → no members; solo)
- Create: `fleet/blueprint/studios/web-studio/studio.md`, `members/frontend-developer.md`, `members/backend-developer.md`, `members/code-reviewer.md`, `members/qa-engineer.md`
- Create: `fleet/blueprint/studios/release-studio/studio.md`, `members/qa-engineer.md`
- Test: `apps/fleet/test/studio.files.test.ts`

**Interfaces:**
- Consumes: `parseStudioFile`, `validateMemberFile` (fixture round-trip proves authored files parse).

- [ ] **Step 1: Failing test — walk the studios dir, parse everything**

```ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseStudioFile, validateMemberFile } from "../src/studio/studio-blueprint";

const ROOT = join(import.meta.dir, "../../../fleet/blueprint/studios");

describe("authored studio files", () => {
  test("every studio dir parses clean", () => {
    const studios = readdirSync(ROOT);
    expect(studios.sort()).toEqual(["maestro", "release-studio", "web-studio"]);
    for (const s of studios) {
      const studio = parseStudioFile(readFileSync(join(ROOT, s, "studio.md"), "utf8"));
      expect(studio.name).toBe(s);
      const membersDir = join(ROOT, s, "members");
      if (existsSync(membersDir)) {
        for (const f of readdirSync(membersDir)) {
          validateMemberFile(f, readFileSync(join(membersDir, f), "utf8"));
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run — fail (dirs missing)**

- [ ] **Step 3: Author the files**

Content contracts (write full prose per spec §3/§2.13; caveman; each lead prompt MUST include: never implement + dispatch members + envelope/board rules + approval-request block shape copied from pilot.md lines 14-18):

`maestro/studio.md` frontmatter: `name: maestro`, `title: Maestro Studio`, `lead: Maestro`, `skills: [sprint-ritual, spec-driven-delivery, manager-comms, cto-liaison, agent-lifecycle]`, `secrets: []`, `mcp: []`, `allowedTools: Bash(fleet *) Bash(gh *) Bash(git *) Read`, `keep_alive: true`. Body: the operator's interface; ideas→task specs→spawns; reads board on demand; sprint meetings; NEVER receives studio messages; never implements.

`web-studio/studio.md`: `name: web-studio`, `title: Web Studio`, `lead: Web Designer`, `skills: [frontend-design, qa, landing-page, pricing-page, web-perf, unsplash-integration, emil-design-eng]` (start narrow; cro/design-verb expansion later), `secrets: [UNSPLASH_KEY]`, `mcp: [playwright]`, `allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Read`, `keep_alive: false`. Body: full-stack deliverables; classify scope (spike/bounded/architectural); plan then dispatch; PR + envelope at end.

`release-studio/studio.md`: `name: release-studio`, `title: Release Studio`, `lead: Release Manager`, `skills: [release-verification-checklist, qa, delivery-standards, agent-lifecycle]`, `secrets: []`, `mcp: [playwright]`, `allowedTools: Bash(git *) Bash(gh *) Bash(fleet *) Read`, `keep_alive: false`.

Members (each ≤12 tools, verbatim CC agent format): frontend-developer (tools: Read, Edit, Write, Bash, Glob, Grep), backend-developer (same + wrangler via Bash), code-reviewer (Read, Glob, Grep — read-only, fresh-context review checklist body), qa-engineer (Read, Bash, Glob, Grep — playwright via Bash; console+network capture instructions body).

- [ ] **Step 4: Test passes**

- [ ] **Step 5: Commit** — `feat(fleet): maestro, web-studio, release-studio blueprints (P4a-1 T6)`

---

### Task 7: Provision wiring

**Files:**
- Modify: `apps/fleet/src/studio/provision.ts`
- Test: `apps/fleet/test/studio.provision.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `parseStudioFile`, `validateMemberFile`, `studioBringupEnv`; existing role fetch machinery (GitHub contents API helper already in provision.ts — Read it first, reuse its fetch + error style verbatim).
- Produces: provision resolves `<name>` as studio-first (`fleet/blueprint/studios/<name>/studio.md` exists → studio path: fetch studio.md + list `members/` + fetch each), else falls back to `fleet/blueprint/roles/<name>.md` (existing path untouched). Persisted bringup-env record widens from the ROLE_ triple to `StudioBringupEnv | RoleBringupEnv` union — existing pilot/scratch records must still typecheck and round-trip.

- [ ] **Step 1: Failing tests** — mock the contents fetch (same mocking style the existing provision tests use — mirror it): (a) studio dir present → env record contains STUDIO_MEMBERS_B64 with fetched members; (b) studio absent → role fallback produces the existing triple exactly as today (regression guard); (c) member file failing validation → provision throws BlueprintError, nothing persisted.

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** — studio-first resolution; on studio path also append `BLUEPRINT_REPO` + keep `GH_TOKEN` env already provided for the workspace clone (verify exact var names against studio-bringup.sh's clone section and reuse).

- [ ] **Step 4: Full suite: `cd apps/fleet && bun run test && bun run check`** — all green including untouched role-path tests.

- [ ] **Step 5: Commit** — `feat(fleet): provision resolves studios with role fallback (P4a-1 T7)`

---

## Self-review notes

- Spec coverage: §4 harness contract → T1-T5; §3 three P4a studios → T6; §9 studio parsing/materialization → T4/T7; image additions → T5; Tier-0 lock → T3 (constant) + T6 (lead prompts). NOT in this plan (later P4a plans): board writer, memory injection, ff, lifecycle rescue-push, train/sweep/checklist, Infisical resolver (secrets flow as names only until Plan 2; values keep coming from Worker env bindings).
- Hooks materialization (studio `hooks/` dir → container settings) deliberately deferred to Plan 2 alongside the Stop-gate (needs envelope schema to check against). Tier-0 enforcement in THIS plan = plugins baked + skills materialized + lead prompts; deterministic gates arrive with the envelope.
- Type consistency: `StudioBringupEnv` reuses `ROLE_PROMPT_B64`/`ROLE_ALLOWED_TOOLS`/`ROLE_EFFORT` names so studio-bringup.sh's existing launch block needs zero changes for the lead; only additive vars.
