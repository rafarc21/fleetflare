import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  runRefreshCredential, runRefreshToken, refreshWithStorage,
  credentialWriteCmd, credentialClearCmd, tokenEnv, FLEET_TOKEN_ENV, REFRESH_SECONDS, studioEnvVars, readTailscaleHost, type RefreshDeps,
  ensureSpawnToken, loadOrMintSpawnToken, SPAWN_TOKEN_KEY, type SpawnTokenStorage,
} from "../src/studio/do";
import { hashSpawnToken } from "../src/studio/org";
import { realDoClassForRole } from "../src/studio/profile";
import { writeProxyConfigCmd } from "../src/write-proxy/container-config";
import {
  provisionWithStorage, restartWithStorage, STATUS_KEY, ROLE_ENV_KEY,
  type ProvisionDeps, type StudioStorage, type RoleEnv,
  type HealAttempt,
  type OperationInFlight,
} from "../src/studio/provision";
import { recordStudio, listStudios } from "../src/studio/registry";
import type { StudioStatus, ProvisionConfig } from "../src/studio/types";
import type { Env } from "../src/env";

// A live StudioDO cannot be constructed under vitest-pool-workers (see
// src/studio/provision.ts's header, and src/studio/do.ts's own header) — so
// this file, like test/studio.routes.test.ts, targets the exported pure
// functions do.ts's real provision()/refreshToken() methods are thin
// wrappers around, not the class itself.

const STUDIO_ID = "websites--pilot";
const NOW_ISO = "2026-08-16T00:10:00.000Z";

// Task 11: canned blueprint content — same shape/purpose as
// test/studio.routes.test.ts's own fakeFetchBlueprintFile (kept local
// rather than shared, matching this file's existing convention of
// redefining its own fakeStorage/fakeScheduler rather than importing
// test/studio.routes.test.ts's). None of the tests below exercise the
// blueprint fetch's OWN behavior (that's test/studio.blueprint.test.ts and
// test/studio.routes.test.ts's job) — this just needs to round-trip through
// the real parseFleetJson/parseRoleFile so provision keeps landing on
// state:"running", the same reason it needs a working sbExec/recordStudio.
const FAKE_FLEET_JSON = JSON.stringify({
  blueprint: { repo: "acme-org/websites", ref: "main" }, roles: ["pilot"], instance_type: "standard-2",
});
const FAKE_ROLE_MD = `---
name: pilot
skills: []
allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write
may_spawn: []
reports_to: operator
gates: []
---
You are pilot. Work carefully.
`;
const FAKE_ORG_JSON = JSON.stringify({ edges: { cto: ["release"] }, gates: { merge: ["release"] } });

function fakeFetchBlueprintFile(): ProvisionDeps["fetchBlueprintFile"] {
  return vi.fn(async (_repo: string, path: string) => {
    if (path.endsWith("fleet.json")) return FAKE_FLEET_JSON;
    if (path.endsWith("org.json")) return FAKE_ORG_JSON;
    return FAKE_ROLE_MD;
  });
}

// Same shape as test/studio.routes.test.ts's — see its comment for why `get`
// carries a cast and `put` does not. `| boolean` (Task 4, R-P3-6) covers
// KEEP_ALIVE_KEY, the same one-Map-behind-every-key shape as everything else.
function fakeStorage(): StudioStorage & SpawnTokenStorage {
  const map = new Map<string, StudioStatus | RoleEnv | string | number | boolean | HealAttempt | OperationInFlight | null>();
  return {
    get: (async (key: string) => map.get(key)) as (StudioStorage & SpawnTokenStorage)["get"],
    put: async (key: string, value: StudioStatus | RoleEnv | string | number | boolean | HealAttempt | OperationInFlight | null) => {
      map.set(key, value);
    },
  };
}

function status(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: STUDIO_ID, state: "running", tailscaleHost: null, lastRefresh: "2026-08-15T00:00:00.000Z", error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
    ...overrides,
  };
}

/**
 * Mirrors do.ts's real StudioDO.schedule()/deleteSchedules() — the platform
 * methods a live DO would call. `active` is a plain array a test can
 * inspect directly; `deleteSchedules` mutates it in place, matching the
 * real base class's "remove every pending row with this callback name"
 * semantics (confirmed identical on both the top-level and nested
 * @cloudflare/containers packages — see task-7-report.md). Review round 1,
 * I1: the ORIGINAL fake here just pushed onto an unbounded array with no
 * delete concept at all, so it could not have caught a real do.ts that
 * forgot to call deleteSchedules — this version can.
 */
function fakeScheduler() {
  const active: { delaySeconds: number; name: string }[] = [];
  return {
    schedule(delaySeconds: number, name: string) {
      active.push({ delaySeconds, name });
    },
    deleteSchedules(name: string) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].name === name) active.splice(i, 1);
      }
    },
    active,
  };
}

/** notified[] captures every deps.notify call — the fake stands in for
 *  do.ts's real refreshDeps(), which plugs sendCard(env.TELEGRAM_BOT_TOKEN,
 *  OPERATOR_ID, message) into this same slot. Injected (not a real
 *  fetch-hitting sendCard) the same way ProvisionDeps.sbExec/recordStudio
 *  are injected rather than called directly — this feature's established DI
 *  style throughout src/studio/. */
