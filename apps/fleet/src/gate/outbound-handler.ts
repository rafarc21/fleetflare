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
// #1080: one git bundle per run, `gate-bundles/<owner>/<repo>/<runId>/<headSha>.bundle`.
// Only the bundle leg may write it (bundleWriter); every other leg reads its own run's.
const BUNDLE_RE = new RegExp(`^gate-bundles/(${SEG})/(${SEG})/(${SEG})/([0-9a-f]{40})\\.bundle$`);
/** The largest snapshot the bundle leg may upload (#1080 HIGH 1). The Worker streams
 *  it to R2 and never holds it whole, so this bounds storage and transfer, not memory.
 *  Same value as BUNDLE_MAX_BYTES in container/gate-server.ts. Above it the bundle leg
 *  uploads nothing and every leg clones, so a big repo costs time, never a wrong
 *  verdict. Provisional until sized from a measured large repo. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** A bundle body whose bytes disagree with its declared length. */
export class BundleBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
  }
}

/** Passes the body through, and fails it when its bytes stop matching `declared`:
 *  more bytes than declared is 413, fewer is 400. R2 then stores nothing. */
export function lengthChecked(body: ReadableStream<Uint8Array> | null, declared: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return (body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > declared) ctl.error(new BundleBodyError(413, "body longer than declared"));
      else ctl.enqueue(chunk);
    },
    flush(ctl) {
      if (seen !== declared) ctl.error(new BundleBodyError(400, "body shorter than declared"));
    },
  }));
}

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
    value: ArrayBuffer | ReadableStream<Uint8Array>,
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
  /** Clock and wait for the retry loop. The Worker uses the real ones; tests inject a fake. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

/** Upper bound on one upstream git request, retries and waits included. A
 *  stalled GitHub connection must not hold the leg container open for the rest
 *  of its lifetime. */
export const GIT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** #1137: one first try plus up to three retries for a rate-limited upstream. */
export const GIT_UPSTREAM_MAX_ATTEMPTS = 4;
/** Random extra wait per retry, so legs that hit one limit do not retry in lockstep.
 *  The jitter is at least this, or half the wait if that is larger. */
export const RETRY_JITTER_MIN_MS = 1_000;
/** Wait for a 429 with no usable hint. Doubles on each retry. GitHub asks for at
 *  least one minute on a secondary limit with no header. */
const RETRY_BACKOFF_BASE_MS = 60_000;
/** A retry starts only if at least this much budget is left after its wait: the
 *  200 still has to download, and a late retry would truncate the pack. */
export const RETRY_MIN_TAIL_MS = 5 * 60 * 1000;
/** A POST body up to this size is buffered so a retry resends identical bytes.
 *  A larger body streams once and is never retried. */
export const MAX_RETRY_BODY_BYTES = 1024 * 1024;

/** Retry-After as milliseconds from `now`: delta-seconds, or an HTTP date that
 *  starts with a weekday name. Null when absent or unreadable ("1.5" is neither). */
