// P4a-1, Task 7 — provision.ts's studio-first resolution
// (resolveBringupEnv/provisionWithStorage). No dedicated test file for
// provision.ts existed before this task (its OTHER behavior is covered
// piecemeal across test/studio.routes.test.ts, test/studio.spawn.test.ts,
// test/studio.refresh.test.ts, test/studio.session.test.ts — see each
// file's own header); this one is scoped to the NEW studio-vs-role fork
// only, named to match the repo's own src-file -> test-file convention
// (studio.blueprint.test.ts <-> blueprint.ts, studio.studio-blueprint.test.ts
// <-> studio-blueprint.ts). Same mocking style those files already use: a
// path-routed fetchBlueprintFile fake, a plain in-memory Map behind
// StudioStorage, sbExec tracked only for the bring-up exec's env argument.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  provisionWithStorage, restartWithStorage, resolveBringupEnv, resolveWorkRepoSlug, ROLE_ENV_KEY, BRINGUP_CMD,
  discoverRescueRefsCmd, DESTROYING_KEY, OPS_HOUSE_RULES_PATH,
  type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv,
  type HealAttempt,
  type OperationInFlight,
} from "../src/studio/provision";
import { appendHouseRules, base64EncodeUtf8, BlueprintError } from "../src/studio/blueprint";
import { recordStudio } from "../src/studio/registry";
import { gatedStateIn, opsFileFetcher, installLeakGatePort } from "../src/studio/do";
import { writeProxyConfigCmd } from "../src/write-proxy/container-config";
import { ghBlockCmd, leakGateInstallCmd } from "../src/studio/gh-wrapper";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";
import { memoryCloneCmd, MEMORY_TOKEN_ENV } from "../src/memory/store";
import { MEMORY_INDEX_PATH } from "../src/memory/index-file";
import {
  LEAK_DENYLIST_PATH, LEAK_GATE_OFF, LEAK_GATE_ON, OPS_DENYLIST_PATH, denylistFileContent,
} from "../src/leak-gate";

const REPO_SLUG = "acme-org/websites";

const FAKE_FLEET_JSON = JSON.stringify({
  blueprint: { repo: REPO_SLUG, ref: "main" }, roles: ["pilot", "scratch"], instance_type: "standard-2",
});
const FAKE_ORG_JSON = JSON.stringify({ edges: { cto: ["release"] }, gates: { merge: ["release"] } });

const FAKE_ROLE_PROMPT = "You are scratch. Sandbox role, low stakes.";
const FAKE_ROLE_MD = `---
name: scratch
skills: []
allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
${FAKE_ROLE_PROMPT}
`;

const FAKE_STUDIO_MD = `---
name: web-studio
title: Web Studio
lead: Web Designer
skills: [frontend-design]
secrets: []
mcp: []
allowedTools: Bash(git *) Read Edit Write
keep_alive: false
---
You are the Web Designer, lead of Web Studio. Dispatch members, never implement yourself.
`;
const FAKE_MEMBER_FRONTEND_MD = `---
name: frontend-developer
description: Implements frontend steps dispatched by the lead.
tools: Read, Edit, Write
---
You are the Frontend Developer. Implement exactly what's dispatched.
`;
const FAKE_MEMBER_QA_MD = `---
name: qa-engineer
description: Browser verification before PR.
tools: Read, Bash
---
You are the QA Engineer. Verify in browser before the lead opens a PR.
`;
const FAKE_MEMBERS_LISTING = JSON.stringify([
  { name: "frontend-developer.md", path: "fleet/blueprint/studios/web-studio/members/frontend-developer.md", type: "file" },
  { name: "qa-engineer.md", path: "fleet/blueprint/studios/web-studio/members/qa-engineer.md", type: "file" },
]);

// Same "not found" shape github/api.ts's real fetchRepoFile throws — see
// provision.ts's isNotFoundError, which greps for this exact "(404)"
// substring.
function notFound(path: string, ref: string): Error {
  return new Error(`fetch ${path}@${ref} failed (404): Not Found`);
}

// One Map behind both keys — same shape test/studio.routes.test.ts's own
// fakeStorage() uses (StudioStorage's `get` is a keyed-overload pair, so a
// single non-overloaded implementation needs the cast; `put` does not).
function fakeStorage(): StudioStorage {
  // `| boolean` covers KEEP_ALIVE_KEY — provisionWithStorage always writes
  // it alongside ROLE_ENV_KEY on a successful resolve, studio or role path
  // alike.
  const map = new Map<string, StudioStatus | RoleEnv | StudioEnv | boolean | HealAttempt | OperationInFlight | string | number | null>();
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: async (key: string, value: StudioStatus | RoleEnv | StudioEnv | boolean | HealAttempt | OperationInFlight | string | number | null) => {
      map.set(key, value);
    },
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("provisionWithStorage — studio-first resolution (P4a-1 T7)", () => {
  it("(a) studio dir present: fetches studio.md, lists+fetches+validates members/, persists a StudioEnv with STUDIO_MEMBERS_B64 carrying both members and BLUEPRINT_REPO set", async () => {
    const bringupEnvCalls: (Record<string, string> | undefined)[] = [];
    const sbExecFake = vi.fn(async (cmd: string, execEnv?: Record<string, string>) => {
      if (cmd === BRINGUP_CMD) bringupEnvCalls.push(execEnv);
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return FAKE_MEMBERS_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/frontend-developer.md") return FAKE_MEMBER_FRONTEND_MD;
      if (path === "fleet/blueprint/studios/web-studio/members/qa-engineer.md") return FAKE_MEMBER_QA_MD;
      throw notFound(path, ref);
    });
    const storage = fakeStorage();
    const deps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    const status = await provisionWithStorage(
      deps, storage, { repo: "websites", role: "web-studio" }, REPO_SLUG,
    );

    expect(status.state).toBe("running");
    const stored = (await storage.get(ROLE_ENV_KEY)) as StudioEnv;
    expect(stored.STUDIO_NAME).toBe("web-studio");
    expect(stored.BLUEPRINT_REPO).toBe(REPO_SLUG);
    // Issue #11: bring-up refreshes /opt/blueprint to this ref every time.
    expect(stored.BLUEPRINT_REF).toBe("main");
    expect(stored.ROLE_ALLOWED_TOOLS).toBe("Bash(git *) Read Edit Write");

    const bundle = JSON.parse(atob(stored.STUDIO_MEMBERS_B64)) as Record<string, string>;
    expect(Object.keys(bundle).sort()).toEqual(["frontend-developer.md", "qa-engineer.md"]);
    expect(atob(bundle["frontend-developer.md"])).toBe(FAKE_MEMBER_FRONTEND_MD);
    expect(atob(bundle["qa-engineer.md"])).toBe(FAKE_MEMBER_QA_MD);

    // The exact record persisted is the exact record handed to bring-up.
    expect(bringupEnvCalls).toHaveLength(1);
    expect(bringupEnvCalls[0]).toEqual(stored);
  });

  it("(a1) issue #11: an explicit blueprintRef reaches bring-up as BLUEPRINT_REF, over fleet.json's ref", async () => {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return FAKE_MEMBERS_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/frontend-developer.md") return FAKE_MEMBER_FRONTEND_MD;
      if (path === "fleet/blueprint/studios/web-studio/members/qa-engineer.md") return FAKE_MEMBER_QA_MD;
      throw notFound(path, ref);
    });
    const storage = fakeStorage();
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    await provisionWithStorage(
      deps, storage, { repo: "websites", role: "web-studio", blueprintRef: "pinned-branch" }, REPO_SLUG,
    );

    const stored = (await storage.get(ROLE_ENV_KEY)) as StudioEnv;
    expect(stored.BLUEPRINT_REF).toBe("pinned-branch");
  });

  it("(a2) studio with no members/ dir at all (maestro's real shape, Task 6): resolves solo, STUDIO_MEMBERS_B64 carries an empty bundle rather than failing", async () => {
    const FAKE_MAESTRO_MD = `---
name: maestro
title: Maestro Studio
lead: Maestro
skills: []
secrets: []
mcp: []
allowedTools: Bash(fleet *) Read
keep_alive: true
---
You are the Maestro. Solo. No members, nothing to dispatch.
`;
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/maestro/studio.md") return FAKE_MAESTRO_MD;
      // members/ itself 404s — no such dir on disk (Task 6's own report).
      throw notFound(path, ref);
    });
    const storage = fakeStorage();
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    const status = await provisionWithStorage(deps, storage, { repo: "websites", role: "maestro" }, REPO_SLUG);

    expect(status.state).toBe("running");
    const stored = (await storage.get(ROLE_ENV_KEY)) as StudioEnv;
    expect(stored.STUDIO_NAME).toBe("maestro");
    expect(JSON.parse(atob(stored.STUDIO_MEMBERS_B64))).toEqual({});
  });

  it("(b) studio absent: falls back to the existing role path, producing today's exact RoleEnv triple (regression guard)", async () => {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      // Covers the fleet/blueprint/studios/scratch/studio.md probe.
      throw notFound(path, ref);
    });
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const storage = fakeStorage();
    const deps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    const status = await provisionWithStorage(deps, storage, { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("running");
    const stored = await storage.get(ROLE_ENV_KEY);
    // Exactly the pre-Task-7 triple — no STUDIO_* key leaked in, nothing missing.
    expect(Object.keys(stored ?? {}).sort()).toEqual(["ROLE_ALLOWED_TOOLS", "ROLE_EFFORT", "ROLE_PROMPT_B64"]);
    expect(stored).toEqual({
      ROLE_PROMPT_B64: base64EncodeUtf8(appendHouseRules(FAKE_ROLE_PROMPT)),
      ROLE_ALLOWED_TOOLS: "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write",
      ROLE_EFFORT: "",
    });
  });

  it("(c) member file failing validation: provisionWithStorage degrades (never throws/500s), and nothing is persisted under ROLE_ENV_KEY", async () => {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") {
        return JSON.stringify([
          { name: "broken-member.md", path: "fleet/blueprint/studios/web-studio/members/broken-member.md", type: "file" },
        ]);
      }
      // Missing the required "description" field -> validateMemberFile throws.
      if (path === "fleet/blueprint/studios/web-studio/members/broken-member.md") {
        return "---\nname: broken-member\n---\nNo description field here.\n";
      }
      throw notFound(path, ref);
    });
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const storage = fakeStorage();
    const deps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    const status = await provisionWithStorage(deps, storage, { repo: "websites", role: "web-studio" }, REPO_SLUG);

    expect(status.state).toBe("degraded");
    expect(status.error).toContain("description");
    expect(await storage.get(ROLE_ENV_KEY)).toBeUndefined();
    expect(sbExecFake).not.toHaveBeenCalled(); // never reached clone/bring-up
  });
});