function fakeRefreshDeps(overrides: Partial<RefreshDeps> = {}): RefreshDeps & { notified: string[] } {
  const notified: string[] = [];
  return {
    mintToken: vi.fn(async () => "ghs_freshtoken000"),
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: vi.fn(async () => {}),
    notify: vi.fn(async (message: string) => {
      notified.push(message);
    }),
    now: () => NOW_ISO,
    notified,
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("credentialWriteCmd", () => {
  it("carries no token in the command text — argv and a `Killed <cmd>` line would expose it (#110 review)", () => {
    expect(credentialWriteCmd()).not.toMatch(/ghs_|github_pat_/);
    expect(tokenEnv("ghs_abc123XYZ")).toEqual({ [FLEET_TOKEN_ENV]: "ghs_abc123XYZ" });
  });

  it("embeds the token in https://x-access-token:<TOKEN>@github.com form, writes /workspace/.git-credentials, and points credential.helper at that EXACT file via --file= (C1: bare 'store' reads $HOME/.git-credentials, and container HOME is /root, not /workspace)", () => {
    const cmd = credentialWriteCmd();
    // #110 review: the token rides the exec's env, never the command text.
    expect(cmd).toContain(`"https://x-access-token:$${FLEET_TOKEN_ENV}@github.com"`);
    expect(cmd).toContain("/workspace/.git-credentials");
    expect(cmd).toContain("git config --global credential.helper 'store --file=/workspace/.git-credentials'");
  });

  it("also authenticates gh with the SAME token, so the pilot's Bash(gh *) is not unauthenticated (review round 3, I3)", () => {
    const cmd = credentialWriteCmd();
    // gh's own config files, not `gh auth login --with-token` — see
    // credentialWriteCmd's doc comment for the measurements behind that.
    expect(cmd).toContain('mkdir -p "$HOME/.config/gh"');
    expect(cmd).toContain('> "$HOME/.config/gh/hosts.yml"');
    expect(cmd).toContain("oauth_token: %s");
    expect(cmd).toContain("user: x-access-token");
    // The token reaches BOTH printf arguments (hosts.yml carries it twice:
    // once under users.<login>, once at host level — gh reads the first and
    // older gh reads the second).
    expect(cmd).toContain(`"$${FLEET_TOKEN_ENV}" "$${FLEET_TOKEN_ENV}"`);
  });

  it("pins gh's config version so gh does not abort every command on its multi-account migration", () => {
    // Measured with gh 2.95: with no `version` in config.yml, EVERY gh
    // invocation dies with "failed to migrate config: cowardly refusing to
    // continue with multi account migration", because the migration resolves
    // a username over the network — which an installation token cannot do.
    expect(credentialWriteCmd()).toContain(`printf 'version: "1"\\n' > "$HOME/.config/gh/config.yml"`);
  });

  it("keeps the token file private (hosts.yml is chmod 600)", () => {
    expect(credentialWriteCmd()).toContain(`chmod 600 "$HOME/.config/gh/hosts.yml"`);
  });

  it("chains every step with && so a failed gh write degrades the studio instead of passing silently", () => {
    const cmd = credentialWriteCmd();
    expect(cmd.split(" && ")).toHaveLength(6);
    // The git credential write stays FIRST: provision runs this before the
    // guarded clone, and a private AGENT_REPO's clone needs that file.
    expect(cmd.indexOf("/workspace/.git-credentials")).toBeLessThan(cmd.indexOf(".config/gh"));
  });
});

describe("runRefreshCredential", () => {
  it("mints a token and execs the credential write; the token rides env, never the command", async () => {
    const calls: string[] = [];
    const deps = fakeRefreshDeps({
      mintToken: vi.fn(async () => "ghs_capturedtoken"),
      sbExec: vi.fn(async (cmd: string) => {
        calls.push(cmd);
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    const result = await runRefreshCredential(deps);
    expect(result).toEqual({ ok: true, lastRefresh: NOW_ISO });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("ghs_capturedtoken");
    expect(deps.sbExec).toHaveBeenCalledWith(credentialWriteCmd(), tokenEnv("ghs_capturedtoken"));
  });

  // Issue #7: proxy mode with no read token. The write credential must not
  // survive in the container, so the files are cleared, not left stale.
  it("a null token clears the credential files instead of writing one", async () => {
    const deps = fakeRefreshDeps({ mintToken: vi.fn(async () => null) });
    const result = await runRefreshCredential(deps);
    expect(result).toEqual({ ok: true, lastRefresh: NOW_ISO });
    expect(deps.sbExec).toHaveBeenCalledWith(credentialClearCmd());
  });

  // #13 review, HIGH: the credential refresh (every 50 min) must never leave
  // a studio with a read-only credential and no proxy config. The mode is
  // resolved ONCE; its git config goes in first; a failed proxy config means
  // the credential is not swapped at all.
  describe("write proxy mode (issue #7)", () => {
    const URL = "https://fleet.example.workers.dev";

    it("proxy: config exec'd BEFORE the credential, mint told the mode", async () => {
      const calls: string[] = [];
      const deps = fakeRefreshDeps({
        writeProxy: { workerUrl: URL, mode: vi.fn(async () => "proxy" as const) },
        mintToken: vi.fn(async () => "ghs_read"),
        sbExec: vi.fn(async (cmd: string) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; }),
      });
      expect((await runRefreshCredential(deps)).ok).toBe(true);
      expect(calls).toEqual([writeProxyConfigCmd("proxy", URL), credentialWriteCmd()]);
      expect(deps.mintToken).toHaveBeenCalledWith("proxy");
    });

    it("proxy config fails: refresh fails, credential NOT swapped, nothing minted", async () => {
      const calls: string[] = [];
      const deps = fakeRefreshDeps({
        writeProxy: { workerUrl: URL, mode: vi.fn(async () => "proxy" as const) },
        sbExec: vi.fn(async (cmd: string) => {
          calls.push(cmd);
          return cmd === writeProxyConfigCmd("proxy", URL) ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" };
        }),
      });
      const result = await runRefreshCredential(deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("write proxy config failed");
      expect(calls).toEqual([writeProxyConfigCmd("proxy", URL)]);
      expect(deps.mintToken).not.toHaveBeenCalled();
    });

    it("direct: proxy keys removed, then the credential as before", async () => {
      const calls: string[] = [];
      const deps = fakeRefreshDeps({
        writeProxy: { workerUrl: URL, mode: vi.fn(async () => "direct" as const) },
        sbExec: vi.fn(async (cmd: string) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; }),
      });
      expect((await runRefreshCredential(deps)).ok).toBe(true);
      expect(calls).toEqual([writeProxyConfigCmd("direct", URL), credentialWriteCmd()]);
      expect(deps.mintToken).toHaveBeenCalledWith("direct");
    });
  });

  it("a non-zero sbExec exit becomes ok:false with a stderr-derived error", async () => {
    const deps = fakeRefreshDeps({
      sbExec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "permission denied" })),
    });
    const result = await runRefreshCredential(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permission denied");
  });

  // This scrub is LOAD-BEARING, not belt-and-braces (see the doc comment on
  // runRefreshCredential itself): a shell syntax error can make bash echo
  // the failing line — including the embedded token — verbatim into
  // stderr, so a token-shaped string reaching `err.message` is a real path,
  // not a hypothetical one.
  it("scrubs a token-shaped string out of a thrown mint error before it is ever returned", async () => {
    const deps = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("installation token failed (401): ghs_leakedTokenValue123 already used");
      }),
    });
    const result = await runRefreshCredential(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("ghs_leakedTokenValue123");
      expect(result.error).not.toContain("ghs_");
    }
  });

  it("scrubs a token-shaped string echoed back verbatim in stderr (the realistic bash-syntax-error leak path, not just a thrown mint error)", async () => {
    const deps = fakeRefreshDeps({
      sbExec: vi.fn(async () => ({
        code: 2,
        stdout: "",
        stderr: "bash: -c: line 1: syntax error near `x-access-token:ghs_echoedbacktoken@github'",
      })),
    });
    const result = await runRefreshCredential(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("ghs_echoedbacktoken");
  });
});

// Task 6 (P2 ride-along, tailscaleHost): the refresh tick's read of
// /workspace/.ts-host, written by container/studio-bringup.sh (guarded
// there — absent tailscale, or not up yet, just skips the write). Kept as
// its own sbExec call, separate from runRefreshCredential's — that
// command's exit code is load-bearing (its own res.code !== 0 check above),
// and a merely-missing ts-host file must never read as "credential write
// failed".
describe("readTailscaleHost", () => {
  it("returns the trimmed stdout as the host when the read succeeds with content", async () => {
    const sbExec = vi.fn(async () => ({ code: 0, stdout: "studio-pilot.tailnet-1234.ts.net\n", stderr: "" }));
    const result = await readTailscaleHost(sbExec);
    expect(result).toEqual({ ok: true, host: "studio-pilot.tailnet-1234.ts.net" });
  });

  it("absent (non-zero exit, no such file) reads as ok:true, host:null — not an error", async () => {
    const sbExec = vi.fn(async () => ({
      code: 1, stdout: "", stderr: "cat: /workspace/.ts-host: No such file or directory",
    }));
    const result = await readTailscaleHost(sbExec);
    expect(result).toEqual({ ok: true, host: null });
  });

  it("a zero exit with empty stdout (file present but blank) also reads as host:null", async () => {
    const sbExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const result = await readTailscaleHost(sbExec);
    expect(result).toEqual({ ok: true, host: null });
  });

  it("a deadline exit (124/137) is UNKNOWN: ok:false, never a cleared host (#110 review)", async () => {
    for (const code of [124, 137]) {
      const sbExec = vi.fn(async () => ({ code, stdout: "", stderr: "" }));
      await expect(readTailscaleHost(sbExec)).resolves.toEqual({ ok: false });
    }
  });

  it("sbExec itself throwing (a container communication failure, not a shell exit code) returns ok:false and does not throw", async () => {
    const sbExec = vi.fn(async () => {
      throw new Error("container unavailable");
    });
    await expect(readTailscaleHost(sbExec)).resolves.toEqual({ ok: false });
  });
});

