import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  mintRepoToken, parseRepoAuthMap, reachRepo, repoOwner, repoTokenMinter, resolveRepoAuthKind,
  tokenEnvName,
} from "../src/github/auth";
import type { Env } from "../src/env";

// P6a — the repo-auth provider seam.
//
// One interface, two implementations, chosen PER REPO OWNER. Every rule below
// is proven for both, because "the App path is unchanged" is a claim only
// tests can keep honest.
//
// The failure this removes was measured live 2026-08-29 — `ff` inside
// rafarc21/sample answered
//
//   403 repo "rafarc21/sample" is not reachable by this fleet's GitHub App
//       installation
//
// which was the reachability check working exactly as designed. GitHub Apps
// install per ACCOUNT: the App is on the `acme-org` ORG, and no org
// installation can ever list a personal-account repo, whatever anyone installs
// where. The fix is a different credential for that owner, not a different
// installation.
//
// Measured against the operator's real fine-grained PAT, 2026-08-30 — the reason the
// owner map exists at all, and the reason the token check asserts WRITE:
//   GET /repos/rafarc21/sample   -> 200  permissions {admin:T, push:T, pull:T}
//   GET /repos/torvalds/linux       -> 200  permissions {admin:F, push:F, pull:T}
//   GET /repos/acme-org/websites -> 404  (private, never granted)
// One global provider is wrong in both directions; and readability is not a
// boundary at all, since a PAT reads every public repo on GitHub.

/** What GitHub returns for a repo the token was granted write on. */
const WRITABLE = { full_name: "rafarc21/sample", permissions: { admin: true, push: true, pull: true } };
/** A PUBLIC repo the token was never granted: it still answers 200. */
const PUBLIC_UNGRANTED = { full_name: "torvalds/linux", permissions: { admin: false, push: false, pull: true } };

/** A fetch route stub for the App path: mints the installation token, then
 *  answers the installation's repository list with exactly `names`. Hoisted
 *  to module scope (was local to one describe block) so the P6c per-owner
 *  installation-id tests can reuse it without duplicating it. */
function installationList(names: string[]): (url: string) => Response {
  return (url) => url.includes("/access_tokens")
    ? Response.json({ token: "ghs_installation_token" })
    : Response.json({ total_count: names.length, repositories: names.map((full_name) => ({ full_name })) });
}

let pem: string;
let calls: { url: string; method: string; headers: Record<string, string>; body: string | undefined }[] = [];
let realFetch: typeof globalThis.fetch;
let route: (url: string) => Response;

