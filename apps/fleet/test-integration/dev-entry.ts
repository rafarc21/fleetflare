// Integration-only `wrangler dev` entry point. NOT part of the deployed
// Worker: `wrangler.jsonc`'s `main` still points at `src/index.ts`, and this
// file is reached only when attach.e2e.ts spawns
// `wrangler dev test-integration/dev-entry.ts`.
//
// Why it exists at all
// --------------------
// The integration test drives the REAL Worker, the REAL StudioDO, and a REAL
// container. Three things it cannot drive are genuinely outside this system:
//
//   1. `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` — Cloudflare
//      Access's JWKS. Reaching the real one needs a real Access tenant.
//   2. `https://api.github.com/app/installations/<id>/access_tokens` — needs
//      the real GitHub App private key.
//   3. `https://api.github.com/repos/<repo>/contents/<path>` — the blueprint
//      files, behind that same token.
//
// Everything else — Access JWT verification (real RSA signature check, real
// `aud`, real `exp`), blueprint parsing, the provisioning state machine, the
// guarded clone, bring-up, tmux, the pty, the WS bridge — runs unmodified.
// Only the three outbound URLs above are answered from fixtures, by patching
// `globalThis.fetch`.
//
// The alternative — an env-gated bypass inside `src/` — was rejected: a
// production code path that can be told to skip Access verification is a
// permanent hole in exchange for a temporary test convenience. Nothing under
// `src/` knows this file exists.
//
// Why the patch is installed from TWO places
// ------------------------------------------
// Call (1) is made by the Worker isolate (routes.ts -> studio/auth.ts) and
// calls (2)/(3) are made by the StudioDO isolate (do.ts -> github/*). Those
// are not guaranteed to be the same isolate, so `install()` runs both from
// the default export's handlers and from the DO's constructor — whichever
// happens first in a given isolate wins, and the second call is a no-op.
// The fixture material arrives through `.dev.vars` (written per run by
// attach.e2e.ts, deleted afterwards), which is why `install` needs `env` and
// therefore cannot simply be top-level code.
import type { Env } from "../src/env";
import worker from "../src/index";
import { StudioDO as RealStudioDO } from "../src/studio/do";

export { AgentDO } from "../src/agents/do";
export { DeployDO } from "../src/deploy/do";

/** The extra `.dev.vars` entries attach.e2e.ts writes for this entry only. */
interface ItEnv extends Env {
  IT_JWKS: string;
  IT_INSTALLATION_TOKEN: string;
  IT_BLUEPRINT_REPO: string;
  IT_SERVICE_CLIENT_ID: string;
  IT_SERVICE_CLIENT_SECRET: string;
  IT_SERVICE_JWT: string;
}

/**
 * Stands in for Cloudflare Access's own edge, which is what turns a service
 * token (CF-Access-Client-Id / CF-Access-Client-Secret — the only credentials
 * cli/fleet.ts ever holds) into the `Cf-Access-Jwt-Assertion` header the
 * Worker verifies. There is no Access edge in front of `wrangler dev`, so
 * without this the real CLI cannot be exercised against a local Worker at
 * all.
 *
 * Note what this does NOT do: it never skips verification. It mints nothing
 * and trusts nothing — it swaps one exact, locally-generated credential pair
 * for the fixture JWT, which src/studio/auth.ts then verifies for real
 * (signature, kid, aud, exp). A request with the wrong secret, or with no
 * service-token headers, is passed through untouched and gets the same 401/403
 * it would in production.
 */
function accessEdge(req: Request, env: ItEnv): Request {
  if (req.headers.get("Cf-Access-Jwt-Assertion")) return req;
  const id = req.headers.get("CF-Access-Client-Id");
  const secret = req.headers.get("CF-Access-Client-Secret");
  if (id !== env.IT_SERVICE_CLIENT_ID || secret !== env.IT_SERVICE_CLIENT_SECRET) return req;
  const headers = new Headers(req.headers);
  headers.set("Cf-Access-Jwt-Assertion", env.IT_SERVICE_JWT);
  return new Request(req, { headers });
}