describe("resolveBringupEnv — throws directly on a member validation failure (P4a-1 T7)", () => {
  it("a member file that fails validateMemberFile rejects with BlueprintError — not swallowed into a role-fallback attempt", async () => {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") {
        return JSON.stringify([
          { name: "broken-member.md", path: "fleet/blueprint/studios/web-studio/members/broken-member.md", type: "file" },
        ]);
      }
      if (path === "fleet/blueprint/studios/web-studio/members/broken-member.md") {
        return "---\nname: broken-member\n---\nNo description field here.\n";
      }
      throw notFound(path, ref);
    });
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    await expect(
      resolveBringupEnv(deps, { repo: "websites", role: "web-studio" }, REPO_SLUG, REPO_SLUG),
    ).rejects.toThrow(BlueprintError);
  });

  // Fix wave (T7 deferred, promoted to blocking): tryFetchStudio used to
  // catch EVERY fetch error, so a network blip against a REAL studio fell
  // through to the role path and surfaced as "role not declared in
  // fleet.json" — the wrong diagnosis, and now the COMMON one (fleet.json
  // declares all three studios as of this same fix wave).
  it("a NON-404 studio.md fetch failure propagates as itself — never mistaken for 'not a studio' and re-routed to the role path", async () => {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, _ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") throw new Error("network unreachable");
      throw new Error(`unexpected fetch: ${path}`);
    });
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    await expect(
      resolveBringupEnv(deps, { repo: "websites", role: "web-studio" }, REPO_SLUG, REPO_SLUG),
    ).rejects.toThrow("network unreachable");
    // The role path was never attempted — no roles/web-studio.md fetch.
    expect(fetchBlueprintFile.mock.calls.map((c) => c[1])).not.toContain(
      "fleet/blueprint/roles/web-studio.md",
    );
  });

  // The 404 half of the same fork, kept explicit alongside it: a genuinely
  // absent studio.md still means "resolve as a role", exactly as before.
  it("a 404 on studio.md still returns null and falls through to the role path", async () => {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw notFound(path, ref);
    });
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile,
    };

    const { bringupEnv } = await resolveBringupEnv(deps, { repo: "websites", role: "scratch" }, REPO_SLUG, REPO_SLUG);
    expect(Object.keys(bringupEnv).sort()).toEqual(["ROLE_ALLOWED_TOOLS", "ROLE_EFFORT", "ROLE_PROMPT_B64"]);
  });
});

// Fleet board task #118 — the adopted-task fix: resolveBringupEnv resolves
// `briefPrompt` from the board itself (via deps.resolveAssignedBrief) whenever
// a caller supplied none, which is exactly recycle's and a bodyless
// re-provision's shape. Same fixtures (FAKE_FLEET_JSON/FAKE_ROLE_MD) and same
// fetchBlueprintFile-fake convention as the describe blocks above.
function decodePrompt(e: RoleEnv | StudioEnv): string {
  return new TextDecoder().decode(Uint8Array.from(atob(e.ROLE_PROMPT_B64), (c) => c.charCodeAt(0)));
}

describe("resolveBringupEnv — adopted-task brief delivery via deps.resolveAssignedBrief (board task #118)", () => {
  function roleFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw notFound(path, ref);
    });
  }

  it("adopted-task-then-recycle: an unset cfg.briefPrompt falls back to the board-resolved brief", async () => {
    const CANNED_BRIEF = "## Your task — board issue #42\n\nShip the hero.";
    const resolveAssignedBrief = vi.fn(async () => CANNED_BRIEF);
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile: roleFetch(),
      resolveAssignedBrief,
    };
    // A recycle's own workRepoSlug — deliberately NOT REPO_SLUG (the fleet
    // repo passed as the 3rd argument), so the assertion below also proves
    // the RIGHT slug (the work repo, not the fleet repo) reached the board.
    const WORK_REPO_SLUG = "acme-org/beta";

    const { bringupEnv } = await resolveBringupEnv(
      deps, { repo: "websites", role: "scratch" }, REPO_SLUG, WORK_REPO_SLUG,
    );

    expect(decodePrompt(bringupEnv)).toContain(CANNED_BRIEF);
    expect(resolveAssignedBrief).toHaveBeenCalledWith("websites--scratch", WORK_REPO_SLUG);
  });

  it("no-assigned-task: deps.resolveAssignedBrief resolving undefined collapses to today's exact no-brief RoleEnv triple", async () => {
    const resolveAssignedBrief = vi.fn(async () => undefined);
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile: roleFetch(),
      resolveAssignedBrief,
    };

    const { bringupEnv } = await resolveBringupEnv(deps, { repo: "websites", role: "scratch" }, REPO_SLUG, REPO_SLUG);

    // The new port was actually consulted — proves this isn't just the
    // pre-existing "no deps.resolveAssignedBrief at all" path collapsing by
    // construction, but the NEW `cfg.briefPrompt ?? await
    // deps.resolveAssignedBrief?.(...)` fallback itself resolving to nothing.
    expect(resolveAssignedBrief).toHaveBeenCalledWith("websites--scratch", REPO_SLUG);
    // Byte-identical to test (b) above ("falls back to the existing role
    // path, producing today's exact RoleEnv triple") — the exact same
    // assertion, not a weaker or duplicated one, proving the new code path
    // collapses to the unchanged old behavior.
    expect(bringupEnv).toEqual({
      ROLE_PROMPT_B64: base64EncodeUtf8(appendHouseRules(FAKE_ROLE_PROMPT)),
      ROLE_ALLOWED_TOOLS: "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write",
      ROLE_EFFORT: "",
    });
  });

  it("caller-supplied cfg.briefPrompt short-circuits: deps.resolveAssignedBrief is never called (spawn/operator-provision paths untouched)", async () => {
    const CALLER_BRIEF = "## Your task — board issue #7\n\nWire the checkout.";
    const resolveAssignedBrief = vi.fn();
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-08-19T00:00:00.000Z",
      fetchBlueprintFile: roleFetch(),
      resolveAssignedBrief,
    };

    const { bringupEnv } = await resolveBringupEnv(
      deps, { repo: "websites", role: "scratch", briefPrompt: CALLER_BRIEF }, REPO_SLUG, REPO_SLUG,
    );

    expect(resolveAssignedBrief).not.toHaveBeenCalled();
    expect(decodePrompt(bringupEnv)).toContain(CALLER_BRIEF);
  });
});

// Dynamic repo selection (P4a): the WORK repo (what gets cloned) and the
// FLEET repo (where fleet.json lives, and the default work repo) are two
// different things. These pin that they never move together — the whole
// point of the split is that a studio can clone `acme-org/beta` while the
// blueprint keeps coming from the fleet's own repo.
describe("runProvision — work repo vs fleet repo (dynamic repo selection)", () => {
  function fakeDeps(cmds: string[], fetchBlueprintFile: ProvisionDeps["fetchBlueprintFile"]): ProvisionDeps {
    return {
      sbExec: vi.fn(async (cmd: string) => {
        cmds.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-08-25T00:00:00.000Z",
      fetchBlueprintFile,
    };
  }

  function blueprintFetch(seen: string[]): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (repo: string, path: string) => {
      seen.push(`${repo}:${path}`);
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      if (path.startsWith("fleet/blueprint/studios/")) throw notFound(path, "main");
      return FAKE_ROLE_MD;
    });
  }

  it("clones cfg.repoSlug, while fleet.json is still read from the FLEET repo", async () => {
    const cmds: string[] = [];
    const seen: string[] = [];
    const status = await provisionWithStorage(
      fakeDeps(cmds, blueprintFetch(seen)), fakeStorage(),
      { repo: "beta", role: "scratch", repoSlug: "acme-org/beta" }, REPO_SLUG,
    );
    expect(status.state).toBe("running");
    expect(cmds[0]).toContain("https://github.com/acme-org/beta.git");
    expect(cmds[0]).toContain("/workspace/beta");
    expect(seen).toContain(`${REPO_SLUG}:fleet.json`);
    expect(seen.some((s) => s.startsWith("acme-org/beta:"))).toBe(false);
  });

  // #341: the memory store (FLEET_OPS_REPO) is its own, usually private, repo;
  // the Worker clones it for the lead at /opt/memory, token in the exec ENV.
  it("memory store set: provision clones it at /opt/memory, token only in the exec env", async () => {
    const calls: { cmd: string; env?: Record<string, string> }[] = [];
    const deps: ProvisionDeps = {
      ...fakeDeps([], blueprintFetch([])),
      sbExec: vi.fn(async (cmd: string, env?: Record<string, string>) => {
        calls.push({ cmd, env });
        return { code: 0, stdout: "", stderr: "" };
      }),
      memoryRepo: "o/fleet-memory",
      memoryToken: async () => "fake-installation-token",
    };
    await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
    const clone = calls.find((c) => c.cmd === memoryCloneCmd("o/fleet-memory"));
    expect(clone).toBeDefined();
    expect(clone!.env).toEqual({ [MEMORY_TOKEN_ENV]: "fake-installation-token" });
    expect(calls.some((c) => c.cmd.includes("fake-installation-token"))).toBe(false);
  });

  // #341: the memory INDEX (distinct from the file clone above) is read from
  // the store's own default branch — MEMORY_REF's real consumer. Hardcodes
  // the literal "HEAD" (not the MEMORY_REF import) so a drift in either the
  // constant or resolveMemoryIndex's own wiring to it is caught.
  it("memory store set: the index is fetched at the store's default branch (HEAD)", async () => {
    const refs: string[] = [];
    const base = blueprintFetch([]);
    const fetchBlueprintFile: ProvisionDeps["fetchBlueprintFile"] = vi.fn(async (repo, path, ref) => {
      if (path === MEMORY_INDEX_PATH) {
        refs.push(ref);
        throw notFound(path, ref);
      }
      return base(repo, path, ref);
    });
    const deps: ProvisionDeps = { ...fakeDeps([], fetchBlueprintFile), memoryRepo: "o/fleet-memory" };
    await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
    expect(refs).toEqual(["HEAD"]);
  });

  it("memory store unset: no memory clone at all", async () => {
    const cmds: string[] = [];
    await provisionWithStorage(fakeDeps(cmds, blueprintFetch([])), fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
    expect(cmds.some((c) => c.includes("/opt/memory"))).toBe(false);
  });

  it("records the resolved work repo on the status, so `fleet ls` and the claim check can read it back", async () => {
    const status = await provisionWithStorage(
      fakeDeps([], blueprintFetch([])), fakeStorage(),
      { repo: "beta", role: "scratch", repoSlug: "acme-org/beta" }, REPO_SLUG,
    );
    expect(status.repoSlug).toBe("acme-org/beta");
  });

  it("with no cfg.repoSlug, falls back to the fleet repo — the existing websites studios, byte for byte", async () => {
    const cmds: string[] = [];
    await provisionWithStorage(
      fakeDeps(cmds, blueprintFetch([])), fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG,
    );
    expect(cmds[0]).toBe(
      `test -d /workspace/websites/.git || git clone --depth 1 https://github.com/${REPO_SLUG}.git /workspace/websites`,
    );
  });

  it("re-provisioning with no cfg.repoSlug reuses the slug already bound on the stored status (recycle's path)", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(
      fakeDeps([], blueprintFetch([])), storage,
      { repo: "beta", role: "scratch", repoSlug: "acme-org/beta" }, REPO_SLUG,
    );
    const cmds: string[] = [];
    const status = await provisionWithStorage(
      fakeDeps(cmds, blueprintFetch([])), storage, { repo: "beta", role: "scratch" }, REPO_SLUG,
    );
    expect(cmds[0]).toContain("https://github.com/acme-org/beta.git");
    expect(status.repoSlug).toBe("acme-org/beta");
  });
});

