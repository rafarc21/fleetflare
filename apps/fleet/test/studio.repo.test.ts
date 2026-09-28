import { describe, it, expect } from "vitest";
import {
  parseGitRemote, parseRepoSlug, repoIdSegment, resolveWorkRepo, studioIdForTarget, studioIdIn,
  type WorkRepoDeps,
} from "../src/studio/repo";
import type { RepoReach } from "../src/github/reach";
import type { StudioStatus } from "../src/studio/types";

// Dynamic repo selection (P4a): the operator runs `fleet spawn <role>` from a
// local repo folder and the studio clones THAT repo. Everything the Worker
// decides about which repo that is lives in src/studio/repo.ts — pure, over
// ports, for the same reason src/studio/spawn.ts is (see that file's header).
// cli/fleet.ts's own git shell-out is the only untested half, exactly the
// split src/studio/cli-args.ts already draws.

const DEFAULT_SLUG = "acme-org/websites";

function row(overrides: Partial<StudioStatus> = {}): StudioStatus {
  return {
    id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null,
    error: null, lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null,
    repoSlug: null, ...overrides,
  };
}

/** The reachability port (P6a). Throwing is a meaningful outcome (503, never
 *  a silent allow) — the same posture SpawnDeps.fetchPolicy takes. Given a
 *  LIST, this stands in for a provider that can reach exactly those repos;
 *  the real ones (src/github/auth.ts) answer from an App installation's
 *  repository list or from a token's own GET, and both are covered there. */
const REMEDY = "is not reachable by this fleet — grant it access first";

function deps(repos: string[] | Error): WorkRepoDeps {
  return {
    reachRepo: async (slug: string): Promise<RepoReach> => {
      if (repos instanceof Error) throw repos;
      return repos.some((full) => full.toLowerCase() === slug.toLowerCase())
        ? { reachable: true }
        : { reachable: false, remedy: REMEDY };
    },
  };
}

describe("parseGitRemote", () => {
  it("reads an HTTPS remote, with and without the .git suffix", () => {
    expect(parseGitRemote("https://github.com/acme-org/websites.git")).toBe("acme-org/websites");
    expect(parseGitRemote("https://github.com/acme-org/websites")).toBe("acme-org/websites");
  });

  it("reads an SSH remote in both scp-style and ssh:// form", () => {
    expect(parseGitRemote("git@github.com:acme-org/beta.git")).toBe("acme-org/beta");
    expect(parseGitRemote("ssh://git@github.com/acme-org/beta.git")).toBe("acme-org/beta");
  });

  it("tolerates a git:// remote, an embedded user, and a trailing slash", () => {
    expect(parseGitRemote("git://github.com/acme-org/beta.git")).toBe("acme-org/beta");
    expect(parseGitRemote("https://user@github.com/acme-org/beta.git")).toBe("acme-org/beta");
    expect(parseGitRemote("https://github.com/acme-org/beta/")).toBe("acme-org/beta");
  });

  it("keeps a repo name that merely CONTAINS a dot intact (only a .git suffix is stripped)", () => {
    expect(parseGitRemote("https://github.com/acme-org/example.dev")).toBe("acme-org/example.dev");
  });

  it("returns null for a non-GitHub host — never a guessed owner", () => {
    expect(parseGitRemote("https://gitlab.com/acme-org/beta.git")).toBeNull();
    expect(parseGitRemote("git@bitbucket.org:acme-org/beta.git")).toBeNull();
    expect(parseGitRemote("https://github.example.com/acme-org/beta.git")).toBeNull();
  });

  it("returns null for anything that is not a two-segment GitHub remote", () => {
    expect(parseGitRemote("")).toBeNull();
    expect(parseGitRemote("/Users/operator/code/local-only")).toBeNull();
    expect(parseGitRemote("https://github.com/acme-org")).toBeNull();
    expect(parseGitRemote("https://github.com/acme-org/a/b")).toBeNull();
  });
});