function retryAfterMs(res: Response, now: number): number | null {
  const value = res.headers.get("retry-after");
  if (value === null) return null;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000;
  if (!/^\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Secondary-limit reset: when x-ratelimit-remaining is 0, x-ratelimit-reset is
 *  the epoch second the limit lifts. Null otherwise. */
function rateLimitResetMs(res: Response, now: number): number | null {
  if (res.headers.get("x-ratelimit-remaining") !== "0") return null;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return Number.isInteger(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : null;
}

/** 429 always retries. 403 retries only with a limit hint: Retry-After (secondary
 *  limit) or an exhausted reset (primary limit). A plain 403 is a permission
 *  refusal, not a rate limit. */
function isRetryable(status: number, hasLimitHint: boolean): boolean {
  return status === 429 || (status === 403 && hasLimitHint);
}

/** One retry's wait: the hint (or the backoff when there is none) plus jitter.
 *  The hint is waited in full, never cut short, so a retry cannot land before
 *  the upstream said it would accept one. */
function retryWaitMs(hint: number | null, attempt: number, random: number): number {
  const base = hint ?? RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return base + Math.floor(random * Math.max(RETRY_JITTER_MIN_MS, base / 2));
}

/** The request body, read once so every attempt sends the same bytes. Over the
 *  cap, the bytes read so far are replayed as a one-shot stream and retry is off. */
async function bodyForAttempts(req: Request): Promise<{ body: Uint8Array | ReadableStream<Uint8Array> | null; retryable: boolean }> {
  if (req.method !== "POST" || req.body === null) return { body: null, retryable: true };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { body: bytes, retryable: true };
    }
    chunks.push(value);
    total += value.byteLength;
    if (total > MAX_RETRY_BODY_BYTES) {
      let next = 0;
      const replay = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (next < chunks.length) {
            controller.enqueue(chunks[next++]);
            return;
          }
          const part = await reader.read();
          if (part.done) controller.close();
          else controller.enqueue(part.value);
        },
      });
      return { body: replay, retryable: false };
    }
  }
}

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

  const now = git.now ?? Date.now;
  const sleep = git.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = git.random ?? Math.random;
  // One budget for every attempt and every wait on this request (#1137).
  const deadline = now() + GIT_UPSTREAM_TIMEOUT_MS;
  let prepared: Awaited<ReturnType<typeof bodyForAttempts>>;
  try {
    prepared = await bodyForAttempts(req);
  } catch {
    return new Response("upstream unavailable", { status: 502 });
  }
  const { body, retryable } = prepared;

  // GitHub git smart HTTP rejects `Bearer` (401); it takes Basic auth with the
  // installation token as the password of user `x-access-token`.
  const basic = btoa(`x-access-token:${props.gitToken}`);
  const headers = new Headers({ authorization: `Basic ${basic}`, "user-agent": "fleet-gate" });
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await git.fetch(upstream, {
        method: req.method,
        headers,
        body,
        // A redirect would move the fetch to whatever repo it names. Refuse it.
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, deadline - now())),
      });
    } catch {
      return new Response("upstream unavailable", { status: 502 });
    }
    // Diagnosis for a garbled git stream (#1104), and for a throttle (#1137): the
    // framing and rate-limit headers of every upstream response. Never the token.
    const header = (name: string) => res.headers.get(name) ?? "-";
    console.log(`gate git-proxy: upstream ${res.status} content-encoding=${header("content-encoding")} transfer-encoding=${header("transfer-encoding")} retry-after=${header("retry-after")} ratelimit-remaining=${header("x-ratelimit-remaining")} ratelimit-reset=${header("x-ratelimit-reset")}`);
    if (res.status >= 300 && res.status < 400) return new Response("upstream redirect refused", { status: 502 });
    if (res.status === 200) {
      // Only the body and content-type of a 200 reach the container. Upstream
      // headers (set-cookie, request ids) and error bodies are dropped.
      return new Response(res.body, {
        status: 200,
        headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
      });
    }

    // #1137: a rate-limited attempt is retried here, so every leg's container
    // does not fail on the same schedule. Budget spent: the status passes through.
    const retryAfter = retryAfterMs(res, now());
    const hint = retryAfter ?? rateLimitResetMs(res, now());
    // A 403 is retried only with a limit hint: Retry-After (secondary) or an exhausted reset (primary).
    const retry = retryable && attempt < GIT_UPSTREAM_MAX_ATTEMPTS && isRetryable(res.status, hint !== null);
    if (!retry) return new Response(null, { status: res.status });
    const wait = retryWaitMs(hint, attempt, random());
    if (now() + wait > deadline - RETRY_MIN_TAIL_MS) return new Response(null, { status: res.status });
    console.log(`gate git-proxy: retry status=${res.status} wait=${wait}ms attempt=${attempt + 1}/${GIT_UPSTREAM_MAX_ATTEMPTS}`);
    await res.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}

/** #1080 HIGH 1: a bundle is streamed to R2. It must declare its length, so the cap
 *  is checked before any byte is read, and the bytes are checked against that length
 *  as they pass. Never buffered whole. */
async function putBundle(req: Request, bucket: OutboundBucket, key: string): Promise<Response> {
  const header = req.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header)) return new Response("length required", { status: 411 });
  const declared = Number(header);
  if (declared > MAX_BUNDLE_BYTES) return new Response("too large", { status: 413 });
  try {
    // write-once, as for a result key: a bundle is created once per run, never replaced.
    const stored = await bucket.put(key, lengthChecked(req.body, declared), { onlyIf: { etagDoesNotMatch: "*" } });
    if (stored === null) return new Response("already written", { status: 412 });
    return new Response(null, { status: 201 });
  } catch (err) {
    if (err instanceof BundleBodyError) return new Response(err.message, { status: err.status });
    throw err;
  }
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
      return putBundle(req, bucket, target.key);
    }
    if (!isWritableByContainer(target.key)) return new Response("forbidden", { status: 403 });
    if (!props?.resultKey || props.resultKey !== target.key) return new Response("forbidden", { status: 403 });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_RESULT_BYTES) return new Response("too large", { status: 413 });
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_RESULT_BYTES) return new Response("too large", { status: 413 });
    // write-once: a leg's result key may be created once, never replaced.
    const stored = await bucket.put(target.key, body, { onlyIf: { etagDoesNotMatch: "*" } });
    if (stored === null) return new Response("already written", { status: 412 });
    return new Response(null, { status: 201 });
  }

  return new Response("method not allowed", { status: 405 });
}
