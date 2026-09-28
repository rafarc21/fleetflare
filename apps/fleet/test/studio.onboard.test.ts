import { describe, it, expect, vi } from "vitest";
import { runOnboardPreflight, buildOnboardBrief, type OnboardDeps } from "../src/studio/onboard";
import type { RepoReach } from "../src/github/reach";
import type { StudioStatus } from "../src/studio/types";

// Board task #125: `fleet onboard` preflight. Fake-injection style, the same
// house convention test/studio.destroy.test.ts and test/board.routes.test.ts
// already use — no vi.mock() anywhere in this file, matching the rest of
// apps/fleet/test.

interface FakeCreds {
  workerUrl: string;
}

const CREDS: FakeCreds = { workerUrl: "https://fleet.example.com" };
const REPO_SLUG = "acme-hq/acme-os";

function fakeStudio(id: string, state: StudioStatus["state"] = "running"): StudioStatus {
  return {
    id, state, tailscaleHost: null, lastRefresh: null, error: null, lastRefreshError: null,
    burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
  };
}

function baseDeps(overrides: Partial<OnboardDeps<FakeCreds>> = {}): OnboardDeps<FakeCreds> {
  return {
    detectRepo: vi.fn(async () => ({ slug: REPO_SLUG, reason: null })),
    loadCredentials: vi.fn(async () => CREDS),
    checkReach: vi.fn(async (): Promise<RepoReach> => ({ reachable: true })),
    listStudios: vi.fn(async () => [] as StudioStatus[]),
    ...overrides,
  };
}

describe("runOnboardPreflight", () => {
  it("all-pass: repo detected, reach ok, credentials ok, no existing studio — 4 checks pass, allPass true, non-null brief", async () => {
    const deps = baseDeps();

    const result = await runOnboardPreflight(deps);

    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(result.allPass).toBe(true);
    expect(result.brief).not.toBeNull();
    expect(result.brief).toContain(REPO_SLUG);
  });

  it("unwritable repo: check #2 fails with the surfaced remedy, allPass false, no brief", async () => {
    const remedy = "is not writable by this fleet's GitHub token — grant it write access";
    const deps = baseDeps({
      checkReach: vi.fn(async (): Promise<RepoReach> => ({ reachable: false, remedy })),
    });

    const result = await runOnboardPreflight(deps);

    const reachCheck = result.checks[1];
    expect(reachCheck.pass).toBe(false);
    expect(reachCheck.detail).toContain(remedy);
    expect(result.allPass).toBe(false);
    expect(result.brief).toBeNull();
  });

  it("missing credentials: check #3 fails, check #2 also reports failed/blocked, and checkReach/listStudios are never called", async () => {
    const checkReach = vi.fn(async (): Promise<RepoReach> => ({ reachable: true }));
    const listStudios = vi.fn(async () => [] as StudioStatus[]);
    const deps = baseDeps({
      loadCredentials: vi.fn(async () => ({ error: "no credentials file at ~/.fleet/credentials" })),
      checkReach,
      listStudios,
    });

    const result = await runOnboardPreflight(deps);

    const [, reachCheck, credCheck] = result.checks;
    expect(credCheck.pass).toBe(false);
    expect(credCheck.detail).toContain("no credentials file");
    expect(reachCheck.pass).toBe(false);
    expect(result.allPass).toBe(false);
    expect(result.brief).toBeNull();
    expect(checkReach).not.toHaveBeenCalled();
    expect(listStudios).not.toHaveBeenCalled();
  });

  it("no git remote: check #1 fails with the reason, and the whole preflight short-circuits — checkReach/listStudios never called", async () => {
    const checkReach = vi.fn(async (): Promise<RepoReach> => ({ reachable: true }));
    const listStudios = vi.fn(async () => [] as StudioStatus[]);
    const deps = baseDeps({
      detectRepo: vi.fn(async () => ({ slug: null, reason: "fatal: not a git repository (or any of the parent directories): .git" })),
      checkReach,
      listStudios,
    });

    const result = await runOnboardPreflight(deps);

    const repoCheck = result.checks[0];
    expect(repoCheck.pass).toBe(false);
    expect(repoCheck.detail).toContain("not a git repository");
    expect(result.allPass).toBe(false);
    expect(result.brief).toBeNull();
    expect(checkReach).not.toHaveBeenCalled();
    expect(listStudios).not.toHaveBeenCalled();
  });

  it("an existing studio for this repo is reported but does NOT fail the preflight (informational only)", async () => {
    const deps = baseDeps({
      listStudios: vi.fn(async () => [fakeStudio("acme-os--maestro")]),
    });

    const result = await runOnboardPreflight(deps);

    const existsCheck = result.checks[3];
    expect(existsCheck.detail).toContain("acme-os--maestro");
    expect(result.allPass).toBe(true);
    expect(result.brief).not.toBeNull();
  });

  // Board #21. `fleet onboard` in a DOTTED repo must pass all four checks and
  // must FIND that repo's studio — check #4 compares the detected repo's
  // short name against `parseStudioId(s.id).repo`, and the id half is the
  // FOLDED segment, so the comparison has to fold too or every dotted repo
  // reports "no existing studio yet" while one is running.
  it("a dotted repo passes the preflight and its existing studio is found under the folded segment", async () => {
    const deps = baseDeps({
      detectRepo: vi.fn(async () => ({ slug: "demosite-life/exampleorg.com", reason: null })),
      listStudios: vi.fn(async () => [fakeStudio("exampleorg-com--maestro")]),
    });

    const result = await runOnboardPreflight(deps);

    expect(result.allPass).toBe(true);
    expect(result.checks[3].detail).toContain("exampleorg-com--maestro");
    expect(result.brief).toContain("demosite-life/exampleorg.com");
  });

  it("a repo no fold can rescue does not silently match some other repo's studio", async () => {
    const deps = baseDeps({
      detectRepo: vi.fn(async () => ({ slug: "o/-weird", reason: null })),
      listStudios: vi.fn(async () => [fakeStudio("weird--maestro")]),
    });

    const result = await runOnboardPreflight(deps);

    expect(result.checks[3].detail).toContain("no existing studio");
  });
});

describe("buildOnboardBrief", () => {
  it("quotes the fleet-cockpit traps verbatim and covers ff <role> \"<task>\" vs ff <role> <n>", () => {
    const brief = buildOnboardBrief(REPO_SLUG);

    expect(brief).toContain('ff <role> "<task>"');
    expect(brief).toContain("ff <role> <n>");
    expect(brief).toContain("Merged is not served.");
    expect(brief).toContain("Deploy is not rollout.");
    expect(brief).toContain("A studio can look alive and be bare.");
    expect(brief).toContain("`fleet` inside a container is a different CLI.");
    expect(brief).toContain("Leads never implement");
    expect(brief).toContain("board (GitHub Issues) is the single source of truth");
  });
});