// Board issue #9 — rescue-branch discovery. guardedCloneCmd's `--depth 1`
// implies `--single-branch` (git's own documented default), so a fresh
// checkout knows about the default branch only. discoverRescueRefsCmd is
// the cheap, best-effort recovery aid: a pure ref-advertisement listing
// (never an object fetch) written to a file for ANY branch to be grepped,
// plus a small bounded fetch for the ones matching THIS studio's own
// deterministic `fleet/rescue/<studio>-` prefix (do.ts's rescuePushCmd —
// read-only context, not edited here).
describe("discoverRescueRefsCmd — the shell shape that discovers + fetches this studio's own rescue branches", () => {
  const DIR = "/workspace/websites";
  const STUDIO = "websites--pilot";

  // Regression (fresh-context review, board issue #9): the listing file must
  // live OUTSIDE the studio's own git checkout, one level above targetDir --
  // mirroring exactly where container/studio-bringup.sh writes its own
  // working-set.md (`${FLEET_WORKSPACE:-/workspace}/.fleet/working-set.md`,
  // never `${targetDir}/.fleet/...`). Writing it INSIDE the checkout (the
  // original bug) meant it existed from the very first provision onward with
  // no .gitignore anywhere in this repo to hide it, so do.ts's rescuePushCmd
  // — which decides "anything to rescue" via `git status --porcelain` and
  // then blindly `git add -A`s before committing -- would (a) never again see
  // a clean tree (permanently defeating the RESCUE_CLEAN fast path) and (b)
  // sweep this stray branch listing into every real rescue commit.
  it("lists remote heads (a ref-advertisement round trip, never an object fetch) and writes the full raw listing to a file OUTSIDE the studio's own git checkout, one level above targetDir", () => {
    const cmd = discoverRescueRefsCmd(DIR, STUDIO);
    expect(cmd).toContain(`mkdir -p /workspace/.fleet`);
    expect(cmd).toContain(`git -C ${DIR} ls-remote --heads origin`);
    expect(cmd).toContain(`/workspace/.fleet/remote-branches.txt`);
    // never inside the checkout -- would get swept into rescuePushCmd's own
    // `git add -A` (do.ts, read-only context) and pollute every rescue commit.
    expect(cmd).not.toContain(`${DIR}/.fleet/remote-branches.txt`);
    expect(cmd).not.toContain(`mkdir -p ${DIR}/.fleet`);
  });

  it("greps that same listing for THIS studio's deterministic fleet/rescue/<studio>- prefix — the exact prefix rescuePushCmd generates its ref names under", () => {
    const cmd = discoverRescueRefsCmd(DIR, STUDIO);
    expect(cmd).toContain(`refs/heads/fleet/rescue/${STUDIO}-`);
    expect(cmd).toContain("grep -o");
  });

  it("fetches every matching ref into a local branch of the same name, and prints a loud stderr line per branch found (studio-bringup:… fetched, not checked out)", () => {
    const cmd = discoverRescueRefsCmd(DIR, STUDIO);
    expect(cmd).toContain(`git -C ${DIR} fetch origin`);
    expect(cmd).toMatch(/fetch origin "\$ref:\$name"/);
    expect(cmd).toContain("studio-bringup: found rescued work from a prior incarnation of this studio on branch");
    expect(cmd).toContain("fetched (not checked out)");
    expect(cmd).toContain(">&2");
  });

  it("never fails hard — the whole command is guarded so any step's failure (no rescue branches, network blip, unwritable dir) degrades to a no-op exit 0", () => {
    const cmd = discoverRescueRefsCmd(DIR, STUDIO);
    // PR #312 round 3: the guard is an `|| echo ... >&2` (exit 0, and loud),
    // no longer a silent `|| true`. Real-shell exit 0 is proven in
    // test/bun/rescue-push.test.ts against an unwritable list path.
    expect(cmd.trim()).toMatch(/\} \|\| echo "studio-bringup: rescue discovery skipped[^"]*" >&2$/);
  });

  it("never calls `exit`, never bare `cd`s — same shared-session discipline every other command builder in this feature follows", () => {
    // Issue #30: the private-remote shape too.
    for (const cmd of [
      discoverRescueRefsCmd(DIR, STUDIO),
      discoverRescueRefsCmd(DIR, STUDIO, undefined, { remoteUrl: "https://github.com/example-org/rescue-vault.git" }),
    ]) {
      expect(cmd).not.toMatch(/(^|[;&|(\s])exit\b/);
      expect(cmd).not.toMatch(/(^|[;&|(\s])cd\b/);
    }
  });

  // Issue #30: `{}` (private work repo, remote unset) = origin-only, byte-identical.
  it("an empty rescue target yields exactly the origin-only command", () => {
    expect(discoverRescueRefsCmd(DIR, STUDIO, undefined, {})).toBe(discoverRescueRefsCmd(DIR, STUDIO));
  });

  it("scopes the studio id into the grep pattern — a DIFFERENT studio's own rescue prefix is never matched", () => {
    const cmd = discoverRescueRefsCmd(DIR, "websites--other");
    expect(cmd).not.toContain(`fleet/rescue/${STUDIO}-`);
    expect(cmd).toContain("fleet/rescue/websites--other-");
  });

  // Regression (fresh-context review, board issue #9): `[^[:space:]]*` after
  // the prefix is an UNANCHORED substring match -- it matches anything
  // non-whitespace, with no requirement that what follows even look like the
  // timestamp do.ts's rescuePushCmd actually generates
  // (`fleet/rescue/<studio>-$(date -u +%Y%m%d%H%M%S)`, exactly 14 digits,
  // nothing after). A studio id that is a literal hyphen-extended PREFIX of a
  // different studio's id -- e.g. "websites--maestro" vs
  // "websites--maestro-2" -- would wrongly match and fetch the LONGER
  // studio's own rescue branch as if it were the shorter studio's. The fix
  // anchors the match to exactly 14 digits followed by end-of-line, so it
  // matches only `<this studio's own prefix><14 digits><nothing else>`.
  it("anchors the rescue-ref match to the exact 14-digit UTC timestamp shape rescuePushCmd generates, so a studio id that is a hyphen-extended prefix of a DIFFERENT studio's id never matches that other studio's own rescue ref", () => {
    const shortStudio = "websites--maestro";
    const longStudio = "websites--maestro-2";
    const cmd = discoverRescueRefsCmd(DIR, shortStudio);

    const grepMatch = cmd.match(/grep -o[E]? '([^']+)'/);
    expect(grepMatch).not.toBeNull();
    // Translate the shell pattern embedded in the real generated command
    // into an equivalent JS RegExp -- BRE `\{14\}` / ERE `{14}` -> JS
    // `{14}`, POSIX `[^[:space:]]` -> JS `[^\s]`; every other character
    // (anchors, literals) is already valid JS regex syntax.
    const jsSource = grepMatch![1]
      .replace(/\\\{(\d+)\\\}/g, "{$1}")
      .replace(/\[\^\[:space:\]\]/g, "[^\\s]");
    const re = new RegExp(jsSource);

    // the exact ref shapes rescuePushCmd (do.ts) would generate for each
    // studio, as they'd appear (ref-name only) in `git ls-remote --heads
    // origin`'s real output.
    const ownRef = `refs/heads/fleet/rescue/${shortStudio}-20260918120000`;
    const otherStudioRef = `refs/heads/fleet/rescue/${longStudio}-20260918120000`;

    expect(re.test(ownRef)).toBe(true);
    expect(re.test(otherStudioRef)).toBe(false);
  });

  // PR #263 round 4 (#251 review), Finding 2: rescue.ts's round 3 N1/N2 push
  // a SECOND ref shape under this same studio-scoped tree —
  // `fleet/rescue/<studio>/<ts>/checkout/<branch-or-stash-name>` — for a
  // local branch not checked out anywhere at teardown, or a stash entry.
  // Before this fix, neither ever matched the flat-anchored regex above (it
  // requires `-` immediately after `<studio>`, then exactly 14 digits and
  // end-of-line; the nested shape has `/` there, then more path after the
  // digits), so an N1/N2 rescue sat on origin invisible to the auto-fetch
  // every OTHER rescue shape already gets.
  it("also greps the nested fleet/rescue/<studio>/<ts>/checkout/<name> shape rescue.ts's N1/N2 push to, alongside the flat one", () => {
    const cmd = discoverRescueRefsCmd(DIR, STUDIO);
    expect(cmd).toContain(`refs/heads/fleet/rescue/${STUDIO}/`);
    expect(cmd).toContain(`refs/heads/fleet/rescue/${STUDIO}-`);
  });

  it("fetches a nested N1 (branch) or N2 (stash) rescue ref exactly like a flat one, and never a longer studio's own nested ref", () => {
    const shortStudio = "websites--maestro";
    const longStudio = "websites--maestro-2";
    const cmd = discoverRescueRefsCmd(DIR, shortStudio);

    const grepMatch = cmd.match(/grep -o[E]? '([^']+)'/);
    expect(grepMatch).not.toBeNull();
    const jsSource = grepMatch![1]
      .replace(/\\\{(\d+)\\\}/g, "{$1}")
      .replace(/\[\^\[:space:\]\]/g, "[^\\s]");
    const re = new RegExp(jsSource);

    const nestedBranchRef = `refs/heads/fleet/rescue/${shortStudio}/20260925120000/checkout/feat`;
    const nestedStashRef = `refs/heads/fleet/rescue/${shortStudio}/20260925120000/checkout/stash-0`;
    const otherStudioNestedRef = `refs/heads/fleet/rescue/${longStudio}/20260925120000/checkout/feat`;
    const flatRef = `refs/heads/fleet/rescue/${shortStudio}-20260925120000`;

    expect(re.test(nestedBranchRef)).toBe(true);
    expect(re.test(nestedStashRef)).toBe(true);
    expect(re.test(otherStudioNestedRef)).toBe(false);
    expect(re.test(flatRef)).toBe(true);
  });

  // Issue #266 (follow-up on #251/#263): a member worktree's own rescue ref
  // (rescue.ts's rescue_target(), the non-"checkout" branch) used to be flat
  // too — `fleet/rescue/<studio>-<worktree-id>-<timestamp>` — which never
  // matched the flat pattern above (it requires exactly 14 digits right after
  // `<studio>-`, and a member ref has extra `<worktree-id>-` characters
  // there) NOR the nested `checkout/...` pattern (it has no `checkout/`
  // segment). That ref sat on origin forever, invisible to this exact
  // auto-fetch — the same silent-loss class Finding 2 (round 4) already
  // closed for N1/N2, just for this flat member-worktree shape instead.
  // Fixed by giving the worktree id its own path segment: `fleet/rescue/
  // <studio>/wt/<worktree-id>-<timestamp>`.
  it("also greps the nested fleet/rescue/<studio>/wt/<worktree-id>-<ts> shape rescue.ts's rescue_target() generates for a member worktree, alongside the flat and checkout/ shapes", () => {
    const cmd = discoverRescueRefsCmd(DIR, STUDIO);
    expect(cmd).toContain(`refs/heads/fleet/rescue/${STUDIO}/wt/`);
  });

  it("fetches a member-worktree wt/ rescue ref exactly like the flat/nested shapes, and never a longer studio's own wt/ ref", () => {
    const shortStudio = "websites--maestro";
    const longStudio = "websites--maestro-2";
    const cmd = discoverRescueRefsCmd(DIR, shortStudio);

    const grepMatch = cmd.match(/grep -o[E]? '([^']+)'/);
    expect(grepMatch).not.toBeNull();
    const jsSource = grepMatch![1]
      .replace(/\\\{(\d+)\\\}/g, "{$1}")
      .replace(/\[\^\[:space:\]\]/g, "[^\\s]");
    const re = new RegExp(jsSource);

    // The exact shape rescue.ts's rescue_target() generates for a member
    // worktree — git's own admin-dir id (which can itself contain dashes,
    // e.g. "agent-a1b2" or a duplicate-basename "agent-dup1"), a `-`, then
    // the 14-digit timestamp. Still matched by the SAME pattern's other
    // alternative when it's the sibling checkout/ nested shape instead —
    // both live under the same studio-scoped tree, and neither the flat nor
    // checkout/ discovery this file's own suite already covers should
    // regress from adding this third alternative.
    const ownWtRef = `refs/heads/fleet/rescue/${shortStudio}/wt/agent-a1b2-20260925120000`;
    const otherStudioWtRef = `refs/heads/fleet/rescue/${longStudio}/wt/agent-a1b2-20260925120000`;

    expect(re.test(ownWtRef)).toBe(true);
    expect(re.test(otherStudioWtRef)).toBe(false);
  });
});

