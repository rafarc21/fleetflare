import { describe, it, expect, vi } from "vitest";
import {
  adoptWorktreeSessionCmd, runProvision, provisionWithStorage, BRINGUP_CMD, FRESH_SESSION_MARKER,
  FRESH_SESSION_PENDING_KEY,
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
    for (const [stdout, fresh, expectedPending] of [
      // Flag honored, nothing to move: vacuously satisfied — pending clears.
      [`${FRESH_SESSION_MARKER} none\n`, true, false],
      // Review round 1 (issue #100): bring-up exits 0 (status.state stays
      // "running") but prints no FLEET_SESSION_FRESH line at all — the move
      // was never confirmed, so FRESH_SESSION_PENDING_KEY must stay armed so
      // a LATER flagless retry still forces fresh, not silently resume.
      ["", true, true],
      ["", false, undefined],
      // PR #46 review: every move failed — nothing left the tar, nothing to force.
      // Review round 1 (issue #100): a failed move is not a confirmed one
      // either — pending must stay armed here too, same reasoning as above.
      [`${FRESH_SESSION_MARKER} failed /root/.claude/projects/-workspace-acmeclient/x.jsonl\n`, true, true],
    ] as const) {
      const { d } = deps(stdout);
      const { map, storage } = mapStorage();
      const status = await provisionWithStorage(d, storage, { repo: REPO, role: "scratch", ...(fresh ? { freshSession: true } : {}) }, "example-org/acmeclient");
      expect(status.state).toBe("running");
      expect(map.has(SESSION_FORCE_KEY)).toBe(false);
      expect(map.get(FRESH_SESSION_PENDING_KEY)).toBe(expectedPending);
    }
  });
});