describe("runRefreshToken", () => {
  it("success on a healthy studio: bumps lastRefresh, clears lastRefreshError (already null), leaves state/error/other fields alone", async () => {
    // Task 6: the tick now ALSO reads /workspace/.ts-host every time (a
    // second, separate sbExec call — see readTailscaleHost) — the default
    // fakeRefreshDeps() sbExec answers every command with empty stdout,
    // which reads as "absent" for that read and would null out the
    // existing host below. Command-aware here so this test still
    // demonstrates its own point (lastRefresh/error/lastRefreshError are
    // the only things a healthy refresh changes) without also asserting
    // something readTailscaleHost's own dedicated tests already cover.
    const deps = fakeRefreshDeps({
      sbExec: vi.fn(async (cmd: string) =>
        cmd.includes(".ts-host") ? { code: 0, stdout: "100.64.0.1\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
      ),
    });
    const existing = status({
      state: "running", tailscaleHost: "100.64.0.1", error: null, lastRefreshError: null,
    });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.state).toBe("running");
    expect(next.lastRefresh).toBe(NOW_ISO);
    expect(next.error).toBeNull();
    expect(next.lastRefreshError).toBeNull();
    expect(next.tailscaleHost).toBe("100.64.0.1");
    expect(deps.notified).toHaveLength(0);
  });

  // C2: `state`/`error` are a channel provision/restart ALSO write. Before
  // this fix, a successful refresh unconditionally stamped state:"running",
  // error:null — silently erasing a degradation refresh never caused (here,
  // a failed clone) and reporting a studio as healthy when its checkout was
  // never actually cloned.
  it("C2: a successful refresh does NOT erase a degradation it did not cause (e.g. a failed clone)", async () => {
    const deps = fakeRefreshDeps();
    const existing = status({
      state: "degraded", error: "clone failed (128): auth error", lastRefreshError: null,
    });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.state).toBe("degraded"); // untouched: refresh cannot fix a checkout it never cloned
    expect(next.error).toBe("clone failed (128): auth error"); // untouched
    expect(next.lastRefreshError).toBeNull(); // still cleared — refresh's own channel
    expect(next.lastRefresh).toBe(NOW_ISO); // the mint+write itself did succeed
  });

  it("C2: a successful refresh DOES clear a degradation it caused itself (error === the lastRefreshError it previously wrote)", async () => {
    const deps = fakeRefreshDeps();
    const existing = status({
      state: "degraded", error: "credential write failed: boom", lastRefreshError: "credential write failed: boom",
    });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.state).toBe("running");
    expect(next.error).toBeNull();
    expect(next.lastRefreshError).toBeNull();
  });

  it("mint-throw: degrades, stores the SAME scrubbed error in both error and lastRefreshError, alerts telegram exactly once", async () => {
    const deps = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("GitHub App not configured");
      }),
    });
    const existing = status({ state: "running", error: null, lastRefreshError: null });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.state).toBe("degraded");
    expect(next.error).toContain("GitHub App not configured");
    expect(next.lastRefreshError).toBe(next.error);
    expect(deps.notified).toHaveLength(1);
    expect(deps.notified[0]).toContain(STUDIO_ID);
  });

  // C2 regression test for the exact bug the review named: the OLD code
  // used `state !== "degraded"` to decide whether to alert, so a studio
  // already degraded for an unrelated reason (a failed clone, here) made
  // refresh's own FIRST failure look like an already-alerted streak and
  // silently never notified. lastRefreshError is refresh's private
  // channel, independent of `state`, so this now alerts correctly.
  it("C2 regression: a refresh failure alerts even when the studio is ALREADY degraded for an unrelated reason", async () => {
    const deps = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("still misconfigured");
      }),
    });
    const existing = status({
      state: "degraded", error: "clone failed (128): auth error", lastRefreshError: null,
    });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.state).toBe("degraded");
    expect(next.lastRefreshError).toContain("still misconfigured");
    expect(deps.notified).toHaveLength(1); // must alert — this IS refresh's first failure
  });

  it("a second consecutive failure does not alert a second time", async () => {
    const deps = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("still broken");
      }),
    });
    const first = await runRefreshToken(deps, status({ state: "running" }), STUDIO_ID);
    expect(first.state).toBe("degraded");
    expect(first.lastRefreshError).toContain("still broken");
    expect(deps.notified).toHaveLength(1);

    // Second call, fed the FIRST call's own (already-degraded,
    // lastRefreshError-set) output — the same existing-status-in shape
    // do.ts's real refreshWithStorage feeds it on the next scheduled cycle.
    const second = await runRefreshToken(deps, first, STUDIO_ID);
    expect(second.state).toBe("degraded");
    expect(deps.notified).toHaveLength(1); // still just the one
  });

  it("a failure after a recovery alerts again — success resets the lastRefreshError streak", async () => {
    const mintToken = vi.fn();
    const deps = fakeRefreshDeps({ mintToken });

    mintToken.mockRejectedValueOnce(new Error("boom 1"));
    const afterFirstFailure = await runRefreshToken(deps, status({ state: "running" }), STUDIO_ID);
    expect(afterFirstFailure.state).toBe("degraded");
    expect(deps.notified).toHaveLength(1);

    mintToken.mockResolvedValueOnce("ghs_recoverytoken");
    const afterRecovery = await runRefreshToken(deps, afterFirstFailure, STUDIO_ID);
    expect(afterRecovery.state).toBe("running"); // ownsDegradation: error === lastRefreshError from the prior failure
    expect(afterRecovery.error).toBeNull();
    expect(afterRecovery.lastRefreshError).toBeNull();
    expect(deps.notified).toHaveLength(1); // recovery itself does not alert

    mintToken.mockRejectedValueOnce(new Error("boom 2"));
    const afterSecondFailure = await runRefreshToken(deps, afterRecovery, STUDIO_ID);
    expect(afterSecondFailure.state).toBe("degraded");
    expect(deps.notified).toHaveLength(2); // new streak, alerts again
  });

  it("existing null (defensive: refreshToken firing with nothing in storage) still produces a usable status instead of throwing", async () => {
    const deps = fakeRefreshDeps();
    const next = await runRefreshToken(deps, null, STUDIO_ID);
    expect(next.id).toBe(STUDIO_ID);
    // ownsDegradation is false (lastRefreshError starts null), so state is
    // left at the synthetic fallback's "provisioning" rather than forced to
    // "running" — a synthetic, not a realistic, input (see fallback's own
    // doc comment on runRefreshToken); the only real requirement is "does
    // not throw, id is right."
    expect(next.state).toBe("provisioning");
    expect(next.lastRefreshError).toBeNull();
  });

  // Task 6 (P2 ride-along): the tick also reads /workspace/.ts-host
  // (readTailscaleHost above) and folds the result into status.tailscaleHost
  // — independent of whether the credential mint/write itself succeeded.
  it("Task 6: a present ts-host file carries the fresh host into status.tailscaleHost", async () => {
    const deps = fakeRefreshDeps({
      sbExec: vi.fn(async (cmd: string) =>
        cmd.includes(".ts-host")
          ? { code: 0, stdout: "studio-pilot.tailnet-1234.ts.net\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      ),
    });
    const existing = status({ tailscaleHost: null });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.tailscaleHost).toBe("studio-pilot.tailnet-1234.ts.net");
  });

  it("Task 6: an absent ts-host file clears a previously-known host to null", async () => {
    const deps = fakeRefreshDeps({
      sbExec: vi.fn(async (cmd: string) =>
        cmd.includes(".ts-host") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" },
      ),
    });
    const existing = status({ tailscaleHost: "stale.tailnet-1234.ts.net" });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.tailscaleHost).toBeNull();
  });

  it("Task 6: a ts-host read that throws completes the tick normally and leaves the existing host unchanged (not nulled)", async () => {
    const deps = fakeRefreshDeps({
      sbExec: vi.fn(async (cmd: string) => {
        if (cmd.includes(".ts-host")) throw new Error("container communication failed");
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    const existing = status({ tailscaleHost: "still-good.tailnet-1234.ts.net" });
    const next = await runRefreshToken(deps, existing, STUDIO_ID);
    expect(next.tailscaleHost).toBe("still-good.tailnet-1234.ts.net"); // unchanged
    expect(next.lastRefresh).toBe(NOW_ISO); // the tick itself still completed
  });
});

describe("refreshWithStorage", () => {
  it("reads existing STATUS_KEY, writes the computed status back under the same key", async () => {
    const storage = fakeStorage();
    await storage.put(STATUS_KEY, status({ state: "running", lastRefresh: "old" }));
    const deps = fakeRefreshDeps();

    const result = await refreshWithStorage(deps, storage, STUDIO_ID);
    expect(result.lastRefresh).toBe(NOW_ISO);
    expect(await storage.get(STATUS_KEY)).toEqual(result);
  });

  it("also records to the registry (recordStudio) — a real recordStudio, checked against real D1 to prove no raw token or command reaches the stored row", async () => {
    const storage = fakeStorage();
    const capturedCmds: string[] = [];
    const capturedEnvs: (Record<string, string> | undefined)[] = [];
    const deps: RefreshDeps = {
      mintToken: async () => "ghs_realregistrytoken",
      sbExec: async (cmd: string, execEnv?: Record<string, string>) => {
        capturedCmds.push(cmd);
        capturedEnvs.push(execEnv);
        return { code: 0, stdout: "", stderr: "" };
      },
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      notify: async () => {},
      now: () => NOW_ISO,
    };
    await refreshWithStorage(deps, storage, STUDIO_ID);

    // #110 review: the token reaches the container in the exec's env only.
    expect(capturedCmds[0]).not.toContain("ghs_realregistrytoken");
    expect(capturedEnvs[0]).toEqual(tokenEnv("ghs_realregistrytoken"));

    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind(`studio:${STUDIO_ID}`)
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain("ghs_realregistrytoken");
    expect(row!.value).not.toContain(capturedCmds[0]);
  });

  /**
   * I2: refreshWithStorage itself can throw (recordStudio is a real D1
   * write, unguarded) — mirrors do.ts's real refreshToken(), which wraps
   * this exact call in try/finally so the recurring schedule survives a
   * transient failure here instead of dying forever (no studio watchdog
   * exists to notice and re-arm it, unlike AgentDO's cron-driven
   * staleTasks()).
   */
  it("I2: a throw from refreshWithStorage (e.g. a transient recordStudio/D1 failure) still lets the wrapping finally reschedule", async () => {
    const scheduler = fakeScheduler();
    const storage = fakeStorage();
    const deps = fakeRefreshDeps({
      recordStudio: vi.fn(async () => {
        throw new Error("D1 unavailable");
      }),
    });

    async function refreshTokenCycle(): Promise<void> {
      try {
        await refreshWithStorage(deps, storage, STUDIO_ID);
      } finally {
        scheduler.schedule(REFRESH_SECONDS, "refreshToken");
      }
    }

    await expect(refreshTokenCycle()).rejects.toThrow("D1 unavailable");
    expect(scheduler.active).toEqual([{ delaySeconds: REFRESH_SECONDS, name: "refreshToken" }]);
  });
});

// Mirrors do.ts's real provision() method: mint+write the credential
// (through refreshWithStorage — review round 1, I3 — not the bare
// runRefreshCredential) BEFORE the guarded clone (provisionWithStorage's
// own first exec), then deleteSchedules("refreshToken") before scheduling
// the recurring refresh (review round 1, I1). Hand-assembled the same way
// test/studio.routes.test.ts's fakeStudioNamespace is: it calls the SAME
// exported functions do.ts's real method calls, in the SAME order, rather
// than re-implementing their internals — do.ts's own provision() must be
// kept in this order for the two to stay in sync (see task-7-report.md).
function fakeProvisionWithCredential(
  provisionDeps: ProvisionDeps, refreshDeps: RefreshDeps, storage: StudioStorage, scheduler: ReturnType<typeof fakeScheduler>,
) {
  async function provision(cfg: ProvisionConfig, repoSlug: string): Promise<StudioStatus> {
    const id = `${cfg.repo}--${cfg.role}`;
    await refreshWithStorage(refreshDeps, storage, id);
    const result = await provisionWithStorage(provisionDeps, storage, cfg, repoSlug);
    scheduler.deleteSchedules("refreshToken");
    scheduler.schedule(REFRESH_SECONDS, "refreshToken");
    return result;
  }
  return { provision };
}

describe("provision + credential (do.ts's real provision() shape)", () => {
  it("writes the credential before cloning, then schedules the recurring refresh — the credential command itself is never persisted", async () => {
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return { code: 0, stdout: "", stderr: "" };
    });
    const storage = fakeStorage();
    const scheduler = fakeScheduler();
    const provisionDeps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      now: () => "2026-08-16T00:00:00.000Z",
      fetchBlueprintFile: fakeFetchBlueprintFile(),
    };
    const refreshDeps = fakeRefreshDeps({
      mintToken: vi.fn(async () => "ghs_provisiontoken999"),
      sbExec: sbExecFake,
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
    });
    const fake = fakeProvisionWithCredential(provisionDeps, refreshDeps, storage, scheduler);

    const result = await fake.provision({ repo: "websites", role: "pilot", blueprintRef: "main" }, "acme-org/websites");

    expect(result.state).toBe("running");

    // Order: credential write, then the Task 6 ts-host read (both inside
    // refreshWithStorage), then the guarded clone, then board issue #9's
    // rescue-branch-discovery exec, then bring-up, then board issue #28's
    // synchronous POST-bring-up clone-landed re-check ("pilot" is a plain
    // role, so only the clone check runs, never the studio-only
    // ~/.claude/agents check).
    // Issue #116 added the worktree-session adopt exec right before bring-up.
    expect(calls).toHaveLength(7);
    // #110 review: the token rides the exec's env, never the command.
    expect(calls[0]).not.toContain("ghs_provisiontoken999");
    expect(sbExecFake.mock.calls[0]).toEqual([credentialWriteCmd(), tokenEnv("ghs_provisiontoken999")]);
    expect(calls[0]).toContain("/workspace/.git-credentials");
    expect(calls[0]).toContain("store --file=/workspace/.git-credentials"); // C1
    expect(calls[1]).toContain(".ts-host"); // Task 6: readTailscaleHost, its own separate exec
    expect(calls[2]).toContain("git clone");
    expect(calls[3]).toContain("ls-remote --heads origin");
    expect(calls[4]).toContain("FLEET_SESSION_ADOPT");
    expect(calls[5]).toBe("/opt/fleet/studio-bringup.sh");
    expect(calls[6]).toBe("test -d /workspace/websites/.git");

    // The recurring refresh got scheduled, with the brief's exact interval.
    // REFRESH_SECONDS's real do.ts wiring is pinned in the "StudioDO wiring
    // (source-pinned)" describe block below (armTicks/refreshToken rearm).
    expect(scheduler.active).toEqual([{ delaySeconds: 3000, name: "refreshToken" }]);

    // The credential-writing command (token-bearing) is never persisted:
    // not in DO storage, not in the D1-backed registry row.
    const stored = await storage.get(STATUS_KEY);
    expect(JSON.stringify(stored)).not.toContain("ghs_provisiontoken999");
    expect(JSON.stringify(stored)).not.toContain(calls[0]);

    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--pilot")
      .first<{ value: string }>();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain("ghs_provisiontoken999");
    expect(row!.value).not.toContain(calls[0]);
  });

  it("I1: two provisions leave exactly one active refreshToken schedule, not two stacked ones", async () => {
    const sbExecFake = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const storage = fakeStorage();
    const scheduler = fakeScheduler();
    const provisionDeps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      now: () => "2026-08-16T00:00:00.000Z",
      fetchBlueprintFile: fakeFetchBlueprintFile(),
    };
    const refreshDeps = fakeRefreshDeps({ sbExec: sbExecFake });
    const fake = fakeProvisionWithCredential(provisionDeps, refreshDeps, storage, scheduler);
    const cfg: ProvisionConfig = { repo: "websites", role: "pilot", blueprintRef: "main" };

    await fake.provision(cfg, "acme-org/websites");
    await fake.provision(cfg, "acme-org/websites"); // idempotent re-provision — Task 4's own design

    expect(scheduler.active).toEqual([{ delaySeconds: REFRESH_SECONDS, name: "refreshToken" }]);
  });

  it("I3: a provision-time credential mint failure lands in stored status via lastRefreshError (not just a console.error) and alerts telegram, surviving the subsequent clone failure it triggers", async () => {
    const calls: string[] = [];
    const sbExecFake = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      // No credential was ever written (mintToken throws before sbExec is
      // reached for it) — a private repo's clone fails on its own, exactly
      // as provision()'s doc comment describes.
      if (cmd.includes("git clone")) return { code: 128, stdout: "", stderr: "fatal: Authentication failed" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const storage = fakeStorage();
    const scheduler = fakeScheduler();
    const provisionDeps: ProvisionDeps = {
      sbExec: sbExecFake,
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      now: () => "2026-08-16T00:00:00.000Z",
      fetchBlueprintFile: fakeFetchBlueprintFile(),
    };
    const refreshDeps = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("GitHub App not configured");
      }),
      sbExec: sbExecFake,
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
    });
    const fake = fakeProvisionWithCredential(provisionDeps, refreshDeps, storage, scheduler);

    const result = await fake.provision({ repo: "websites", role: "pilot", blueprintRef: "main" }, "acme-org/websites");

    expect(result.state).toBe("degraded");
    expect(result.error).toContain("clone failed"); // the clone's own, downstream failure

    // The credential failure alerted once (new streak).
    expect(refreshDeps.notified).toHaveLength(1);
    expect(refreshDeps.notified[0]).toContain("GitHub App not configured");

    // And it is still visible in stored status via lastRefreshError — NOT
    // erased by provisionWithStorage's later, unrelated write to `error`.
    const row = await env.DB
      .prepare(`SELECT value FROM fleet_state WHERE key = ?`)
      .bind("studio:websites--pilot")
      .first<{ value: string }>();
    const parsed = JSON.parse(row!.value) as StudioStatus;
    expect(parsed.lastRefreshError).toContain("GitHub App not configured");
    expect(parsed.error).not.toBe(parsed.lastRefreshError); // two distinct failures, both preserved
  });
});