describe("runProvision wiring — rescue-branch discovery runs after the clone, best-effort", () => {
  function dispatchingDeps(cmds: string[], onCmd?: (cmd: string) => { code: number; stdout: string; stderr: string } | undefined | void) {
    const sbExec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      const forced = onCmd?.(cmd);
      if (forced) return forced;
      return { code: 0, stdout: "", stderr: "" };
    });
    const deps: ProvisionDeps = {
      sbExec,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-18T00:00:00.000Z",
      fetchBlueprintFile: vi.fn(async (_repo: string, path: string) => {
        if (path === "fleet.json") return FAKE_FLEET_JSON;
        if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
        if (path.startsWith("fleet/blueprint/studios/")) throw notFound(path, "main");
        return FAKE_ROLE_MD;
      }),
    };
    return deps;
  }

  it("issues discoverRescueRefsCmd right after the clone succeeds, before bring-up", async () => {
    const cmds: string[] = [];
    const status = await provisionWithStorage(
      dispatchingDeps(cmds), fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG,
    );
    expect(status.state).toBe("running");
    const cloneIdx = cmds.findIndex((c) => c.includes("git clone --depth 1"));
    const discoverIdx = cmds.findIndex((c) => c.includes("ls-remote --heads origin"));
    const bringupIdx = cmds.findIndex((c) => c === BRINGUP_CMD);
    expect(cloneIdx).toBeGreaterThanOrEqual(0);
    expect(discoverIdx).toBeGreaterThan(cloneIdx);
    expect(bringupIdx).toBeGreaterThan(discoverIdx);
    expect(cmds[discoverIdx]).toBe(discoverRescueRefsCmd("/workspace/websites", "websites--scratch"));
  });

  // Same "best-effort, never degrades provisioning" contract runSessionRestore
  // already has (own try/catch, logged, proceeds) — mirrored here for the
  // rescue-discovery step's own, separate try/catch.
  it("a thrown failure in the rescue-discovery step does not degrade provisioning — clone and bring-up still succeed, status still lands 'running'", async () => {
    const cmds: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = dispatchingDeps(cmds, (cmd) => {
        if (cmd.includes("ls-remote --heads origin")) throw new Error("sandbox disconnected");
        return undefined;
      });
      const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
      expect(status.state).toBe("running");
      expect(status.error).toBeNull();
      expect(cmds.some((c) => c === BRINGUP_CMD)).toBe(true); // bring-up still ran
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  // Issue #30: discovery lists the SAME remote rescue pushes to. The target
  // comes from deps.rescueTarget (do.ts: resolveRescueTarget); its token
  // rides the discovery exec's env, never the command text.
  it("with deps.rescueTarget set, discovery also reads the private rescue remote; the token rides exec env only", async () => {
    const calls: { cmd: string; env?: Record<string, string> }[] = [];
    const deps = dispatchingDeps([]);
    deps.sbExec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      return { code: 0, stdout: "", stderr: "" };
    });
    const remoteUrl = "https://github.com/example-org/rescue-vault.git";
    const askedFor: string[] = [];
    deps.rescueTarget = async (workRepo: string) => {
      askedFor.push(workRepo);
      return { remoteUrl, env: { FLEET_RESCUE_TOKEN: "fake-token-value" } };
    };

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("running");
    // The visibility decision is about THIS provision's work repo.
    expect(askedFor).toEqual([REPO_SLUG]);
    const discover = calls.find((c) => c.cmd.includes("ls-remote --heads origin"));
    expect(discover).toBeDefined();
    expect(discover!.cmd).toBe(discoverRescueRefsCmd("/workspace/websites", "websites--scratch", undefined, { remoteUrl }));
    expect(discover!.cmd).not.toContain("fake-token-value");
    expect(discover!.env).toEqual({ FLEET_RESCUE_TOKEN: "fake-token-value" });
  });

  // PR #42 review: rescue and discovery must share ONE decision. StudioDO
  // cannot be constructed here (see studio.backup-guard.test.ts's #94 block),
  // so the wiring is source-pinned: one resolveRescueTarget call site, and
  // both ports route through it. Repointing either one fails this test.
  it("do.ts: rescue (syncDeps) and discovery (deps) both route through the one rescueTarget decision", () => {
    const src: string = (env as unknown as { TEST_STUDIO_DO_SRC: string }).TEST_STUDIO_DO_SRC;
    const body = (sig: string) => {
      const start = src.indexOf(sig);
      expect(start).toBeGreaterThan(-1);
      return src.slice(start, src.indexOf("\n  }", start));
    };
    expect(src.split("resolveRescueTarget(").length - 1).toBe(1);
    expect(body("  private rescueTarget(")).toContain("resolveRescueTarget(");
    expect(body("  private deps(): ProvisionDeps {"))
      .toContain(`rescueTarget: (slug: string) => this.rescueTarget(async () => slug, "discovery"),`);
    expect(body("  private syncDeps("))
      .toContain("rescueTarget: () => this.rescueTarget(() => this.workRepoSlug(null)),");
  });

  it("a stalled-origin skip line on discovery's stderr is logged by the Worker too", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const skipped = "studio-bringup: rescue discovery skipped (could not list origin's branches into /workspace/.fleet/remote-branches.txt)";
      const deps = dispatchingDeps([], (cmd) =>
        cmd.includes("ls-remote --heads origin") ? { code: 0, stdout: "", stderr: skipped } : undefined);
      const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
      expect(status.state).toBe("running");
      expect(errSpy.mock.calls.some((args) => args.join(" ").includes(skipped))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("deps.rescueTarget throwing falls back to origin-only discovery; provisioning still lands 'running'", async () => {
    const cmds: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = dispatchingDeps(cmds);
      deps.rescueTarget = async () => { throw new Error("mint failed"); };
      const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
      expect(status.state).toBe("running");
      expect(cmds).toContain(discoverRescueRefsCmd("/workspace/websites", "websites--scratch"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a private-remote WARNING on discovery's stderr is logged by the Worker, not only buried in the container", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const warning = "studio-bringup: WARNING: rescue discovery could not list the private rescue remote -- rescued work there NOT fetched; origin results kept";
      const deps = dispatchingDeps([], (cmd) =>
        cmd.includes("ls-remote --heads origin") ? { code: 0, stdout: "", stderr: warning } : undefined);
      deps.rescueTarget = async () => ({ remoteUrl: "https://github.com/example-org/rescue-vault.git" });
      const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
      expect(status.state).toBe("running");
      expect(errSpy.mock.calls.some((args) => args.join(" ").includes(warning))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a non-zero exit code from the rescue-discovery step (not a throw) also does not degrade provisioning", async () => {
    const cmds: string[] = [];
    const deps = dispatchingDeps(cmds, (cmd) => {
      if (cmd.includes("ls-remote --heads origin")) return { code: 1, stdout: "", stderr: "network unreachable" };
      return undefined;
    });
    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);
    expect(status.state).toBe("running");
    expect(status.error).toBeNull();
  });
});

// P6a: the SAME rule now answers two questions — which repo a studio clones,
// and which owner's credential StudioDO writes into its container before that
// clone (do.ts's workRepoSlug -> refreshDeps -> mintRepoToken). They are one
// function precisely so they cannot disagree: a container handed the org's
// installation token while cloning a personal repo fails at the clone, and the
// error names nothing useful.
describe("resolveWorkRepoSlug — one rule, credential and checkout alike", () => {
  const FLEET = "acme-org/websites";
  const bound = (repoSlug: string | null): StudioStatus => ({
    id: "beta--scratch", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null,
    spawnTokenHash: null, repoSlug,
  });

  it("prefers the cfg's repo — a FIRST provision into a new repo, where storage knows nothing yet", () => {
    expect(resolveWorkRepoSlug({ repo: "sample", role: "scratch", repoSlug: "acme-org/sample" }, null, FLEET))
      .toBe("acme-org/sample");
  });

  it("falls back to the slug already bound — restart, refresh and recycle carry no cfg at all", () => {
    expect(resolveWorkRepoSlug(null, bound("acme-org/sample"), FLEET)).toBe("acme-org/sample");
  });

  it("falls back to the fleet repo last — every pre-P4a websites studio, unchanged", () => {
    expect(resolveWorkRepoSlug(null, bound(null), FLEET)).toBe(FLEET);
    expect(resolveWorkRepoSlug(null, null, FLEET)).toBe(FLEET);
  });
});

// Board task #149 — blueprint credential scope. do.ts's credentialWriteCmd/
// RefreshDeps/refreshDeps()/refreshWithStorage write exactly ONE git
// credential into the container, scoped to the studio's WORK repo owner
// (mintRepoToken(env, workRepoSlug)). container/studio-bringup.sh's blueprint
// clone (:339-341) has no credential of its own — it relies entirely on
// that same one. For `websites--*` studios the work repo and the blueprint
// repo share an owner (`acme-org`), so it happens to work; for every
// other studio (e.g. `sample--*`, work repo `acme-org/sample`,
// blueprint repo `acme-org/websites`) the credential names the wrong
// owner and the clone fails silently (studio-bringup.sh's own
// `|| echo ... >&2`), leaving every declared skill unresolved.
// `writeBlueprintCredential` (ProvisionDeps) is the new, separate mint+write
// port that fixes it — see do.ts's blueprintCredentialWriteCmd for the
// actual mechanism.
describe("writeBlueprintCredential — the blueprint clone's own credential (board task #149)", () => {
  // A work repo whose owner differs from the blueprint repo (REPO_SLUG,
  // `acme-org/websites`, from FAKE_FLEET_JSON) — the exact asymmetry the
  // bug depends on, and the same `acme-org/sample` example
  // resolveWorkRepoSlug's own tests above already use.
  const STUDIO_WORK_CFG = { repo: "sample", role: "web-studio", repoSlug: "acme-org/sample" };

  function studioFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return FAKE_MEMBERS_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/frontend-developer.md") return FAKE_MEMBER_FRONTEND_MD;
      if (path === "fleet/blueprint/studios/web-studio/members/qa-engineer.md") return FAKE_MEMBER_QA_MD;
      throw notFound(path, ref);
    });
  }

  function roleFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw notFound(path, ref);
    });
  }

  it("studio path (provision): called with the resolved BLUEPRINT_REPO (not the work repo), BEFORE the work-repo clone exec", async () => {
    const order: string[] = [];
    const writeBlueprintCredential = vi.fn(async (blueprintRepo: string) => {
      order.push(`blueprint-credential:${blueprintRepo}`);
      return { ok: true as const };
    });
    const sbExecFake = vi.fn(async (cmd: string) => {
      order.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const deps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: studioFetch(),
      writeBlueprintCredential,
    };

    const status = await provisionWithStorage(deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(writeBlueprintCredential).toHaveBeenCalledTimes(1);
    // The BLUEPRINT repo (REPO_SLUG, from fleet.json) — not the work repo
    // ("acme-org/sample") and not a hardcoded string.
    expect(writeBlueprintCredential.mock.calls[0][0]).toBe(REPO_SLUG);

    const credIndex = order.indexOf(`blueprint-credential:${REPO_SLUG}`);
    const cloneIndex = order.findIndex((c) => c.includes("acme-org/sample"));
    expect(credIndex).toBeGreaterThanOrEqual(0);
    expect(cloneIndex).toBeGreaterThan(credIndex);
  });

  it("role path (provision): never called — a plain RoleEnv carries no BLUEPRINT_REPO, so no blueprint clone will ever run for it", async () => {
    const writeBlueprintCredential = vi.fn(async () => ({ ok: true as const }));
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: roleFetch(),
      writeBlueprintCredential,
    };

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(writeBlueprintCredential).not.toHaveBeenCalled();
  });

  it("restart: called again with the SAME BLUEPRINT_REPO read back from storage, when the persisted roleEnv is a studio shape", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: studioFetch(),
        writeBlueprintCredential: vi.fn(async () => ({ ok: true as const })),
      },
      storage, STUDIO_WORK_CFG, REPO_SLUG,
    );

    const writeBlueprintCredential = vi.fn(async (_blueprintRepo: string) => ({ ok: true as const }));
    const status = await restartWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
        writeBlueprintCredential,
      },
      storage, "sample--web-studio", "rafarc21/fleetflare",
    );

    expect(status.state).toBe("running");
    expect(writeBlueprintCredential).toHaveBeenCalledTimes(1);
    expect(writeBlueprintCredential.mock.calls[0][0]).toBe(REPO_SLUG);
  });

  it("restart: NOT called when the persisted roleEnv is a role shape", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: roleFetch(),
        writeBlueprintCredential: vi.fn(async () => ({ ok: true as const })),
      },
      storage, { repo: "websites", role: "scratch" }, REPO_SLUG,
    );

    const writeBlueprintCredential = vi.fn(async () => ({ ok: true as const }));
    const status = await restartWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
        writeBlueprintCredential,
      },
      storage, "websites--scratch", "rafarc21/fleetflare",
    );

    expect(status.state).toBe("running");
    expect(writeBlueprintCredential).not.toHaveBeenCalled();
  });

  it("failure tolerance: a failed mint/write never degrades the studio, and nothing throws", async () => {
    const writeBlueprintCredential = vi.fn(async () => ({ ok: false as const, error: "mint failed: 403" }));
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: studioFetch(),
      writeBlueprintCredential,
    };

    const status = await provisionWithStorage(deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running"); // NOT "degraded" — same tolerance as a failed blueprint clone
    expect(status.error).toBeNull();
    expect(writeBlueprintCredential).toHaveBeenCalledTimes(1);
  });

  it("absence is a no-op: a ProvisionDeps literal with no writeBlueprintCredential at all still provisions a studio successfully", async () => {
    // Proves the optional-field backward-compat claim for real, not just by
    // assertion: every OTHER test in this file (written before this task)
    // omits writeBlueprintCredential entirely and still compiles/passes
    // unchanged — this is simply the same shape, named explicitly.
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: studioFetch(),
    };

    const status = await provisionWithStorage(deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
  });

  it("absence is a no-op: a ProvisionDeps literal with no writeBlueprintCredential at all still restarts a studio successfully", async () => {
    // Same backward-compat proof as the provision-path test above, but for
    // restartWithStorage: both call the same shared maybeWriteBlueprintCredential
    // helper (provision.ts:1022-1030), so deps.writeBlueprintCredential?.(...)
    // must no-op safely on this path too. The persisted roleEnv must be a
    // studio shape (has BLUEPRINT_REPO) so that branch is actually reached,
    // not skipped the way the role-shape restart test above skips it.
    const storage = fakeStorage();
    await provisionWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: studioFetch(),
        writeBlueprintCredential: vi.fn(async () => ({ ok: true as const })),
      },
      storage, STUDIO_WORK_CFG, REPO_SLUG,
    );

    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
    };

    const status = await restartWithStorage(deps, storage, "sample--web-studio", "rafarc21/fleetflare");

    expect(status.state).toBe("running");
  });
});