describe("parseRepoSlug", () => {
  it("accepts owner/name and splits it", () => {
    expect(parseRepoSlug("acme-org/websites")).toEqual({ owner: "acme-org", repo: "websites" });
  });

  it("rejects a non-string, an empty half, extra segments, and path/shell metacharacters", () => {
    expect(parseRepoSlug(42)).toBeNull();
    expect(parseRepoSlug("websites")).toBeNull();
    expect(parseRepoSlug("/websites")).toBeNull();
    expect(parseRepoSlug("a/b/c")).toBeNull();
    expect(parseRepoSlug("acme-org/web sites")).toBeNull();
    expect(parseRepoSlug("acme-org/web;rm -rf")).toBeNull();
    expect(parseRepoSlug("../../etc/passwd")).toBeNull();
  });
});

describe("repoIdSegment", () => {
  it("lowercases a repo name into a studio id segment", () => {
    expect(repoIdSegment("websites")).toBe("websites");
    expect(repoIdSegment("Websites")).toBe("websites");
    expect(repoIdSegment("fleetflare-agency")).toBe("fleetflare-agency");
  });

  it("folds dots and underscores to hyphens, so a domain-named repo can have a studio", () => {
    // The four real repos that had no studio before this (board #21).
    expect(repoIdSegment("exampleorg.com")).toBe("exampleorg-com");
    expect(repoIdSegment("demosite.life")).toBe("demosite-life");
    expect(repoIdSegment("acmevault.ai")).toBe("acmevault-ai");
    expect(repoIdSegment("example-owner.com")).toBe("example-owner-com");
    expect(repoIdSegment("example.dev")).toBe("example-dev");
    expect(repoIdSegment("my_repo")).toBe("my-repo");
    expect(repoIdSegment("My_Repo.V2")).toBe("my-repo-v2");
  });

  it("collapses a RUN of separators to one hyphen, so no fold can invent the `--` id delimiter", () => {
    // "a..b" -> "a--b" would parse as repo "a" / role "b" in a studio id.
    expect(repoIdSegment("a..b")).toBe("a-b");
    expect(repoIdSegment("a._-b")).toBe("a-b");
    expect(repoIdSegment("web--studio")).toBe("web-studio");
  });

  it("still refuses a name no fold can rescue", () => {
    expect(repoIdSegment("-lead")).toBeNull();
    expect(repoIdSegment("lead-")).toBeNull();
    expect(repoIdSegment("caf\u00e9")).toBeNull();
    expect(repoIdSegment("")).toBeNull();
  });
});