// Mirrors do.ts's real restartStudio() method (review round 2, symmetry
// with provision()'s round 1 I3 wiring): the credential step
// (refreshWithStorage) runs BEFORE bring-up (restartWithStorage), same
// shape as fakeProvisionWithCredential above. No scheduler involvement —
// restart doesn't create a new refresh loop, only heals/recreates the tmux
// session; the recurring schedule from the original provision() keeps
// firing on its own regardless.
function fakeRestartWithCredential(
  provisionDeps: ProvisionDeps, refreshDeps: RefreshDeps, storage: StudioStorage,
) {
  async function restart(idFallback: string): Promise<StudioStatus> {
    await refreshWithStorage(refreshDeps, storage, idFallback);
    return restartWithStorage(provisionDeps, storage, idFallback, "rafarc21/fleetflare");
  }
  return { restart };
}

/** Task 12: restart only runs bring-up when provision already persisted a
 *  role env (otherwise it degrades and never execs — see NO_ROLE_ENV_ERROR).
 *  Both tests below are about the credential/lastRefreshError streak, not
 *  about that guard, so they seed the env the way a prior successful
 *  provision would have. */
async function seedRoleEnv(storage: StudioStorage): Promise<void> {
  await storage.put(ROLE_ENV_KEY, {
    ROLE_PROMPT_B64: "WW91IGFyZSBwaWxvdC4=",
    ROLE_ALLOWED_TOOLS: "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write",
    ROLE_EFFORT: "",
  });
}