// Board issue #253 — 2026-09-25 06:02Z: a bare `git push` from a worktree
// whose branch carried origin/main as its upstream landed 6 commits on main
// with no PR, no review, no CI. Unlike writeBlueprintCredential above, applyStudioGitSafety
// is NOT gated on BLUEPRINT_REPO — every provision and every restart gets
// its own git safety config, role studio or full studio alike.
describe("applyStudioGitSafety — provision-time git safety config + wrapper install (issue #253)", () => {
  const STUDIO_WORK_CFG = { repo: "sample", role: "web-studio", repoSlug: "acme-org/sample" };

  function studioFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return FAKE_MEMBERS_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/frontend-developer.md") return FAKE_MEMBER_FRONTEND_MD;
      if (path === "fleet/blueprint/studios/web-studio/members/qa-engineer.md") return FAKE_MEMBER_QA_MD;
      throw notFound(path, ref);
    });
  }

  function roleFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw notFound(path, ref);
    });
  }

  it("provision: called exactly once, on BOTH the role path and the studio path", async () => {
    const roleApply = vi.fn(async () => ({ ok: true as const }));
    await provisionWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: roleFetch(),
        applyStudioGitSafety: roleApply,
      },
      fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG,
    );
    expect(roleApply).toHaveBeenCalledTimes(1);

    const studioApply = vi.fn(async () => ({ ok: true as const }));
    const status = await provisionWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: studioFetch(),
        applyStudioGitSafety: studioApply,
      },
      fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG,
    );
    expect(status.state).toBe("running");
    expect(studioApply).toHaveBeenCalledTimes(1);
  });

  it("restart: called again — a rollout-replaced container's fresh filesystem carries none of this config either", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: studioFetch(),
        applyStudioGitSafety: vi.fn(async () => ({ ok: true as const })),
      },
      storage, STUDIO_WORK_CFG, REPO_SLUG,
    );

    const applyStudioGitSafety = vi.fn(async () => ({ ok: true as const }));
    const status = await restartWithStorage(
      {
        sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
        recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
        now: () => "2026-09-08T00:00:00.000Z",
        fetchBlueprintFile: vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); }),
        applyStudioGitSafety,
      },
      storage, "sample--web-studio", "rafarc21/fleetflare",
    );

    expect(status.state).toBe("running");
    expect(applyStudioGitSafety).toHaveBeenCalledTimes(1);
  });

  it("failure tolerance: a failed config/wrapper install never degrades the studio, and nothing throws", async () => {
    const applyStudioGitSafety = vi.fn(async () => ({ ok: false as const, error: "sbExec failed: 137" }));
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: studioFetch(),
      applyStudioGitSafety,
    };

    const status = await provisionWithStorage(deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running"); // NOT "degraded" — same tolerance as a failed blueprint credential
    expect(status.error).toBeNull();
    expect(applyStudioGitSafety).toHaveBeenCalledTimes(1);
  });

  it("absence is a no-op: a ProvisionDeps literal with no applyStudioGitSafety at all still provisions a studio successfully", async () => {
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-08T00:00:00.000Z",
      fetchBlueprintFile: studioFetch(),
    };

    const status = await provisionWithStorage(deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
  });
});

