import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  runRefreshCredential, credentialWriteCmd, tokenEnv, type RefreshDeps,
} from "../src/studio/do";
import { readReposCredentialClearCmd, readReposCredentialWriteCmd } from "../src/studio/credentials";

// Issue #291: the read-only sibling token rides the SAME refresh cycle as the
// primary credential (provision + every 50 min), written AFTER it and never
// through it. No opt-in -> the read helper is cleared, nothing minted.

const NOW = "2026-10-09T00:00:00.000Z";

function deps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    mintToken: vi.fn(async () => "ghs_primary"),
    sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
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
      [credentialWriteCmd(), tokenEnv("ghs_primary")],
      [readReposCredentialClearCmd()],
    ]);
  });

  it("a grant: the read token is written by its OWN command after the primary, riding env only", async () => {
    const d = deps({ readRepos: vi.fn(async () => ({ token: "ghs_read", repos: ["acme-org/alpha"] })) });
    expect((await runRefreshCredential(d)).ok).toBe(true);
    const calls = vi.mocked(d.sbExec).mock.calls;
    expect(calls).toEqual([
      [credentialWriteCmd(), tokenEnv("ghs_primary")],
      [readReposCredentialWriteCmd(["acme-org/alpha"]), tokenEnv("ghs_read")],
    ]);
    // The primary (push) credential is never fed the read token.
    expect(calls.filter(([cmd]) => cmd === credentialWriteCmd()).every(([, e]) => e?.FLEET_TOKEN === "ghs_primary")).toBe(true);
  });

  it("a read mint failure clears the read helper and fails the refresh, token-free", async () => {
    const d = deps({ readRepos: vi.fn(async () => { throw new Error("installation token failed (422)"); }) });
    const r = await runRefreshCredential(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/read-repos/);
    expect(vi.mocked(d.sbExec).mock.calls.at(-1)).toEqual([readReposCredentialClearCmd()]);
  });

  it("without the port (legacy callers) nothing about the read helper runs", async () => {
    const d = deps();
    expect((await runRefreshCredential(d)).ok).toBe(true);
    expect(vi.mocked(d.sbExec).mock.calls).toEqual([[credentialWriteCmd(), tokenEnv("ghs_primary")]]);
  });

  it("do.ts wires the port into refreshDeps (source pin: StudioDO cannot be constructed under test)", () => {
    const src = env.TEST_STUDIO_DO_SRC as string;
    const refresh = src.slice(src.indexOf("private refreshDeps("), src.indexOf("private shipDeps("));
    expect(refresh).toContain("readRepos:");
    expect(refresh).toContain("studioReadReposCredential(");
  });
});
