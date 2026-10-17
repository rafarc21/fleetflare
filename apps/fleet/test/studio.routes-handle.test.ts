import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RepoReach } from "../src/github/reach";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import {
  provisionWithStorage,
  STATUS_KEY, ROLE_ENV_KEY, NO_ROLE_ENV_ERROR, BRINGUP_CMD, PROVISIONED_OK, provisionedCheckCmd,
  adoptWorktreeSessionCmd,
  HEAL_ATTEMPT_KEY, OPERATION_KEY, LAST_STOP_KEY,
  type ProvisionDeps,
} from "../src/studio/provision";
import {
  SPAWN_TOKEN_KEY, type ProvisionedVerdict,
} from "../src/studio/do";
import { appendHouseRules } from "../src/studio/blueprint";
import { hashSpawnToken } from "../src/studio/org";
import { recordStudio, listStudios } from "../src/studio/registry";
import { sbExec, sbWriteFile, sbSetKeepAlive, withKillDeadline, EXEC_CLASSES, type SandboxHandle } from "../src/studio/sandbox-api";
import { redactSecrets } from "../src/studio/redact";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import {
  STUDIO_ID, FAKE_ROLE_PROMPT, FAKE, decodeRolePrompt,
  envWithFakeStudio, fakeFetchBlueprintFile, fakeStorage,
} from "./helpers/routes-studio-harness";

const { fleetJson: FAKE_FLEET_JSON, orgJson: FAKE_ORG_JSON, roleMd: FAKE_ROLE_MD } = FAKE;
// Fleet Spawn P3, Task 4 (R-P3-6): same role, `keep_alive: false` added —
// used only by the setKeepAlive tests below. Kept local (suite-specific
// variant, deliberately not folded): same frontmatter as FAKE.roleMd with
// the keep_alive line, same prompt.
const FAKE_ROLE_MD_KEEP_ALIVE_FALSE = `---
name: pilot
skills: []
allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
keep_alive: false
---
${FAKE_ROLE_PROMPT}
`;


function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
  await env.DB.prepare("DELETE FROM worker_exceptions").run();
});