// Board issue #28 — the measured incident: a studio reported `state:
// "running", error: null` over a fresh container whose /workspace was empty
// and whose ~/.claude carried no skills/agents/hooks at all, because both the
// clone exec and the bring-up exec genuinely returned exit 0 SOMEWHERE, just
// not durably on the container these checks now re-verify against. The fix:
// a synchronous, on-disk re-check immediately after bring-up succeeds,
// BEFORE runProvision is allowed to report "running" — a failure throws into
// the SAME existing catch block that already degrades a clone/bring-up
// failure (provision.ts:1283), no new error-handling path.
describe("runProvision — post-bringup on-disk verification (board issue #28)", () => {
  function roleFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw notFound(path, ref);
    });
  }

  function studioFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return FAKE_MEMBERS_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/frontend-developer.md") return FAKE_MEMBER_FRONTEND_MD;
      if (path === "fleet/blueprint/studios/web-studio/members/qa-engineer.md") return FAKE_MEMBER_QA_MD;
      throw notFound(path, ref);
    });
  }

  // Every OTHER command (clone, rescue discovery, bring-up) returns success;
  // only the new clone-landed check is forced to fail — reproducing the
  // measured incident's own shape: bring-up's own exit code was 0.
  function dispatchingDeps(cmds: string[], fetchBlueprintFile: ProvisionDeps["fetchBlueprintFile"], onCmd: (cmd: string) => { code: number; stdout: string; stderr: string } | undefined) {
    const sbExec = vi.fn(async (cmd: string) => {
      cmds.push(cmd);
      const forced = onCmd(cmd);
      if (forced) return forced;
      return { code: 0, stdout: "", stderr: "" };
    });
    const deps: ProvisionDeps = {
      sbExec,
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-22T00:00:00.000Z",
      fetchBlueprintFile,
    };
    return deps;
  }

  it("clone dir missing after a clean bring-up exit: degrades with a distinct error, never reports running (the measured incident)", async () => {
    const cmds: string[] = [];
    const deps = dispatchingDeps(cmds, roleFetch(), (cmd) => {
      if (cmd === "test -d /workspace/websites/.git") return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("degraded");
    expect(status.error).toContain("/workspace/websites/.git is missing");
    expect(status.error).toContain("clone did not land on this container");
    // The verify check ran strictly after bring-up, not before it — this is
    // a POST-bring-up re-check, not a pre-condition on the clone itself.
    const bringupIdx = cmds.indexOf(BRINGUP_CMD);
    const verifyIdx = cmds.indexOf("test -d /workspace/websites/.git");
    expect(bringupIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeGreaterThan(bringupIdx);
  });

  it("studio path: ~/.claude/agents missing after a clean bring-up exit (and the clone landed fine): degrades with a distinct error naming studio materialization, never reports running", async () => {
    const cmds: string[] = [];
    const deps = dispatchingDeps(cmds, studioFetch(), (cmd) => {
      if (cmd === 'test -d "$HOME/.claude/agents"') return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "web-studio" }, REPO_SLUG);

    expect(status.state).toBe("degraded");
    expect(status.error).toContain("~/.claude/agents is missing");
    expect(status.error).toContain("studio materialization did not land on this container");
  });

  it("role path (no STUDIO_NAME): the ~/.claude/agents check is never issued — a plain role never gets that directory (measured live: websites--pilot, HOOK=0 SKILLS=0)", async () => {
    const cmds: string[] = [];
    const deps = dispatchingDeps(cmds, roleFetch(), () => undefined);

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(cmds).not.toContain('test -d "$HOME/.claude/agents"');
  });

  it("regression: clone + bring-up + both verification checks all succeed — status still lands running, error null, no false positive on a genuinely healthy provision", async () => {
    const cmds: string[] = [];
    const deps = dispatchingDeps(cmds, studioFetch(), () => undefined);

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "web-studio" }, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(status.error).toBeNull();
    expect(cmds).toContain("test -d /workspace/websites/.git");
    expect(cmds).toContain('test -d "$HOME/.claude/agents"');
  });
});

// PR #108 review N1: a destroy that died mid-flight leaves DESTROYING_KEY set.
// Provision / restart (and so recycle and heal) bring the container back up,
// so they must clear it — or the wake gate reads `stopped` for up to 15 min.
describe("provision/restart clear a leftover destroy marker (#100 N1)", () => {
  function roleFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      throw notFound(path, ref);
    });
  }
  function deps(): ProvisionDeps {
    return {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => new Date().toISOString(),
      fetchBlueprintFile: roleFetch(),
    };
  }
  const freshMarker = () => new Date(Date.now() - 60_000).toISOString();

  it("provisionWithStorage clears the marker; the gate reads running", async () => {
    const storage = fakeStorage();
    await storage.put(DESTROYING_KEY, freshMarker());
    const status = await provisionWithStorage(deps(), storage, { repo: "websites", role: "scratch" }, REPO_SLUG);
    expect(status.state).toBe("running");
    expect((await storage.get(DESTROYING_KEY)) ?? null).toBeNull();
    expect(await gatedStateIn(storage, () => new Date())).toBe("running");
  });

  it("restartWithStorage clears the marker; the gate reads running", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(deps(), storage, { repo: "websites", role: "scratch" }, REPO_SLUG);
    await storage.put(DESTROYING_KEY, freshMarker());
    const status = await restartWithStorage(deps(), storage, "websites--scratch", "rafarc21/fleetflare");
    expect(status.state).toBe("running");
    expect((await storage.get(DESTROYING_KEY)) ?? null).toBeNull();
    expect(await gatedStateIn(storage, () => new Date())).toBe("running");
  });
});

// Issue #330 round 2 (HIGH-severity architecture correction): the operator's
// house-rules overlay used to be read from fleet/blueprint/house-rules.md
// INSIDE the blueprint repo — for this fleet, fleet.blueprint.repo resolves
// to rafarc21/fleetflare, which the public-release plan makes PUBLIC, so any
// operator override committed there would ship in the open-source repo. Fix:
// the overlay now comes from a SEPARATE, PRIVATE, operator-owned repo named
// by its own config var, FLEET_OPS_REPO (env.ts) — issue #341's own maestro
// comment settled this shared shape: #341's harvested-memory feature and
// this feature read the SAME private ops repo, different paths (fleet/memory/
// there, OPS_HOUSE_RULES_PATH here, at root).
// #330 round 4 (review item 1): the overlay's token is scoped to the ops repo
// AND narrowed to contents:read -- never the installation's full permissions
// the blueprint minter hands out.
describe("opsFileFetcher — the ops repo is read with a contents:read token scoped to it", () => {
  it("mints for the ops repo with permissions { contents: 'read' }, then fetches that repo's file", async () => {
    const mint = vi.fn(async () => "tok-ro");
    const fetchFile = vi.fn(async () => "overlay text");
    const fetchOps = opsFileFetcher({} as Env, "acme/ops", mint, fetchFile);

    await expect(fetchOps(OPS_HOUSE_RULES_PATH, "HEAD")).resolves.toBe("overlay text");
    expect(mint).toHaveBeenCalledWith({}, "acme/ops", { permissions: { contents: "read" } });
    expect(fetchFile).toHaveBeenCalledWith("tok-ro", "acme/ops", OPS_HOUSE_RULES_PATH, "HEAD");
  });
});

