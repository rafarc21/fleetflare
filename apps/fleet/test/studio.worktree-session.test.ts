import { describe, it, expect, vi } from "vitest";
import {
  adoptWorktreeSession, adoptWorktreeSessionCmd, relaunchBringup, restartWithStorage, runProvision,
  BRINGUP_CMD, ROLE_ENV_KEY, STATUS_KEY, SESSION_ADOPT_MARKER, SESSION_ADOPT_DEADLINE_MS,
  type ProvisionDeps, type RoleEnv, type StudioStorage,
} from "../src/studio/provision";
import type { StudioStatus } from "../src/studio/types";
import { env } from "cloudflare:test";
import { EXEC_CLASSES, type SbExecOptions } from "../src/studio/sandbox-api";

// Issue #116: a healed lead came back blank because its session lived under
// a worktree project key. Before EVERY bring-up (provision, restart, the
// restart's retry, failover relaunch) the Worker runs ONE deadlined exec that
// copies the newest worktree-keyed session into the root key when it is
// newer than every root session. These tests pin the wiring; the command's
// own behaviour runs in a real shell in test/bun/worktree-session-adopt.test.ts.

const REPO = "fleetflare";
const STUDIO_ID = `${REPO}--web-studio`;
const NOW = "2026-09-24T15:00:00.000Z";
const SESSION_ID = "b1c006ac-dd42-48a7-a063-90400c353858";
const WT_KEY = "-workspace-fleetflare--claude-worktrees-row-tells-truth-85-pr1";
const ADOPTED_STDOUT = `${SESSION_ADOPT_MARKER} adopted ${SESSION_ID} ${WT_KEY}\n`;
const ADOPT_CMD = adoptWorktreeSessionCmd(REPO);
const ROLE_ENV: RoleEnv = { ROLE_PROMPT_B64: "aGk=", ROLE_ALLOWED_TOOLS: "Bash(git *)", ROLE_EFFORT: "" };

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: `rafarc21/${REPO}`,
    ...overrides,
  };
}

function fakeStorage(seed: { status?: StudioStatus; roleEnv?: RoleEnv }): StudioStorage {
  const map = new Map<string, unknown>();
  if (seed.status) map.set(STATUS_KEY, seed.status);
  if (seed.roleEnv) map.set(ROLE_ENV_KEY, seed.roleEnv);
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as StudioStorage["put"],
  };
}

type Res = { code: number; stdout: string; stderr: string };

function deps(onCmd: (cmd: string, bringups: number) => Res | undefined = () => undefined) {
  const cmds: string[] = [];
  let bringups = 0;
  const d: ProvisionDeps = {
    sbExec: vi.fn(async (cmd: string) => {
      if (cmd === BRINGUP_CMD) bringups += 1;
      cmds.push(cmd);
      return onCmd(cmd, bringups) ?? { code: 0, stdout: "", stderr: "" };
    }),
    recordStudio: async () => {},
    now: () => NOW,
    fetchBlueprintFile: vi.fn(async () => {
      throw new Error("not under test");
    }),
  };
  return { d, cmds };
}

function scratchBlueprint(): ProvisionDeps["fetchBlueprintFile"] {
  return vi.fn(async (_repo: string, path: string) => {
    if (path === "fleet.json") return JSON.stringify({ blueprint: { repo: "rafarc21/fleetflare", ref: "main" }, roles: ["scratch"], instance_type: "standard-2" });
    if (path === "fleet/blueprint/org.json") return JSON.stringify({ edges: {}, gates: {} });
    if (path.startsWith("fleet/blueprint/studios/")) throw new Error(`fetch ${path}@main failed (404): Not Found`);
    return "---\nname: scratch\nskills: []\nallowedTools: Bash(git *)\nmay_spawn: []\nreports_to: operator\ngates: []\n---\nhi\n";
  });
}