describe("handleStudio", () => {
  it("401 without an Access header on GET status (real verifyAccess, not mocked)", async () => {
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(new Request(`https://x/studio/${STUDIO_ID}/status`), testEnv);
    expect(res.status).toBe(401);
  });

  it("GET /studio/ (fleet ls' list route): 401 unauthenticated; authorized it returns exactly what listStudios returns", async () => {
    const { testEnv } = envWithFakeStudio();

    const unauth = await handleStudio(new Request("https://x/studio/"), testEnv);
    expect(unauth.status).toBe(401);

    authorized();
    await recordStudio(env, {
      id: STUDIO_ID, state: "running", tailscaleHost: null,
      lastRefresh: "2026-08-16T00:00:00.000Z", error: null, lastRefreshError: null, burn: null,
      spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });
    await recordStudio(env, {
      id: "websites--scratch", state: "stopped", tailscaleHost: null,
      lastRefresh: null, error: null, lastRefreshError: null, burn: null,
      spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });

    const res = await handleStudio(authorizedReq("/studio/"), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus[];
    expect(body).toHaveLength(2);
    expect(body).toEqual(await listStudios(env));
  });

  it("400 on a malformed studio id (auth mocked ok)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq("/studio/BAD_ID/status"), testEnv);
    expect(res.status).toBe(400);
  });

  it("404 on an unrecognised /studio/ path", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/nonsense`), testEnv);
    expect(res.status).toBe(404);
  });

  it("provision happy path: 200 running, exec sequence is exactly [guarded clone, bring-up]", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("running");
    expect(body.id).toBe(STUDIO_ID);

    // Task 4 controller ruling: NO separate "tailscale up" exec (that lives
    // inside the bring-up script, Task 8). The clone is shell-guarded
    // (idempotent). Board issue #9 added a third, best-effort exec between
    // the clone and bring-up — rescue-branch discovery (discoverRescueRefsCmd)
    // — so the exact-two-exec ruling now reads [clone, rescue-discovery,
    // bring-up]. Board issue #28 added a fourth, synchronous, POST-bring-up
    // on-disk re-check (the clone-landed verification) — STUDIO_ID here is a
    // plain role ("pilot"), so only the clone check runs, never the
    // studio-only ~/.claude/agents check.
    // Issue #116 added the worktree-session adopt exec right before bring-up.
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("git clone");
    expect(calls[0]).toContain("||"); // shell guard: skip if target dir exists
    expect(calls[0]).toContain("test -d");
    expect(calls[1]).toContain("ls-remote --heads origin");
    expect(calls[2]).toBe(adoptWorktreeSessionCmd("websites"));
    expect(calls[3]).toBe("/opt/fleet/studio-bringup.sh");
    expect(calls[4]).toBe("test -d /workspace/websites/.git");
    expect(calls.some((c) => c.includes("tailscale"))).toBe(false);
  });

  it("provision fetches the blueprint (fleet.json, role file, org.json) and passes ROLE_PROMPT_B64/ROLE_ALLOWED_TOOLS into the bring-up exec env — Task 11", async () => {
    authorized();
    const bringupEnvCalls: (Record<string, string> | undefined)[] = [];
    const fetchedPaths: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      if (cmd === "/opt/fleet/studio-bringup.sh") bringupEnvCalls.push(env);
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchBlueprintFile = vi.fn(async (repo: string, path: string, ref: string) => {
      fetchedPaths.push(path);
      if (path.endsWith("fleet.json")) return FAKE.fleetJson;
      if (path.endsWith("org.json")) return FAKE.orgJson;
      return FAKE.roleMd;
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).state).toBe("running");

    // fleet.json first (target repo, default branch), then the Task 7
    // studio-first probe (fleet/blueprint/studios/pilot/studio.md — 404s,
    // "pilot" is a role not a studio, so this falls back), then the role
    // file and org.json (blueprint repo, resolved ref). #341: no memory
    // index fetch -- this env sets no FLEET_OPS_REPO, so memory is off.
    expect(fetchedPaths).toEqual([
      "fleet.json", "fleet/blueprint/studios/pilot/studio.md",
      "fleet/blueprint/roles/pilot.md", "fleet/blueprint/org.json",
    ]);
    expect(fetchBlueprintFile).toHaveBeenNthCalledWith(1, "acme-org/websites", "fleet.json", "main");
    expect(fetchBlueprintFile).toHaveBeenNthCalledWith(
      3, "acme-org/websites", "fleet/blueprint/roles/pilot.md", "main",
    );

    expect(bringupEnvCalls).toHaveLength(1);
    expect(bringupEnvCalls[0]?.ROLE_ALLOWED_TOOLS).toBe(
      "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write",
    );
    expect(decodeRolePrompt(bringupEnvCalls[0]?.ROLE_PROMPT_B64 ?? ""))
      .toBe(appendHouseRules(FAKE_ROLE_PROMPT));
    // Fleet CTO effort default (operator directive 2026-08-19): the resolved
    // RoleEnv carries ROLE_EFFORT end to end through the real provision
    // path. FAKE_ROLE_MD's role is "pilot" (non-cto) with no explicit
    // effort, so it resolves to "" — see the dedicated cto-default test
    // below for the "max" case.
    expect(bringupEnvCalls[0]?.ROLE_EFFORT).toBe("");
  });

  it("provision uses the request body's blueprintRef to override fleet.json's own pinned ref when fetching the role file + org.json (fleet.json itself is still read at the default branch)", async () => {
    authorized();
    const fetchedRefs: { path: string; ref: string }[] = [];
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      fetchedRefs.push({ path, ref });
      if (path.endsWith("fleet.json")) return FAKE.fleetJson;
      if (path.endsWith("org.json")) return FAKE.orgJson;
      return FAKE.roleMd;
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);

    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision`, {
        method: "POST", body: JSON.stringify({ blueprintRef: "v2.0.0" }),
      }),
      testEnv,
    );
    expect(((await res.json()) as StudioStatus).state).toBe("running");

    expect(fetchedRefs).toEqual([
      { path: "fleet.json", ref: "main" }, // always the default branch, override or not
      // Task 7 studio-first probe — 404s ("pilot" is a role), same override
      // ref the role fetch below uses.
      { path: "fleet/blueprint/studios/pilot/studio.md", ref: "v2.0.0" },
      { path: "fleet/blueprint/roles/pilot.md", ref: "v2.0.0" },
      { path: "fleet/blueprint/org.json", ref: "v2.0.0" },
      // #341: memory lives in its own store now (FLEET_OPS_REPO, unset here),
      // read at the store's default branch -- never at the blueprint ref.
    ]);
  });

  it("provision degrades (does not throw/500) when the requested role isn't declared in fleet.json's roles", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string) => {
      if (path.endsWith("fleet.json")) {
        return JSON.stringify({ blueprint: { repo: "o/r", ref: "main" }, roles: ["dev"], instance_type: "standard-2" });
      }
      return FAKE_ROLE_MD;
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("degraded");
    expect(body.error).toContain("pilot");
    expect(sbExecFake).not.toHaveBeenCalled(); // never reached the clone/bring-up
  });

  it("provision degrades (does not throw/500) when a blueprint file fetch fails (e.g. 404)", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const fetchBlueprintFile = vi.fn(async () => {
      throw new Error("fetch fleet.json@main failed (404): Not Found");
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("degraded");
    expect(body.error).toContain("404");
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("400 on a malformed blueprintRef in the provision body (Task 4 carry-over: validated before use, never reaches the DO)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision`, {
        method: "POST", body: JSON.stringify({ blueprintRef: "not a valid ref!!" }),
      }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("400 on an empty-string blueprintRef", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST", body: JSON.stringify({ blueprintRef: "" }) }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });

  it("a valid blueprintRef (tag/branch/sha charset) is accepted", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision`, {
        method: "POST", body: JSON.stringify({ blueprintRef: "release/v1.2.3" }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
  });

  it("provision records the spawn token's HASH to the registry row, never the token itself (P3 Task 2)", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);

    // The token lives in the studio's own DO storage (and its container env);
    // the registry only ever learns its digest.
    const token = await fakeNs.storage.get(SPAWN_TOKEN_KEY);
    expect(token).toMatch(/^fsp_[0-9a-f]{64}$/);

    const raw = await env.DB
      .prepare("SELECT value FROM fleet_state WHERE key = ?")
      .bind(`studio:${STUDIO_ID}`)
      .first<{ value: string }>();
    // Asserted on the SERIALIZED row, not the parsed object: the guarantee is
    // that no `fsp_` token is anywhere in what D1 actually holds.
    expect(raw?.value).not.toContain("fsp_");
    expect(raw?.value).toContain(await hashSpawnToken(token!));

    const row = (await listStudios(env)).find((s) => s.id === STUDIO_ID);
    expect(row?.spawnTokenHash).toBe(await hashSpawnToken(token!));
    expect(row?.spawnedBy).toBeNull(); // operator-provisioned: no parent
  });

  it("provision records the resulting status to the registry", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);

    const rows = await listStudios(env);
    expect(rows.find((s) => s.id === STUDIO_ID)?.state).toBe("running");
  });

  it("provision idempotent: second POST also 200 running; both calls issue identical guard-prefixed clone commands", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const provisionReq = () => authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" });

    const first = await handleStudio(provisionReq(), testEnv);
    expect(first.status).toBe(200);
    const second = await handleStudio(provisionReq(), testEnv);
    expect(second.status).toBe(200);
    expect(((await second.json()) as StudioStatus).state).toBe("running");

    // Review round 2, Important 1: the clone is re-issued on EVERY provision
    // call — there is no "already cloned" flag in DO storage to skip it
    // (removed: DO storage survives a container recycle, the container
    // filesystem does not, so that flag could skip a clone the checkout no
    // longer has and pin the studio to "degraded" forever, unrecoverable
    // even via restart). Idempotency now comes from the shell guard alone —
    // both calls must issue the exact same guard-prefixed command, not just
    // "a" clone command. Board issue #9's rescue-discovery exec makes each
    // provision issue three execs now, not two. Board issue #28 added a
    // fourth, synchronous, POST-bring-up clone-landed re-check (STUDIO_ID is
    // a plain role, so only the clone check runs, never the studio-only
    // ~/.claude/agents check).
    // Issue #116 added the worktree-session adopt exec right before bring-up.
    expect(calls).toHaveLength(10); // [clone, rescue-discovery, adopt, bring-up, verify-clone] x2
    const cloneCalls = calls.filter((c) => c.includes("git clone"));
    expect(cloneCalls).toHaveLength(2);
    expect(cloneCalls[0]).toBe(cloneCalls[1]);
    expect(cloneCalls[0]).toContain("||");
    const bringupCalls = calls.filter((c) => c === "/opt/fleet/studio-bringup.sh");
    expect(bringupCalls).toHaveLength(2);
    const verifyCalls = calls.filter((c) => c === "test -d /workspace/websites/.git");
    expect(verifyCalls).toHaveLength(2);
  });

  it("provision failure: bring-up returning non-zero degrades instead of throwing", async () => {
    authorized();
    const sbExecFake = vi.fn(async (cmd: string) => {
      if (cmd === "/opt/fleet/studio-bringup.sh") return { code: 1, stdout: "", stderr: "tmux: no server" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200); // route itself does not fail — the state machine reports degraded
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("degraded");
    expect(body.error).toContain("bring-up failed");
  });

  it("status carries lastStop, healAttempt and operationInFlight, heal reason scrubbed (#104)", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    await fakeNs.storage.put(STATUS_KEY, {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });
    const put = fakeNs.storage.put as unknown as (k: string, v: unknown) => Promise<void>;
    await put(LAST_STOP_KEY, { exitCode: 137, reason: "exit", at: "2026-09-24T11:42:38.000Z" });
    await put(HEAL_ATTEMPT_KEY, { armed: true, attemptedAt: "2026-09-24T11:43:00.000Z", reason: "bare: ghs_healsecretvalue" });
    const since = new Date(Date.now() - 60_000).toISOString(); // fresh: a stale lock reads null
    await put(OPERATION_KEY, { op: "restart", since });

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/status`), testEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("ghs_healsecretvalue");
    const body = JSON.parse(text);
    expect(body.state).toBe("running");
    expect(body.lastStop).toEqual({ exitCode: 137, reason: "exit", at: "2026-09-24T11:42:38.000Z" });
    expect(body.healAttempt).toMatchObject({ armed: true, attemptedAt: "2026-09-24T11:43:00.000Z" });
    expect(body.operationInFlight).toEqual({ op: "restart", since });
  });

  it("status is scrubbed: a stored error containing GitHub/Tailscale credentials never reaches the response body", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    await fakeNs.storage.put(STATUS_KEY, {
      id: STUDIO_ID, state: "degraded", tailscaleHost: null, lastRefresh: null,
      error:
        "refresh failed: ghs_secretsecret rejected; github_pat_alsosecret rejected; " +
        "ghp_classicpatvalue rejected; Bearer opaquebearertoken123; " +
        "tailscale up: tskey-auth-kABC123CNTRL-xyzxyzxyzxyzxyzxyzxyzxyz invalid; " +
        // Fleet Spawn P3, Task 1: a status seeded with a spawn token is
        // scrubbed end-to-end through this same route, same as every other
        // container-env secret above.
        `spawn auth rejected: fsp_${"deadbeef".repeat(8)}`,
      // Task 7 review round 1, C2: lastRefreshError (src/studio/do.ts's own
      // refresh-streak marker) carries the same secret-shaped risk `error`
      // does, and must be scrubbed at this exact same boundary.
      lastRefreshError: "credential write failed: ghs_lastrefreshsecretvalue rejected",
      burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/status`), testEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("ghs_");
    expect(text).not.toContain("github_pat_");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("opaquebearertoken123");
    expect(text).not.toContain("tskey-auth-");
    expect(text).not.toContain("fsp_");
    expect(text).not.toContain("deadbeef");
  });

  it("status on a never-provisioned studio returns 200 stopped, not an error", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/status`), testEnv);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).state).toBe("stopped");
  });

  it("restart refuses to clone a repo that does not name this studio, and says so", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);
    // Task 12: a restart only runs bring-up when provision already stored the
    // role env — seeded here so this test keeps asserting what it is about
    // (bring-up only, no clone) rather than tripping the new guard.
    await fakeNs.storage.put(ROLE_ENV_KEY, { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Bash(git *) Edit", ROLE_EFFORT: "" });

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/restart`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
    // Issue #76 put the guarded clone on the restart path, with ONE guard:
    // this studio (`websites--*`) recorded no `repoSlug` of its own, so the
    // slug resolves to the FLEET repo fallback, which does not name
    // `websites`. Cloning it would hand this lead somebody else's code,
    // silently. Refusing leaves the container bare, which is visibly broken
    // and therefore recoverable — `fleet provision` resolves the repo from
    // config and clones the right one.
    //
    // #38's on-disk verification still follows bring-up (a `test -d` re-read).
    // STUDIO_ID is a plain role, so only the clone check runs, never the
    // studio-only ~/.claude/agents one.
    // Issue #116 added the worktree-session adopt exec right before bring-up.
    expect(calls).toEqual([adoptWorktreeSessionCmd("websites"), BRINGUP_CMD, "test -d /workspace/websites/.git"]);
    expect(calls.some((c) => c.includes("git clone"))).toBe(false);
  });

  // The other half, and the whole point of #76: a studio that DOES know its
  // repo gets its checkout put back by a restart. Before this, a container
  // replaced by an image rollout could be restarted forever and stay bare —
  // the clone lived only in runProvision, and bring-up never had a clone step
  // at all (measured 2026-09-24: nine steps, all exit=0, no clone among them).
  it("restart CLONES when the recorded repo names this studio, before bring-up", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);
    await fakeNs.storage.put(ROLE_ENV_KEY, { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Bash(git *) Edit", ROLE_EFFORT: "" });
    // What provision records on every call: which repo this container was
    // actually pointed at.
    await fakeNs.storage.put(STATUS_KEY, {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, repoSlug: "acme-org/websites",
    } as StudioStatus);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/restart`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    // The clone comes FIRST: bring-up's claude-launch cds into the checkout,
    // so a lead started before it exists reasons about the wrong tree.
    expect(calls[0]).toBe(
      "test -d /workspace/websites/.git || git clone --depth 1 https://github.com/acme-org/websites.git /workspace/websites",
    );
    // Issue #116's adopt exec sits between the clone and bring-up.
    expect(calls[1]).toBe(adoptWorktreeSessionCmd("websites"));
    expect(calls[2]).toBe(BRINGUP_CMD);
  });

  // Caught before shipping, on the live fleet's own ids. A studio id's repo
  // segment folds `.` and `_` onto `-` (repo.ts's repoIdSegment, issue #5),
  // so `demositeltda/demosite.life` legitimately owns `demosite-life--*`. A raw
  // string comparison in the guard above would have refused to clone the
  // BETA/Gamma repo into every one of its studios — the exact repo this fleet
  // was being repaired for.
  it("the guard compares repo names the way studio ids do, so a dotted repo still clones", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);
    await fakeNs.storage.put(ROLE_ENV_KEY, { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Bash(git *) Edit", ROLE_EFFORT: "" });
    await fakeNs.storage.put(STATUS_KEY, {
      id: "demosite-life--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, repoSlug: "demositeltda/demosite.life",
    } as StudioStatus);

    await handleStudio(authorizedReq("/studio/demosite-life--pilot/restart", { method: "POST" }), testEnv);

    expect(calls[0]).toBe(
      "test -d /workspace/demosite-life/.git || git clone --depth 1 https://github.com/demositeltda/demosite.life.git /workspace/demosite-life",
    );
  });

  // --- recycle: root-cause fix for the stranded-image bug --------------------
  // Cloudflare keeps a container on the image it booted with; restart/
  // provision only ever exec into whatever container is already running, so
  // neither can ever get a new image onto a live studio. recycle destroys
  // the container first — see src/studio/do.ts's recycle()/recycleWithSync
  // for the composition these tests exercise through the fake stub above.

  it("recycle: destroys the container, awaits readiness, THEN re-runs the full provisioning path (clone + bring-up) — 200 running", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const destroyFake = vi.fn(async () => {
      calls.push("destroy");
    });
    const awaitReadyFake = vi.fn(async () => {
      calls.push("awaitReady");
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, undefined, destroyFake, awaitReadyFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("running");
    expect(body.id).toBe(STUDIO_ID);

    // destroy, then awaitReady, THEN the FULL provisioning sequence — clone
    // + bring-up, never restart's bring-up-only shortcut, since a destroyed
    // container has nothing on disk left for the clone's shell guard to
    // skip. This exact order is the fix for the live incident: provision's
    // execs must never run before the container is confirmed ready. Board
    // issue #9's rescue-discovery exec lands between the clone and bring-up.
    // Board issue #28 added a synchronous, POST-bring-up clone-landed
    // re-check as the final exec (STUDIO_ID is a plain role, so only the
    // clone check runs, never the studio-only ~/.claude/agents check).
    expect(calls).toEqual([
      "destroy", "awaitReady", expect.stringContaining("git clone"),
      expect.stringContaining("ls-remote --heads origin"), adoptWorktreeSessionCmd("websites"), BRINGUP_CMD,
      "test -d /workspace/websites/.git",
    ]);
    expect(destroyFake).toHaveBeenCalledTimes(1);
    expect(awaitReadyFake).toHaveBeenCalledTimes(1);
  });

  it("recycle records the resulting status to the registry, same as provision", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), testEnv);

    const rows = await listStudios(env);
    expect(rows.find((s) => s.id === STUDIO_ID)?.state).toBe("running");
  });

  // --- recycle readiness failure: the exact bug the second review pass fixed.
  // A recycle that cannot reach a confirmed-ready container must fail loudly
  // — never a 200 "running" body over a studio that was never provisioned.

  it("recycle: a readiness failure never reaches provisioning — non-200, error surfaced, registry shows degraded (not a silent 'running')", async () => {
    authorized();
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const destroyFake = vi.fn(async () => {
      calls.push("destroy");
    });
    const awaitReadyFake = vi.fn(async () => {
      throw new Error("port 3000 never became ready within 90000ms");
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, undefined, destroyFake, awaitReadyFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), testEnv);

    // The headline requirement: NEVER a 200. The old bug was exactly a 200
    // "running, error: null" body over an empty studio.
    expect(res.status).not.toBe(200);
    const text = await res.text();
    expect(text).toContain("never became ready");

    // provisionFn (clone/bring-up) never ran — nothing was attempted against
    // an unconfirmed container.
    expect(calls).toEqual(["destroy"]);

    // Surfaced in the registry too, not just this one HTTP response — an
    // operator checking `fleet ls` afterward must see the failure.
    const row = (await listStudios(env)).find((s) => s.id === STUDIO_ID);
    expect(row?.state).toBe("degraded");
    expect(row?.error).toContain("never became ready");
  });

  // --- recycle over a bare container: the 2026-08-25 incident ---------------
  // Measured live: `fleet recycle` answered `state: running, error: null`
  // while the container it left behind had an empty /workspace and no
  // claude. Both execs really had exited 0 — provisioning's own success is
  // inferred from exit codes, never from the container. recycleWithSync now
  // reads the container back (provision.ts's provisionedCheckCmd) and gives
  // the recycle one retry before refusing to call it a success.

  it("recycle: provisioning claims success but the container is bare — reprovisions once, and a passing recheck answers 200 running", async () => {
    authorized();
    const provisionCalls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      provisionCalls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake, undefined, undefined, undefined, [
      { stdout: "no git checkout at /workspace/websites" },
      { stdout: PROVISIONED_OK },
    ]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), testEnv);

    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
    // The whole provisioning sequence ran TWICE — clone + bring-up each
    // time, the same pair a manual `fleet provision` would have run by hand.
    expect(provisionCalls.filter((c) => c === BRINGUP_CMD)).toHaveLength(2);
    expect(provisionCalls.filter((c) => c.includes("git clone"))).toHaveLength(2);
  });

  it("recycle: the container is STILL bare after the retry — non-200, reason surfaced, registry degraded (never a silent 'running')", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake, undefined, undefined, undefined, [
      { stdout: "no git checkout at /workspace/websites" },
      { stdout: "claude is not running in tmux studio:claude (pane runs: bash)" },
    ]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), testEnv);

    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain("claude is not running");

    const row = (await listStudios(env)).find((s) => s.id === STUDIO_ID);
    expect(row?.state).toBe("degraded");
    expect(row?.error).toContain("claude is not running");
  });

  it("recycle: the check cannot run at all — 200 with an explicit unverified note, never a 500 over a working studio", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    // Every attempt throws, exactly as the live `exit`-kills-the-session bug
    // did on 2026-08-25 against a fully healthy websites--maestro.
    const { testEnv } = envWithFakeStudio(sbExecFake, undefined, undefined, undefined, [null, null, null, null]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/recycle`, { method: "POST" }), testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("running");
    expect(body.error).toContain("NOT verified");

    // Visible in `fleet ls`, in the same column a real failure would use.
    const row = (await listStudios(env)).find((st) => st.id === STUDIO_ID);
    expect(row?.error).toContain("NOT verified");
  });

  // --- destroy: board task #124 — stop a studio for good, no reprovision ----
  // Same pre-destroy sequence recycle runs (session sync, rescue-push,
  // learning-harvest — src/studio/destroy.ts's destroyWithSync), but leaves
  // the studio `stopped` instead of reprovisioning. Refuses when an open
  // board task is still assigned, unless `?force=true`.

  it("destroy: dispatches to stub.destroyStudio, destroys the container, and persists stopped — 200, never running", async () => {
    authorized();
    const destroyFake = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, destroyFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/destroy`, { method: "POST" }), testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("stopped");
    expect(destroyFake).toHaveBeenCalledTimes(1);

    const row = (await listStudios(env)).find((s) => s.id === STUDIO_ID);
    expect(row?.state).toBe("stopped");
  });

  it("destroy: an open assigned board task refuses with 409, and the container is never touched", async () => {
    authorized();
    const destroyFake = vi.fn(async () => {});
    const checkOpenTaskFake = async () => ({ ok: true as const, hasOpenTask: true });
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, destroyFake, undefined, undefined, checkOpenTaskFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/destroy`, { method: "POST" }), testEnv);

    expect(res.status).toBe(409);
    expect(await res.text()).toContain("open assigned board task");
    expect(destroyFake).not.toHaveBeenCalled();
  });

  it("destroy: an open-task check FAILURE (board lookup error) also refuses with 409 — fail closed, not open — and the container is never touched", async () => {
    authorized();
    const destroyFake = vi.fn(async () => {});
    const checkOpenTaskFake = async () => ({ ok: false as const, message: "board API error: 503" });
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, destroyFake, undefined, undefined, checkOpenTaskFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/destroy`, { method: "POST" }), testEnv);

    expect(res.status).toBe(409);
    expect(await res.text()).toContain("board API error: 503");
    expect(destroyFake).not.toHaveBeenCalled();
  });

  it("destroy: ?force=true passes force through, overriding an open-task refusal", async () => {
    authorized();
    const destroyFake = vi.fn(async () => {});
    const checkOpenTaskFake = async () => ({ ok: true as const, hasOpenTask: true });
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, destroyFake, undefined, undefined, checkOpenTaskFake);

    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/destroy?force=true`, { method: "POST" }), testEnv,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("stopped");
    expect(destroyFake).toHaveBeenCalledTimes(1);
  });

  it("destroy: ?discard-unsynced=true (recycle's own param) reaches the DO; a probe refusal is a 409 (#113 M3)", async () => {
    authorized();
    const destroyStudio = vi.fn(async (_force: boolean, discard: boolean) =>
      discard
        ? { ok: true as const, status: { id: STUDIO_ID, state: "stopped" } as StudioStatus }
        : { ok: false as const, refused: true as const, reason: "destroy refused: the container did not answer" });
    const testEnv = {
      ...env, STUDIO: { idFromName: (n: string) => n, get: () => ({ destroyStudio }) },
    } as unknown as Env;

    const refused = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/destroy`, { method: "POST" }), testEnv);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("destroy refused:");
    expect(destroyStudio).toHaveBeenLastCalledWith(false, false);

    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/destroy?discard-unsynced=true`, { method: "POST" }), testEnv,
    );
    expect(res.status).toBe(200);
    expect(destroyStudio).toHaveBeenLastCalledWith(false, true);
  });

  it("destroy: a container-kill failure is a non-200, distinct from a refusal — 500, never 409", async () => {
    authorized();
    const destroyFake = vi.fn(async () => { throw new Error("no such container"); });
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, destroyFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/destroy`, { method: "POST" }), testEnv);

    expect(res.status).toBe(500);
    expect(await res.text()).toContain("no such container");
  });

  it("destroy: GET is not found — no branch matches a non-POST request", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn());

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/destroy`, { method: "GET" }), testEnv);

    expect(res.status).toBe(404);
  });

  // --- GET /studio/:id/provisioned — the read-only container check ----------
  // Closes the gap `ff` shipped with: until this route existed a client could
  // only INFER provisioned-ness from state/error, and the 2026-08-25 incident
  // is exactly a container reporting `state: running` over an empty
  // /workspace. Same check recycle gates on (checkProvisionedWithRetry),
  // without a single one of recycle's destructive steps.

  // Issue #100: the check execs into the container, and an exec STARTS a
  // stopped one. The route must answer from storage alone.
  it("provisioned: a STOPPED studio answers inconclusive with zero execs", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(
      vi.fn(), undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }], undefined, undefined, "stopped",
    );
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);
    const body = await res.json() as { kind: string; reason?: string };
    expect(res.status).toBe(200);
    expect(body.kind).toBe("inconclusive");
    expect(body.reason).toContain("stopped");
    expect(fakeNs.checkCmds).toEqual([]);
  });

  it("provisioned: the container says yes — 200 {kind:'provisioned'}", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "provisioned" });
  });

  it("provisioned: the container names what is missing — 200 {kind:'bare', reason}", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: "claude is not running in tmux studio:claude (pane runs: bash)" },
    ]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "bare", reason: "claude is not running in tmux studio:claude (pane runs: bash)",
    });
  });

  it("provisioned: an exec that cannot run is INCONCLUSIVE — a statement about the check, never about the studio", async () => {
    authorized();
    // Every attempt throws, exactly as the live `exit`-kills-the-session bug
    // did on 2026-08-25 against a fully healthy studio.
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [null, null, null, null]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvisionedVerdict;
    expect(body.kind).toBe("inconclusive");
    // Never "bare": an unreachable check must not be reported as a broken
    // studio, or a client would tear down a studio that is perfectly fine.
    if (body.kind !== "inconclusive") throw new Error("unreachable");
    expect(body.reason).toContain("sandbox-default");
  });

  it("provisioned: runs the EXACT command recycle runs — so the `never calls exit` assertion covers this route too", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }]);

    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);

    // STUDIO_ID is `websites--pilot`, so the checkout the route asks about is
    // the id's own repo segment — never a caller-supplied value.
    expect(fakeNs.checkCmds).toEqual([provisionedCheckCmd("websites")]);
    // The same assertion test/studio.session.test.ts pins on the recycle
    // path, applied to the command this route actually executed: an `exit`
    // here kills the shared "sandbox-default" session shell instead of the
    // command, and the SDK throws rather than returning a verdict.
    expect(fakeNs.checkCmds[0]).not.toMatch(/(^|[;&|(\s])exit\b/);
  });

  it("provisioned: read-only — no clone, no bring-up, no registry row, no stored status", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake, undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }]);

    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);

    // sbExec is the PROVISIONING port (clone + bring-up). Untouched.
    expect(sbExecFake).not.toHaveBeenCalled();
    expect(await fakeNs.storage.get(STATUS_KEY)).toBeUndefined();
    expect((await listStudios(env)).find((r) => r.id === STUDIO_ID)).toBeUndefined();
  });

  it("provisioned: reason is redacted at the output boundary", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: "no git checkout at /workspace/websites (token fsp_deadbeef00)" },
    ]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), testEnv);

    const body = await res.text();
    expect(body).not.toContain("fsp_deadbeef00");
    expect(body).toContain(redactSecrets("fsp_deadbeef00"));
  });

  it("provisioned: a DO round trip that throws is still 200 inconclusive — a broken check can never make ff unusable", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn());
    const brokenEnv = {
      ...testEnv,
      STUDIO: {
        idFromName: (n: string) => n,
        get: () => ({ checkProvisioned: async () => { throw new Error("container unavailable"); } }),
      },
    } as unknown as Env;

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provisioned`), brokenEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProvisionedVerdict;
    expect(body.kind).toBe("inconclusive");
    if (body.kind !== "inconclusive") throw new Error("unreachable");
    expect(body.reason).toContain("check unreachable");
    expect(body.reason).toContain("container unavailable");
  });

  it("provisioned: GET only, and it never shadows POST /provision", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }]);

    // Wrong verb on the read route: no branch matches, so it 404s rather than
    // silently falling through to the PROVISION route next to it.
    const post = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provisioned`, { method: "POST" }), testEnv,
    );
    expect(post.status).toBe(404);

    // And the neighbouring write route is untouched by the new alternation:
    // POST /provision still provisions and still answers a StudioStatus.
    const provisionRes = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv,
    );
    expect(provisionRes.status).toBe(200);
    expect((await provisionRes.json()) as StudioStatus).toHaveProperty("state");
  });

  // --- POST /studio/:id/check — issue #37's on-demand live check ------------
  // "THERE IS NO WAY TO ASK FOR THE TRUTH NOW." provisionedCheckCmd already
  // tested the right things; nothing exposed it on demand AND recorded the
  // answer, so an operator needed a shell inside the container to tell a
  // healthy studio from a dead one — which is what turned a 2-of-4 partial
  // outage into a reported total outage on 2026-09-23.
  //
  // Distinct from GET /provisioned (which answers a bare verdict and writes
  // nothing): this answers the whole studio ROW and records the verdict, so
  // the `fleet ls` right after it agrees instead of showing the pre-check
  // value for up to another 300s.

  it("check: 200 with the studio row carrying the verdict the container just gave", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: PROVISIONED_OK },                                              // provision's own post-provision check
      { stdout: "claude is not running in tmux studio:claude (pane runs: bash)" }, // the on-demand check
    ]);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/check`, { method: "POST" }), testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe(STUDIO_ID);
    expect(body.readiness).toMatchObject({
      kind: "bare", reason: "claude is not running in tmux studio:claude (pane runs: bash)",
    });
    expect(typeof body.readiness?.checkedAt).toBe("string");
  });

  it("check: records the verdict, so the very next listing shows it instead of the pre-check row", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: PROVISIONED_OK },
      { stdout: "no git checkout at /workspace/websites" },
    ]);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);

    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/check`, { method: "POST" }), testEnv);

    const row = (await listStudios(env)).find((r) => r.id === STUDIO_ID);
    expect(row?.readiness).toMatchObject({ kind: "bare", reason: "no git checkout at /workspace/websites" });
  });

  it("check: runs the SAME command recycle and GET /provisioned run — by tmux window NAME, never a window switch", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: PROVISIONED_OK }, { stdout: PROVISIONED_OK },
    ]);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);

    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/check`, { method: "POST" }), testEnv);

    expect(fakeNs.checkCmds.at(-1)).toBe(provisionedCheckCmd("websites"));
    // The invisibility requirement: a probe that leaves tmux window 1 active
    // made an operator read a healthy studio as dead, three times over. This
    // check addresses `studio:claude` by name and switches nothing.
    expect(fakeNs.checkCmds.at(-1)).not.toContain("select-window");
  });

  // --- POST /studio/:id/clear-session-guard — board #140 (HOLD fix) ---------
  // The operator's escape from a sync guard stuck displacing every candidate
  // (do.ts's own clearSessionGuard doc comment has the full reasoning). Arms
  // a one-shot force-upload override for the NEXT sync tick — it does not
  // itself touch the stored mark, or exec/R2 anything (storage-only, safe on
  // a stopped studio).

  it("clear-session-guard: 200 with the row, guard cleared, force-upload override armed, mark left untouched", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);
    await fakeNs.storage.put(STATUS_KEY, {
      id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
      burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      sessionGuard: { at: "2026-09-24T09:00:00.000Z", key: "sessions/x/displaced/1", reason: "candidate poorer than latest" },
    } as StudioStatus);
    const mark = { file: "a.jsonl", lines: 5, lastTs: "2026-09-24T09:00:00.000Z" };
    await fakeNs.storage.put("sessionMark" as never, mark as never);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/clear-session-guard`, { method: "POST" }), testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.id).toBe(STUDIO_ID);
    expect(body.sessionGuard ?? null).toBeNull();
    // Unlike the original #140 design, the mark itself is untouched — the
    // override changes what the NEXT sync tick does, not the mark's current
    // value (see do.ts's clearSessionGuard doc comment for why deleting the
    // mark alone was a no-op).
    expect(await fakeNs.storage.get("sessionMark" as never)).toEqual(mark);
    expect(await fakeNs.storage.get("sessionForceUpload" as never)).toBe(true);
    // Storage-only: no exec, no R2 call from the route handler itself.
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("clear-session-guard: a studio with no guard state at all is a harmless 200 no-op", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/clear-session-guard`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
  });

  it("clear-session-guard: GET is not allowed (falls through to 404, same as every other POST-only action)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/clear-session-guard`), testEnv);
    expect(res.status).toBe(404);
  });

  it("clear-session-guard: a second POST before any sync tick runs is idempotent — same armed state, no double-arm, no exec, no R2 write", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);

    const first = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/clear-session-guard`, { method: "POST" }), testEnv);
    const second = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/clear-session-guard`, { method: "POST" }), testEnv);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await fakeNs.storage.get("sessionForceUpload" as never)).toBe(true);
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("check: reason is redacted before it leaves the Worker", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: PROVISIONED_OK },
      { stdout: "no git checkout at /workspace/websites (token fsp_deadbeef00)" },
    ]);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/check`, { method: "POST" }), testEnv);

    const body = await res.text();
    expect(body).not.toContain("fsp_deadbeef00");
    expect(body).toContain(redactSecrets("fsp_deadbeef00"));
  });

  // Issue #251, review finding: `rescue` mirrors `check`'s own redaction test
  // above — `result.error` can carry a rejected push's raw git stderr (a repo
  // URL/credential fragment), and that must not leave the Worker unredacted.
  it("rescue: a non-ok result's error is redacted before it leaves the Worker", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio();
    const stub = fakeNs.get();
    const failingNs = {
      ...fakeNs,
      get: () => ({
        ...stub,
        rescueNow: async () => ({
          ok: false,
          error: "no git checkout at /workspace/websites (token fsp_deadbeef00)",
        }),
      }),
    };
    const res = await handleStudio(
      authorizedReq(`/studio/${STUDIO_ID}/rescue`, { method: "POST" }),
      { ...testEnv, STUDIO: failingNs } as unknown as Env,
    );

    const body = await res.text();
    expect(body).not.toContain("fsp_deadbeef00");
    expect(body).toContain(redactSecrets("fsp_deadbeef00"));
  });

  it("check: POST only — a GET 404s rather than silently reading as something else", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/check`), testEnv);

    expect(res.status).toBe(404);
  });

  it("the default listing stays cheap: GET /studio/ runs NO container check", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [{ stdout: PROVISIONED_OK }]);
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    const before = fakeNs.checkCmds.length;

    const res = await handleStudio(authorizedReq("/studio/", { headers: { Accept: "application/json" } }), testEnv);

    expect(res.status).toBe(200);
    // Issue #37's explicit boundary: "Do NOT make `fleet ls` always check live
    // — it fans out an exec per studio." Freshness is opt-in, per studio,
    // through the check route above.
    expect(fakeNs.checkCmds).toHaveLength(before);
  });

  it("provision: answers with the verdict measured AFTER provisioning, not the one already on the row", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn(), undefined, undefined, undefined, [
      { stdout: "no git checkout at /workspace/websites" }, // first provision: still bare
      { stdout: PROVISIONED_OK },                            // second provision: healed
    ]);

    const first = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(((await first.json()) as StudioStatus).readiness).toMatchObject({ kind: "bare" });

    const second = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    // The measured 2026-09-23 failure: a `fleet provision` that healed the
    // studio kept printing the previous "bare" verdict for minutes.
    expect(((await second.json()) as StudioStatus).readiness).toMatchObject({ kind: "provisioned" });
  });

  // --- Task 12: the restart ROLE_* env gap -----------------------------------
  // Before this, restartStudio passed NO env to bring-up, and the script's own
  // `${ROLE_PROMPT_B64:-}` / `${ROLE_ALLOWED_TOOLS:-}` defaults meant that
  // relaunching claude after a container recycle would have succeeded with an
  // empty system prompt and an empty tool policy — a studio silently running
  // with no role at all.

  it("provision persists the resolved role env, and restart hands that exact env to bring-up", async () => {
    authorized();
    const envs: (Record<string, string> | undefined)[] = [];
    const sbExecFake = vi.fn(async (_cmd: string, execEnv?: Record<string, string>) => {
      envs.push(execEnv);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);

    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    const stored = await fakeNs.storage.get(ROLE_ENV_KEY);
    expect(stored).toBeDefined();
    expect(stored?.ROLE_ALLOWED_TOOLS).toBe("Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write");
    // The bring-up exec of the PROVISION (index 2; index 0 is the clone,
    // index 1 is board issue #9's rescue-branch-discovery exec — neither
    // is ever called with an env argument, so `envs[0]`/`envs[1]` read
    // `undefined`).
    // Issue #116's adopt exec (index 2, no env) now precedes bring-up.
    expect(envs[3]).toEqual(stored);

    envs.length = 0;
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/restart`, { method: "POST" }), testEnv);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
    // Restart's bring-up carries the SAME env — no blueprint refetch, no
    // bare relaunch.
    //
    // Three execs now, not two. Issue #76 put the guarded clone on the
    // restart path: a container image rollout replaces the container under
    // this DO, so restart is routinely the first thing to touch an empty
    // filesystem and it has to put the checkout back before bring-up starts
    // a lead in it. The clone carries no env (index 0), bring-up carries the
    // stored one (index 1), and #38's post-bring-up verification carries
    // none (index 2), like every other verification exec.
    // Issue #116's adopt exec (no env) precedes bring-up.
    expect(envs).toEqual([undefined, undefined, stored, undefined]);
  });

  // --- Fleet Spawn P3, Task 4 (R-P3-6): per-role keep_alive plumb ------------

  it("provision resolves the role's keep_alive:false and calls setKeepAlive(false); restart re-derives the same value with no blueprint refetch", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string) => {
      if (path.endsWith("fleet.json")) return FAKE.fleetJson;
      if (path.endsWith("org.json")) return FAKE.orgJson;
      return FAKE_ROLE_MD_KEEP_ALIVE_FALSE;
    });
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);

    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(fakeNs.setKeepAliveCalls).toEqual([false]);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/restart`, { method: "POST" }), testEnv);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
    expect(fakeNs.setKeepAliveCalls).toEqual([false, false]);
    // Restart never refetches the blueprint — the 4 calls are all provision's
    // (fleet.json, the Task 7 studio-first probe, role file, org.json).
    // #341: back to 4 -- the memory index comes from the memory store
    // (FLEET_OPS_REPO), unset in this env, so there is no index fetch.
    expect(fetchBlueprintFile).toHaveBeenCalledTimes(4);
  });

  it("provision defaults keep_alive to true when the role frontmatter omits it, and calls setKeepAlive(true)", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake); // FAKE_ROLE_MD: no keep_alive line

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
    expect(fakeNs.setKeepAliveCalls).toEqual([true]);
  });

  it("restart with no stored keep_alive (a studio provisioned before this feature existed) defaults to true", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake);
    // Same seeding style as the pre-existing "restart: 200 running after a
    // bring-up-only re-run" test above: ROLE_ENV_KEY present, KEEP_ALIVE_KEY
    // deliberately absent — this studio provisioned before Task 4 shipped.
    await fakeNs.storage.put(ROLE_ENV_KEY, { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Bash(git *) Edit", ROLE_EFFORT: "" });

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/restart`, { method: "POST" }), testEnv);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
    expect(fakeNs.setKeepAliveCalls).toEqual([true]);
  });

  it("a provision that cannot resolve the blueprint never calls setKeepAlive (nothing resolved to toggle)", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const fetchBlueprintFile = vi.fn(async () => {
      throw new Error("fetch fleet.json@main failed (404): Not Found");
    });
    const { testEnv, fakeNs } = envWithFakeStudio(sbExecFake, fetchBlueprintFile);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(((await res.json()) as StudioStatus).state).toBe("degraded");
    expect(fakeNs.setKeepAliveCalls).toEqual([]);
  });

  it("restart with no stored role env degrades with an actionable error and never runs bring-up", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);

    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/restart`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StudioStatus;
    expect(body.state).toBe("degraded");
    expect(body.error).toBe(NO_ROLE_ENV_ERROR);
    expect(body.error).toContain("provision");
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("a provision that cannot resolve the blueprint leaves a previously stored role env intact", async () => {
    authorized();
    const { testEnv, fakeNs } = envWithFakeStudio(
      vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    );
    await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    const good = await fakeNs.storage.get(ROLE_ENV_KEY);
    expect(good).toBeDefined();

    // Second provision against a blueprint fetch that fails outright.
    const { testEnv: brokenEnv, fakeNs: brokenNs } = envWithFakeStudio(
      vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      vi.fn(async () => {
        throw new Error("github unreachable");
      }),
    );
    await brokenNs.storage.put(ROLE_ENV_KEY, good!);
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), brokenEnv);
    expect(((await res.json()) as StudioStatus).state).toBe("degraded");
    // The container is very likely still running the old role; one transient
    // GitHub failure must not brick restart by wiping the env it needs.
    expect(await brokenNs.storage.get(ROLE_ENV_KEY)).toEqual(good);
  });
});

