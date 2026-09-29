import { describe, it, expect, vi } from "vitest";
import {
  adoptWorktreeSessionCmd, runProvision, provisionWithStorage, BRINGUP_CMD, FRESH_SESSION_MARKER,
  type ProvisionDeps, type StudioStorage,
} from "../src/studio/provision";
import { SESSION_FORCE_KEY } from "../src/studio/session-sync";

// Issue #28: `fleet provision|recycle --fresh-session`. ONE bring-up skips the
// adopt and gets FLEET_FRESH_SESSION=1; the persisted role env never carries
// it (every later heal/restart replays that env, and must resume normally).
// Where bring-up moved the old session reaches the row, never silent.
// Bring-up's own behaviour runs in a real shell: test/bun/bringup-fresh-session.test.ts.

const REPO = "acmeclient";
const NOW = "2026-09-29T10:00:00.000Z";
const ADOPT_CMD = adoptWorktreeSessionCmd(REPO);
const ASIDE = "~/.claude/projects/fleet-aside-20260929T100000Z-42--workspace-acmeclient";

function deps(bringupStdout: string) {
  const calls: Array<{ cmd: string; env?: Record<string, string> }> = [];
  const d: ProvisionDeps = {
    sbExec: vi.fn(async (cmd: string, env?: Record<string, string>) => {
      calls.push({ cmd, env });
      return cmd === BRINGUP_CMD ? { code: 0, stdout: bringupStdout, stderr: "" } : { code: 0, stdout: "", stderr: "" };
    }),
    recordStudio: async () => {},
    now: () => NOW,
    fetchBlueprintFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "fleet.json") return JSON.stringify({ blueprint: { repo: "example-org/fleet", ref: "main" }, roles: ["scratch"], instance_type: "standard-2" });
      if (path === "fleet/blueprint/org.json") return JSON.stringify({ edges: {}, gates: {} });
      if (path.startsWith("fleet/blueprint/studios/")) throw new Error(`fetch ${path}@main failed (404): Not Found`);
      return "---\nname: scratch\nskills: []\nallowedTools: Bash(git *)\nmay_spawn: []\nreports_to: operator\ngates: []\n---\nhi\n";
    }),
  };
  return { d, calls };
}

describe("runProvision — freshSession (issue #28)", () => {
  it("skips the adopt, sets FLEET_FRESH_SESSION=1 on THIS bring-up only, and names where the old session went", async () => {
    const { d, calls } = deps(`${FRESH_SESSION_MARKER} moved ${ASIDE}\n`);
    const { status, roleEnv } = await runProvision(d, { repo: REPO, role: "scratch", freshSession: true }, "example-org/acmeclient", null);

    expect(calls.map((c) => c.cmd)).not.toContain(ADOPT_CMD);
    const bringup = calls.find((c) => c.cmd === BRINGUP_CMD)!;
    expect(bringup.env?.FLEET_FRESH_SESSION).toBe("1");
    // The persisted env is replayed by every later restart/heal: never in it.
    expect(roleEnv).not.toBeNull();
    expect(roleEnv as Record<string, string>).not.toHaveProperty("FLEET_FRESH_SESSION");
    expect(status.state).toBe("running");
    expect(status.error).toContain(ASIDE);
    expect(status.sessionAdoption).toBeNull();
  });

  it("flag honored with nothing to move: says so on the row", async () => {
    const { d } = deps(`${FRESH_SESSION_MARKER} none\n`);
    const { status } = await runProvision(d, { repo: REPO, role: "scratch", freshSession: true }, "example-org/acmeclient", null);
    expect(status.state).toBe("running");
    expect(status.error).toContain("no old session to move aside");
  });

  it("flag set but bring-up never confirmed it (older image): the row says so, loudly", async () => {
    const { d } = deps("");
    const { status } = await runProvision(d, { repo: REPO, role: "scratch", freshSession: true }, "example-org/acmeclient", null);
    expect(status.error).toContain("fresh session not confirmed");
  });

  it("a failed move is reported, never read as a clean one", async () => {
    const { d } = deps(`${FRESH_SESSION_MARKER} failed /root/.claude/projects/-workspace-acmeclient/x.jsonl\n`);
    const { status } = await runProvision(d, { repo: REPO, role: "scratch", freshSession: true }, "example-org/acmeclient", null);
    expect(status.error).toContain("could not move");
    expect(status.error).toContain("x.jsonl");
  });

  it("no flag: adopt runs, no FLEET_FRESH_SESSION, no note", async () => {
    const { d, calls } = deps("");
    const { status } = await runProvision(d, { repo: REPO, role: "scratch" }, "example-org/acmeclient", null);
    expect(calls.map((c) => c.cmd)).toContain(ADOPT_CMD);
    expect(calls.find((c) => c.cmd === BRINGUP_CMD)!.env).not.toHaveProperty("FLEET_FRESH_SESSION");
    expect(status.error).toBeNull();
  });
});

// Issue #37: the old session leaves the main tar (it ships as its own aside
// archive), so the sync guard's baseline — the old session's newest file —
// is gone from every later candidate and would displace them all. A fresh
// bring-up that moved something arms the one-shot force upload; the old
// `latest` is kept under superseded/ by that upload itself.
describe("provisionWithStorage — freshSession arms the force upload (issue #37)", () => {
  function mapStorage() {
    const map = new Map<string, unknown>();
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    } as StudioStorage;
    return { map, storage };
  }

  it("moved something: SESSION_FORCE_KEY armed; the note names where it ships", async () => {
    const { d } = deps(`${FRESH_SESSION_MARKER} moved ${ASIDE}\n`);
    const { map, storage } = mapStorage();
    const status = await provisionWithStorage(d, storage, { repo: REPO, role: "scratch", freshSession: true }, "example-org/acmeclient");
    expect(map.get(SESSION_FORCE_KEY)).toBe(true);
    expect(status.error).toContain(`sessions/${REPO}--scratch/aside/`);
    // PR #46 review: the row says the override is armed, like clear-session-guard.
    expect(status.sessionForceArmedAt).toBe(NOW);
  });

  it("nothing moved, not confirmed, or no flag: not armed", async () => {
    for (const [stdout, fresh] of [
      [`${FRESH_SESSION_MARKER} none\n`, true], ["", true], ["", false],
      // PR #46 review: every move failed — nothing left the tar, nothing to force.
      [`${FRESH_SESSION_MARKER} failed /root/.claude/projects/-workspace-acmeclient/x.jsonl\n`, true],
    ] as const) {
      const { d } = deps(stdout);
      const { map, storage } = mapStorage();
      await provisionWithStorage(d, storage, { repo: REPO, role: "scratch", ...(fresh ? { freshSession: true } : {}) }, "example-org/acmeclient");
      expect(map.has(SESSION_FORCE_KEY)).toBe(false);
    }
  });
});