describe("the operator ops-repo overlay end to end (issue #330 round 2) — resolveBringupEnv/provisionWithStorage", () => {
  // No return-type annotation, deliberately: `ProvisionDeps["fetchBlueprintFile"]`
  // would erase vi.fn's own Mock type, and the "unset" test below needs
  // `.mock.calls` off the returned fake.
  function opsFetch(overrides: Record<string, string | Error> = {}) {
    return vi.fn(async (repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
      if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
      const key = `${repo}:${path}`;
      if (key in overrides) {
        const v = overrides[key];
        if (v instanceof Error) throw v;
        return v;
      }
      throw notFound(path, ref);
    });
  }

  // Round 4 (review item 1): the ops repo is read ONLY through its own
  // read-only port. `fetchBlueprintFile` above never serves it, so a
  // regression back to the full-permission blueprint fetch 404s the overlay.
  function opsFile(files: Record<string, string | Error> = {}) {
    return vi.fn(async (path: string, ref: string) => {
      if (path in files) {
        const v = files[path];
        if (v instanceof Error) throw v;
        return v;
      }
      throw notFound(path, ref);
    });
  }

  // THE MUTANT PROOF (round-2 review item 5): a code regression that drops
  // the resolved overlay before it reaches the built prompt — e.g.
  // resolveBringupEnv passing a hardcoded `null` in place of the resolved
  // ops-overlay text — turns this test red. Verified by hand during
  // development: forcing that one call site to `null` fails this test;
  // restoring the real wiring passes it again.
  it("FLEET_OPS_REPO configured and house-rules.md present -> its text reaches ROLE_PROMPT_B64, appended after the neutral default", async () => {
    const OVERLAY = "## Operator house rules -- private overlay\n\nAlways greet the operator.";
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-09-25T00:00:00.000Z",
      fetchBlueprintFile: opsFetch(),
      opsRepo: "rafarc21/fleetflare-ops",
      fetchOpsFile: opsFile({ [OPS_HOUSE_RULES_PATH]: OVERLAY }),
    };

    const { bringupEnv } = await resolveBringupEnv(deps, { repo: "websites", role: "scratch" }, REPO_SLUG, REPO_SLUG);

    expect(decodePrompt(bringupEnv)).toContain(OVERLAY);
  });

  // Round 3: the STUDIO call site (tryFetchStudio -> studioBringupEnv) is a
  // separate wiring from the role path above; a `null` there alone must fail.
  it("studio path: FLEET_OPS_REPO overlay reaches the studio's ROLE_PROMPT_B64 too", async () => {
    const OVERLAY = "## Operator house rules -- studio overlay\n\nAlways greet the operator.";
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-09-25T00:00:00.000Z",
      fetchBlueprintFile: opsFetch({
        [`${REPO_SLUG}:fleet/blueprint/studios/web-studio/studio.md`]: FAKE_STUDIO_MD,
      }),
      opsRepo: "rafarc21/fleetflare-ops",
      fetchOpsFile: opsFile({ [OPS_HOUSE_RULES_PATH]: OVERLAY }),
    };

    const { bringupEnv } = await resolveBringupEnv(deps, { repo: "websites", role: "web-studio" }, REPO_SLUG, REPO_SLUG);

    expect((bringupEnv as StudioEnv).STUDIO_NAME).toBe("web-studio");
    expect(decodePrompt(bringupEnv)).toContain(OVERLAY);
  });

  it("FLEET_OPS_REPO unset -> no overlay fetch is even attempted, and the prompt is byte-identical to today's neutral-only shape", async () => {
    const fetch = opsFetch();
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-09-25T00:00:00.000Z",
      fetchBlueprintFile: fetch,
      // opsRepo deliberately omitted -- absent = off, same posture as every
      // other optional store this codebase has (memory index, Directus).
    };

    const { bringupEnv } = await resolveBringupEnv(deps, { repo: "websites", role: "scratch" }, REPO_SLUG, REPO_SLUG);

    expect(decodePrompt(bringupEnv)).toBe(appendHouseRules(FAKE_ROLE_PROMPT));
    expect(fetch.mock.calls.map((c) => c[1])).not.toContain(OPS_HOUSE_RULES_PATH);
  });

  // Round-2 review item 2: "configured but the file is missing" must be
  // VISIBLE, never silently indistinguishable from "never configured" — the
  // provision still succeeds (state stays "running", the studio boots fine
  // on the neutral default alone), but the row's own `error` field carries a
  // note a maestro would see in `fleet ls`/`fleet inspect`. Same "recorded
  // on the ROW, not only a Worker log" convention runRestart's own
  // `cloneRefusal` already uses for a different non-fatal misconfiguration.
  it("FLEET_OPS_REPO configured but house-rules.md 404s -> running (neutral default only), with a visible note on the row", async () => {
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-25T00:00:00.000Z",
      fetchBlueprintFile: opsFetch(),
      opsRepo: "rafarc21/fleetflare-ops",
      fetchOpsFile: opsFile(),
    };

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(status.error).toBeTruthy();
    expect(status.error).toContain("rafarc21/fleetflare-ops");
    expect(status.error).toContain(OPS_HOUSE_RULES_PATH);
  });

  it("FLEET_OPS_REPO configured with a non-404 fetch failure -> same visible-note treatment as a 404, never a silent swallow", async () => {
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-25T00:00:00.000Z",
      fetchBlueprintFile: opsFetch(),
      opsRepo: "rafarc21/fleetflare-ops",
      fetchOpsFile: opsFile({ [OPS_HOUSE_RULES_PATH]: new Error("network unreachable") }),
    };

    const status = await provisionWithStorage(deps, fakeStorage(), { repo: "websites", role: "scratch" }, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(status.error).toContain("rafarc21/fleetflare-ops");
  });
});