// ---------------------------------------------------------------------------
// Fleet CTO effort default (operator directive 2026-08-19): provision.ts
// resolves ROLE_EFFORT via the real provisionWithStorage/roleBringupEnv path
// — called directly here (not through handleStudio/fakeStudioNamespace,
// which are keyed to the fixed STUDIO_ID/"pilot" role used throughout this
// file) so a "cto" role can be provisioned without retrofitting that shared
// harness. Non-cto absent-effort is already covered above (the Task 11
// test's own ROLE_EFFORT assertion); this covers the actual headline
// behavior — a cto role with no explicit frontmatter opinion defaults to
// "max" — end to end through the real resolve+persist path, not just the
// blueprint.ts unit level (test/studio.blueprint-brief.test.ts).
// ---------------------------------------------------------------------------

describe("provisionWithStorage resolves ROLE_EFFORT (Fleet CTO effort default, operator directive 2026-08-19)", () => {
  const FAKE_ROLE_MD_CTO = `---
name: cto
skills: []
allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
You are cto. Argue with the operator, carefully.
`;
  const FAKE_FLEET_JSON_CTO = JSON.stringify({
    blueprint: { repo: "acme-org/websites", ref: "main" }, roles: ["cto"], instance_type: "standard-2",
  });

  it("a cto role with no explicit frontmatter effort resolves ROLE_EFFORT to \"max\" in the bring-up exec env, and persists it under ROLE_ENV_KEY for restart to reuse", async () => {
    const bringupEnvCalls: (Record<string, string> | undefined)[] = [];
    const sbExecFake = vi.fn(async (cmd: string, execEnv?: Record<string, string>) => {
      if (cmd === BRINGUP_CMD) bringupEnvCalls.push(execEnv);
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string) => {
      if (path.endsWith("fleet.json")) return FAKE_FLEET_JSON_CTO;
      if (path.endsWith("org.json")) return FAKE_ORG_JSON;
      return FAKE_ROLE_MD_CTO;
    });
    const storage = fakeStorage();
    const deps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    const status = await provisionWithStorage(
      deps, storage, { repo: "websites", role: "cto" }, "acme-org/websites",
    );

    expect(status.state).toBe("running");
    expect(bringupEnvCalls).toHaveLength(1);
    expect(bringupEnvCalls[0]?.ROLE_EFFORT).toBe("max");
    const stored = await storage.get(ROLE_ENV_KEY);
    expect(stored?.ROLE_EFFORT).toBe("max");
  });
});

