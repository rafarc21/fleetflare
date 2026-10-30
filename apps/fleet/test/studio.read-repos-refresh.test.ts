import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  runRefreshCredential, refreshCredentialExec, STUDIO_GIT_IDENTITY, tokenEnv, workCredentialVerifyCmd, type RefreshDeps,
} from "../src/studio/do";
import { readReposCredentialClearCmd, readReposCredentialWriteCmd } from "../src/studio/credentials";

// Issue #291: the read-only sibling token rides the SAME refresh cycle as the
// primary credential (provision + every 50 min), written AFTER it and never
// through it. No opt-in -> the read helper is cleared, nothing minted.

const NOW = "2026-10-09T00:00:00.000Z";
const PRIMARY = refreshCredentialExec("ghs_primary", STUDIO_GIT_IDENTITY);

function deps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    mintToken: vi.fn(async () => "ghs_primary"),
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    // Issue #1422: this suite exercises the read-repos helper, not the push
    // probe gate -- a real network call here would make it flaky against
    // the actual internet, so the default is "always passes".
    canPush: vi.fn(async () => true),
    recordStudio: vi.fn(async () => {}),
    notify: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

describe("runRefreshCredential — read-repos (issue #291)", () => {
  it("no grant: primary written, read helper CLEARED, no read token anywhere", async () => {
    const d = deps({ readRepos: vi.fn(async () => null) });
    expect(await runRefreshCredential(d)).toEqual({ ok: true, lastRefresh: NOW });
    expect(vi.mocked(d.sbExec).mock.calls).toEqual([
      [PRIMARY.cmd, PRIMARY.env],
      [readReposCredentialClearCmd()],
    ]);
  });

  it("a grant: the read token is written by its OWN command after the primary, riding env only", async () => {
    const d = deps({ readRepos: vi.fn(async () => ({ token: "ghs_read", repos: ["acme-org/alpha"] })) });
    expect((await runRefreshCredential(d)).ok).toBe(true);
    const calls = vi.mocked(d.sbExec).mock.calls;
    expect(calls).toEqual([
      [PRIMARY.cmd, PRIMARY.env],
      [readReposCredentialWriteCmd(["acme-org/alpha"]), tokenEnv("ghs_read")],
    ]);
    // The primary (push) credential is never fed the read token.
    expect(calls.filter(([cmd]) => cmd === PRIMARY.cmd).every(([, e]) => e?.FLEET_TOKEN === "ghs_primary")).toBe(true);
  });

  // PR #292 review item 1: a read-token failure must never degrade the
  // studio — the primary credential is what keeps it working.
  it("a read mint failure does NOT fail the refresh: helper cleared, old token revoked, logged", async () => {
    const swapReadToken = vi.fn(async () => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const d = deps({ readRepos: vi.fn(async () => { throw new Error("installation token failed (422)"); }), swapReadToken });
    expect(await runRefreshCredential(d)).toEqual({ ok: true, lastRefresh: NOW });
    expect(vi.mocked(d.sbExec).mock.calls).toEqual([[PRIMARY.cmd, PRIMARY.env], [readReposCredentialClearCmd()]]);
    expect(swapReadToken).toHaveBeenCalledWith(null);
    expect(errors.join("\n")).toMatch(/read-repos/);
    vi.restoreAllMocks();
  });

  it("a failed read helper WRITE does not fail the refresh either, and the unwritten token is not kept", async () => {
    const swapReadToken = vi.fn(async () => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sbExec = vi.fn(async (cmd: string) => cmd === PRIMARY.cmd
      ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "boom" });
    const d = deps({ sbExec, swapReadToken, readRepos: vi.fn(async () => ({ token: "ghs_read", repos: ["acme-org/alpha"] })) });
    expect((await runRefreshCredential(d)).ok).toBe(true);
    expect(swapReadToken).toHaveBeenCalledWith(null);
    vi.restoreAllMocks();
  });

  // PR #292 review item 2: the previous read token dies now, not in <=1h.
  it("swapReadToken gets the NEW token only after its write succeeded, and null after a clear", async () => {
    const order: string[] = [];
    const sbExec = vi.fn(async (cmd: string) => { order.push(cmd === PRIMARY.cmd ? "primary" : "read-exec"); return { code: 0, stdout: "", stderr: "" }; });
    const swapReadToken = vi.fn(async (t: string | null) => { order.push(`swap:${t}`); });
    await runRefreshCredential(deps({ sbExec, swapReadToken, readRepos: vi.fn(async () => ({ token: "ghs_read", repos: ["acme-org/alpha"] })) }));
    expect(order).toEqual(["primary", "read-exec", "swap:ghs_read"]);
    order.length = 0;
    await runRefreshCredential(deps({ sbExec, swapReadToken, readRepos: vi.fn(async () => null) }));
    expect(order).toEqual(["primary", "read-exec", "swap:null"]);
  });

  it("without the port (legacy callers) nothing about the read helper runs", async () => {
    const d = deps();
    expect((await runRefreshCredential(d)).ok).toBe(true);
    expect(vi.mocked(d.sbExec).mock.calls).toEqual([[PRIMARY.cmd, PRIMARY.env]]);
  });

  // Issue #1187: workRepo enables the post-write verify; the read grant is
  // unaffected by it — the two ride separate exec calls. The read-repos exec
  // runs BEFORE the verify: the verify can fail (a stale own-repo read key
  // still shadows the fresh token), and the read-repos rewrite is the heal
  // that drops that stale key — it must never be skipped by a failed verify.
  it("workRepo adds a verify exec AFTER the read-repos exec; a read grant still lists the own repo (that guard lives in read-repos.ts)", async () => {
    const d = deps({
      workRepo: "acme-org/websites",
      readRepos: vi.fn(async () => ({ token: "ghs_read", repos: ["acme-org/alpha"] })),
      sbExec: vi.fn(async (cmd: string) => (
        cmd === workCredentialVerifyCmd("acme-org/websites")
          ? { code: 0, stdout: "password=ghs_primary\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }
      )),
    });
    expect((await runRefreshCredential(d)).ok).toBe(true);
    const calls = vi.mocked(d.sbExec).mock.calls.map(([cmd]) => cmd);
    expect(calls).toEqual([
      refreshCredentialExec("ghs_primary", STUDIO_GIT_IDENTITY, "acme-org/websites").cmd,
      readReposCredentialWriteCmd(["acme-org/alpha"]),
      workCredentialVerifyCmd("acme-org/websites"),
    ]);
  });

  // Issue #1187: the read-repos heal must run even when the verify is about
  // to fail — the heal is what drops a stale own-repo read key that makes the
  // verify return the wrong token, so it is load-bearing, not best-effort.
  it("a failing verify still runs the read-repos exec first — the heal is never skipped by the verify's own failure", async () => {
    const d = deps({
      workRepo: "acme-org/websites",
      readRepos: vi.fn(async () => ({ token: "ghs_read", repos: ["acme-org/alpha"] })),
      sbExec: vi.fn(async (cmd: string) => (
        cmd === workCredentialVerifyCmd("acme-org/websites")
          ? { code: 0, stdout: "password=ghs_stale\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }
      )),
    });
    expect((await runRefreshCredential(d)).ok).toBe(false);
    const calls = vi.mocked(d.sbExec).mock.calls.map(([cmd]) => cmd);
    expect(calls).toEqual([
      refreshCredentialExec("ghs_primary", STUDIO_GIT_IDENTITY, "acme-org/websites").cmd,
      readReposCredentialWriteCmd(["acme-org/alpha"]),
      workCredentialVerifyCmd("acme-org/websites"),
    ]);
  });

  it("do.ts wires the port into refreshDeps (source pin: StudioDO cannot be constructed under test)", () => {
    const src = env.TEST_STUDIO_DO_SRC as string;
    const refresh = src.slice(src.indexOf("private refreshDeps("), src.indexOf("private shipDeps("));
    expect(refresh).toContain("readRepos:");
    expect(refresh).toContain("studioReadReposCredential(");
    expect(refresh).toContain("swapReadToken:");
    expect(src).toContain("async revokeReadRepos(");
  });
});