/**
 * Fleet Spawn P3, Task 6: the pilot role file's ADVISORY spawn list, and
 * deliberately a superset of what org.json below actually permits it.
 *
 * `may_spawn` is documentation that lives inside a container the agent
 * controls; org.json, fetched server-side at the blueprint's pinned ref, is
 * the only thing the Worker checks (spawn.ts's own header: "the Worker is
 * law"). Claiming `cto` here — which org.json edges from `operator` but NOT
 * from `pilot` — is what makes attach.e2e.ts's denied-edge check prove that
 * invariant rather than merely illustrate it: the container asks for a role
 * its own role file advertises, and the Worker still refuses it.
 *
 * No runtime code reads this field at all (verified: `may_spawn` has zero
 * consumers under src/ outside blueprint.ts's parser), so a non-empty list
 * changes nothing else about provisioning.
 */
const PILOT_MAY_SPAWN = ["scratch", "cto"];

// Deliberately carries the real six-rule allowedTools string — the exact
// value the bring-up word-split fix is about. If bring-up ever regresses to
// splitting it, this is the value that would arrive corrupted.
const roleMd = (name: string) => `---
name: ${name}
skills: []
allowedTools: Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write
may_spawn: [${name === "pilot" ? PILOT_MAY_SPAWN.join(", ") : ""}]
reports_to: operator
gates: []
---
You are ${name}. This is an integration-test studio. Do nothing on your own.
`;

/**
 * Mirrors the SHIPPED fleet/blueprint/org.json (Task 3) rather than being a
 * minimal invention of its own — an e2e that judges spawns against a chart
 * the real fleet does not have would prove nothing about the real fleet.
 * The three properties the spawn checks turn on:
 *   - `pilot -> scratch`: the happy path, in-container `fleet spawn scratch`.
 *   - `operator -> scratch`: the same spawn from the Mac CLI (routes.ts's
 *     Access-gated passthrough, parent fixed to the operator literal).
 *   - `cto` edged from `operator` but NOT from `pilot`: the denied edge is
 *     then genuinely about WHO is asking, not about an unknown role name —
 *     `cto` is a role this chart knows perfectly well.
 */