describe("restartStudio + credential (review round 2: stale lastRefreshError symmetry fix)", () => {
  it("refresh fails (E1, alerts) -> restart succeeds with a working mint -> a LATER refresh failure (E2) alerts again instead of being suppressed by the stale marker", async () => {
    const storage = fakeStorage();

    // E1: a prior refresh failure, already alerted, already persisted —
    // the exact starting point of the reviewer's repro.
    const refreshDepsE1 = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("E1: credential rejected");
      }),
    });
    await refreshWithStorage(refreshDepsE1, storage, STUDIO_ID);
    expect(refreshDepsE1.notified).toHaveLength(1);
    expect((await storage.get(STATUS_KEY))?.lastRefreshError).toContain("E1");

    // restartStudio(): mint now works (e.g. the operator fixed the App, or
    // it was always transient) — bring-up succeeds too, unrelated to auth.
    const restartRefreshDeps = fakeRefreshDeps({ mintToken: vi.fn(async () => "ghs_workingtoken") });
    const restartProvisionDeps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      now: () => "2026-08-16T00:20:00.000Z",
      // runRestart has no ProvisionConfig to resolve a role/ref from and
      // never calls this (see provision.ts's ProvisionDeps doc comment) — a
      // throwing stub turns an accidental future wiring bug into a loud
      // test failure instead of a silent pass.
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("restart must not fetch the blueprint");
      }),
    };
    await seedRoleEnv(storage);
    const fakeRestart = fakeRestartWithCredential(restartProvisionDeps, restartRefreshDeps, storage);
    const afterRestart = await fakeRestart.restart(STUDIO_ID);

    expect(afterRestart.state).toBe("running");
    // The bug this closes: BEFORE the fix, lastRefreshError stayed at "E1"
    // here (runRestart never touches it) — now it's cleared, since the
    // credential step ran and succeeded.
    expect(afterRestart.lastRefreshError).toBeNull();
    expect(restartRefreshDeps.notified).toHaveLength(0); // a success never alerts

    // E2: a later, genuinely new refresh failure — must be treated as a
    // FRESH streak now, not swallowed by a stale "already alerted" marker.
    const refreshDepsE2 = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("E2: different credential problem");
      }),
    });
    const afterE2 = await refreshWithStorage(refreshDepsE2, storage, STUDIO_ID);
    expect(afterE2.lastRefreshError).toContain("E2");
    expect(refreshDepsE2.notified).toHaveLength(1); // the second alert the fix restores
  });

  it("refresh fails (E1, alerts) -> restart's mint ALSO fails even though bring-up succeeds -> no duplicate alert, marker stays current (same ongoing credential streak)", async () => {
    const storage = fakeStorage();

    const refreshDepsE1 = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("E1: credential rejected");
      }),
    });
    await refreshWithStorage(refreshDepsE1, storage, STUDIO_ID);
    expect(refreshDepsE1.notified).toHaveLength(1);

    // restartStudio(): mint STILL fails (the underlying problem never got
    // fixed), but bring-up (recreating the tmux session) succeeds anyway —
    // the two are independent subsystems.
    const restartRefreshDeps = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("still broken at restart time");
      }),
    });
    const restartProvisionDeps: ProvisionDeps = {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), // bring-up succeeds regardless
      recordStudio: (s) => recordStudio(env as unknown as Env, s),
      now: () => "2026-08-16T00:20:00.000Z",
      fetchBlueprintFile: vi.fn(async () => {
        throw new Error("restart must not fetch the blueprint");
      }),
    };
    await seedRoleEnv(storage);
    const fakeRestart = fakeRestartWithCredential(restartProvisionDeps, restartRefreshDeps, storage);
    const afterRestart = await fakeRestart.restart(STUDIO_ID);

    expect(restartRefreshDeps.notified).toHaveLength(0); // NOT a new streak — no duplicate alert
    expect(afterRestart.state).toBe("running"); // bring-up itself did succeed
    expect(afterRestart.lastRefreshError).toContain("still broken at restart time"); // marker stays current, non-null

    // A later refresh failure, still within the SAME ongoing credential
    // streak (lastRefreshError never went null), must not alert either.
    const refreshDepsE2 = fakeRefreshDeps({
      mintToken: vi.fn(async () => {
        throw new Error("E2: same underlying problem, still unresolved");
      }),
    });
    await refreshWithStorage(refreshDepsE2, storage, STUDIO_ID);
    expect(refreshDepsE2.notified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 12: the studio container's own process environment.
//
// Found by reading `tmux show-environment -g` inside a real provisioned
// container (test-integration/attach.e2e.ts asserts on it now): StudioDO
// declared no `envVars` at all, so the container received none of these —
// claude would have started unauthenticated, tailscale would have been
// skipped on every bring-up, and every studio would have claimed the same
// "studio" tailnet hostname. Covered here as a pure function because a
// container-backed DO cannot be constructed under vitest-pool-workers.
// ---------------------------------------------------------------------------
describe("studioEnvVars", () => {
  const base = {
    CLAUDE_CODE_OAUTH_TOKEN: "oat_abc123",
    TS_AUTHKEY: "tskey-auth-kEXAMPLE-realish",
    WORKER_PUBLIC_URL: "https://example-org.demosite.workers.dev",
  } as unknown as Env;
  // Fleet Spawn P3, Task 1: a realistic-shaped token, not the STUDIO_ID
  // constant — keeps assertions honest about which value flows where.
  const SPAWN_TOKEN = "fsp_" + "a".repeat(64);

  it("threads the claude OAuth token, the tailscale auth key, this studio's id and the worker URL", () => {
    expect(studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN)).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oat_abc123",
      TS_AUTHKEY: "tskey-auth-kEXAMPLE-realish",
      STUDIO_ID: STUDIO_ID,
      FLEET_SPAWN_TOKEN: SPAWN_TOKEN,
      FLEET_WORKER_URL: "https://example-org.demosite.workers.dev",
      // Issue #335: absent env.FLEET_BOT_NAME/_EMAIL becomes "" here (same
      // "empty and unset identically" shape as TS_AUTHKEY above) — the
      // container-side fallback to the neutral default is server.ts's own
      // job, not this function's.
      FLEET_BOT_NAME: "",
      FLEET_BOT_EMAIL: "",
    });
  });

  it("threads FLEET_BOT_NAME/_EMAIL through when set, issue #335", () => {
    const vars = studioEnvVars(
      { ...base, FLEET_BOT_NAME: "acme-bot[bot]", FLEET_BOT_EMAIL: "acme-bot[bot]@users.noreply.github.com" } as Env,
      STUDIO_ID, SPAWN_TOKEN,
    );
    expect(vars.FLEET_BOT_NAME).toBe("acme-bot[bot]");
    expect(vars.FLEET_BOT_EMAIL).toBe("acme-bot[bot]@users.noreply.github.com");
  });

  it("an unset TS_AUTHKEY becomes an empty string, which the bring-up guard reads as absent", () => {
    const vars = studioEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: "oat_abc123" } as unknown as Env, STUDIO_ID, SPAWN_TOKEN);
    // Not undefined and not omitted: `envVars` is string-valued, and
    // studio-bringup.sh's `[ -z "${TS_AUTHKEY:-}" ]` treats "" and unset the
    // same way — it logs and skips `tailscale up` instead of failing.
    expect(vars.TS_AUTHKEY).toBe("");
    expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat_abc123");
  });

  it("STUDIO_ID is per-studio, so two studios never share a tailnet hostname", () => {
    expect(studioEnvVars(base, "websites--pilot", SPAWN_TOKEN).STUDIO_ID).toBe("websites--pilot");
    expect(studioEnvVars(base, "websites--scratch", SPAWN_TOKEN).STUDIO_ID).toBe("websites--scratch");
  });

  // Fleet Spawn P3, Task 1 (R-P3-1): the per-studio spawn-auth token —
  // "container env FLEET_SPAWN_TOKEN". This is the one testable seam for
  // that requirement (do.ts's real class methods that mint/store it cannot
  // be constructed under vitest-pool-workers — see this file's own header),
  // the same reason CLAUDE_CODE_OAUTH_TOKEN/TS_AUTHKEY/STUDIO_ID above are
  // covered here and not on StudioDO directly.
  it("threads FLEET_SPAWN_TOKEN through verbatim", () => {
    expect(studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN).FLEET_SPAWN_TOKEN).toBe(SPAWN_TOKEN);
  });

  // Fleet Spawn P3, Task 3: FLEET_WORKER_URL (env.WORKER_PUBLIC_URL,
  // wrangler.jsonc's new committed var) — the address container/studio-fleet
  // POSTs /fleet/spawn to. Same untestable-class reason as every other
  // assertion in this describe block (see its own header).
  it("threads FLEET_WORKER_URL from env.WORKER_PUBLIC_URL verbatim", () => {
    expect(studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN).FLEET_WORKER_URL).toBe(
      "https://example-org.demosite.workers.dev",
    );
  });

  it("studioEnvVars threads through whichever token it's given — two different tokens produce two different FLEET_SPAWN_TOKEN values (not a re-provision/remint claim; do.ts's ensureSpawnToken owns that policy, tested below)", () => {
    const first = studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN);
    const second = studioEnvVars(base, STUDIO_ID, "fsp_" + "b".repeat(64));
    expect(first.FLEET_SPAWN_TOKEN).not.toBe(second.FLEET_SPAWN_TOKEN);
  });

  // Issue #249 — `leadType: "glm"`: no Claude account at all, no
  // CLAUDE_CODE_OAUTH_TOKEN, and the container's claude binary points at
  // this fleet's own GLM-translation route instead, authenticated with the
  // studio's own spawn token (verified live, 2026-10-08: a local echo
  // server under ANTHROPIC_BASE_URL=http://host:port, claude-cli 2.1.224
  // requested POST /v1/messages — the SDK appends "/v1/messages" to
  // ANTHROPIC_BASE_URL itself, so the env var here carries the route's
  // PARENT path, not ANTHROPIC_MESSAGES_PATH verbatim, or the SDK's own
  // append would double it).
  describe("leadType: glm", () => {
    it("omits CLAUDE_CODE_OAUTH_TOKEN and sets ANTHROPIC_AUTH_TOKEN to the studio's own spawn token", () => {
      const vars = studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN, null, "glm");
      expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(vars.ANTHROPIC_AUTH_TOKEN).toBe(SPAWN_TOKEN);
    });

    it("ANTHROPIC_BASE_URL is env.WORKER_PUBLIC_URL + the route's parent path (never the full /v1/messages path)", () => {
      const vars = studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN, null, "glm");
      expect(vars.ANTHROPIC_BASE_URL).toBe("https://example-org.demosite.workers.dev/fleet/llm/anthropic");
    });

    it("every other env var (tailscale, studio id, fleet spawn token/bot identity) is unaffected", () => {
      const vars = studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN, null, "glm");
      expect(vars.TS_AUTHKEY).toBe("tskey-auth-kEXAMPLE-realish");
      expect(vars.STUDIO_ID).toBe(STUDIO_ID);
      expect(vars.FLEET_SPAWN_TOKEN).toBe(SPAWN_TOKEN);
    });

    it("absent/undefined leadType (the default) keeps today's Claude-only shape — no ANTHROPIC_* vars at all", () => {
      const vars = studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN);
      expect(vars.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat_abc123");
    });

    it("leadType: \"claude\" (explicit) is byte-identical to omitting it", () => {
      expect(studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN, null, "claude")).toEqual(studioEnvVars(base, STUDIO_ID, SPAWN_TOKEN, null));
    });
  });

  // Issue #53: a studio that failed over to a second account must come back up
  // on THAT account after a recycle. The container's env comes from the Worker
  // secret, which is precisely why the manual in-container `/login` an
  // operator ran on 2026-09-23 died at the next recycle.
  const ACCOUNT_1_TOKEN = "sk-ant-oat01-" + "a".repeat(40);
  const ACCOUNT_2_TOKEN = "sk-ant-oat01-" + "b".repeat(40);
  // Env declares only CLAUDE_CODE_OAUTH_TOKEN — the alternates are read by
  // computed name (src/studio/accounts.ts), exactly like GITHUB_TOKEN_<OWNER>,
  // so the interface stays closed. Hence the cast, and hence the local
  // constants rather than reading the extra key back off `multi`.
  const multi = {
    CLAUDE_CODE_OAUTH_TOKEN: ACCOUNT_1_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN_2: ACCOUNT_2_TOKEN,
    WORKER_PUBLIC_URL: "https://example-org.demosite.workers.dev",
  } as unknown as Env;

  // Issue #271: only with auto-failover ON — off, nothing moves a studio, and
  // a restart lands on the repo's mapped primary (test/studio.account-by-repo).
  it("launches the container on the account the studio is recorded on, not always the first", () => {
    const vars = studioEnvVars({ ...multi, FLEET_AUTO_FAILOVER: "on" } as Env, STUDIO_ID, SPAWN_TOKEN, "CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBe(ACCOUNT_2_TOKEN);
  });

  it("a studio on no recorded account keeps the first account — every studio that predates issue #53", () => {
    expect(studioEnvVars(multi, STUDIO_ID, SPAWN_TOKEN).CLAUDE_CODE_OAUTH_TOKEN).toBe(ACCOUNT_1_TOKEN);
    expect(studioEnvVars(multi, STUDIO_ID, SPAWN_TOKEN, null).CLAUDE_CODE_OAUTH_TOKEN).toBe(ACCOUNT_1_TOKEN);
  });

  it("an account name whose secret is gone falls back to the first, never to an unset token", () => {
    expect(studioEnvVars(multi, STUDIO_ID, SPAWN_TOKEN, "CLAUDE_CODE_OAUTH_TOKEN_5").CLAUDE_CODE_OAUTH_TOKEN)
      .toBe(ACCOUNT_1_TOKEN);
  });

  it("the second account's token NEVER lands in the container of a studio on the first", () => {
    const vars = studioEnvVars(multi, STUDIO_ID, SPAWN_TOKEN, "CLAUDE_CODE_OAUTH_TOKEN");
    expect(Object.values(vars)).not.toContain(ACCOUNT_2_TOKEN);
    expect(Object.keys(vars)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
  });
});