// --- Fleet Spawn P3, Task 4 (R-P3-3): MAX_STUDIOS at the direct-provision
// entry point (the OTHER one — spawn.ts's runSpawn has its own cap tests,
// against a fake registry; this one goes through the real D1-backed
// listStudios(env), the same registry every other test in this file reads
// through, since routes.ts's provision handler has no injected registry
// seam of its own). ------------------------------------------------------

describe("POST /studio/:id/provision — MAX_STUDIOS cap", () => {
  async function seedFillerRows(n: number, startAt = 0): Promise<void> {
    for (let i = startAt; i < startAt + n; i++) {
      await recordStudio(env, {
        id: `websites--filler-${i}`, state: "running", tailscaleHost: null, lastRefresh: null,
        error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      });
    }
  }

  it("99 existing studios, cap 100 (default): provisioning a NEW id still succeeds", async () => {
    authorized();
    await seedFillerRows(99);
    const { testEnv } = envWithFakeStudio(vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })));
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
  });

  it("100 existing studios (AT the default cap): provisioning a NEW id 409s with an actionable body, the DO is never touched", async () => {
    authorized();
    await seedFillerRows(100);
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("100");
    expect(body).toContain("capacity");
    expect(body).toContain(STUDIO_ID); // actionable: names the id that couldn't provision
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("#81: 100 STOPPED rows do not hold the cap -- a new id provisions", async () => {
    authorized();
    for (let i = 0; i < 100; i++) {
      await recordStudio(env, {
        id: `websites--gone-${i}`, state: "stopped", tailscaleHost: null, lastRefresh: null,
        error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
      });
    }
    const { testEnv } = envWithFakeStudio(vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })));
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
  });

  it("100 existing studios, one of them THIS id: re-provisioning it is exempt from the cap (idempotent recovery must survive a full fleet)", async () => {
    authorized();
    await seedFillerRows(99);
    await recordStudio(env, {
      id: STUDIO_ID, state: "degraded", tailscaleHost: null, lastRefresh: null,
      error: "stale", lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    });
    const { testEnv } = envWithFakeStudio(vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })));
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/provision`, { method: "POST" }), testEnv);
    expect(res.status).toBe(200);
    expect(((await res.json()) as StudioStatus).state).toBe("running");
  });
});

describe("GET /studio/:id/terminal (Task 10 xterm.js fallback page)", () => {
  it("401 without an Access header (real verifyAccess, not mocked; the DO is never touched)", async () => {
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(new Request(`https://x/studio/${STUDIO_ID}/terminal`), testEnv);
    expect(res.status).toBe(401);
  });

  it("200 text/html once authorized, serving the bundled page with this studio's id substituted in", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(authorizedReq(`/studio/${STUDIO_ID}/terminal`), testEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const body = await res.text();
    expect(body).toContain('<div id="t">');
    // The build artifact's placeholder is gone, replaced with this request's
    // own studio id — not left generic, and not another studio's.
    expect(body).not.toContain("__FLEET_STUDIO_ID__");
    expect(body).toContain(JSON.stringify(STUDIO_ID));
  });
});

