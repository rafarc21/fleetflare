// #715 Phase 1 (Task 16): the ONE place a real R2 credential is used on
// GateRunnerDO's behalf. The container makes PLAIN HTTP requests to
// http://gate-r2.internal/<key>; the Worker-side GateOutbound entrypoint
// (outbound-entrypoint.ts) is wired in as the container's outbound handler
// via ctx.container.interceptAllOutboundHttp, and it calls this function. The
// container never sees a token, a key, or a signed URL: the STUDIO_ARCHIVE
// binding inside this Worker is the credential, and this allow-list decides
// what it is used for.
//
// #715 private-repo clones: the same interceptor also serves
// http://git-proxy.internal/<owner>/<repo>.git. That host proxies ONLY git
// smart-HTTP upload-pack fetch traffic for props.repo, with the token GateRunnerDO
// minted once at leg start (props.gitToken, App-only, contents: read). This
// handler never mints. The container never holds the token.
//
// Pure on purpose: no cloudflare:workers import, so bun test can load it.

export const GATE_R2_HOST = "gate-r2.internal";

/** The private-repo clone host. Plain HTTP, so the Worker-side outbound
 *  handler intercepts it. Its only job is git fetch traffic for one repo. */
export const GIT_PROXY_HOST = "git-proxy.internal";

const GITHUB_ORIGIN = "https://github.com";
/** `<owner>/<repo>.git/` then exactly one of the two fetch endpoints. The
 *  endpoint is what limits the proxy to fetch: `git-receive-pack` matches no
 *  alternative here, so a push cannot be routed at all. */
const GIT_PATH_RE = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-upload-pack)$/;

/** The only container request headers copied upstream. Everything else the
 *  container sends (its own Authorization, Cookie, Host) is dropped. */
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "git-protocol", "content-encoding"] as const;

/** Result JSON is a few KB. 1 MiB is generous headroom, and a hard cap keeps
 *  a runaway leg from buffering an arbitrary body inside the Worker. */
export const MAX_RESULT_BYTES = 1024 * 1024;

const SEG = "[A-Za-z0-9._-]+";
// Results: one distinct key per leg per run, `runs/<pr>/<runId>/shard-<leg>.json`
// (fanout.ts planLegs). The runId segment is the Workflow instance id, so a second
// run on the same PR never reuses a write-once key. Never a baseline path.
// Variants (#1100): `shard-<leg>.retry.json` (retry log, #1063) and
// `shard-<leg>@head.json` (union leg, #1095), each optionally combined. Shard
// name chars stay exact: no path separators, no uppercase, no other suffixes.
// Baselines: `<owner>/<repo>/baselines/<sha>-<lockhash>.tar` (baseline.ts baselineTarballKey).
const RUN_RESULT_RE = new RegExp(`^gate/(${SEG})/(${SEG})/runs/(${SEG})/(${SEG})/shard-[a-z0-9-]+(@head)?(\\.retry)?\\.json$`);
const BASELINE_RE = new RegExp(`^gate/(${SEG})/(${SEG})/baselines/(${SEG})\\.tar$`);
// #1080: one git bundle per run, `bundles/<runId>/<headSha>.bundle`. Only the
// bundle leg may write it (bundleWriter); every other leg reads its own run's.
const BUNDLE_RE = new RegExp(`^gate/(${SEG})/(${SEG})/bundles/(${SEG})/([0-9a-f]{40})\\.bundle$`);
/** The largest bundle the Worker buffers in one PUT. Above it the bundle leg
 *  uploads nothing and every leg clones (the fallback), so a big repo costs
 *  time, never a wrong verdict. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface OutboundTarget {
  bucket: "STUDIO_ARCHIVE";
  key: string;
}

/** Allow-list resolver. Returns the R2 key for a container path that matches
 *  one of the two exact gate/ shapes, or null for everything else. Never a
 *  passthrough: a path that doesn't match is refused, not signed against an
 *  arbitrary key. */
export function resolveOutboundTarget(path: string): OutboundTarget | null {
  const key = path.replace(/^\/+/, "");
  if (key.split("/").some((seg) => seg === "." || seg === "..")) return null;
  if (RUN_RESULT_RE.test(key) || BASELINE_RE.test(key) || BUNDLE_RE.test(key)) return { bucket: "STUDIO_ARCHIVE", key };
  return null;
}

/** The container may write its own leg's result, never a baseline. A baseline
 *  is what every later PR's gate restores from, so PR code that could write one
 *  could poison every later verdict. A bundle is written only through its own
 *  PUT path above (bundleWriter), never here. */
function isWritableByContainer(key: string): boolean {
  return RUN_RESULT_RE.test(key);
}

/** The subset of the STUDIO_ARCHIVE R2 binding this handler uses. Kept narrow so
 *  the test can supply an in-memory fake; the real R2Bucket satisfies it. */