// Issue #100: a --fresh-session provision whose bring-up exec fails mid-way
// (a real 500, timeout, or any other throw) must not silently drop the
// operator's fresh-session intent — the NEXT plain `fleet provision` (no
// flag) must still apply it, not resume whatever stale session the
// container happens to hold. See FRESH_SESSION_PENDING_KEY's own doc
// comment (provision.ts) for the mechanism.
describe("provisionWithStorage — a failed --fresh-session attempt stays pending (issue #100)", () => {
  function mapStorage() {
    const map = new Map<string, unknown>();
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    } as StudioStorage;
    return { map, storage };
  }

  /** Same fixture as `deps()` above, except the bring-up exec fails on its
   *  FIRST call (a real exec failure — "the route 500s mid-way", the
   *  issue's own test spec) and succeeds on every call after. */
  function flakyBringupDeps(bringupStdoutOnceHealthy: string) {
    const calls: Array<{ cmd: string; env?: Record<string, string> }> = [];
    let bringupCalls = 0;
    const d: ProvisionDeps = {
      sbExec: vi.fn(async (cmd: string, env?: Record<string, string>) => {
        calls.push({ cmd, env });
        if (cmd === BRINGUP_CMD) {
          bringupCalls++;
          if (bringupCalls === 1) return { code: 1, stdout: "", stderr: "bring-up died: HTTP error! status: 500" };
          return { code: 0, stdout: bringupStdoutOnceHealthy, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
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

  it("the retry (no flag) still skips adopt, sets FLEET_FRESH_SESSION=1, and reports success — never a silent resume", async () => {
    const { d, calls } = flakyBringupDeps(`${FRESH_SESSION_MARKER} moved ${ASIDE}\n`);
    const { map, storage } = mapStorage();

    // 1) operator asks for a fresh session; the bring-up exec 500s mid-way.
    const first = await provisionWithStorage(d, storage, { repo: REPO, role: "scratch", freshSession: true }, "example-org/acmeclient");
    expect(first.state).toBe("degraded");
    expect(map.get(FRESH_SESSION_PENDING_KEY)).toBe(true);
    // Issue #115: the returned/persisted row mirrors the pending marker too.
    expect(first.freshSessionPending).toBe(true);

    // 2) operator retries WITHOUT --fresh-session, exactly per the field
    // report ("retry `fleet provision <id>` (no flag)").
    calls.length = 0;
    const second = await provisionWithStorage(d, storage, { repo: REPO, role: "scratch" }, "example-org/acmeclient");

    expect(calls.map((c) => c.cmd)).not.toContain(ADOPT_CMD);
    const bringup = calls.find((c) => c.cmd === BRINGUP_CMD)!;
    expect(bringup.env?.FLEET_FRESH_SESSION).toBe("1");
    expect(second.state).toBe("running");
    expect(second.error).toContain(ASIDE);
    expect(map.get(FRESH_SESSION_PENDING_KEY)).toBe(false);
    expect(second.freshSessionPending).toBe(false);
  });
});

// Issue #115: "add cancel path + show in fleet ls" — a stuck
// FRESH_SESSION_PENDING_KEY previously had no way to be cleared other than a
// SUCCESSFUL, CONFIRMED fresh-session attempt. `cfg.cancelFreshSession`
// (`fleet provision <id> --no-fresh-session`) clears it explicitly, before
// runProvision ever runs, and wins over any freshSession request also
// present on the same call.
describe("provisionWithStorage — cfg.cancelFreshSession clears a stuck pending intent (issue #115)", () => {
  function mapStorage() {
    const map = new Map<string, unknown>();
    const storage = {
      get: (async (k: string) => map.get(k)) as StudioStorage["get"],
      put: (async (k: string, v: unknown) => { map.set(k, v); }) as StudioStorage["put"],
    } as StudioStorage;
    return { map, storage };
  }

  it("clears an armed FRESH_SESSION_PENDING_KEY UNCONDITIONALLY, before runProvision ever runs, and the retry is an ordinary (non-fresh) call", async () => {
    const { d, calls } = deps("");
    const { map, storage } = mapStorage();
    // Arm the marker directly, as a prior failed --fresh-session attempt would.
    await storage.put(FRESH_SESSION_PENDING_KEY, true);

    const status = await provisionWithStorage(
      d, storage, { repo: REPO, role: "scratch", cancelFreshSession: true }, "example-org/acmeclient",
    );

    expect(calls.map((c) => c.cmd)).toContain(ADOPT_CMD);
    expect(calls.find((c) => c.cmd === BRINGUP_CMD)!.env).not.toHaveProperty("FLEET_FRESH_SESSION");
    expect(status.state).toBe("running");
    expect(map.get(FRESH_SESSION_PENDING_KEY)).toBe(false);
    expect(status.freshSessionPending).toBe(false);
  });

  it("cancelling an already-clear pending intent is a safe no-op", async () => {
    const { d, calls } = deps("");
    const { map, storage } = mapStorage();

    const status = await provisionWithStorage(
      d, storage, { repo: REPO, role: "scratch", cancelFreshSession: true }, "example-org/acmeclient",
    );

    expect(calls.map((c) => c.cmd)).toContain(ADOPT_CMD);
    expect(status.state).toBe("running");
    expect(map.get(FRESH_SESSION_PENDING_KEY)).toBe(false);
    expect(status.freshSessionPending).toBe(false);
  });

  it("cancel wins over freshSession also present on the same call — never both honored", async () => {
    const { d, calls } = deps(`${FRESH_SESSION_MARKER} moved ${ASIDE}\n`);
    const { map, storage } = mapStorage();

    const status = await provisionWithStorage(
      d, storage, { repo: REPO, role: "scratch", freshSession: true, cancelFreshSession: true }, "example-org/acmeclient",
    );

    expect(calls.map((c) => c.cmd)).toContain(ADOPT_CMD);
    expect(calls.find((c) => c.cmd === BRINGUP_CMD)!.env).not.toHaveProperty("FLEET_FRESH_SESSION");
    expect(status.state).toBe("running");
    expect(map.get(FRESH_SESSION_PENDING_KEY)).toBe(false);
    expect(status.freshSessionPending).toBe(false);
  });
});