describe("restart — a worktree-keyed session is adopted before bring-up (issue #116)", () => {
  it("runs the adopt exec BEFORE bring-up and records the resumed session on the row", async () => {
    const { d, cmds } = deps((cmd) => (cmd === ADOPT_CMD ? { code: 0, stdout: ADOPTED_STDOUT, stderr: "" } : undefined));
    const result = await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");

    const adoptIdx = cmds.indexOf(ADOPT_CMD);
    expect(adoptIdx).toBeGreaterThanOrEqual(0);
    expect(cmds.indexOf(BRINGUP_CMD)).toBeGreaterThan(adoptIdx);
    expect(result.state).toBe("running");
    expect(result.sessionAdoption).toEqual({ sessionId: SESSION_ID, fromKey: WT_KEY, at: NOW });
  });

  it("the retry re-runs the adopt exec before its second bring-up too", async () => {
    const { d, cmds } = deps((cmd, bringups) =>
      cmd === `test -d /workspace/${REPO}/.git` && bringups === 1 ? { code: 1, stdout: "", stderr: "" } : undefined,
    );
    await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");

    const bringupIdxs = cmds.flatMap((c, i) => (c === BRINGUP_CMD ? [i] : []));
    const adoptIdxs = cmds.flatMap((c, i) => (c === ADOPT_CMD ? [i] : []));
    expect(bringupIdxs).toHaveLength(2);
    expect(adoptIdxs).toHaveLength(2);
    expect(adoptIdxs[0]).toBeLessThan(bringupIdxs[0]);
    expect(adoptIdxs[1]).toBeGreaterThan(bringupIdxs[0]);
    expect(adoptIdxs[1]).toBeLessThan(bringupIdxs[1]);
  });

  it("no worktree session: bring-up unchanged and the row says nothing was adopted", async () => {
    const { d, cmds } = deps();
    const result = await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
    expect(cmds.filter((c) => c === BRINGUP_CMD)).toHaveLength(1);
    expect(result.state).toBe("running");
    expect(result.sessionAdoption).toBeNull();
  });

  it("an adopt exec that THROWS never blocks or fails the restart", async () => {
    const { d, cmds } = deps((cmd) => {
      if (cmd === ADOPT_CMD) throw new Error("exec channel died");
      return undefined;
    });
    const result = await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
    expect(cmds).toContain(BRINGUP_CMD);
    expect(result.state).toBe("running");
    expect(result.error).toBeNull();
  });
});

describe("provision — adopt runs after session restore, before bring-up (issue #116)", () => {
  it("adopt exec lands between the restore check and bring-up", async () => {
    const { d, cmds } = deps((cmd) => (cmd === ADOPT_CMD ? { code: 0, stdout: ADOPTED_STDOUT, stderr: "" } : undefined));
    d.fetchBlueprintFile = scratchBlueprint();
    const { status: s } = await runProvision(d, { repo: REPO, role: "scratch" }, "rafarc21/fleetflare", null);

    expect(s.error).toBeNull();
    const adoptIdx = cmds.indexOf(ADOPT_CMD);
    const cloneIdx = cmds.findIndex((c) => c.includes("git clone"));
    expect(adoptIdx).toBeGreaterThan(cloneIdx);
    expect(cmds.indexOf(BRINGUP_CMD)).toBeGreaterThan(adoptIdx);
    expect(s.sessionAdoption).toEqual({ sessionId: SESSION_ID, fromKey: WT_KEY, at: NOW });
  });
});