// ---------------------------------------------------------------------------
// The spawn token's whole lifecycle, in two functions.
//
// loadOrMintSpawnToken is storage-only: read it, mint one ONLY if there is
// none. Task 6 (ruling 2) made it the first thing StudioDO's constructor
// does, so an alarm-woken DO's first exec starts its container with the token
// the registry already knows — hence the "writes nothing but the token"
// assertion below, which is what keeps a bare DO construction from publishing
// a studio row for an id nobody provisioned.
//
// ensureSpawnToken wraps it and publishes the hash. Task 6 (ruling 1) killed
// reminting: the token is now static for a studio's lifetime, so provision
// and restart call the same function and get the same answer, and
// `container env == registry hash` holds by construction instead of by
// timing. Rotation became an operator procedure (delete the key, recycle,
// provision) — see OPERATOR-FINISH-LIST §9.
//
// Both are split out of the class for the usual reason: do.ts's real
// StudioDO cannot be constructed under vitest-pool-workers, so these are the
// testable seam.
// ---------------------------------------------------------------------------
describe("loadOrMintSpawnToken", () => {
  function seeded(initial?: string): StudioStorage & SpawnTokenStorage {
    const storage = fakeStorage();
    if (initial !== undefined) void storage.put(SPAWN_TOKEN_KEY, initial);
    return storage;
  }

  it("no token stored: mints a fresh fsp_ token", async () => {
    const token = await loadOrMintSpawnToken(seeded());
    expect(token).toMatch(/^fsp_[0-9a-f]{64}$/);
  });

  it("the minted token is persisted under SPAWN_TOKEN_KEY — env carries the SAME stored value", async () => {
    const storage = seeded();
    const token = await loadOrMintSpawnToken(storage);
    // What do.ts threads into this.envVars (the returned value) must be
    // exactly what a LATER call, or the spawn route's own validation read,
    // finds on file — not a different value that merely happens to look
    // similar.
    await expect(storage.get(SPAWN_TOKEN_KEY)).resolves.toBe(token);
  });

  it("returns the stored token untouched when one exists — never overwrites", async () => {
    const existing = "fsp_" + "c".repeat(64);
    const storage = seeded(existing);
    await expect(loadOrMintSpawnToken(storage)).resolves.toBe(existing);
    await expect(storage.get(SPAWN_TOKEN_KEY)).resolves.toBe(existing);
  });

  it("stable across calls: a second call returns the SAME token the first minted", async () => {
    const storage = seeded();
    const first = await loadOrMintSpawnToken(storage);
    await expect(loadOrMintSpawnToken(storage)).resolves.toBe(first);
  });

  it("writes NOTHING but the token — no status, so a bare DO construction cannot publish a studio row", async () => {
    // Task 6 (ruling 2): StudioDO's constructor calls this on every wake,
    // including for an id nobody ever provisioned (a bare status read
    // constructs a DO). A status/registry write here would make that id
    // appear in `fleet ls`.
    const storage = seeded();
    await loadOrMintSpawnToken(storage);
    expect(await storage.get(STATUS_KEY)).toBeUndefined();
  });
});

// --- P3 Task 2: the token/hash write pair ------------------------------------