export interface OutboundBucket {
  get(key: string): Promise<{ body: ReadableStream | null; size: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(
    key: string,
    value: ArrayBuffer,
    opts?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<unknown | null>;
}

/** Set by GateRunnerDO when it registers the interceptor (do.ts), one per leg.
 *  `resultKey` is the only key this container may PUT: the leg's own result.
 *  The run id is part of that key, so another run's key is refused by equality.
 *  A private leg adds `repo`, the one `owner/name` the git proxy will serve, and
 *  `gitToken`, the read-only token the DO minted for it at leg start. A public
 *  leg has neither, so the git proxy 403s for it. */
export interface GateOutboundProps {
  resultKey: string;
  repo?: string;
  gitToken?: string;
  /** #1080: this run's bundle key. The only bundle key this container may read. */
  bundleKey?: string;
  /** #1080: set on the bundle leg alone. It may PUT `bundleKey`, and no other key. */
  bundleWriter?: boolean;
}

/** The Worker's side of the git proxy: the upstream fetch. Injected so the
 *  handler stays pure and the tests can observe every call. The token from
 *  props is set on the upstream request only, never on anything returned. */
export interface GitProxyDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

/** Upper bound on one upstream git request. A stalled GitHub connection must
 *  not hold the leg container open for the rest of its lifetime. */
export const GIT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** The upstream URL for one allowed git fetch request, or null. Allowed:
 *  GET info/refs?service=git-upload-pack and POST git-upload-pack, both for
 *  exactly `scopedRepo` (case-insensitive, as GitHub names are). Refused:
 *  receive-pack, every other endpoint or method, extra query parameters, and
 *  any other repo. */
export function resolveGitUpstream(method: string, url: URL, scopedRepo: string): string | null {
  const m = GIT_PATH_RE.exec(url.pathname);
  if (!m) return null;
  const [, owner, repo, endpoint] = m;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  if (`${owner}/${repo}`.toLowerCase() !== scopedRepo.toLowerCase()) return null;
  if (endpoint === "info/refs") {
    if (method !== "GET") return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || url.searchParams.get("service") !== "git-upload-pack") return null;
    return `${GITHUB_ORIGIN}/${owner}/${repo}.git/info/refs?service=git-upload-pack`;
  }
  if (method !== "POST" || url.search !== "") return null;
  return `${GITHUB_ORIGIN}/${owner}/${repo}.git/git-upload-pack`;
}

async function handleGitProxy(
  req: Request,
  url: URL,
  props: GateOutboundProps | undefined,
  git: GitProxyDeps | undefined,
): Promise<Response> {
  // A public leg has no repo and no token in props: nothing to proxy with, so 403.
  if (!git || !props?.repo || !props.gitToken) return new Response("forbidden", { status: 403 });
  const upstream = resolveGitUpstream(req.method, url, props.repo);
  if (!upstream) return new Response("forbidden", { status: 403 });

  // GitHub git smart HTTP rejects `Bearer` (401); it takes Basic auth with the
  // installation token as the password of user `x-access-token`.
  const basic = btoa(`x-access-token:${props.gitToken}`);
  const headers = new Headers({ authorization: `Basic ${basic}`, "user-agent": "fleet-gate" });
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let res: Response;
  try {
    res = await git.fetch(upstream, {
      method: req.method,
      headers,
      body: req.method === "POST" ? req.body : undefined,
      // A redirect would move the fetch to whatever repo it names. Refuse it.
      redirect: "manual",
      signal: AbortSignal.timeout(GIT_UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return new Response("upstream unavailable", { status: 502 });
  }
  // Diagnosis for a garbled git stream (#1104): the framing headers of every
  // upstream response. Status and encoding headers only, never the token.
  console.log(`gate git-proxy: upstream ${res.status} content-encoding=${res.headers.get("content-encoding") ?? "-"} transfer-encoding=${res.headers.get("transfer-encoding") ?? "-"}`);
  if (res.status >= 300 && res.status < 400) return new Response("upstream redirect refused", { status: 502 });
  // Only the body and content-type of a 200 reach the container. Upstream
  // headers (set-cookie, request ids) and error bodies are dropped.
  if (res.status !== 200) return new Response(null, { status: res.status });
  return new Response(res.body, {
    status: 200,
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
  });
}

/** Serves one plain container request. Every branch either uses the bucket for
 *  an allow-listed key or returns a status without touching it. A PUT needs
 *  props whose resultKey equals the requested key exactly; missing props deny
 *  every write. A git request needs props.repo, props.gitToken and the git deps. */
export async function handleGateOutbound(
  req: Request,
  bucket: OutboundBucket,
  props?: GateOutboundProps,
  git?: GitProxyDeps,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.host === GIT_PROXY_HOST) return handleGitProxy(req, url, props, git);
  if (url.host !== GATE_R2_HOST) return new Response("forbidden", { status: 403 });

  const target = resolveOutboundTarget(url.pathname);
  if (!target) return new Response("forbidden", { status: 403 });
  const isBundle = BUNDLE_RE.test(target.key);
  // #1080: a bundle is read only by the run it was built for, and written only by its bundle leg.
  if (isBundle && props?.bundleKey !== target.key) return new Response("forbidden", { status: 403 });

  if (req.method === "GET") {
    const obj = await bucket.get(target.key);
    if (!obj) return new Response("not found", { status: 404 });
    return new Response(obj.body, { status: 200, headers: { "content-length": String(obj.size) } });
  }

  if (req.method === "HEAD") {
    const obj = await bucket.head(target.key);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(null, { status: 200, headers: { "content-length": String(obj.size) } });
  }

  if (req.method === "PUT") {
    if (isBundle) {
      if (!props?.bundleWriter) return new Response("forbidden", { status: 403 });
    } else {
      if (!isWritableByContainer(target.key)) return new Response("forbidden", { status: 403 });
      if (!props?.resultKey || props.resultKey !== target.key) return new Response("forbidden", { status: 403 });
    }
    const cap = isBundle ? MAX_BUNDLE_BYTES : MAX_RESULT_BYTES;
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > cap) return new Response("too large", { status: 413 });
    const body = await req.arrayBuffer();
    if (body.byteLength > cap) return new Response("too large", { status: 413 });
    // write-once: a leg's result key may be created once, never replaced.
    const stored = await bucket.put(target.key, body, { onlyIf: { etagDoesNotMatch: "*" } });
    if (stored === null) return new Response("already written", { status: 412 });
    return new Response(null, { status: 201 });
  }

  return new Response("method not allowed", { status: 405 });
}