describe("relaunchBringup — failover relaunch adopts first (issue #116)", () => {
  it("adopt exec (no env), then BRINGUP_CMD with the stored role env", async () => {
    const calls: Array<{ cmd: string; env?: Record<string, string> }> = [];
    const exec = vi.fn(async (cmd: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      return { code: 0, stdout: cmd === ADOPT_CMD ? ADOPTED_STDOUT : "", stderr: "" };
    });
    const res = await relaunchBringup(exec, ROLE_ENV, STUDIO_ID);
    expect(calls).toEqual([{ cmd: ADOPT_CMD, env: undefined }, { cmd: BRINGUP_CMD, env: ROLE_ENV }]);
    expect(res.code).toBe(0);
  });

  it("an id with no repo segment skips the adopt and still relaunches with the role env", async () => {
    const exec = vi.fn(async (_cmd: string, _env?: Record<string, string>) => ({ code: 0, stdout: "", stderr: "" }));
    await relaunchBringup(exec, ROLE_ENV, "not-a-studio-id");
    expect(exec.mock.calls).toEqual([[BRINGUP_CMD, ROLE_ENV]]);
  });

  // PR #120 review: after #110 sbExec's third argument is an options bag. A
  // do.ts lambda `(cmd, env) => sbExec(this, cmd, env)` still type-checks
  // and DROPS the role env — claude relaunches with an empty system prompt
  // and tool policy. The Durable Object itself is not constructible here, so
  // the wiring line is pinned at the source, and the exec it builds is run
  // against a recording sbExec.
  it("do.ts's relaunch hands the role env to bring-up INSIDE the provision exec class", async () => {
    // Same source handle #110's exec-class guard reads (vitest.config.ts binding).
    const src: string = env.TEST_STUDIO_DO_SRC;
    const line = src.split("\n").find((l) => l.includes("relaunchBringup("));
    expect(line).toBeDefined();
    const lambda = line!.match(/relaunchBringup\((\(cmd, env\) => sbExec\(this, cmd, [^)]*\)),/)?.[1];
    expect(lambda).toBe("(cmd, env) => sbExec(this, cmd, { ...EXEC_CLASSES.provision, env })");

    const seen: Array<{ cmd: string; opts: SbExecOptions }> = [];
    const sbExec = async (_self: unknown, cmd: string, opts: SbExecOptions) => {
      seen.push({ cmd, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const self = {};
    const exec = (cmd: string, env?: Record<string, string>) => sbExec(self, cmd, { ...EXEC_CLASSES.provision, env });
    await relaunchBringup(exec, ROLE_ENV, STUDIO_ID);
    const bringup = seen.find((c) => c.cmd === BRINGUP_CMD);
    expect(bringup?.opts).toEqual({ ...EXEC_CLASSES.provision, env: ROLE_ENV });
  });
});

describe("#146 — the adopt runs INSIDE bring-up; the row reads bring-up's result line", () => {
  it("ADOPT_CMD runs /opt/fleet/studio-adopt.sh when it is executable, else today's inline command (old image, rollout)", () => {
    const cmd = adoptWorktreeSessionCmd(REPO);
    expect(cmd.startsWith("if [ -x /opt/fleet/studio-adopt.sh ]; then timeout -k 2 15 /opt/fleet/studio-adopt.sh 'fleetflare' ")).toBe(true);
    expect(cmd).toContain("; else timeout -k 2 15 sh -c ");
  });

  it("provision: a fresh container's adopt happens in bring-up (pre-bring-up saw nothing) — the row records bring-up's", async () => {
    const { d } = deps((cmd) => {
      if (cmd === ADOPT_CMD) return { code: 0, stdout: `${SESSION_ADOPT_MARKER} none\n`, stderr: "" };
      if (cmd === BRINGUP_CMD) return { code: 0, stdout: ADOPTED_STDOUT, stderr: "" };
      return undefined;
    });
    d.fetchBlueprintFile = scratchBlueprint();
    const { status: s } = await runProvision(d, { repo: REPO, role: "scratch" }, "rafarc21/fleetflare", null);
    expect(s.state).toBe("running");
    expect(s.sessionAdoption).toEqual({ sessionId: SESSION_ID, fromKey: WT_KEY, at: NOW });
  });

  it("restart: same — bring-up's adoption line reaches the row", async () => {
    const { d } = deps((cmd) => {
      if (cmd === ADOPT_CMD) return { code: 0, stdout: `${SESSION_ADOPT_MARKER} none\n`, stderr: "" };
      if (cmd === BRINGUP_CMD) return { code: 0, stdout: ADOPTED_STDOUT, stderr: "" };
      return undefined;
    });
    const result = await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
    expect(result.state).toBe("running");
    expect(result.sessionAdoption).toEqual({ sessionId: SESSION_ID, fromKey: WT_KEY, at: NOW });
  });
});

describe("#185 review — bring-up #1 ADOPTS, then exits non-zero; the retry resumes the copy", () => {
  it("restart (the rollout path): the row keeps bring-up #1's adoption", async () => {
    const { d } = deps((cmd, n) => {
      if (cmd === ADOPT_CMD) return { code: 0, stdout: `${SESSION_ADOPT_MARKER} ${n === 0 ? "none" : "root"}\n`, stderr: "" };
      if (cmd === BRINGUP_CMD) {
        return n === 1
          ? { code: 1, stdout: ADOPTED_STDOUT, stderr: "studio-bringup: claude is not running in tmux studio:claude 20s after the launch was sent (pane runs: bash) -- the lead never came up" }
          : { code: 0, stdout: `${SESSION_ADOPT_MARKER} root\n`, stderr: "" };
      }
      return undefined;
    });
    const r = await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
    expect(r.state).toBe("running");
    expect(r.sessionAdoption).toEqual({ sessionId: SESSION_ID, fromKey: WT_KEY, at: NOW });
  });
});

describe("row truth — sessionAdoption (PR #120 review)", () => {
  it("a retry keeps the FIRST attempt's adoption (the second sees the copy as root-newest)", async () => {
    let adopts = 0;
    const { d } = deps((cmd, bringups) => {
      if (cmd === ADOPT_CMD) {
        adopts += 1;
        return { code: 0, stdout: adopts === 1 ? ADOPTED_STDOUT : `${SESSION_ADOPT_MARKER} root\n`, stderr: "" };
      }
      if (cmd === `test -d /workspace/${REPO}/.git` && bringups === 1) return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });
    const result = await restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
    expect(adopts).toBe(2);
    expect(result.state).toBe("running");
    expect(result.sessionAdoption).toEqual({ sessionId: SESSION_ID, fromKey: WT_KEY, at: NOW });
  });

  it("restart degraded on both attempts: sessionAdoption null, even over a previous row's adoption", async () => {
    const { d } = deps((cmd) => {
      if (cmd === ADOPT_CMD) return { code: 0, stdout: ADOPTED_STDOUT, stderr: "" };
      if (cmd === `test -d /workspace/${REPO}/.git`) return { code: 1, stdout: "", stderr: "" };
      return undefined;
    });
    const prior = status({ sessionAdoption: { sessionId: SESSION_ID, fromKey: WT_KEY, at: "earlier" } });
    const result = await restartWithStorage(d, fakeStorage({ status: prior, roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
    expect(result.state).toBe("degraded");
    expect(result.sessionAdoption).toBeNull();
  });

  it("provision degraded: sessionAdoption null, even over a previous row's adoption", async () => {
    const { d } = deps((cmd) => (cmd === BRINGUP_CMD ? { code: 1, stdout: "", stderr: "boom" } : undefined));
    d.fetchBlueprintFile = scratchBlueprint();
    const prior = status({ sessionAdoption: { sessionId: SESSION_ID, fromKey: WT_KEY, at: "earlier" } });
    const { status: s } = await runProvision(d, { repo: REPO, role: "scratch" }, "rafarc21/fleetflare", prior);
    expect(s.state).toBe("degraded");
    expect(s.sessionAdoption).toBeNull();
  });
});

describe("a hung adopt never holds bring-up hostage (PR #120 review)", () => {
  it("restart: adopt exec that never answers -> Worker backstop fires, bring-up still issued", async () => {
    vi.useFakeTimers();
    try {
      const cmds: string[] = [];
      const d: ProvisionDeps = {
        sbExec: vi.fn((cmd: string) => {
          cmds.push(cmd);
          if (cmd === ADOPT_CMD) return new Promise<Res>(() => {});
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        }),
        recordStudio: async () => {},
        now: () => NOW,
        fetchBlueprintFile: vi.fn(async () => { throw new Error("not under test"); }),
      };
      const pending = restartWithStorage(d, fakeStorage({ status: status(), roleEnv: ROLE_ENV }), STUDIO_ID, "rafarc21/fleetflare");
      await vi.advanceTimersByTimeAsync(SESSION_ADOPT_DEADLINE_MS + 1);
      const result = await pending;
      expect(cmds).toContain(BRINGUP_CMD);
      expect(result.state).toBe("running");
      expect(result.sessionAdoption).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("adoptWorktreeSession — deadlined, never throws", () => {
  it("an exec that never answers resolves 'unknown' at the deadline", async () => {
    const exec = () => new Promise<Res>(() => {});
    const result = await adoptWorktreeSession(exec, REPO, NOW, 20);
    expect(result.outcome).toBe("unknown");
  });

  it("garbage stdout from the container is never recorded as an adoption", async () => {
    const exec = async () => ({ code: 0, stdout: `${SESSION_ADOPT_MARKER} adopted ../../etc/passwd; rm -rf /\n`, stderr: "" });
    const result = await adoptWorktreeSession(exec, REPO, NOW);
    expect(result.outcome).toBe("unknown");
  });
});