const ORG_JSON = JSON.stringify({
  edges: {
    cto: ["release", "qa", "dev"],
    operator: ["cto", "pilot", "scratch"],
    pilot: ["scratch"],
  },
  gates: { merge: ["release"], deploy: ["release"] },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let installed = false;

function install(env: ItEnv): void {
  if (installed) return;
  installed = true;

  const fleetJson = JSON.stringify({
    blueprint: { repo: env.IT_BLUEPRINT_REPO, ref: "main" },
    roles: ["pilot", "scratch"],
    instance_type: "standard-2",
  });
  const certsUrl = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const jwks = env.IT_JWKS;
  const installationToken = env.IT_INSTALLATION_TOKEN;
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // (1) Access JWKS. The signature/aud/exp checks in src/studio/auth.ts
    // still run for real against these keys.
    if (url === certsUrl) return new Response(jwks, { headers: { "content-type": "application/json" } });

    // (2) GitHub App installation token. src/github/app.ts still signs a real
    // RS256 App JWT with the key in .dev.vars before getting here; only the
    // exchange is answered locally.
    if (url.includes("api.github.com/app/installations/")) {
      return json({ token: installationToken, expires_at: "2099-01-01T00:00:00Z" });
    }

    // (3) Blueprint files. Path-routed exactly the way the real Contents API
    // is called by src/github/api.ts's fetchRepoFile (raw media type -> plain
    // text body), so parseFleetJson/parseRoleFile run on realistic input.
    if (url.includes("api.github.com/repos/") && url.includes("/contents/")) {
      const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
      if (path === "fleet.json") return new Response(fleetJson);
      if (path === "fleet/blueprint/org.json") return new Response(ORG_JSON);
      const role = path.match(/^fleet\/blueprint\/roles\/(.+)\.md$/)?.[1];
      if (role) return new Response(roleMd(role));
      return new Response("Not Found", { status: 404 });
    }

    // Telegram alerts: swallowed rather than sent. Nothing in this test
    // asserts on them, and a real outbound call with a fake bot token is
    // pure noise.
    if (url.includes("api.telegram.org/")) return json({ ok: true });

    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Task 7: test-only orchestration routes. NOT part of the deployed Worker —
// same containment as everything else in this file (see header): `wrangler
// .jsonc`'s `main` still points at `src/index.ts`, and nothing under `src/`
// knows these paths exist. Three needs the real suites cannot satisfy any
// other way:
//
//   1. Forcing a StudioDO schedule callback (`shipTranscript`/`syncSession`)
//      to fire on demand, instead of waiting out its real 30s/300s interval.
//      These are already public DO methods — do.ts's own `this.schedule(sec,
//      "shipTranscript")` names them by that exact identifier — so calling
//      `stub.shipTranscript()` over the stub's ordinary RPC surface (the same
//      mechanism routes.ts's `stub.getStatus()`/`stub.provision(cfg)` already
//      use) invokes the EXACT SAME method body a real alarm fire would call.
//      Nothing here reimplements or shortcuts the tick itself.
//   2. Reading back what a tick shipped, through R2 — miniflare's local R2
//      simulation is reachable only from INSIDE the Worker (env.STUDIO_ARCHIVE),
//      so a read-back needs a route, the same reason the outbound-fetch shim
//      above has to run inside this same Worker rather than the test script.
//      Read-only: list + get. No write/put route exists here — every R2
//      object the tests ever assert on was produced by a real ship/sync tick
//      through the production code path above, never injected directly.
//   3. Reading the raw (unscrubbed) `transcriptTail` DO storage value
//      directly, so a ship/rotation assertion doesn't have to go through the
//      grid page's own scrub step (grid.ts's scrubPreview) to be checked —
//      that scrub is asserted separately, on purpose (see attach.e2e.ts's
//      grid-page check), so a raw-tail assertion and a scrubbed-preview
//      assertion can never be confused for one another.
//
// Gated behind a path prefix ("/__it__/") that cannot collide with any real
// `/studio/*` route, and reached BEFORE `accessEdge`/`worker.fetch` — these
// carry no Access check of their own (they are a local test harness talking
// to its own `wrangler dev`, not a studio operator surface).
// ---------------------------------------------------------------------------

const TICK_RE = /^\/__it__\/tick\/([^/]+)\/(shipTranscript|syncSession)$/;
const TAIL_RE = /^\/__it__\/tail\/([^/]+)$/;

async function handleTestOnlyRoutes(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);

  const tick = TICK_RE.exec(url.pathname);
  if (tick && req.method === "POST") {
    const [, id, name] = tick;
    const stub = env.STUDIO.get(env.STUDIO.idFromName(id));
    if (name === "shipTranscript") await stub.shipTranscript();
    else await stub.syncSession();
    return json({ ok: true });
  }

  const tail = TAIL_RE.exec(url.pathname);
  if (tail && req.method === "GET") {
    const stub = env.STUDIO.get(env.STUDIO.idFromName(tail[1]));
    return json({ tail: await stub.getTranscriptTail() });
  }

  // R2 read-back — key/prefix come straight from the test script, which
  // already knows the exact key formats (src/studio/archive.ts's chunkKey/
  // sessionLatestKey/sessionDailyKey) because it imports nothing else to
  // build them; this route does no interpretation of its own.
  if (url.pathname === "/__it__/r2/list" && req.method === "GET") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const listed = await env.STUDIO_ARCHIVE.list({ prefix });
    return json({ keys: listed.objects.map((o) => o.key).sort() });
  }
  if (url.pathname === "/__it__/r2/get" && req.method === "GET") {
    const key = url.searchParams.get("key");
    if (!key) return new Response("missing key", { status: 400 });
    const obj = await env.STUDIO_ARCHIVE.get(key);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(await obj.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } });
  }

  return null;
}

export class StudioDO extends RealStudioDO {
  // Spread-forwarded rather than re-declaring (ctx, env): the Sandbox base
  // class's own constructor signature is what must be satisfied, and copying
  // it here would just be a second place to get it wrong.
  constructor(...args: ConstructorParameters<typeof RealStudioDO>) {
    super(...args);
    install(args[1] as ItEnv);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    install(env as ItEnv);
    // Task 7: test-only routes are checked first and short-circuit — see
    // handleTestOnlyRoutes's own header for why this is safe containment.
    const testRes = await handleTestOnlyRoutes(req, env);
    if (testRes) return testRes;
    return worker.fetch(accessEdge(req, env as ItEnv), env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    install(env as ItEnv);
    return worker.scheduled(controller, env, ctx);
  },
};
