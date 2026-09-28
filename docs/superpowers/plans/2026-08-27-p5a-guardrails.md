# P5a Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio cannot run without its guardrails, cannot claim done without evidence, and cannot lose work when it dies.

**Architecture:** Extend three existing mechanisms rather than add new ones — the PreToolUse lead gate, the Stop completion gate, and the harness check. Add a skill-RESOLUTION probe (existing check only stats files), verification intent to the Stop gate, and rescue-push to the Worker's kill paths.

**Tech Stack:** Bun + TypeScript (Worker), bash (container bring-up), Claude Code hooks, `bun test` + vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-fleet-guardrails-p5-design.md` — §2 hook matrix, §4 verification intent, §9 teardown harvest. Read §1 for why each rule exists; every one traces to a failure the operator watched.

## Global Constraints

- `bun` only, never npm/npx/pnpm.
- Caveman-compressed persistent text (comments, commits, PRs). NOT code. NOT user-facing messages.
- Baseline is **1189 vitest + 23 bun-side**, `bun run check` clean across 5 tsconfig projects. There is no `lint` script in `apps/fleet`.
- A check command must NEVER contain the `exit` builtin — it kills the shared `sandbox-default` session's shell and the SDK throws instead of returning. Existing tests assert this; new checks must carry the same assertion.
- Fail-CLOSED for a gate (no gate → do not boot). Fail-OPEN for a CHECK (inconclusive is a statement about the check, never about the studio). This asymmetry is already ruled in code — honour it.
- Touching `studio-bringup.sh` or `Dockerfile.studio` requires bumping `LABEL fleet.image.rev`, deploying, AND recycling to verify. Deploy is not rollout; an image change that never reaches a container has been this project's most expensive recurring mistake.
- `wrangler deploy` builds the image from the WORKING TREE, not from git. Never deploy with someone else's uncommitted edits present.

---

### Task 1: Skill-resolution probe

The harness check stats skill directories. Failure 6 was a skill present on disk and NOT invocable — presence is not resolvability.

**Files:**
- Modify: `apps/fleet/src/studio/provision.ts` (the check command builder near `PROVISIONED_CHECK_TRIES`, ~line 269-450)
- Test: `apps/fleet/test/studio.provision.test.ts`

**Interfaces:**
- Consumes: `TIER0_SKILLS` from `src/studio/studio-blueprint.ts:193`
- Produces: the harness check additionally reports `skills-unresolvable: <names>` in its `bare` reason

- [ ] **Step 1: Write the failing test**

Assert the built check command contains a resolution probe for each Tier-0 skill, and — critically — contains no `exit`:

```ts
it("probes that tier-0 skills RESOLVE, not merely that their directories exist", () => {
  const cmd = provisionedCheckCmd({ repo: "websites", skills: ["brainstorming"] });
  expect(cmd).toContain("brainstorming");
  expect(cmd).not.toContain("exit ");   // kills the shared sandbox session
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd apps/fleet && bun run test -- studio.provision`
Expected: FAIL — no resolution probe in the command.

- [ ] **Step 3: Implement**

Resolution differs from existence. A skill resolves when its directory holds a readable `SKILL.md` with a `name:` frontmatter key. That is what the loader reads; a `program.md`-only directory is the exact shape that silently failed before. Emit the missing names on stdout, never via exit code.

- [ ] **Step 4: Run tests — green**

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/studio/provision.ts apps/fleet/test/studio.provision.test.ts
git commit -m "fix(fleet): harness check probes skill resolution, not presence"
```

---

### Task 2: Verification intent in the Stop gate

**Files:**
- Modify: `apps/fleet/container/studio-bringup.sh` (completion-gate materialization)
- Modify: `apps/fleet/src/board/envelope.ts` (schema)
- Test: `apps/fleet/test/board.envelope.test.ts`

**Interfaces:**
- Consumes: the §6 envelope schema already shipped
- Produces: `verification: { url, steps[], expected }` — required for EVERY studio, all domains

- [ ] **Step 1: Failing test — envelope rejects a done-report with no verification block**

- [ ] **Step 2: Run, watch it fail**

- [ ] **Step 3: Implement schema field + completion-gate demand**

The gate must state precisely what it wants and be satisfiable — a Stop hook that fires wrongly makes a studio unusable. Message names the missing field and shows the shape.

- [ ] **Step 4: Tests green**

- [ ] **Step 5: Commit** — `feat(fleet): stop gate demands verification intent`

---

### Task 3: Rescue-push before every kill

Spec P4 §2.14, never built. A Stop hook cannot see a teardown.

**Files:**
- Modify: `apps/fleet/src/studio/do.ts` (every kill path — recycle's destroy, idle reap, sprint close)
- Test: `apps/fleet/test/studio.session.test.ts`

**Interfaces:**
- Produces: `rescuePush(deps, repo)` — commits dirty tree to `task/<issue>-<slug>`, pushes, returns what it saved

- [ ] **Step 1: Failing test — destroy path calls rescuePush before destroy()**

Assert ORDER, not merely that both ran. Rescue after destroy saves nothing.

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement.** A failed rescue must not block the kill — log it, proceed. A container that cannot be destroyed is worse than lost work, and the work is already lost in that case.

- [ ] **Step 4: Tests green**

- [ ] **Step 5: Commit** — `feat(fleet): rescue-push before every kill path`

---

### Task 4: Teardown learning harvest

**Files:**
- Modify: `apps/fleet/src/studio/do.ts` (beside rescuePush)
- Modify: `apps/fleet/src/board/envelope.ts` (`learnings[]` already in schema — wire it)

- [ ] **Step 1: Failing test — learnings from the final envelope are committed to `fleet/memory/<studio>/`**

- [ ] **Step 2: Run, fail**

- [ ] **Step 3: Implement.** Worker commits; containers never hold blueprint-repo write credentials.

- [ ] **Step 4: Tests green**

- [ ] **Step 5: Commit** — `feat(fleet): harvest learnings at teardown`

---

### Task 5: Live verification

No new code. This task exists because every prior round of this work passed unit tests and failed in a container.

- [ ] **Step 1: Bump `LABEL fleet.image.rev`, deploy, confirm the deploy output says `EDIT fleetflare-studiodo`** — `no changes` means the image did not rebuild and nothing below is being tested.

- [ ] **Step 2: Recycle a studio; wait for the rollout.** First recycle after a deploy commonly lands on the OLD image. Poll on script CONTENT (`grep -c` a known-new line), never on the route's verdict — the verdict can catch claude alive in the second before it exits.

- [ ] **Step 3: Prove each gate, live**
  - skill made unresolvable (rename its `SKILL.md`) → check reports it by name
  - done-report without verification intent → Stop gate refuses, names the field
  - kill a studio holding an uncommitted file → branch carries it after
  - healthy studio → `{"kind":"provisioned"}`, no false flag

Probe: `/private/tmp/claude-501/-Users-example-code-fleetflare-fleetflare-agency-worktrees-35-terminal-watch/6278510d-956c-463e-bdcc-2b39e9138717/scratchpad/probe2.ts <studio-id> '<cmd>' <ms>` — runs in the shell tmux window, returns to claude, never types into the lead's prompt.

- [ ] **Step 4: Record what could NOT be proven live, by name.** Unproven is a finding, not a gap to paper over.

---

## Self-review

- Spec coverage: §2 fleet-wide hooks → T1, T2 (caveman rows already BUILT and proven firing). §4 verification intent → T2. §9 teardown harvest → T4. P4 §2.14 rescue-push → T3.
- NOT in this plan, deliberately: per-studio Stop-gate variants for Content/Media/Marketing (they need the non-code brainstorm skill, which does not exist yet — P5b), backlog, Directus, portal, memory compaction. Each is its own plan.
- Type consistency: `rescuePush` and the harvest both take `SessionSyncDeps` + repo, matching `checkProvisionedWithRetry`'s existing shape.
