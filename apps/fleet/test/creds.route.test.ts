import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { handleFleetCreds, __resetInfisicalTokenCacheForTests } from "../src/creds/test-creds";
import { SPAWN_TOKEN_HEADER } from "../src/studio/spawn";
import { hashSpawnToken, mintSpawnToken } from "../src/studio/org";
import { recordStudio } from "../src/studio/registry";
import type { StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

// Issue #279: GET /fleet/creds/<name>. Spawn-token auth (same as /fleet/tasks
// and /fleet/junior), per-repo allowlist, Worker-held Infisical machine
// identity. All Infisical traffic is a mocked fetch — no real credential and
// no real network anywhere in this file.

const REPO = "acme-org/websites";
const ME = "websites--web-studio";
const OTHER = "beta--web-studio";
const SECRET_VALUE = "fake-secret-value-7f3a9c";
const CLIENT_SECRET = "fake-client-secret-0b1d";
const ACCESS_TOKEN = "fake-access-token-4e2c";
const BASE = "https://infisical.example.test";

const CONFIG = JSON.stringify({
  [REPO]: { viewer: { workspaceId: "ws-1", environment: "staging", secretPath: "/test-accounts", key: "VIEWER_PASSWORD" } },
  "acme-org/beta": { editor: { workspaceId: "ws-2", environment: "dev", secretPath: "/test-accounts/beta", key: "EDITOR_PASSWORD" } },
});

function row(id: string, hash: string, repoSlug: string | null = REPO): StudioStatus {
  return { id, state: "running", tailscaleHost: null, lastRefresh: null, error: null,
    lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug };
}

function configured(over: Partial<Env> = {}): Env {
  return { ...env, AGENT_REPO: REPO, INFISICAL_CLIENT_ID: "fake-client-id", INFISICAL_CLIENT_SECRET: CLIENT_SECRET,
    INFISICAL_API_URL: BASE, TEST_CREDS_BY_REPO: CONFIG, ...over } as unknown as Env;
}

type Call = { url: string; method: string; body: string | null; auth: string | null };

/** Fake Infisical. `login`/`secret` pick the upstream status per call. */
function infisical(opts: { login?: () => Response | Promise<Response>; secret?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "POST" ? await req.text() : null;
    calls.push({ url: req.url, method: req.method, body, auth: req.headers.get("authorization") });
    const path = new URL(req.url).pathname;
    if (path === "/api/v1/auth/universal-auth/login") {
      return opts.login ? opts.login() : Response.json({ accessToken: ACCESS_TOKEN, expiresIn: 600, tokenType: "Bearer" });
    }
    if (path.startsWith("/api/v3/secrets/raw/")) {
      return opts.secret ? opts.secret() : Response.json({ secret: { secretKey: "VIEWER_PASSWORD", secretValue: SECRET_VALUE } });
    }
    return new Response("unexpected", { status: 500 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

async function caller(id = ME, repoSlug: string | null = REPO) {
  const token = mintSpawnToken();
  const rows = [row(id, await hashSpawnToken(token), repoSlug)];
  return { token, rows: async () => rows };
}

const get = (name: string, token: string | null) =>
  new Request(`https://x/fleet/creds/${name}`, { headers: token ? { [SPAWN_TOKEN_HEADER]: token } : {} });

let logged: string[];
beforeEach(() => {
  __resetInfisicalTokenCacheForTests();
  logged = [];
  for (const m of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe("handleFleetCreds — auth and allowlist", () => {
  it("returns the one allowlisted secret to its own studio", async () => {
    const c = await caller();
    const up = infisical();
    const res = await handleFleetCreds(get("viewer", c.token), configured(), { rows: c.rows, fetch: up.fn });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ name: "viewer", value: SECRET_VALUE });
    const read = up.calls.find((x) => x.method === "GET")!;
    const u = new URL(read.url);
    expect(u.origin).toBe(BASE);
    expect(u.pathname).toBe("/api/v3/secrets/raw/VIEWER_PASSWORD");
    expect(u.searchParams.get("workspaceId")).toBe("ws-1");
    expect(u.searchParams.get("environment")).toBe("staging");
    expect(u.searchParams.get("secretPath")).toBe("/test-accounts");
    expect(read.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    const login = up.calls.find((x) => x.method === "POST")!;
    expect(JSON.parse(login.body!)).toEqual({ clientId: "fake-client-id", clientSecret: CLIENT_SECRET });
  });

  it("401s no token, a malformed token, and an unknown token — before touching Infisical", async () => {
    const c = await caller();
    const up = infisical();
    for (const t of [null, "nope", mintSpawnToken()]) {
      const res = await handleFleetCreds(get("viewer", t), configured(), { rows: c.rows, fetch: up.fn });
      expect(res.status).toBe(401);
    }
    expect(up.calls).toEqual([]);
  });

  it("403s a name not in the caller's repo allowlist", async () => {
    const c = await caller();
    const up = infisical();
    const res = await handleFleetCreds(get("nobody", c.token), configured(), { rows: c.rows, fetch: up.fn });
    expect(res.status).toBe(403);
    expect(up.calls).toEqual([]);
  });

  it("403s a name allowlisted only for another repo (cross-repo deny)", async () => {
    const c = await caller();
    const up = infisical();
    const res = await handleFleetCreds(get("editor", c.token), configured(), { rows: c.rows, fetch: up.fn });
    expect(res.status).toBe(403);
    expect(up.calls).toEqual([]);
  });

  it("403s a studio bound to a repo with no allowlist at all", async () => {
    const c = await caller("other--web-studio", "acme-org/other");
    const res = await handleFleetCreds(get("viewer", c.token), configured(), { rows: c.rows, fetch: infisical().fn });
    expect(res.status).toBe(403);
  });

  it("a studio with no repoSlug falls back to AGENT_REPO, like every other studio route", async () => {
    const c = await caller(ME, null);
    const res = await handleFleetCreds(get("viewer", c.token), configured(), { rows: c.rows, fetch: infisical().fn });
    expect(res.status).toBe(200);
  });

  it("the other repo's studio gets its own entry", async () => {
    const c = await caller(OTHER, "acme-org/beta");
    const res = await handleFleetCreds(get("editor", c.token), configured(), { rows: c.rows, fetch: infisical().fn });
    expect(res.status).toBe(200);
  });

  it("400s a malformed name and 405s a non-GET", async () => {
    const c = await caller();
    expect((await handleFleetCreds(get("bad%20name", c.token), configured(), { rows: c.rows, fetch: infisical().fn })).status)
      .toBe(400);
    const post = new Request("https://x/fleet/creds/viewer", { method: "POST", headers: { [SPAWN_TOKEN_HEADER]: c.token } });
    expect((await handleFleetCreds(post, configured(), { rows: c.rows, fetch: infisical().fn })).status).toBe(405);
  });
});

describe("handleFleetCreds — not configured", () => {
  for (const missing of ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "TEST_CREDS_BY_REPO"] as const) {
    it(`503 "test creds not configured" when ${missing} is absent`, async () => {
      const c = await caller();
      const up = infisical();
      const res = await handleFleetCreds(get("viewer", c.token), configured({ [missing]: undefined }), { rows: c.rows, fetch: up.fn });
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("test creds not configured");
      expect(up.calls).toEqual([]);
    });
  }

  it("503s a config the guard refuses (prod entry), and never calls Infisical", async () => {
    const c = await caller();
    const up = infisical();
    const bad = JSON.stringify({ [REPO]: { viewer: { workspaceId: "ws-1", environment: "production",
      secretPath: "/test-accounts", key: "VIEWER_PASSWORD" } } });
    const res = await handleFleetCreds(get("viewer", c.token), configured({ TEST_CREDS_BY_REPO: bad }), { rows: c.rows, fetch: up.fn });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("test creds config invalid");
    expect(up.calls).toEqual([]);
  });

  it("an unauthenticated caller still gets 401, not a config hint", async () => {
    const c = await caller();
    const res = await handleFleetCreds(get("viewer", null), configured({ TEST_CREDS_BY_REPO: undefined }), { rows: c.rows });
    expect(res.status).toBe(401);
  });

  it("refuses a non-https INFISICAL_API_URL", async () => {
    const c = await caller();
    const up = infisical();
    const res = await handleFleetCreds(get("viewer", c.token), configured({ INFISICAL_API_URL: "http://infisical.example.test" }),
      { rows: c.rows, fetch: up.fn });
    expect(res.status).toBe(503);
    expect(up.calls).toEqual([]);
  });
});

describe("handleFleetCreds — Infisical token cache", () => {
  it("logs in once and reuses the token until it nears expiry", async () => {
    const c = await caller();
    const up = infisical();
    let now = 1_000_000;
    const deps = { rows: c.rows, fetch: up.fn, now: () => now };
    await handleFleetCreds(get("viewer", c.token), configured(), deps);
    await handleFleetCreds(get("viewer", c.token), configured(), deps);
    expect(up.calls.filter((x) => x.method === "POST")).toHaveLength(1);
    now += 600_000; // expiresIn: 600s — past it, log in again
    await handleFleetCreds(get("viewer", c.token), configured(), deps);
    expect(up.calls.filter((x) => x.method === "POST")).toHaveLength(2);
  });

  it("drops the cached token when the read answers 401, so the next call logs in fresh", async () => {
    const c = await caller();
    let secretStatus = 401;
    const up = infisical({ secret: () => secretStatus === 200
      ? Response.json({ secret: { secretValue: SECRET_VALUE } })
      : new Response("expired", { status: secretStatus }) });
    const deps = { rows: c.rows, fetch: up.fn };
    expect((await handleFleetCreds(get("viewer", c.token), configured(), deps)).status).toBe(502);
    secretStatus = 200;
    expect((await handleFleetCreds(get("viewer", c.token), configured(), deps)).status).toBe(200);
    expect(up.calls.filter((x) => x.method === "POST")).toHaveLength(2);
  });

  it("a different client id never reuses another identity's token", async () => {
    const c = await caller();
    const up = infisical();
    await handleFleetCreds(get("viewer", c.token), configured(), { rows: c.rows, fetch: up.fn });
    await handleFleetCreds(get("viewer", c.token), configured({ INFISICAL_CLIENT_ID: "fake-client-id-2" }), { rows: c.rows, fetch: up.fn });
    expect(up.calls.filter((x) => x.method === "POST")).toHaveLength(2);
  });
});

describe("handleFleetCreds — Infisical error mapping", () => {
  const cases: Array<[string, Parameters<typeof infisical>[0], number]> = [
    ["login 401", { login: () => new Response(`bad creds ${CLIENT_SECRET}`, { status: 401 }) }, 502],
    ["login 500", { login: () => new Response("boom", { status: 500 }) }, 502],
    ["login network error", { login: () => { throw new TypeError("network down"); } }, 502],
    ["login 200 without accessToken", { login: () => Response.json({ expiresIn: 600 }) }, 502],
    ["secret 404", { secret: () => new Response("Secret not found", { status: 404 }) }, 404],
    ["secret 403", { secret: () => new Response("forbidden", { status: 403 }) }, 502],
    ["secret 500", { secret: () => new Response(`upstream ${SECRET_VALUE}`, { status: 500 }) }, 502],
    ["secret network error", { secret: () => { throw new TypeError("network down"); } }, 502],
    ["secret 200 without secretValue", { secret: () => Response.json({ secret: {} }) }, 502],
  ];
  for (const [label, opts, status] of cases) {
    it(`${label} -> ${status}, upstream body never echoed`, async () => {
      const c = await caller();
      const res = await handleFleetCreds(get("viewer", c.token), configured(), { rows: c.rows, fetch: infisical(opts).fn });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(text).not.toContain(SECRET_VALUE);
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain("network down");
    });
  }
});

describe("handleFleetCreds — audit", () => {
  it("logs every call (studio, name, outcome) and never the value, client secret or access token", async () => {
    const c = await caller();
    const up = infisical();
    await handleFleetCreds(get("viewer", c.token), configured(), { rows: c.rows, fetch: up.fn });
    await handleFleetCreds(get("editor", c.token), configured(), { rows: c.rows, fetch: up.fn });
    await handleFleetCreds(get("viewer", null), configured(), { rows: c.rows, fetch: up.fn });
    await handleFleetCreds(get("viewer", c.token), configured(),
      { rows: c.rows, fetch: infisical({ secret: () => new Response(SECRET_VALUE, { status: 500 }) }).fn });

    const audits = logged.filter((l) => l.includes("fleet_creds")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
    expect(audits.map((a) => [a.studio, a.name, a.outcome])).toEqual([
      [ME, "viewer", "allowed"],
      [ME, "editor", "denied"],
      [null, "viewer", "unauthorized"],
      [ME, "viewer", "upstream_error"],
    ]);
    for (const a of audits) expect(typeof a.at).toBe("string");
    const all = logged.join("\n");
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).not.toContain(CLIENT_SECRET);
    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).not.toContain(c.token);
  });
});

// The route must be MOUNTED, not just exist: these go through the real
// router (src/index.ts's default export) with a real D1 registry row.
describe("/fleet/creds mount (src/index.ts)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM fleet_state").run();
  });

  it("routes /fleet/creds/<name> to the creds handler, not the spawn catch-all", async () => {
    const res = await worker.fetch(get("viewer", null), configured(), {} as ExecutionContext);
    // handleFleetSpawn answers 405 to a GET (its method check runs first);
    // the creds handler 401s an unauthenticated GET. That difference is the proof.
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("serves the full flow end to end through the router", async () => {
    const token = mintSpawnToken();
    const e = configured();
    await recordStudio(e, row(ME, await hashSpawnToken(token)));
    const up = infisical();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(up.fn);
    const res = await worker.fetch(get("viewer", token), e, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "viewer", value: SECRET_VALUE });
    expect(spy).toHaveBeenCalled();
    expect(logged.join("\n")).not.toContain(SECRET_VALUE);
  });

  it("answers 503 through the router when not configured", async () => {
    const token = mintSpawnToken();
    const e = configured({ INFISICAL_CLIENT_ID: undefined });
    await recordStudio(e, row(ME, await hashSpawnToken(token)));
    const res = await worker.fetch(get("viewer", token), e, {} as ExecutionContext);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("test creds not configured");
  });
});