// ---------------------------------------------------------------------------
// Task 6 (ruling 2): the constructor WIRING. StudioDO is container-backed and
// cannot be constructed under vitest-pool-workers (do.ts's own header), so
// what its constructor does is unreachable by import — but it is exactly
// where the "load the stored token before anything can start a container"
// guarantee lives. Source-pinned instead, the same technique this repo
// already uses for container/server.ts, studio-bringup.sh and studio-fleet
// (see vitest.config.ts's TEST_STUDIO_DO_SRC). The BEHAVIOUR remains guarded
// by the real-container e2e (test-integration/attach.e2e.ts asserts the
// container's own token hashes to the registry's stored digest); these pin
// the three orderings that e2e would otherwise be the only thing to notice.
// ---------------------------------------------------------------------------
describe("StudioDO wiring (source-pinned — the class cannot be constructed here)", () => {
  const src = env.TEST_STUDIO_DO_SRC;

  /** The body of the first `  constructor(` in the class — `\n  }` is the
   *  method's own closing brace (everything nested inside is indented
   *  deeper). */
  function constructorBody(): string {
    const classAt = src.indexOf("export class StudioDO");
    expect(classAt).toBeGreaterThan(-1);
    const start = src.indexOf("\n  constructor(", classAt);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  /** Issue #37 split provision() into a thin reporting wrapper plus this
   *  core — everything the method always did lives here, so every ordering
   *  pin below still reads the code it was written for. */
  function provisionBody(): string {
    // Issue #152: `provisionUngated` now also takes the operation's own
    // `ctx: OpCtx` (do.ts's `allowingStart` — every caller creates and
    // threads one through, so a destroy landing mid-provision can be told
    // apart from one that never happened). Issue #85 PR1's `via` sits before
    // it — see the rebase's own arg-ordering rule (existing params, then
    // `via`, then `ctx` last).
    const start = src.indexOf("  private async provisionUngated(cfg: ProvisionConfig, via: BringupVia, ctx: OpCtx)");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  function provisionWrapperBody(): string {
    const start = src.indexOf("  async provision(cfg: ProvisionConfig)");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  function checkNowBody(): string {
    const start = src.indexOf("  async checkNow(): Promise<StudioStatus> {");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  function restartBody(): string {
    // Issue #152: same `ctx: OpCtx` threading as provisionUngated above,
    // appended after the pre-existing `via` parameter.
    const start = src.indexOf("  private async restartUngated(via: BringupVia, ctx: OpCtx): Promise<StudioStatus> {");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  function recycleBody(): string {
    const start = src.indexOf("  async recycle(cfg: ProvisionConfig, discardUnsynced = false)");
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("\n  }", start));
  }

  it("the constructor loads the persisted token into envVars under blockConcurrencyWhile", () => {
    const body = constructorBody();
    expect(body).toContain("blockConcurrencyWhile");
    expect(body).toContain("loadOrMintSpawnToken(ctx.storage)");
    expect(body).toContain("this.envVars =");
  });

  it("the constructor never invents a token of its own", () => {
    // `loadOrMintSpawnToken` is capital-M, so this substring can only match a
    // direct mintSpawnToken() call — the throwaway that used to be the only
    // thing an alarm-woken DO's container ever saw.
    expect(constructorBody()).not.toContain("mintSpawnToken(");
  });

  it("provision() settles the spawn token BEFORE the credential refresh that starts the container", () => {
    // The Task 6 fix. refreshWithStorage execs into the container, and an exec
    // is what starts it — container env is fixed at start, so a token settled
    // after this point can never reach the container.
    const body = provisionBody();
    const ensureAt = body.indexOf("ensureSpawnToken(");
    const envVarsAt = body.indexOf("this.envVars =");
    const refreshAt = body.indexOf("refreshWithStorage(");
    expect(ensureAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(refreshAt);
    expect(envVarsAt).toBeLessThan(refreshAt);
  });

  it("restartStudio() settles the spawn token BEFORE the credential refresh that starts the container (final review fix, mirrors provision() above)", () => {
    // Same reasoning as provision()'s own test just above: refreshWithStorage
    // execs into the container, and an exec is what STARTS one that is not
    // already running (e.g. right after the documented rotation procedure
    // recycles it) — so a token settled after this point can never reach
    // that container.
    const body = restartBody();
    const ensureAt = body.indexOf("ensureSpawnToken(");
    const envVarsAt = body.indexOf("this.envVars =");
    const refreshAt = body.indexOf("refreshWithStorage(");
    expect(ensureAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(refreshAt);
    expect(envVarsAt).toBeLessThan(refreshAt);
  });

  // Second review pass (2026-08-20): a live `fleet recycle` run proved
  // destroy() -> provision() alone races (see do.ts's recycleWithSync doc
  // comment and sandbox-api.ts's sbAwaitReady doc comment for the full
  // mechanism). This pins the exact regression class that bug was: someone
  // later reordering recycle()'s own composed callbacks so provision could
  // run before the container is confirmed ready again. recycleWithSync's own
  // unit tests (test/studio.session.test.ts) prove the RUNTIME ordering;
  // this proves the WIRING that feeds it never drifts back.
  it("recycle() destroys, THEN awaits readiness via sbAwaitReady, THEN calls provision — never provision before readiness is confirmed", () => {
    const body = recycleBody();
    expect(body).toContain("recycleWithSync(");
    const destroyAt = body.indexOf("this.destroy()");
    const readyAt = body.indexOf("sbAwaitReady(this)");
    // Issue #152: recycle passes its OWN ctx into provisionCore (`sharedCtx`)
    // so the internal reprovision reuses recycle's epoch snapshot instead of
    // taking a fresh one after `this.destroy()` above has already run.
    const provisionAt = body.indexOf('this.provisionCore(c, "recycle", ctx)');
    expect(destroyAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(provisionAt).toBeGreaterThan(-1);
    expect(destroyAt).toBeLessThan(readyAt);
    expect(readyAt).toBeLessThan(provisionAt);
  });

  // --- Issue #37: the recovery verbs report a FRESH verdict -----------------
  // provisionWithFreshVerdict / checkAndRecordReadiness have their own unit
  // suites (test/studio.readiness.test.ts); these pin the WIRING that feeds
  // them, which no import can reach.

  it("provision() answers through provisionWithFreshVerdict, so the row it returns is measured, not cached", () => {
    const body = provisionWrapperBody();
    expect(body).toContain("provisionWithFreshVerdict(");
    // Issue #152: provision() now calls provisionUngated directly (through
    // allowingStart's own ctx), not through the separate provisionCore
    // wrapper — provisionWithFreshVerdict's own post-provision readiness
    // check needs the SAME ctx the provisioning itself used, and provision()
    // is the one place both live under a single allowingStart call.
    expect(body).toContain('this.provisionUngated(c, "provision", ctx)');
  });

  it("recycle() re-provisions through provisionCore, never the wrapper — one post-provision check, not two", () => {
    expect(recycleBody()).not.toContain("this.provision(c)");
  });

  // #96: the flag the route parsed must reach the guard, and the age the
  // guard quotes must be the snapshot a recycle actually restores.
  it("recycle() threads discardUnsynced into recycleWithSync's guard, with the R2 snapshot's age", () => {
    expect(recycleBody()).toContain("{ discardUnsynced, lastSyncedAt: () => this.lastSyncedAt() }");
    expect(src).toContain("this.env.STUDIO_ARCHIVE.head(sessionLatestKey(this.selfId())))?.uploaded ?? null");
  });

  it("checkNow() runs the same recorded readiness check the syncSession tick runs", () => {
    expect(checkNowBody()).toContain("checkAndRecordReadiness(");
  });

  // REFRESH_SECONDS's real consumer is do.ts, unreachable by import (the DO
  // cannot be constructed here) — pins the symbol itself at both rearm
  // sites (armTicks' initial arm, refreshToken()'s own reschedule), so a
  // future edit that hardcodes a different interval at either site, or
  // drops the constant from one of them, breaks this. StudioDO cannot be
  // constructed under vitest-pool-workers; source-pinning is this repo's
  // established compromise, see studio.account-launched.test.ts.
  it("rearms refreshToken with REFRESH_SECONDS at both call sites (armTicks, refreshToken's own reschedule)", () => {
    const sites = src.split("\n").filter((l) => l.includes('this.rearm("refreshToken", REFRESH_SECONDS)'));
    expect(sites.length).toBe(2); // test-lies-check: allow — source-pinning, see comment above
  });
});

describe("ensureSpawnToken", () => {
  it("no token yet: mints, persists it, and writes its hash to status + registry in the same early sequence", async () => {
    const storage = fakeStorage();
    const recorded: StudioStatus[] = [];
    const token = await ensureSpawnToken(storage, STUDIO_ID, async (st) => void recorded.push(st));

    expect(token).toMatch(/^fsp_[0-9a-f]{64}$/);
    await expect(storage.get(SPAWN_TOKEN_KEY)).resolves.toBe(token);
    expect((await storage.get(STATUS_KEY))?.spawnTokenHash).toBe(await hashSpawnToken(token));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].spawnTokenHash).toBe(await hashSpawnToken(token));
    expect(recorded[0].id).toBe(STUDIO_ID);
  });

  // Task 6 (ruling 1) — this replaces the old "re-provision remints"
  // assertion, which pinned behaviour that could not work: a container's env
  // is fixed at container start, so a remint against a running studio
  // published a hash for a token that container would never hold.
  it("re-provision KEEPS the token: a second call returns the same one, and neither stored value moves", async () => {
    const storage = fakeStorage();
    const first = await ensureSpawnToken(storage, STUDIO_ID, async () => {});
    const firstHash = (await storage.get(STATUS_KEY))?.spawnTokenHash;
    const second = await ensureSpawnToken(storage, STUDIO_ID, async () => {});

    expect(second).toBe(first);
    await expect(storage.get(SPAWN_TOKEN_KEY)).resolves.toBe(first);
    expect((await storage.get(STATUS_KEY))?.spawnTokenHash).toBe(firstHash);
    expect(firstHash).toBe(await hashSpawnToken(first));
  });

  it("nothing is re-published once the status carries a hash — no status write, no registry write", async () => {
    const storage = fakeStorage();
    await ensureSpawnToken(storage, STUDIO_ID, async () => {});
    const before = await storage.get(STATUS_KEY);

    const recorded: StudioStatus[] = [];
    await ensureSpawnToken(storage, STUDIO_ID, async (st) => void recorded.push(st));
    expect(recorded).toHaveLength(0);
    expect(await storage.get(STATUS_KEY)).toBe(before); // same object: never rewritten
  });

  it("pre-P3 studio (token stored, status carries no hash): publishes the hash so that token can authenticate", async () => {
    const existing = "fsp_" + "c".repeat(64);
    const storage = fakeStorage();
    await storage.put(SPAWN_TOKEN_KEY, existing);
    await storage.put(STATUS_KEY, status({ state: "running" }));

    const recorded: StudioStatus[] = [];
    const token = await ensureSpawnToken(storage, STUDIO_ID, async (st) => void recorded.push(st));
    expect(token).toBe(existing); // healed by publishing, never by reminting
    expect((await storage.get(STATUS_KEY))?.spawnTokenHash).toBe(await hashSpawnToken(existing));
    expect(recorded.at(-1)?.spawnTokenHash).toBe(await hashSpawnToken(existing));
  });

  // Whole-branch final review, Critical finding 1: the old presence check
  // (`existing?.spawnTokenHash` truthy) neither revoked nor healed. The
  // documented rotation procedure (delete SPAWN_TOKEN_KEY, recycle the
  // container, provision — OPERATOR-FINISH-LIST §9) leaves EXACTLY this in
  // storage between step 1 and step 3: no token on file, but status still
  // carrying the hash of the token that was just deleted. The old code
  // returned early on that stale-but-truthy hash and never republished — the
  // fresh mint's hash never reached status or the registry, so the OLD
  // (compromised) token's hash kept "authenticating" while the NEW token
  // 401'd forever, with no path back except editing storage by hand.
  it("rotation self-heal: SPAWN_TOKEN_KEY gone but STATUS_KEY still carries the OLD hash — next ensure republishes the NEW hash, and the old hash is gone from the row", async () => {
    const staleToken = "fsp_" + "d".repeat(64);
    const staleHash = await hashSpawnToken(staleToken);
    const storage = fakeStorage();
    await storage.put(STATUS_KEY, status({ spawnTokenHash: staleHash })); // no SPAWN_TOKEN_KEY: simulates "key deleted"

    const recorded: StudioStatus[] = [];
    const newToken = await ensureSpawnToken(storage, STUDIO_ID, async (st) => void recorded.push(st));
    const newHash = await hashSpawnToken(newToken);

    expect(newToken).not.toBe(staleToken); // no token on file: a fresh mint, not the deleted one
    expect((await storage.get(STATUS_KEY))?.spawnTokenHash).toBe(newHash); // republished...
    expect((await storage.get(STATUS_KEY))?.spawnTokenHash).not.toBe(staleHash); // ...the old hash is gone from the row
    expect(recorded).toHaveLength(1); // republished to the registry too — the old code skipped this entirely
    expect(recorded[0].spawnTokenHash).toBe(newHash);
  });

  it("preserves the rest of an existing status (it stamps one field, it does not reset the studio)", async () => {
    const storage = fakeStorage();
    await storage.put(STATUS_KEY, status({ state: "running", tailscaleHost: "s.ts.net", spawnedBy: "websites--cto" }));
    await ensureSpawnToken(storage, STUDIO_ID, async () => {});
    const stored = await storage.get(STATUS_KEY);
    expect(stored?.state).toBe("running");
    expect(stored?.tailscaleHost).toBe("s.ts.net");
    expect(stored?.spawnedBy).toBe("websites--cto");
  });

  // Issue #107 fix-first round 2: the optional 4th `doClass` parameter is
  // do.ts's real provision()/restartStudio() call sites' seam for
  // realDoClassForRole's Env-aware answer (see that function's own doc
  // comment) — freshStatus itself no longer stamps a doClass at all, since it
  // has no Env and cannot know whether env.STUDIO_BIG is actually reachable.
  describe("doClass hint (4th param) — the only safe-to-persist source of a fresh row's doClass", () => {
    const BIG_ID = "acme--release-studio";

    it("a fresh row stamps the passed doClass when STUDIO_BIG is genuinely bound", async () => {
      const storage = fakeStorage();
      const doClass = realDoClassForRole(env as unknown as Env, "release-studio");
      expect(doClass).toBe("STUDIO_BIG"); // sanity: the real test env has STUDIO_BIG bound
      await ensureSpawnToken(storage, BIG_ID, async () => {}, doClass);
      expect((await storage.get(STATUS_KEY))?.doClass).toBe("STUDIO_BIG");
    });

    it("a fresh row stamps STUDIO, never STUDIO_BIG, when env.STUDIO_BIG is undefined -- the batched-rollout window", async () => {
      const storage = fakeStorage();
      const envWithoutBig = { ...env, STUDIO_BIG: undefined } as unknown as Env;
      const doClass = realDoClassForRole(envWithoutBig, "release-studio");
      expect(doClass).toBe("STUDIO");
      const recorded: StudioStatus[] = [];
      await ensureSpawnToken(storage, BIG_ID, async (st) => void recorded.push(st), doClass);
      expect((await storage.get(STATUS_KEY))?.doClass).toBe("STUDIO");
      expect(recorded.at(-1)?.doClass).toBe("STUDIO");
    });

    it("omitting the 4th param (every pre-existing caller) leaves doClass absent -- the safe default", async () => {
      const storage = fakeStorage();
      await ensureSpawnToken(storage, BIG_ID, async () => {});
      expect((await storage.get(STATUS_KEY))?.doClass).toBeUndefined();
    });

    it("an EXISTING row's doClass is never overwritten by a later doClass hint", async () => {
      const storage = fakeStorage();
      await storage.put(STATUS_KEY, status({ id: BIG_ID, doClass: "STUDIO" }));
      // A later call passes STUDIO_BIG (e.g. the operator has since deployed
      // the binding) -- the already-recorded row must not move. The existing
      // row's spawnTokenHash is null, so the write path below genuinely runs
      // (this isn't the early-return "nothing changed" branch).
      await ensureSpawnToken(storage, BIG_ID, async () => {}, "STUDIO_BIG");
      expect((await storage.get(STATUS_KEY))?.doClass).toBe("STUDIO");
    });
  });
});

describe("spawnTokenHash plumbing (the hash the registry matches on survives every later write)", () => {
  function recordingProvisionDeps(recorded: StudioStatus[]): ProvisionDeps {
    return {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: async (st: StudioStatus) => {
        recorded.push(st);
      },
      now: () => NOW_ISO,
      fetchBlueprintFile: fakeFetchBlueprintFile(),
    };
  }

  it("provision carries the early-sequence hash forward into the status it stores and records", async () => {
    const storage = fakeStorage();
    const recorded: StudioStatus[] = [];
    const token = await ensureSpawnToken(storage, STUDIO_ID, async () => {});
    const hash = await hashSpawnToken(token);

    const result = await provisionWithStorage(
      recordingProvisionDeps(recorded), storage, { repo: "websites", role: "pilot" }, "acme-org/websites",
    );
    expect(result.state).toBe("running");
    expect(result.spawnTokenHash).toBe(hash);
    expect(recorded.at(-1)?.spawnTokenHash).toBe(hash);
    expect((await storage.get(STATUS_KEY))?.spawnTokenHash).toBe(hash);
  });

  it("restart carries it too — the pre-P3 heal reaches the registry, not just the container", async () => {
    const storage = fakeStorage();
    await storage.put(ROLE_ENV_KEY, { ROLE_PROMPT_B64: "cHJvbXB0", ROLE_ALLOWED_TOOLS: "Edit", ROLE_EFFORT: "" });
    const recorded: StudioStatus[] = [];

    // Nothing stored yet: the legacy-studio heal path, which mints and
    // publishes the hash through the same early sequence provision uses.
    const token = await ensureSpawnToken(storage, STUDIO_ID, async () => {});
    const hash = await hashSpawnToken(token);
    const result = await restartWithStorage(recordingProvisionDeps(recorded), storage, STUDIO_ID, "rafarc21/fleetflare");
    expect(result.state).toBe("running");
    expect(result.spawnTokenHash).toBe(hash);
    expect(recorded.at(-1)?.spawnTokenHash).toBe(hash);
  });

  it("a refresh tick never clobbers a stored hash", async () => {
    const storage = fakeStorage();
    const hash = await hashSpawnToken("fsp_" + "a".repeat(64));
    await storage.put(STATUS_KEY, status({ spawnTokenHash: hash }));
    const next = await refreshWithStorage(fakeRefreshDeps(), storage, STUDIO_ID);
    expect(next.spawnTokenHash).toBe(hash);
  });
});

// Review round 1, Important 3 — token/hash interleave incoherence. Two
// provision() calls on the same studio can overlap at their many awaits
// (blueprint fetches, clone, bring-up). Task 6 (ruling 1) closed the case
// this suite was written for outright: a studio that already has a token
// never mints another, so overlapping provisions cannot produce two tokens
// at all. What remains is the assertion that matters — whatever the container
// ends up holding is what the registry hashes.
describe("interleaved provisions keep the DO token and the registry hash paired", () => {
  function provisionDeps(): ProvisionDeps {
    return {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: (st: StudioStatus) => recordStudio(env as unknown as Env, st),
      now: () => NOW_ISO,
      fetchBlueprintFile: fakeFetchBlueprintFile(),
    };
  }

  it("A and B both ensure, then B's provision completes before A's — one token, and the registry hashes it", async () => {
    const storage = fakeStorage(); // one studio, one keyspace, two callers
    const cfg = { repo: "websites", role: "pilot" };

    // Both early sequences run first — they are storage/D1 writes with no
    // network in between, which is exactly why they cannot straddle the slow
    // work below. B finds A's token and keeps it: there is no second mint to
    // desync from.
    const tokenA = await ensureSpawnToken(storage, STUDIO_ID, provisionDeps().recordStudio);
    const tokenB = await ensureSpawnToken(storage, STUDIO_ID, provisionDeps().recordStudio);
    expect(tokenB).toBe(tokenA);

    // ...then the long halves finish in the OPPOSITE order (A was slower).
    await provisionWithStorage(provisionDeps(), storage, cfg, "acme-org/websites");
    await provisionWithStorage(provisionDeps(), storage, cfg, "acme-org/websites");

    const finalToken = await storage.get(SPAWN_TOKEN_KEY);
    expect(finalToken).toBe(tokenA);
    const row = (await listStudios(env as unknown as Env)).find((st) => st.id === STUDIO_ID);
    // The whole point: the registry's hash is the hash of the token the
    // container actually holds.
    expect(row?.spawnTokenHash).toBe(await hashSpawnToken(finalToken!));
  });
});