describe("resolveWorkRepo — no repo requested", () => {
  it("falls back to the fleet default and never touches the installation list", async () => {
    let called = false;
    const res = await resolveWorkRepo(
      { reachRepo: async () => { called = true; return { reachable: true }; } },
      { requested: undefined, defaultSlug: DEFAULT_SLUG, rows: [] },
    );
    expect(res).toEqual({ ok: true, slug: DEFAULT_SLUG, segment: "websites" });
    expect(called).toBe(false);
  });

  // The example is a TRAILING separator, not `my_repo`: since board #21 that
  // one folds to `my-repo` and is perfectly valid. `my_repo_` folds to
  // `my-repo-`, which no fold can rescue — still a deployment fault, still a
  // 500 naming the variable.
  it("500s naming AGENT_REPO when the fleet default itself has no valid repo segment", async () => {
    const res = await resolveWorkRepo(deps([]), { requested: undefined, defaultSlug: "owner/my_repo_", rows: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(500);
    expect(res.message).toContain("AGENT_REPO");
    expect(res.message).toContain("owner/my_repo_");
  });
});

describe("resolveWorkRepo — a requested repo is verified, never trusted", () => {
  it("accepts a repo the fleet's credential can reach", async () => {
    const res = await resolveWorkRepo(deps(["acme-org/websites", "acme-org/beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res).toEqual({ ok: true, slug: "acme-org/beta", segment: "beta" });
  });

  it("matches case-insensitively (GitHub owner/repo names are)", async () => {
    const res = await resolveWorkRepo(deps(["Acme-Org/Beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res).toEqual({ ok: true, slug: "acme-org/beta", segment: "beta" });
  });

  it("403s an unreachable repo — a client cannot make a studio clone an arbitrary repo", async () => {
    const res = await resolveWorkRepo(deps(["acme-org/websites"]), {
      requested: "attacker/payload", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.message).toContain("attacker/payload");
  });

  it("503s (never a silent allow) when reachability cannot be answered", async () => {
    const res = await resolveWorkRepo(deps(new Error("github down")), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(503);
  });

  it("400s a malformed repo before any network call happens", async () => {
    const res = await resolveWorkRepo(deps(new Error("must not be called")), {
      requested: "not-a-slug", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
  });

  // `example.dev` used to be the example here; board #21 made it valid
  // (`example-dev`). A trailing separator still is not, and the point stands:
  // the refusal happens BEFORE the reachability call, which is why `deps`
  // throws if anything reaches it.
  it("400s a repo whose name cannot be a studio id segment even after the fold", async () => {
    const res = await resolveWorkRepo(deps(new Error("must not be called")), {
      requested: "acme-org/example.dev.", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toContain("example.dev.");
  });

  it("skips the reachability call when the requested repo IS the fleet default (the websites regression guard)", async () => {
    const res = await resolveWorkRepo(deps(new Error("must not be called")), {
      requested: DEFAULT_SLUG, defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res).toEqual({ ok: true, slug: DEFAULT_SLUG, segment: "websites" });
  });
});

describe("resolveWorkRepo — id segment agreement", () => {
  it("400s when the requested repo's short name is not the id's own repo segment", async () => {
    const res = await resolveWorkRepo(deps(["acme-org/beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows: [], idRepo: "websites",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toContain("websites");
    expect(res.message).toContain("acme-org/beta");
  });

  it("accepts when they agree", async () => {
    const res = await resolveWorkRepo(deps(["acme-org/beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows: [], idRepo: "beta",
    });
    expect(res.ok).toBe(true);
  });
});

describe("resolveWorkRepo — the segment claim (two orgs, one repo name)", () => {
  it("409s a second owner's same-named repo, naming BOTH slugs", async () => {
    const rows = [row({ id: "beta--maestro", repoSlug: "acme-org/beta" })];
    const res = await resolveWorkRepo(deps(["other-org/beta"]), {
      requested: "other-org/beta", defaultSlug: DEFAULT_SLUG, rows,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("acme-org/beta");
    expect(res.message).toContain("other-org/beta");
  });

  it("claims the segment fleet-wide, not per id — a DIFFERENT role under the same name still conflicts", async () => {
    const rows = [row({ id: "beta--maestro", repoSlug: "acme-org/beta" })];
    const res = await resolveWorkRepo(deps(["other-org/beta"]), {
      requested: "other-org/beta", defaultSlug: DEFAULT_SLUG, rows, idRepo: "beta",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
  });

  it("the SAME slug re-provisioning its own studio is not a conflict", async () => {
    const rows = [row({ id: "beta--maestro", repoSlug: "acme-org/beta" })];
    const res = await resolveWorkRepo(deps(["acme-org/beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows, idRepo: "beta",
    });
    expect(res).toEqual({ ok: true, slug: "acme-org/beta", segment: "beta" });
  });

  it("a legacy row with no repoSlug reads as the fleet default, so it still guards its segment", async () => {
    // Every studio provisioned before this feature has repoSlug null and was
    // cloned from AGENT_REPO — treating null as anything else would let a
    // foreign owner/websites quietly take over `websites--*`.
    const rows = [row({ id: "websites--pilot", repoSlug: null })];
    const res = await resolveWorkRepo(deps(["other-org/websites"]), {
      requested: "other-org/websites", defaultSlug: DEFAULT_SLUG, rows,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain(DEFAULT_SLUG);
  });

  it("a row under a DIFFERENT segment never blocks a claim", async () => {
    const rows = [row({ id: "websites--pilot", repoSlug: null })];
    const res = await resolveWorkRepo(deps(["acme-org/beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows,
    });
    expect(res.ok).toBe(true);
  });

  it("a malformed registry id is skipped rather than crashing the claim check", async () => {
    const rows = [row({ id: "not a studio id", repoSlug: "other-org/beta" })];
    const res = await resolveWorkRepo(deps(["acme-org/beta"]), {
      requested: "acme-org/beta", defaultSlug: DEFAULT_SLUG, rows,
    });
    expect(res.ok).toBe(true);
  });
});

describe("resolveWorkRepo — a bodyless re-provision resolves to the studio's own binding", () => {
  it("falls back to boundSlug, not the fleet default, and still skips the installation call", async () => {
    const res = await resolveWorkRepo(deps(new Error("must not be called")), {
      requested: undefined, boundSlug: "acme-org/beta", defaultSlug: DEFAULT_SLUG,
      rows: [row({ id: "beta--maestro", repoSlug: "acme-org/beta" })], idRepo: "beta",
    });
    expect(res).toEqual({ ok: true, slug: "acme-org/beta", segment: "beta" });
  });

  it("an unbound studio whose id names a repo the fleet default is not gets an actionable 400, never a wrong clone", async () => {
    const res = await resolveWorkRepo(deps(new Error("must not be called")), {
      requested: undefined, boundSlug: null, defaultSlug: DEFAULT_SLUG, rows: [], idRepo: "beta",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toContain("not bound to a repo yet");
  });

  it("a bodyless re-provision of a legacy websites studio still resolves to the fleet default", async () => {
    const res = await resolveWorkRepo(deps(new Error("must not be called")), {
      requested: undefined, boundSlug: null, defaultSlug: DEFAULT_SLUG,
      rows: [row({ id: "websites--pilot", repoSlug: null })], idRepo: "websites",
    });
    expect(res).toEqual({ ok: true, slug: DEFAULT_SLUG, segment: "websites" });
  });
});

describe("studioIdIn — the role -> studio id bridge the Mac CLIs cross", () => {
  it("names the studio for a role in the detected repo", () => {
    expect(studioIdIn("acme-org/websites", "web-studio")).toEqual({ ok: true, id: "websites--web-studio" });
  });

  it("refuses when the folder names no repo rather than guessing the fleet default", () => {
    const res = studioIdIn(null, "web-studio");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("names no repo");
  });

  it("names the studio for a role in a DOTTED repo, folding the dot to a hyphen", () => {
    expect(studioIdIn("demosite-life/exampleorg.com", "web-studio"))
      .toEqual({ ok: true, id: "exampleorg-com--web-studio" });
  });

  it("refuses a repo whose short name could never be an id segment", () => {
    const res = studioIdIn("o/-weird", "web-studio");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("id segment");
  });

  it("refuses a role that could never be one either", () => {
    const res = studioIdIn("o/websites", "Web_Studio");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("not a role");
  });

  // Issue #269: the default is the two-segment id this function always built.
  it("takes an optional instance, defaulting to the bare two-segment id", () => {
    expect(studioIdIn("acme-org/websites", "web-studio", 1))
      .toEqual({ ok: true, id: "websites--web-studio" });
    expect(studioIdIn("acme-org/websites", "web-studio", 2))
      .toEqual({ ok: true, id: "websites--web-studio--2" });
    expect(studioIdIn("demosite-life/exampleorg.com", "release-studio", 11))
      .toEqual({ ok: true, id: "exampleorg-com--release-studio--11" });
  });
});

// Issue #269 item 3: `fleet task assign <n> <target>`. The three shapes and
// their repo resolution, in one place — a wrong id here is SILENT (a valid id
// belonging to a different studio), so every refusal is asserted too.
describe("studioIdForTarget — what a task-assign target resolves to", () => {
  const SLUG = "acme-org/websites";

  it("a bare role is that role's instance 1 in the detected repo — unchanged", () => {
    expect(studioIdForTarget(SLUG, "pilot")).toEqual({ ok: true, id: "websites--pilot" });
    expect(studioIdForTarget(SLUG, "web-studio")).toEqual({ ok: true, id: "websites--web-studio" });
  });

  it("<role>--<k> is that role's instance k in the detected repo", () => {
    expect(studioIdForTarget(SLUG, "pilot--2")).toEqual({ ok: true, id: "websites--pilot--2" });
    expect(studioIdForTarget(SLUG, "web-studio--3"))
      .toEqual({ ok: true, id: "websites--web-studio--3" });
  });

  it("<role>--1 normalises onto the bare id rather than refusing", () => {
    expect(studioIdForTarget(SLUG, "pilot--1")).toEqual({ ok: true, id: "websites--pilot" });
  });

  it("a full studio id is used as typed, two segments or three", () => {
    expect(studioIdForTarget(SLUG, "beta--pilot")).toEqual({ ok: true, id: "beta--pilot" });
    expect(studioIdForTarget(SLUG, "beta--pilot--2")).toEqual({ ok: true, id: "beta--pilot--2" });
    expect(studioIdForTarget(SLUG, "exampleorg-com--web-studio--4"))
      .toEqual({ ok: true, id: "exampleorg-com--web-studio--4" });
  });

  it("a full studio id needs NO repo context — it is already qualified", () => {
    expect(studioIdForTarget(null, "beta--pilot--2")).toEqual({ ok: true, id: "beta--pilot--2" });
  });

  it("a role-shaped target outside a repo refuses, naming the problem", () => {
    for (const target of ["pilot", "pilot--2"]) {
      const res = studioIdForTarget(null, target);
      expect(res.ok, target).toBe(false);
      if (!res.ok) expect(res.message).toContain("names no repo");
    }
  });

  it("a target that names no studio refuses and lists all three shapes", () => {
    for (const bad of ["Pilot", "pilot--", "--pilot", "a--b--c", "a--b--c--2", "pilot--0", "pilot--01", ""]) {
      const res = studioIdForTarget(SLUG, bad);
      expect(res.ok, bad).toBe(false);
      if (!res.ok) {
        expect(res.message).toContain("names no studio");
        expect(res.message).toContain("pilot--2");
        expect(res.message).toContain("websites--pilot--2");
      }
    }
  });

  it("dots fold in the detected repo but are still refused inside the target itself", () => {
    expect(studioIdForTarget("demosite-life/exampleorg.com", "pilot--2"))
      .toEqual({ ok: true, id: "exampleorg-com--pilot--2" });
    expect(studioIdForTarget(SLUG, "demosite.life--pilot").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Board #21. Folding `.`/`_` onto `-` is what lets a domain-named repo have a
// studio at all, and it is also what makes `a.b` and `a-b` name the SAME
// segment. That collision must be REFUSED, never resolved: the fleet-wide
// segment claim is the mechanism, and these pin that it covers the folded
// case and not only the literal one.

describe("resolveWorkRepo — a folded segment collides as loudly as a literal one", () => {
  it("409s when a dotted repo would claim a segment a hyphenated repo already holds", async () => {
    const rows = [row({ id: "a-b--maestro", repoSlug: "o/a-b" })];
    const res = await resolveWorkRepo(deps(["o/a.b"]), {
      requested: "o/a.b", defaultSlug: DEFAULT_SLUG, rows,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("a-b");
    expect(res.message).toContain("o/a-b");
  });

  it("409s the other way round too — the literal name has no priority over the folded one", async () => {
    const rows = [row({ id: "a-b--maestro", repoSlug: "o/a.b" })];
    const res = await resolveWorkRepo(deps(["o/a-b"]), {
      requested: "o/a-b", defaultSlug: DEFAULT_SLUG, rows,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.message).toContain("o/a.b");
  });

  it("resolves a dotted repo to its folded segment when nothing else claims it", async () => {
    const res = await resolveWorkRepo(deps(["demosite-life/exampleorg.com"]), {
      requested: "demosite-life/exampleorg.com", defaultSlug: DEFAULT_SLUG, rows: [],
    });
    expect(res).toEqual({
      ok: true, slug: "demosite-life/exampleorg.com", segment: "exampleorg-com",
    });
  });

  it("accepts a provision whose fixed id carries the FOLDED segment of the detected repo", async () => {
    const res = await resolveWorkRepo(deps(["demosite-life/demosite.life"]), {
      requested: "demosite-life/demosite.life", defaultSlug: DEFAULT_SLUG, rows: [],
      idRepo: "demosite-life",
    });
    expect(res.ok).toBe(true);
  });
});