function fakeSandboxHandle(overrides: Partial<SandboxHandle> = {}): SandboxHandle {
  return {
    exec: vi.fn(async () => ({ success: true, exitCode: 0, stdout: "", stderr: "" })),
    execWithSessionToken: vi.fn(async () => ({ success: true, exitCode: 0, stdout: "", stderr: "" })),
    writeFile: vi.fn(async () => ({ success: true })),
    setKeepAlive: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("sandbox-api adapter", () => {
  it("sbExec maps ExecResult (exitCode) to the adapter's {code, stdout, stderr}", async () => {
    const fakeSb = fakeSandboxHandle({
      exec: vi.fn(async (cmd: string) => ({ success: true, exitCode: 0, stdout: `ran ${cmd}`, stderr: "" })),
    });
    // #104: every exec names a class; provision's is the default session.
    const res = await sbExec(fakeSb, "echo hi", EXEC_CLASSES.provision);
    const wrapped = withKillDeadline("echo hi", EXEC_CLASSES.provision.timeoutMs);
    expect(fakeSb.exec).toHaveBeenCalledWith(wrapped);
    expect(res).toEqual({ code: 0, stdout: `ran ${wrapped}`, stderr: "" });
  });

  it("sbExec forwards an env map as {env} in the options bag (Task 11 bring-up env contract)", async () => {
    const fakeSb = fakeSandboxHandle();
    await sbExec(fakeSb, "/opt/fleet/studio-bringup.sh", {
      ...EXEC_CLASSES.provision, env: { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Edit" },
    });
    expect(fakeSb.exec).toHaveBeenCalledWith(
      withKillDeadline("/opt/fleet/studio-bringup.sh", EXEC_CLASSES.provision.timeoutMs),
      { env: { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Edit" } },
    );
  });

  it("sbExec surfaces a non-zero exit code (caller decides success/failure)", async () => {
    const fakeSb = fakeSandboxHandle({
      exec: vi.fn(async () => ({ success: false, exitCode: 127, stdout: "", stderr: "not found" })),
    });
    const res = await sbExec(fakeSb, "nonexistent-cmd", EXEC_CLASSES.provision);
    expect(res).toEqual({ code: 127, stdout: "", stderr: "not found" });
  });

  it("sbWriteFile base64-encodes bytes losslessly and writes with encoding:'base64'", async () => {
    const fakeSb = fakeSandboxHandle();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67]);
    await sbWriteFile(fakeSb, "/workspace/.paste/img-1.png", bytes);

    expect(fakeSb.writeFile).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fakeSb.writeFile).mock.calls[0];
    expect(call[0]).toBe("/workspace/.paste/img-1.png");
    expect(call[2]).toEqual({ encoding: "base64" });
    const decoded = Uint8Array.from(atob(call[1] as string), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([...bytes]);
  });

  it("sbWriteFile round-trips a buffer spanning multiple base64 chunks", async () => {
    const fakeSb = fakeSandboxHandle();
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await sbWriteFile(fakeSb, "/workspace/.paste/img-2.png", bytes);

    const call = vi.mocked(fakeSb.writeFile).mock.calls[0];
    const decoded = Uint8Array.from(atob(call[1] as string), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect([...decoded]).toEqual([...bytes]);
  });

  it("sbWriteFile throws on {success:false} instead of resolving silently (Task 6 carry-over from Task 4 review: a discarded failure would let a paste route report a path for a file that never landed)", async () => {
    const fakeSb = fakeSandboxHandle({ writeFile: vi.fn(async () => ({ success: false })) });
    await expect(sbWriteFile(fakeSb, "/workspace/.paste/img-1.png", new Uint8Array([1]))).rejects.toThrow();
  });

  it("sbSetKeepAlive calls through to setKeepAlive (review round 2, Spec 4 — no direct SDK call from do.ts)", async () => {
    const fakeSb = fakeSandboxHandle();
    await sbSetKeepAlive(fakeSb, true);
    expect(fakeSb.setKeepAlive).toHaveBeenCalledWith(true);
  });

  // sbAttachPty's own coverage lives in test/studio.ws.test.ts, alongside the
  // bridge that consumes it (it needs a WebSocketPair, not a SandboxHandle).
});

describe("redactSecrets", () => {
  it("masks a GitHub App/installation token (ghs_)", () => {
    expect(redactSecrets("token ghs_secretsecret here")).not.toContain("ghs_");
  });

  it("masks a GitHub fine-grained PAT (github_pat_)", () => {
    expect(redactSecrets("token github_pat_abc123XYZ here")).not.toContain("github_pat_");
  });

  it("masks the other GitHub token prefixes (ghp_/gho_/ghu_/ghr_)", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghr"]) {
      const s = redactSecrets(`token ${prefix}_secretvalue123 here`);
      expect(s).not.toContain(`${prefix}_`);
    }
  });

  it("masks a Tailscale auth key (tskey-auth-...)", () => {
    // Review round 2, Important 3: this feature's own bring-up script runs
    // `tailscale up --authkey=...` — a failed bring-up's stderr can echo
    // this key straight into StudioStatus.error exactly like a GitHub token.
    const s = redactSecrets("tailscale up failed: key tskey-auth-kABC123CNTRL-xyzxyzxyzxyzxyzxyzxyzxyz rejected");
    expect(s).not.toContain("tskey-auth-");
  });

  it("masks an Anthropic OAuth/API token (sk-ant-...)", () => {
    // Review round 3, Minor 4: CLAUDE_CODE_OAUTH_TOKEN now lives in every
    // studio container's process environment (StudioDO.envVars), so a failed
    // bring-up's stderr can echo it into StudioStatus.error exactly like the
    // Tailscale key above.
    const s = redactSecrets("claude: auth failed for sk-ant-oat01-AbC_123-xyzXYZ0987 (401)");
    expect(s).not.toContain("sk-ant-");
    expect(s).not.toContain("AbC_123-xyzXYZ0987");
    expect(redactSecrets("key sk-ant-api03-deadbeef here")).not.toContain("deadbeef");
  });

  it("masks a fleet spawn token (fsp_...)", () => {
    // Fleet Spawn P3, Task 1: R-P3-1's per-studio spawn-auth token
    // (studio/do.ts's FLEET_SPAWN_TOKEN envVar, org.ts's mintSpawnToken) can
    // reach StudioStatus.error exactly like the other container-env secrets
    // above — a failed bring-up's stderr, an `env` dump, a shell trace.
    const s = redactSecrets(
      `bring-up failed: token fsp_${"a1b2c3".repeat(10)} rejected by /fleet/spawn`,
    );
    expect(s).not.toContain("fsp_");
    expect(s).not.toContain("a1b2c3");
  });

  it("masks a Bearer token", () => {
    expect(redactSecrets("Authorization: Bearer opaquetoken123")).not.toContain("opaquetoken123");
  });

  it("leaves ordinary text untouched", () => {
    const s = "bring-up failed (1): tmux: no server running on /tmp/tmux-0/default";
    expect(redactSecrets(s)).toBe(s);
  });
});

// Dynamic repo selection (P4a) — the OTHER entry point that creates a
// studio. src/studio/repo.ts owns every decision (and test/studio.repo.test.ts
// covers them directly); these pin this route's wiring: that the body's
// `repo` reaches it, that a rejection never reaches the DO, that the
// resolved slug becomes the clone target, and — the regression guard — that
// a bodyless provision of an existing `websites` studio behaves exactly as
// it always did, installation call included (there isn't one).
describe("POST /studio/:id/provision — dynamic repo selection", () => {
  function repos(list: string[] | Error) {
    const calls: string[] = [];
    return {
      calls,
      reach: async (slug: string): Promise<RepoReach> => {
        calls.push(slug);
        if (list instanceof Error) throw list;
        return list.some((full) => full.toLowerCase() === slug.toLowerCase())
          ? { reachable: true }
          : { reachable: false, remedy: "is not reachable by this fleet — grant it access first" };
      },
    };
  }

  function provisionReq(id: string, body?: unknown) {
    return authorizedReq(`/studio/${id}/provision`, {
      method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("clones the requested repo when the installation can reach it", async () => {
    authorized();
    const cmds: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(
      provisionReq("beta--pilot", { repo: "acme-org/beta" }), testEnv,
      fakeFetchBlueprintFile(), repos(["acme-org/beta"]).reach,
    );
    expect(res.status).toBe(200);
    expect(cmds[0]).toContain("https://github.com/acme-org/beta.git");
    expect(cmds[0]).toContain("/workspace/beta");
  });

  it("400s when the requested repo's short name is not the id's own repo segment — the DO is never touched", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(
      provisionReq("websites--pilot", { repo: "acme-org/beta" }), testEnv,
      fakeFetchBlueprintFile(), repos(["acme-org/beta"]).reach,
    );
    expect(res.status).toBe(400);
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("403s a repo outside the installation — the DO is never touched", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(
      provisionReq("payload--pilot", { repo: "attacker/payload" }), testEnv,
      fakeFetchBlueprintFile(), repos(["acme-org/websites"]).reach,
    );
    expect(res.status).toBe(403);
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("400s a malformed repo before the installation is ever asked", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio(vi.fn());
    const { reach, calls } = repos(new Error("must not be called"));
    const res = await handleStudio(
      provisionReq("websites--pilot", { repo: "not-a-slug" }), testEnv, fakeFetchBlueprintFile(), reach,
    );
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("a bodyless provision of an existing websites studio still clones AGENT_REPO, with no installation call", async () => {
    authorized();
    const cmds: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const { reach, calls } = repos(new Error("must not be called"));
    const res = await handleStudio(
      provisionReq(STUDIO_ID), testEnv, fakeFetchBlueprintFile(), reach,
    );
    expect(res.status).toBe(200);
    expect(cmds[0]).toBe(
      "test -d /workspace/websites/.git || git clone --depth 1 " +
      "https://github.com/acme-org/websites.git /workspace/websites",
    );
    expect(calls).toEqual([]);
  });

  it("a bodyless re-provision reads the binding off the registry row and re-clones THAT repo, not the fleet default", async () => {
    authorized();
    const cmds: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);
    // The row a `fleet spawn` from the beta folder leaves behind. Seeded
    // rather than produced by a first POST: this file's fake DO namespace is
    // hardcoded to ONE studio id (see fakeStudioNamespace), so a real
    // two-call sequence would record the binding under the wrong id — an
    // artefact of the fake, not of the route. The registry row is what the
    // route actually reads.
    await recordStudio(env as unknown as Env, {
      id: "beta--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: "acme-org/beta",
    });
    // `fleet provision beta--pilot` from anywhere, no body at all.
    const res = await handleStudio(
      provisionReq("beta--pilot"), testEnv, fakeFetchBlueprintFile(),
      repos(new Error("must not be called")).reach,
    );
    expect(res.status).toBe(200);
    expect(cmds[0]).toContain("https://github.com/acme-org/beta.git");
  });

  it("a bodyless provision of an UNBOUND non-default id is refused, never silently cloned from the fleet default", async () => {
    authorized();
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const { testEnv } = envWithFakeStudio(sbExecFake);
    const res = await handleStudio(
      provisionReq("beta--pilot"), testEnv, fakeFetchBlueprintFile(),
      repos(new Error("must not be called")).reach,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not bound to a repo yet");
    expect(sbExecFake).not.toHaveBeenCalled();
  });

  it("recycle re-provisions the studio's own bound repo (it carries no repo of its own)", async () => {
    authorized();
    const cmds: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const { testEnv } = envWithFakeStudio(sbExecFake);
    await handleStudio(
      provisionReq("beta--pilot", { repo: "acme-org/beta" }), testEnv,
      fakeFetchBlueprintFile(), repos(["acme-org/beta"]).reach,
    );
    cmds.length = 0;
    const res = await handleStudio(
      authorizedReq("/studio/beta--pilot/recycle", { method: "POST" }), testEnv, fakeFetchBlueprintFile(),
      repos(new Error("must not be called")).reach,
    );
    expect(res.status).toBe(200);
    expect(cmds.some((c) => c.includes("https://github.com/acme-org/beta.git"))).toBe(true);
  });
});

// Board task #125: `fleet onboard`'s check #2 — a standalone GET exposing
// reachRepo (src/github/auth.ts), unmodified, for a caller with no studio to
// provision yet. Same "401 unauthenticated, authorized it returns exactly
// what X returns" pattern the /studio/ list route test above already uses.
describe("GET /studio/reach", () => {
  function repos(list: string[] | Error) {
    const calls: string[] = [];
    return {
      calls,
      reach: async (slug: string): Promise<RepoReach> => {
        calls.push(slug);
        if (list instanceof Error) throw list;
        return list.some((full) => full.toLowerCase() === slug.toLowerCase())
          ? { reachable: true }
          : { reachable: false, remedy: "is not reachable by this fleet — grant it access first" };
      },
    };
  }

  it("401 without an Access header (real verifyAccess, not mocked; reachRepo is never called)", async () => {
    const { testEnv } = envWithFakeStudio();
    const { reach, calls } = repos(new Error("must not be called"));
    const res = await handleStudio(
      new Request("https://x/studio/reach?repo=acme-org/websites"), testEnv,
      fakeFetchBlueprintFile(), reach,
    );
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("authorized: calls reachRepo with the parsed slug and returns its JSON verbatim", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const { reach, calls } = repos(["acme-org/websites"]);
    const res = await handleStudio(
      authorizedReq("/studio/reach?repo=acme-org/websites"), testEnv,
      fakeFetchBlueprintFile(), reach,
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual(["acme-org/websites"]);
    expect(await res.json()).toEqual({ reachable: true });
  });

  it("authorized, unreachable repo: still 200, body carries reachable:false + remedy verbatim", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const { reach } = repos(["some-other/repo"]);
    const res = await handleStudio(
      authorizedReq("/studio/reach?repo=attacker/payload"), testEnv,
      fakeFetchBlueprintFile(), reach,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reachable: false, remedy: "is not reachable by this fleet — grant it access first",
    });
  });

  it("400s a malformed repo param before reachRepo is ever called", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const { reach, calls } = repos(new Error("must not be called"));
    const res = await handleStudio(
      authorizedReq("/studio/reach?repo=not-a-slug"), testEnv, fakeFetchBlueprintFile(), reach,
    );
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("400s when the repo param is absent entirely", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const { reach, calls } = repos(new Error("must not be called"));
    const res = await handleStudio(authorizedReq("/studio/reach"), testEnv, fakeFetchBlueprintFile(), reach);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