// Issue #1: the leak gate reaches every studio container at provision AND
// restart -- scanner + gh wrapper installed, the private denylist written as
// a file (never a command string), and a stale gate file removed whenever the
// Worker cannot deliver one, so the wrappers fail closed.
describe("applyLeakGate — denylist delivery into the container (issue #1)", () => {
  const STUDIO_WORK_CFG = { repo: "sample", role: "web-studio", repoSlug: "acme-org/sample" };
  const OPS = "acme-org/fleet-ops";
  const DENYLIST = "acmeclient\nacme-secret-[0-9]+\n";
  const RM = `rm -f ${LEAK_DENYLIST_PATH}`;

  function studioFetch(): ProvisionDeps["fetchBlueprintFile"] {
    return vi.fn(async (_repo: string, path: string, ref: string) => {
      if (path === "fleet.json") return FAKE_FLEET_JSON;
      if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
      if (path === "fleet/blueprint/studios/web-studio/members") return FAKE_MEMBERS_LISTING;
      if (path === "fleet/blueprint/studios/web-studio/members/frontend-developer.md") return FAKE_MEMBER_FRONTEND_MD;
      if (path === "fleet/blueprint/studios/web-studio/members/qa-engineer.md") return FAKE_MEMBER_QA_MD;
      throw notFound(path, ref);
    });
  }

  // `ops` null = FLEET_OPS_REPO unset. A file value of Error = the fetch throws.
  function gateDeps(opts: { ops?: string | null; file?: string | Error; isPrivate?: boolean | Error; noHouseRules?: boolean } = {}) {
    const cmds: string[] = [];
    const writes: { path: string; text: string }[] = [];
    const ops = opts.ops === undefined ? OPS : opts.ops;
    const file = opts.file === undefined ? DENYLIST : opts.file;
    const fetchOpsFile = vi.fn(async (path: string, ref: string) => {
      if (path === OPS_DENYLIST_PATH) {
        if (file instanceof Error) throw file;
        return file;
      }
      if (path === OPS_HOUSE_RULES_PATH && !opts.noHouseRules) return "## Operator house rules";
      throw notFound(path, ref);
    });
    const installLeakGate = vi.fn(async () => ({ ok: true as const }));
    const workRepoIsPrivate = vi.fn(async () => {
      if (opts.isPrivate instanceof Error) throw opts.isPrivate;
      return opts.isPrivate ?? false;
    });
    const deps: ProvisionDeps = {
      sbExec: vi.fn(async (cmd: string) => {
        cmds.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      }),
      recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
      now: () => "2026-09-28T00:00:00.000Z",
      fetchBlueprintFile: studioFetch(),
      writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
        writes.push({ path, text: new TextDecoder().decode(bytes) });
      }),
      installLeakGate,
      workRepoIsPrivate,
      ...(ops === null ? {} : { opsRepo: ops, fetchOpsFile }),
    };
    return { deps, cmds, writes, fetchOpsFile, installLeakGate, workRepoIsPrivate };
  }

  it("public work repo + denylist present -> gate file written with the on header and every pattern, no rm", async () => {
    const g = gateDeps();
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(g.workRepoIsPrivate).toHaveBeenCalledWith("acme-org/sample");
    expect(g.writes).toEqual([
      { path: LEAK_DENYLIST_PATH, text: denylistFileContent({ patterns: ["acmeclient", "acme-secret-[0-9]+"] }) },
    ]);
    expect(g.writes[0].text.startsWith(`${LEAK_GATE_ON}\n`)).toBe(true);
    expect(g.cmds).not.toContain(RM);
    expect(status.error).toBeNull();
  });

  it("terms never ride a command string or the row", async () => {
    const g = gateDeps();
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.cmds.join("\n")).not.toContain("acmeclient");
    expect(JSON.stringify(status)).not.toContain("acmeclient");
  });

  it("install cmd issued through installLeakGate on provision", async () => {
    const g = gateDeps();
    await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.installLeakGate).toHaveBeenCalledTimes(1);
  });

  it("private work repo -> off header naming the repo, denylist never fetched", async () => {
    const g = gateDeps({ isPrivate: true });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.writes).toEqual([
      { path: LEAK_DENYLIST_PATH, text: denylistFileContent({ off: "work repo acme-org/sample is private" }) },
    ]);
    expect(g.writes[0].text.startsWith(LEAK_GATE_OFF)).toBe(true);
    expect(g.fetchOpsFile.mock.calls.map((c) => c[0])).not.toContain(OPS_DENYLIST_PATH);
    expect(status.error).toBeNull();
  });

  it("privacy lookup throws -> treated as public (fail closed): patterns written", async () => {
    const g = gateDeps({ isPrivate: new Error("github 502") });
    await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.writes[0].text.startsWith(`${LEAK_GATE_ON}\n`)).toBe(true);
  });

  // Mutant: a missing denylist must never become a pass (no gate file = the
  // wrappers refuse). A stale file from an earlier provision is removed.
  it("FLEET_OPS_REPO unset -> rm -f the gate file, nothing written, note on the row, still running", async () => {
    const g = gateDeps({ ops: null });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(g.writes).toEqual([]);
    expect(g.cmds).toContain(RM);
    expect(status.error).toContain("leak gate: no denylist");
    expect(status.error).toContain(OPS_DENYLIST_PATH);
  });

  it("denylist 404 -> rm -f + note", async () => {
    const g = gateDeps({ file: notFound(OPS_DENYLIST_PATH, "HEAD") });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.writes).toEqual([]);
    expect(g.cmds).toContain(RM);
    expect(status.error).toContain("leak gate: no denylist");
  });

  it("empty denylist (parse error) -> rm -f + note, never an empty on-list", async () => {
    const g = gateDeps({ file: "\n\n" });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.writes).toEqual([]);
    expect(g.cmds).toContain(RM);
    expect(status.error).toContain("leak gate: no denylist");
  });

  // Mutant: a JS-only pattern delivered -> the container's grep -E reads `\d`
  // as a literal d and passes the term (fail OPEN). Refused at parse instead.
  it("pattern grep -E and JS read differently -> rm -f + note naming the index, never the term", async () => {
    const g = gateDeps({ file: "acmeclient\nacme-secret-\\d+\n" });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(g.writes).toEqual([]);
    expect(g.cmds).toContain(RM);
    expect(status.error).toContain("leak gate: no denylist");
    expect(status.error).toContain("pattern #2");
    expect(JSON.stringify(status)).not.toContain("acme-secret");
  });

  it("gate file write fails -> rm -f + note", async () => {
    const g = gateDeps();
    g.deps.writeFile = vi.fn(async () => { throw new Error("sandbox writeFile failed"); });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(g.cmds).toContain(RM);
    expect(status.error).toContain("leak gate: no denylist");
  });

  it("install failure -> note on the row, denylist still delivered", async () => {
    const g = gateDeps();
    g.deps.installLeakGate = vi.fn(async () => ({ ok: false as const, error: "exit 1" }));
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(status.error).toContain("leak gate: scanner/gh wrapper install failed");
    expect(g.writes).toHaveLength(1);
  });

  it("install failure -> gh blocked via ghBlockCmd, note says so (mutant: row note only, no block)", async () => {
    const g = gateDeps();
    g.deps.installLeakGate = vi.fn(async () => ({ ok: false as const, error: "exit 1" }));
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.cmds).toContain(ghBlockCmd());
    expect(status.error).toContain("gh is blocked in this studio");
  });

  it("install ok -> gh never blocked", async () => {
    const g = gateDeps();
    await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.cmds).not.toContain(ghBlockCmd());
  });

  it("install failure + block exec non-zero -> note says gh is NOT blocked", async () => {
    const g = gateDeps();
    g.deps.installLeakGate = vi.fn(async () => ({ ok: false as const, error: "exit 1" }));
    g.deps.sbExec = vi.fn(async (cmd: string) => {
      g.cmds.push(cmd);
      return { code: cmd === ghBlockCmd() ? 1 : 0, stdout: "", stderr: "" };
    });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(status.error).toContain("gh block also failed");
    expect(status.error).not.toContain("gh is blocked in this studio");
  });

  it("install failure + block exec throws -> note says gh is NOT blocked, never throws", async () => {
    const g = gateDeps();
    g.deps.installLeakGate = vi.fn(async () => ({ ok: false as const, error: "exit 1" }));
    g.deps.sbExec = vi.fn(async (cmd: string) => {
      g.cmds.push(cmd);
      if (cmd === ghBlockCmd()) throw new Error("sandbox gone");
      return { code: 0, stdout: "", stderr: "" };
    });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.state).toBe("running");
    expect(status.error).toContain("gh block also failed");
  });

  it("note joins the house-rules overlay note on the row", async () => {
    const g = gateDeps({ file: notFound(OPS_DENYLIST_PATH, "HEAD"), noHouseRules: true });
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(status.error).toContain(OPS_HOUSE_RULES_PATH);
    expect(status.error).toContain("leak gate: no denylist");
  });

  it("restart re-installs and re-delivers the gate (fresh container filesystem)", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(gateDeps().deps, storage, STUDIO_WORK_CFG, REPO_SLUG);

    const g = gateDeps();
    g.deps.fetchBlueprintFile = vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); });
    const status = await restartWithStorage(g.deps, storage, "sample--web-studio", "rafarc21/fleetflare");

    expect(status.state).toBe("running");
    expect(g.installLeakGate).toHaveBeenCalledTimes(1);
    expect(g.workRepoIsPrivate).toHaveBeenCalledWith("acme-org/sample");
    expect(g.writes.map((w) => w.path)).toEqual([LEAK_DENYLIST_PATH]);
  });

  it("restart with no denylist -> rm -f + note on the row", async () => {
    const storage = fakeStorage();
    await provisionWithStorage(gateDeps().deps, storage, STUDIO_WORK_CFG, REPO_SLUG);

    const g = gateDeps({ ops: null });
    const status = await restartWithStorage(g.deps, storage, "sample--web-studio", "rafarc21/fleetflare");

    expect(status.state).toBe("running");
    expect(g.cmds).toContain(RM);
    expect(status.error).toContain("leak gate: no denylist");
  });

  // Issue #7: the push/gh routing follows the same visibility answer.
  describe("write proxy config (issue #7)", () => {
    const WORKER = "https://fleet.example.workers.dev";
    // The port's own mode rule is write-proxy/mode.ts's writeModeFor (tested
    // there); this stand-in is its App shape: direct only when private.
    const withProxy = (g: ReturnType<typeof gateDeps>, on = true) => {
      g.deps.writeProxy = { workerUrl: WORKER, mode: (_slug, isPrivate) => (on && !isPrivate ? "proxy" : "direct") };
      return g;
    };

    it("public work repo -> proxy config exec'd (pushInsteadOf to the Worker)", async () => {
      const g = withProxy(gateDeps());
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(g.cmds).toContain(writeProxyConfigCmd("proxy", WORKER));
    });

    it("visibility unknown reads as public -> proxy", async () => {
      const g = withProxy(gateDeps({ isPrivate: new Error("github down") }));
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(g.cmds).toContain(writeProxyConfigCmd("proxy", WORKER));
    });

    it("private work repo -> direct config (proxy keys removed)", async () => {
      const g = withProxy(gateDeps({ isPrivate: true }));
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(g.cmds).toContain(writeProxyConfigCmd("direct", WORKER));
    });

    it("kill switch -> direct even on a public repo", async () => {
      const g = withProxy(gateDeps(), false);
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(g.cmds).toContain(writeProxyConfigCmd("direct", WORKER));
    });

    it("restart re-applies it (fresh container)", async () => {
      const storage = fakeStorage();
      await provisionWithStorage(gateDeps().deps, storage, STUDIO_WORK_CFG, REPO_SLUG);
      const g = withProxy(gateDeps());
      await restartWithStorage(g.deps, storage, "sample--web-studio", "rafarc21/fleetflare");
      expect(g.cmds).toContain(writeProxyConfigCmd("proxy", WORKER));
    });

    it("a failed config exec is a row note, never a thrown provision", async () => {
      const g = withProxy(gateDeps());
      const base = g.deps.sbExec;
      g.deps.sbExec = vi.fn(async (cmd: string, e?: Record<string, string>) =>
        cmd === writeProxyConfigCmd("proxy", WORKER) ? { code: 1, stdout: "", stderr: "boom" } : base(cmd, e));
      const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(status.state).toBe("running");
      expect(status.error).toContain("write proxy: git config failed");
    });

    it("the mode rule gets the work repo and the gate's own visibility answer", async () => {
      const g = gateDeps({ isPrivate: true });
      const mode = vi.fn((_slug: string, _isPrivate: boolean) => "proxy" as const);
      g.deps.writeProxy = { workerUrl: WORKER, mode };
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(mode).toHaveBeenCalledWith("acme-org/sample", true);
      expect(g.cmds).toContain(writeProxyConfigCmd("proxy", WORKER));
    });

    it("first provision: blueprint + memory ports get the resolved work repo (row has none yet)", async () => {
      const g = gateDeps();
      const cred = vi.fn(async () => ({ ok: true as const }));
      const mem = vi.fn(async () => "fake-read-token");
      g.deps.writeBlueprintCredential = cred;
      g.deps.memoryRepo = "acme-org/fleet-ops";
      g.deps.memoryToken = mem;
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(cred.mock.calls.length).toBeGreaterThan(0);
      for (const c of cred.mock.calls as unknown[][]) expect(c[2]).toBe("acme-org/sample");
      expect(mem).toHaveBeenCalledWith("acme-org/sample");
    });

    // #13 re-review: restart resolves the repo from the stored row. A mutant
    // handing the fleet default repo to these ports survived; this pins it.
    it("restart: blueprint + memory ports get the row's work repo, not the fleet default", async () => {
      const storage = fakeStorage();
      await provisionWithStorage(gateDeps().deps, storage, STUDIO_WORK_CFG, REPO_SLUG);
      const g = gateDeps();
      const cred = vi.fn(async () => ({ ok: true as const }));
      const mem = vi.fn(async () => "fake-read-token");
      g.deps.writeBlueprintCredential = cred;
      g.deps.memoryRepo = "acme-org/fleet-ops";
      g.deps.memoryToken = mem;
      g.deps.fetchBlueprintFile = vi.fn(async () => { throw new Error("restart must not refetch the blueprint"); });
      await restartWithStorage(g.deps, storage, "sample--web-studio", "rafarc21/fleetflare");
      expect(cred.mock.calls.length).toBeGreaterThan(0);
      for (const c of cred.mock.calls as unknown[][]) expect(c[2]).toBe("acme-org/sample");
      expect(mem).toHaveBeenCalledWith("acme-org/sample");
    });

    it("absent port -> no proxy config at all", async () => {
      const g = gateDeps();
      await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);
      expect(g.cmds.some((c) => c.includes("/fleet/git/"))).toBe(false);
    });
  });

  it("absence is a no-op: no installLeakGate port -> no gate exec, no write, no note", async () => {
    const g = gateDeps({ ops: null });
    delete g.deps.installLeakGate;
    const status = await provisionWithStorage(g.deps, fakeStorage(), STUDIO_WORK_CFG, REPO_SLUG);

    expect(g.cmds).not.toContain(RM);
    expect(g.writes).toEqual([]);
    expect(status.error).toBeNull();
  });
});

describe("installLeakGatePort — do.ts's installLeakGate body (issue #1)", () => {
  it("runs leakGateInstallCmd() in one exec; ok on exit 0", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect(await installLeakGatePort(exec)).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith(leakGateInstallCmd());
  });

  it("non-zero exit or a throw -> ok:false, never throws", async () => {
    expect((await installLeakGatePort(vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" })))).ok).toBe(false);
    expect((await installLeakGatePort(vi.fn(async () => { throw new Error("gone"); }))).ok).toBe(false);
  });
});