beforeAll(async () => {
  // Same casts, same reason as test/github.app.test.ts's own beforeAll:
  // @cloudflare/workers-types declares generateKey/exportKey without the
  // overloads that would narrow their return types from the arguments.
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`;
});

const PAT = "github_pat_11ABCDEF0_exampleexampleexample";

/** App only — exactly what the deployed Worker carried before P6a. */
const appEnv = (): Env => ({
  GITHUB_APP_ID: "1111111",
  GITHUB_INSTALLATION_ID: "2222222",
  GITHUB_APP_PRIVATE_KEY: pem,
}) as unknown as Env;

/** Token only — the one secret an OSS clone brings, and no App at all. */
const tokenEnv = (): Env => ({ GITHUB_TOKEN: PAT }) as unknown as Env;

/** the operator's real shape: an org on the App, everything else on his PAT. */
const mixedEnv = (): Env => ({
  ...appEnv(), ...tokenEnv(), GITHUB_REPO_AUTH: "acme-org=app",
}) as unknown as Env;

beforeEach(() => {
  calls = [];
  route = () => Response.json({});
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({
      url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    return route(url);
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

describe("repoOwner", () => {
  it("takes the owner half, lowercased — GitHub owner names are case-insensitive", () => {
    expect(repoOwner("Acme-Org/Websites")).toBe("acme-org");
    expect(repoOwner("rafarc21/sample")).toBe("rafarc21");
  });
});

describe("parseRepoAuthMap", () => {
  it("reads owner=provider pairs, and is empty when unset", () => {
    expect(parseRepoAuthMap(undefined).size).toBe(0);
    expect(parseRepoAuthMap("")).toEqual(new Map());
    expect(parseRepoAuthMap("acme-org=app, rafarc21=token"))
      .toEqual(new Map([["acme-org", "app"], ["rafarc21", "token"]]));
  });

  it("lowercases owners so the map matches however the repo was typed", () => {
    expect(parseRepoAuthMap("Acme-Org=app").get("acme-org")).toBe("app");
  });

  it("accepts * as the wildcard entry — an owner name can never be *", () => {
    expect(parseRepoAuthMap("*=token").get("*")).toBe("token");
  });

  it("throws on a provider it does not know, rather than ignoring the entry", () => {
    // Ignoring it would silently run an owner on a provider nobody chose.
    expect(() => parseRepoAuthMap("acme-org=oauth")).toThrow(/"token" or "app"/);
  });

  it("throws on a malformed entry rather than dropping it", () => {
    expect(() => parseRepoAuthMap("acme-org")).toThrow(/GITHUB_REPO_AUTH/);
    expect(() => parseRepoAuthMap("=app")).toThrow(/GITHUB_REPO_AUTH/);
  });
});

describe("resolveRepoAuthKind — per owner, token is the default", () => {
  it("picks the token when only a token is configured — the OSS default, every owner", () => {
    expect(resolveRepoAuthKind(tokenEnv(), "rafarc21/sample")).toBe("token");
    expect(resolveRepoAuthKind(tokenEnv(), "anyone/anything")).toBe("token");
  });

  it("picks the App when only the App is configured — the Worker as deployed today", () => {
    expect(resolveRepoAuthKind(appEnv(), "acme-org/websites")).toBe("app");
  });

  it("picks the TOKEN when both could apply and no map says otherwise", () => {
    expect(resolveRepoAuthKind({ ...appEnv(), ...tokenEnv() } as Env, "rafarc21/sample")).toBe("token");
  });

  it("routes BY OWNER on the operator's mixed config — the org keeps the App, the rest gets the token", () => {
    expect(resolveRepoAuthKind(mixedEnv(), "acme-org/websites")).toBe("app");
    expect(resolveRepoAuthKind(mixedEnv(), "Acme-Org/beta")).toBe("app");
    expect(resolveRepoAuthKind(mixedEnv(), "rafarc21/sample")).toBe("token");
  });

  it("lets a wildcard entry override the automatic fallback", () => {
    const env = { ...appEnv(), ...tokenEnv(), GITHUB_REPO_AUTH: "*=app, rafarc21=token" } as Env;
    expect(resolveRepoAuthKind(env, "someone/else")).toBe("app");
    expect(resolveRepoAuthKind(env, "rafarc21/sample")).toBe("token");
  });

  it("treats an empty-string token as absent, not as a configured token", () => {
    expect(resolveRepoAuthKind({ ...appEnv(), GITHUB_TOKEN: "" } as Env, "o/r")).toBe("app");
  });

  it("refuses an owner mapped to a provider that is not configured, naming what is missing", () => {
    expect(() => resolveRepoAuthKind({ ...appEnv(), GITHUB_REPO_AUTH: "rafarc21=token" } as Env, "rafarc21/sample"))
      .toThrow(/GITHUB_TOKEN/);
    expect(() => resolveRepoAuthKind({ ...tokenEnv(), GITHUB_REPO_AUTH: "acme-org=app" } as Env, "acme-org/websites"))
      .toThrow(/GITHUB_APP_ID/);
    expect(() => resolveRepoAuthKind(
      { ...appEnv(), GITHUB_INSTALLATION_ID: "", GITHUB_REPO_AUTH: "acme-org=app" } as Env, "acme-org/websites",
    )).toThrow(/GITHUB_INSTALLATION_ID/);
  });

  it("refuses when nothing at all is configured, naming both ways out", () => {
    expect(() => resolveRepoAuthKind({} as Env, "o/r")).toThrow(/GITHUB_TOKEN/);
    expect(() => resolveRepoAuthKind({} as Env, "o/r")).toThrow(/GITHUB_APP_ID/);
  });

  it("no longer requires GITHUB_INSTALLATION_ID when a token is configured", () => {
    // The pin this whole feature exists to remove.
    expect(resolveRepoAuthKind(tokenEnv(), "acme-org/websites")).toBe("token");
  });
});

describe("mintRepoToken", () => {
  it("returns the configured PAT verbatim, with no GitHub round trip at all", async () => {
    expect(await mintRepoToken(tokenEnv(), "rafarc21/sample")).toBe(PAT);
    expect(calls).toHaveLength(0);
  });

  it("mints an installation token for an App-mapped owner, unchanged — the regression guard", async () => {
    route = () => Response.json({ token: "ghs_installation_token" });
    expect(await mintRepoToken(mixedEnv(), "acme-org/websites")).toBe("ghs_installation_token");
    expect(calls[0].url).toBe("https://api.github.com/app/installations/2222222/access_tokens");
    expect(calls[0].method).toBe("POST");
  });

  it("hands the SAME fleet two different credentials for two different owners", async () => {
    route = () => Response.json({ token: "ghs_installation_token" });
    expect(await mintRepoToken(mixedEnv(), "acme-org/websites")).toBe("ghs_installation_token");
    expect(await mintRepoToken(mixedEnv(), "rafarc21/sample")).toBe(PAT);
  });
});

// ---------------------------------------------------------------------------
// Issue #331 — MUST-fix, security. A mint with no request body at all is
// valid for EVERY repo the installation covers, not the one caller that
// asked for it — see src/github/app.ts's mintInstallationToken doc comment.
// mintRepoToken already had `repo` in hand at every real call site; it used
// to discard it before reaching the App. These tests prove it now reaches
// the mint's own request body.

describe("mintRepoToken — scopes the App mint to the caller's own repo (#331)", () => {
  it("sends the SHORT repo name in `repositories` on the App path", async () => {
    route = () => Response.json({ token: "ghs_installation_token" });
    await mintRepoToken(mixedEnv(), "acme-org/websites");
    const mint = calls.find((c) => c.url.includes("/access_tokens"))!;
    expect(JSON.parse(mint.body!).repositories).toEqual(["websites"]);
  });

  it("MUTANT PROOF: a missing/empty `repositories` array must not pass through mintRepoToken", async () => {
    route = () => Response.json({ token: "ghs_installation_token" });
    await mintRepoToken(mixedEnv(), "acme-org/websites");
    const mint = calls.find((c) => c.url.includes("/access_tokens"))!;
    expect(mint.body).toBeTruthy();
    const repos = JSON.parse(mint.body!).repositories;
    expect(Array.isArray(repos)).toBe(true);
    expect(repos.length).toBeGreaterThan(0);
  });

  it("forwards a `permissions` narrowing to the mint's own body", async () => {
    // The blueprint-credential call site (studio/do.ts) passes this to keep
    // that mint read-only — proven here at the layer that actually forwards
    // it into the request.
    route = () => Response.json({ token: "ghs_installation_token" });
    await mintRepoToken(mixedEnv(), "acme-org/blueprint", { permissions: { contents: "read" } });
    const mint = calls.find((c) => c.url.includes("/access_tokens"))!;
    expect(JSON.parse(mint.body!).permissions).toEqual({ contents: "read" });
  });

  it("ignores opts under the token path — nothing to narrow, no round trip either way", async () => {
    expect(await mintRepoToken(tokenEnv(), "rafarc21/sample", { permissions: { contents: "read" } })).toBe(PAT);
    expect(calls).toHaveLength(0);
  });
});

describe("mintRepoToken — a renamed repo's stale 422 recovers via canonical-name retry (PR #339 round 2, RISK)", () => {
  it("a 422 (stale name) resolves the canonical name via an UNSCOPED lookup, then retries scoped", async () => {
    let mintCalls = 0;
    route = (url) => {
      if (url.includes("/graphql")) {
        return Response.json({ data: { repository: { nameWithOwner: "acme-org/new-name" } } });
      }
      mintCalls++;
      if (mintCalls === 1) return new Response(JSON.stringify({ message: "Not Found" }), { status: 422 });
      return Response.json({ token: `ghs_${mintCalls}` });
    };
    const token = await mintRepoToken(appEnv(), "acme-org/old-name");
    expect(token).toBe("ghs_3"); // the FINAL, canonical-scoped mint — never the unscoped lookup token
    const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
    expect(tokenCalls).toHaveLength(3);
    expect(JSON.parse(tokenCalls[0].body!).repositories).toEqual(["old-name"]); // original, stale name
    expect(tokenCalls[1].body).toBeUndefined(); // the unscoped lookup mint — NO repositories field at all
    expect(JSON.parse(tokenCalls[2].body!).repositories).toEqual(["new-name"]); // retried against the canonical name
  });

  it("MUTANT PROOF: the unscoped lookup token is NEVER what this function returns — only the re-scoped retry is", async () => {
    let mintCalls = 0;
    route = (url) => {
      if (url.includes("/graphql")) return Response.json({ data: { repository: { nameWithOwner: "o/new" } } });
      mintCalls++;
      return mintCalls === 1
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 422 })
        : Response.json({ token: mintCalls === 2 ? "ghs_UNSCOPED_LOOKUP" : "ghs_RESCOPED" });
    };
    expect(await mintRepoToken(appEnv(), "o/old")).toBe("ghs_RESCOPED");
  });

  it("a genuinely unresolvable 422 (not a rename — canonical name comes back unchanged) propagates, never retries the same name", async () => {
    let mintCalls = 0;
    route = (url) => {
      if (url.includes("/graphql")) return Response.json({ data: { repository: { nameWithOwner: "acme-org/gone" } } });
      mintCalls++;
      return mintCalls === 1
        ? new Response(JSON.stringify({ message: "Not Found" }), { status: 422 })
        : Response.json({ token: "ghs_unscoped" });
    };
    await expect(mintRepoToken(appEnv(), "acme-org/gone")).rejects.toThrow(/422/);
    // The original 422 mint, plus the one unscoped lookup — and STOPS there.
    // A third call would mean it retried the identical (still-stale) name.
    expect(calls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(2);
  });

  it("a non-422 failure (bad credentials, rate limit) never triggers the canonical-name retry at all", async () => {
    route = (url) => url.includes("/graphql")
      ? Response.json({ data: {} })
      : new Response("Bad credentials", { status: 401 });
    await expect(mintRepoToken(appEnv(), "acme-org/websites")).rejects.toThrow(/401/);
    expect(calls.some((c) => c.url.includes("/graphql"))).toBe(false);
    expect(calls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(1);
  });

  it("a caller who already asked for `unscoped` gets the original error untouched — no retry machinery", async () => {
    route = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 422 });
    await expect(mintRepoToken(appEnv(), "acme-org/websites", { unscoped: true })).rejects.toThrow(/422/);
    expect(calls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(1);
  });
});

describe("repoTokenMinter — memoised per REPO, never shared across repos or owners", () => {
  it("mints once per repo within one request, not once per call", async () => {
    route = () => Response.json({ token: "ghs_installation_token" });
    const mint = repoTokenMinter(mixedEnv());
    await mint("acme-org/websites");
    await mint("acme-org/websites");
    expect(calls.filter((c) => c.url.includes("/access_tokens"))).toHaveLength(1);
  });

  // PR #339 round 2 (issue #331) — BLOCKER, MUTANT PROOF: this test is red
  // against an owner-keyed cache. Under the App path a mint is scoped to
  // `repositories: [repo]` (app.ts), so `websites`'s token is invalid for
  // `beta` even though both are `acme-org` — a single provision reading
  // fleet.json from one repo and a role file from another, same-owner repo
  // is exactly this shape, and an owner-keyed cache would hand the SECOND
  // repo the FIRST repo's scoped (and therefore wrong) token.
  it("two DIFFERENT repos under the SAME owner mint TWO separately-scoped tokens, never share one", async () => {
    let n = 0;
    route = () => Response.json({ token: `ghs_${++n}` });
    const mint = repoTokenMinter(mixedEnv());
    const a = await mint("acme-org/websites");
    const b = await mint("acme-org/beta");
    const tokenCalls = calls.filter((c) => c.url.includes("/access_tokens"));
    expect(tokenCalls).toHaveLength(2);
    expect(a).not.toBe(b);
    expect(tokenCalls.map((c) => JSON.parse(c.body as string))).toEqual([
      { repositories: ["websites"] }, { repositories: ["beta"] },
    ]);
  });

  it("never serves one owner's credential for another owner's repo", async () => {
    route = () => Response.json({ token: "ghs_installation_token" });
    const mint = repoTokenMinter(mixedEnv());
    expect(await mint("acme-org/websites")).toBe("ghs_installation_token");
    expect(await mint("rafarc21/sample")).toBe(PAT);
  });
});

describe("reachRepo — the token provider", () => {
  it("asks GitHub about the repo, and says yes when the token may push to it", async () => {
    route = () => Response.json(WRITABLE);
    expect(await reachRepo(tokenEnv(), "rafarc21/sample")).toEqual({ reachable: true });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.github.com/repos/rafarc21/sample");
    expect(calls[0].headers.authorization).toBe(`Bearer ${PAT}`);
  });

  it("reaches a PERSONAL-account repo, which no org installation ever could", async () => {
    route = () => Response.json(WRITABLE);
    expect((await reachRepo(mixedEnv(), "rafarc21/sample")).reachable).toBe(true);
    // And it asked the token, not the installation list.
    expect(calls.some((c) => c.url.includes("/installation/repositories"))).toBe(false);
  });

  it("REFUSES a public repo the token was never granted — 200 is not a boundary", async () => {
    // The hole a GET-only check would have left wide open, and the case a
    // reviewer would miss: a fine-grained PAT answers 200 for every public
    // repo on GitHub. Without the push check, any caller could point a studio
    // — which holds the fleet's own credential — at any repo in the world.
    route = () => Response.json(PUBLIC_UNGRANTED);
    const reach = await reachRepo(tokenEnv(), "torvalds/linux");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("write");
  });

  it("fails CLOSED when the response carries no permissions object at all", async () => {
    route = () => Response.json({ full_name: "o/r" });
    expect((await reachRepo(tokenEnv(), "o/r")).reachable).toBe(false);
  });

  it("refuses a 404 — the remedy names the TOKEN and does NOT claim the repo is missing", async () => {
    // Measured: a fine-grained PAT answers 404, not 403, for a PRIVATE repo
    // outside its grant — the same status a repo that does not exist answers.
    // 404 is therefore ambiguous, and the message must not assert either
    // reading while still being right about the public-repo case too.
    route = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const reach = await reachRepo(tokenEnv(), "acme-org/websites");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("GITHUB_TOKEN");
    expect(reach.remedy).toContain("404");
    expect(reach.remedy).toContain("write");
    expect(reach.remedy).not.toContain("install the app");
    expect(reach.remedy).not.toMatch(/does not exist(?!.*or)/);
  });

  it("refuses a 403 the same way — a repo the token may not see is not reachable", async () => {
    route = () => new Response("Forbidden", { status: 403 });
    expect((await reachRepo(tokenEnv(), "someone/else")).reachable).toBe(false);
  });

  it("THROWS on a 401 or a 5xx rather than answering 'not reachable'", async () => {
    // A broken credential and a GitHub outage are both "ask again later" —
    // the caller turns a throw into 503 — never a silent refusal an operator
    // would read as "the fleet may not have this repo".
    route = () => new Response("Bad credentials", { status: 401 });
    await expect(reachRepo(tokenEnv(), "o/r")).rejects.toThrow(/401/);
    route = () => new Response("boom", { status: 500 });
    await expect(reachRepo(tokenEnv(), "o/r")).rejects.toThrow(/500/);
  });

  it("never puts the token in the thrown message", async () => {
    route = () => new Response("Bad credentials", { status: 401 });
    await reachRepo(tokenEnv(), "o/r").then(
      () => { throw new Error("should have thrown"); },
      (err: Error) => { expect(err.message).not.toContain("github_pat_"); },
    );
  });
});

describe("reachRepo — the App provider, unchanged", () => {
  it("answers from the installation's repository list", async () => {
    route = installationList(["acme-org/websites", "acme-org/beta"]);
    expect(await reachRepo(mixedEnv(), "acme-org/beta")).toEqual({ reachable: true });
    expect(calls.some((c) => c.url.includes("/installation/repositories"))).toBe(true);
    // No per-repo GET: the installation list IS the boundary on this path.
    expect(calls.some((c) => c.url === "https://api.github.com/repos/acme-org/beta")).toBe(false);
  });

  it("matches the list case-insensitively, as GitHub owner/repo names are", async () => {
    route = installationList(["Acme-Org/Beta"]);
    expect((await reachRepo(mixedEnv(), "acme-org/beta")).reachable).toBe(true);
  });

  it("refuses a repo outside the installation, naming the per-owner installation var too (P6c)", async () => {
    // Was a fixed string (APP_REMEDY) with no var name at all. Now it also
    // names the escape hatch for THIS owner — see the P6c section below for
    // why it is always the per-owner format, never the shared default's name.
    route = installationList(["acme-org/websites"]);
    const reach = await reachRepo(appEnv(), "rafarc21/sample");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toBe(
      "is not reachable by this fleet's GitHub App installation — " +
      "install the app on it (or add it to the installation's repository list) first, " +
      "or set GITHUB_INSTALLATION_ID_RAFARC21 if this owner needs its own installation",
    );
  });

  it("throws when the installation list cannot be read", async () => {
    route = (url) => url.includes("/access_tokens")
      ? Response.json({ token: "ghs_installation_token" })
      : new Response("Bad credentials", { status: 401 });
    await expect(reachRepo(appEnv(), "acme-org/beta")).rejects.toThrow(/401/);
  });

  it("issue #331 — mints its OWN check UNSCOPED, by design (see reachRepo's own doc comment)", async () => {
    // reachRepo's mint never leaves this function (one GET, discarded
    // immediately) and answers "is this repo in reach AT ALL" for a repo that
    // may not be anyone's workRepoSlug yet — unlike every other mint in this
    // codebase, which ships to a container or spends on a merge. Scoping it
    // would trade a well-understood "is repo in this list" check for
    // reinterpreting a mint 422 as "unreachable", so it deliberately opts out
    // via `unscoped: true` and sends no `repositories` field at all.
    route = installationList(["acme-org/websites", "acme-org/beta"]);
    await reachRepo(mixedEnv(), "acme-org/beta");
    const mint = calls.find((c) => c.url.includes("/access_tokens"))!;
    expect(mint.body).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// P6b — per-owner tokens.
//
// A fine-grained PAT has exactly ONE resource owner. The deployed fleet's
// `fleet-1` token owns `rafarc21`, so `acme-hq/acme-os` — an org repo on a
// different owner — was unreachable no matter what GITHUB_REPO_AUTH said.
// Measured 2026-09-11, `fleet onboard` inside /Users/you/code/acme:
//
//   [FAIL] reachable & writable — repo "acme-hq/acme-os" is not writable
//
// One PAT cannot be made to cover both owners; only a SECOND PAT can. So the
// token provider gains the same per-owner shape the provider choice already
// had: owner -> secret name, with GITHUB_TOKEN as the declared default for
// every owner that has no secret of its own.
//
// The property resolveRepoAuthKind's doc comment protects is unchanged and is
// the reason the fallback goes only one way: a per-owner MISS falls back to
// GITHUB_TOKEN — same provider, operator-declared default. A per-owner token
// is NEVER served for an owner other than the one it is named for, which would
// be exactly the silent-wrong-credential failure this seam exists to prevent.

const ACME_PAT = "github_pat_11ACME0_acmeacmeacme";

/** Both owners, the shape the operator ends up with: the org on the App, the
 *  personal owner on the default PAT, acme-hq on its own. */
const perOwnerEnv = (): Env => ({
  ...mixedEnv(), GITHUB_TOKEN_ACME_HQ: ACME_PAT,
}) as unknown as Env;

describe("tokenEnvName — the owner -> secret-name contract", () => {
  it("uppercases and replaces every non-alphanumeric with _", () => {
    // THE contract the operator types into `wrangler secret put`. If this
    // changes, every already-set secret silently stops being found.
    expect(tokenEnvName("acme-hq")).toBe("GITHUB_TOKEN_ACME_HQ");
    expect(tokenEnvName("rafarc21")).toBe("GITHUB_TOKEN_RAFARC21");
    expect(tokenEnvName("acme-org")).toBe("GITHUB_TOKEN_ACME_ORG");
    expect(tokenEnvName("foo.bar")).toBe("GITHUB_TOKEN_FOO_BAR");
    expect(tokenEnvName("a1-b2.c3")).toBe("GITHUB_TOKEN_A1_B2_C3");
  });

  it("takes the owner however the repo was typed, since owners are case-insensitive", () => {
    expect(tokenEnvName(repoOwner("Acme-HQ/Acme-OS"))).toBe("GITHUB_TOKEN_ACME_HQ");
  });
});

describe("mintRepoToken — per-owner tokens", () => {
  it("serves acme-hq its OWN token, not the default GITHUB_TOKEN", async () => {
    expect(await mintRepoToken(perOwnerEnv(), "acme-hq/acme-os")).toBe(ACME_PAT);
    expect(calls).toHaveLength(0);
  });

  it("falls back to GITHUB_TOKEN for an owner with no token of its own", async () => {
    expect(await mintRepoToken(perOwnerEnv(), "rafarc21/sample")).toBe(PAT);
  });

  it("NEVER serves one owner's token to another owner", async () => {
    // The silent-wrong-credential failure this seam exists to prevent.
    expect(await mintRepoToken(perOwnerEnv(), "rafarc21/sample")).not.toBe(ACME_PAT);
    expect(await mintRepoToken(perOwnerEnv(), "someone/else")).not.toBe(ACME_PAT);
  });

  it("keeps the App path byte-identical — an App-mapped owner ignores its per-owner token", async () => {
    // Regression guard: passes before P6b too, which is the point.
    route = () => Response.json({ token: "ghs_installation_token" });
    const env = { ...perOwnerEnv(), GITHUB_TOKEN_ACME_ORG: "github_pat_11NEVER0_neverneverused" } as Env;
    expect(await mintRepoToken(env, "acme-org/websites")).toBe("ghs_installation_token");
    expect(calls[0].url).toBe("https://api.github.com/app/installations/2222222/access_tokens");
  });

  it("treats an empty per-owner secret as absent, falling back to the default", async () => {
    const env = { ...mixedEnv(), GITHUB_TOKEN_ACME_HQ: "" } as Env;
    expect(await mintRepoToken(env, "acme-hq/acme-os")).toBe(PAT);
  });
});

describe("resolveRepoAuthKind — a per-owner token configures the token path", () => {
  it("picks the token for an owner whose ONLY credential is its per-owner secret", () => {
    // No GITHUB_TOKEN at all: without this, hasToken would read false and the
    // owner would fall through to the App, which cannot see it either.
    const env = { GITHUB_TOKEN_ACME_HQ: ACME_PAT } as unknown as Env;
    expect(resolveRepoAuthKind(env, "acme-hq/acme-os")).toBe("token");
  });

  it("does NOT let one owner's token configure the token path for another owner", () => {
    // App + acme's token only. acme-hq resolves to the token; every other
    // owner falls to the App, the provider the operator actually configured
    // for them — never to a credential named for somebody else.
    const env = { ...appEnv(), GITHUB_TOKEN_ACME_HQ: ACME_PAT } as unknown as Env;
    expect(resolveRepoAuthKind(env, "acme-hq/acme-os")).toBe("token");
    expect(resolveRepoAuthKind(env, "rafarc21/sample")).toBe("app");
  });

  it("satisfies an explicit owner=token mapping with the per-owner secret alone", () => {
    const env = { GITHUB_REPO_AUTH: "acme-hq=token", GITHUB_TOKEN_ACME_HQ: ACME_PAT } as unknown as Env;
    expect(resolveRepoAuthKind(env, "acme-hq/acme-os")).toBe("token");
  });

  it("still refuses when NEITHER a token nor the App is configured, message unchanged", () => {
    // Regression guard: the per-owner lookup must not accidentally satisfy
    // hasToken for an owner that has nothing.
    const env = { GITHUB_TOKEN_ACME_HQ: ACME_PAT } as unknown as Env;
    expect(() => resolveRepoAuthKind(env, "rafarc21/sample")).toThrow(
      'no GitHub repo auth configured for "rafarc21" — set GITHUB_TOKEN (a fine-grained PAT), ' +
      "or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_INSTALLATION_ID for a GitHub App",
    );
  });
});

describe("reachRepo — asks the OWNER's token", () => {
  it("checks acme-hq with the acme token, not the default one", async () => {
    route = () => Response.json({ full_name: "acme-hq/acme-os", permissions: { push: true } });
    expect(await reachRepo(perOwnerEnv(), "acme-hq/acme-os")).toEqual({ reachable: true });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme-hq/acme-os");
    expect(calls[0].headers.authorization).toBe(`Bearer ${ACME_PAT}`);
  });

  it("still checks an owner with no token of its own with GITHUB_TOKEN", async () => {
    route = () => Response.json(WRITABLE);
    expect((await reachRepo(perOwnerEnv(), "rafarc21/sample")).reachable).toBe(true);
    expect(calls[0].headers.authorization).toBe(`Bearer ${PAT}`);
  });

  it("never puts a per-owner token in a thrown message either", async () => {
    route = () => new Response("Bad credentials", { status: 401 });
    await reachRepo(perOwnerEnv(), "acme-hq/acme-os").then(
      () => { throw new Error("should have thrown"); },
      (err: Error) => { expect(err.message).not.toContain("github_pat_"); },
    );
  });
});

describe("repoTokenMinter — per-owner tokens stay per owner", () => {
  it("hands two owners two different PATs from one minter", async () => {
    const mint = repoTokenMinter(perOwnerEnv());
    expect(await mint("acme-hq/acme-os")).toBe(ACME_PAT);
    expect(await mint("rafarc21/sample")).toBe(PAT);
  });

  it("memoises per owner without leaking the first owner's credential", async () => {
    const mint = repoTokenMinter(perOwnerEnv());
    await mint("acme-hq/acme-os");
    expect(await mint("acme-hq/other-repo")).toBe(ACME_PAT);
    expect(await mint("rafarc21/sample")).toBe(PAT);
  });
});

describe("reachRepo — the remedy names the secret that actually answered", () => {
  it("names the OWNER's variable when the owner has its own token", async () => {
    // The operator's next action is `wrangler secret put <name>`. Naming
    // GITHUB_TOKEN here would send them to fix a credential that was never
    // used for this repo — and the one that was would stay wrong.
    route = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const reach = await reachRepo(perOwnerEnv(), "acme-hq/acme-os");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("GITHUB_TOKEN_ACME_HQ");
  });

  it("names plain GITHUB_TOKEN when that is the credential the owner fell back to", async () => {
    route = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const reach = await reachRepo(perOwnerEnv(), "rafarc21/sample");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("GITHUB_TOKEN write access");
    expect(reach.remedy).not.toContain("GITHUB_TOKEN_");
  });

  it("names shared GITHUB_TOKEN for a BRAND-NEW owner — no per-owner token, no per-owner installation id, everything falls to the default", async () => {
    // Investigated per the P6c task: tokenRemedy already takes `varName` and
    // is already called with tokenVarName(env, owner) at reachRepo's call
    // site (auth.ts) — this test exists to prove that was ALREADY correct,
    // not to fix a live bug. A genuinely never-configured owner (present in
    // no map, no GITHUB_TOKEN_<OWNER>, no GITHUB_INSTALLATION_ID_<OWNER>) has
    // only the shared GITHUB_TOKEN to fall back to, and the remedy must name
    // exactly that — never a per-owner var this owner was never given.
    route = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const reach = await reachRepo(perOwnerEnv(), "brand-new-owner/repo");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("GITHUB_TOKEN write access");
    expect(reach.remedy).not.toContain("GITHUB_TOKEN_");
  });
});

// ---------------------------------------------------------------------------
// P6c — per-owner installation ids, the App-side mirror of P6b's per-owner
// tokens. GitHub Apps install per ACCOUNT: a global GITHUB_INSTALLATION_ID
// only ever covers the ONE org it was minted for. Measured 2026-09-16 across
// the orgs the operator admins:
//
//   acme-org  -> covered (2222222, the deployed default)
//   demositeltda  -> not covered, no installation path at all
//   acme-hq    -> not covered (P6b already gave it a token path, not an app one)
//   demositellc   -> not covered, no installation path at all
//
// Same fix shape as P6b: an owner may bring its own
// GITHUB_INSTALLATION_ID_<OWNER>, with the shared GITHUB_INSTALLATION_ID as
// the declared default for every owner with none. The fallback runs the same
// one way only — a per-owner installation id is never served for any owner
// but its own.

/** demositeltda: an owner with its OWN installation id and nothing else — no
 *  shared GITHUB_INSTALLATION_ID, no token of any kind. Exercises hasApp's
 *  per-owner branch in isolation, the same way P6b's perOwnerEnv exercises
 *  hasToken's. */
const demositeltdaAppEnv = (): Env => ({
  GITHUB_APP_ID: "1111111", GITHUB_APP_PRIVATE_KEY: pem,
  GITHUB_INSTALLATION_ID_DEMOSITELTDA: "778899",
}) as unknown as Env;

describe("resolveRepoAuthKind — a per-owner installation id configures the app path", () => {
  it("picks the app for an owner whose ONLY credential is its own installation id", () => {
    // No shared GITHUB_INSTALLATION_ID at all: without per-owner hasApp this
    // owner would fall through to "no auth configured" even though its own
    // installation id is right there — the same gap P6b closed for tokens.
    expect(resolveRepoAuthKind(demositeltdaAppEnv(), "demositeltda/site")).toBe("app");
  });

  it("does NOT let one owner's installation id configure the app path for another owner", () => {
    // demositeltda's own id must never leak into a "so-and-so's app is
    // configured" answer for anybody else — the App trio (id included) is
    // still missing for this owner, so it refuses naming both ways out.
    expect(() => resolveRepoAuthKind(demositeltdaAppEnv(), "someone-else/repo")).toThrow(/GITHUB_TOKEN/);
    expect(() => resolveRepoAuthKind(demositeltdaAppEnv(), "someone-else/repo")).toThrow(/GITHUB_APP_ID/);
  });

  it("satisfies an explicit owner=app mapping with the per-owner installation id alone", () => {
    const env = { ...demositeltdaAppEnv(), GITHUB_REPO_AUTH: "demositeltda=app" } as Env;
    expect(resolveRepoAuthKind(env, "demositeltda/site")).toBe("app");
  });

  it("still refuses an app-mapped owner when NEITHER its own id nor the shared one is set", () => {
    // Regression guard: the per-owner lookup must not accidentally satisfy
    // hasApp for an owner that has nothing — same message as before P6c.
    const env = { GITHUB_APP_ID: "1111111", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_REPO_AUTH: "demositeltda=app" } as unknown as Env;
    expect(() => resolveRepoAuthKind(env, "demositeltda/site")).toThrow(/GITHUB_INSTALLATION_ID/);
  });
});

describe("reachRepo — asks the OWNER's installation", () => {
  it("mints against the owner's own installation id, not the shared default", async () => {
    route = installationList(["demositeltda/site"]);
    expect(await reachRepo(demositeltdaAppEnv(), "demositeltda/site")).toEqual({ reachable: true });
    expect(calls.some((c) => c.url === "https://api.github.com/app/installations/778899/access_tokens")).toBe(true);
  });
});

describe("reachRepo — the app remedy names the per-owner installation var", () => {
  it("names the PER-OWNER var for a brand-new owner falling back to the shared installation", async () => {
    // The escape hatch this owner does not know exists yet: it has no
    // installation of its own, so the shared GITHUB_INSTALLATION_ID answered
    // and its repo is (unsurprisingly) not in THAT installation's list.
    route = installationList(["acme-org/websites"]);
    const reach = await reachRepo(appEnv(), "demositeltda/site");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("GITHUB_INSTALLATION_ID_DEMOSITELTDA");
    // Never the bare shared name on its own — only ever as the per-owner
    // suffix. (The negative lookahead accepts "..._DEMOSITELTDA" and would
    // reject a bare "...GITHUB_INSTALLATION_ID" appearing anywhere else.)
    expect(reach.remedy).not.toMatch(/GITHUB_INSTALLATION_ID(?!_)/);
  });

  it("names the SAME per-owner var for an owner that already has its own installation configured", async () => {
    // Bullet 2 of the P6c spec: still names the owner's own var even when it
    // is already set — the message tells an operator WHICH knob governs this
    // owner, whether or not they have touched it yet.
    route = installationList(["acme-org/websites"]);
    const reach = await reachRepo(demositeltdaAppEnv(), "demositeltda/other-repo");
    expect(reach.reachable).toBe(false);
    if (reach.reachable) return;
    expect(reach.remedy).toContain("GITHUB_INSTALLATION_ID_DEMOSITELTDA");
  });
});
