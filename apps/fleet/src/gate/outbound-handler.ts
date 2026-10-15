// #715 Phase 1 (Task 16): the ONE place a real R2 credential is used on
// GateRunnerDO's behalf. The container makes PLAIN HTTP requests to
// http://gate-r2.internal/<key>; the Worker-side GateOutbound entrypoint
// (outbound-entrypoint.ts) is wired in as the container's outbound handler
// via ctx.container.interceptAllOutboundHttp, and it calls this function. The
// container never sees a token, a key, or a signed URL: the STUDIO_ARCHIVE
// binding inside this Worker is the credential, and this allow-list decides
// what it is used for.
//
// Pure on purpose: no cloudflare:workers import, so bun test can load it.

export const GATE_R2_HOST = "gate-r2.internal";

/** Result JSON is a few KB. 1 MiB is generous headroom, and a hard cap keeps
 *  a runaway leg from buffering an arbitrary body inside the Worker. */
export const MAX_RESULT_BYTES = 1024 * 1024;

const SEG = "[A-Za-z0-9._-]+";
// Results: one distinct key per leg per run (Task 10/14 layout), never a
// baseline path. Baselines: `<owner>/<repo>/baselines/<sha>-<lockhash>.tar`
// (baseline.ts baselineTarballKey).
const RUN_RESULT_RE = new RegExp(`^gate/(${SEG})/(${SEG})/runs/(${SEG})/shard-[a-z0-9-]+\\.json$`);
const BASELINE_RE = new RegExp(`^gate/(${SEG})/(${SEG})/baselines/(${SEG})\\.tar$`);

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
  if (RUN_RESULT_RE.test(key) || BASELINE_RE.test(key)) return { bucket: "STUDIO_ARCHIVE", key };
  return null;
}

/** The container may write its own leg's result, never a baseline. A baseline
 *  is what every later PR's gate restores from, so PR code that could write one
 *  could poison every later verdict. */
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
 *  The run id is part of that key, so another run's key is refused by equality. */
export interface GateOutboundProps {
  resultKey: string;
}

/** Serves one plain container request. Every branch either uses the bucket for
 *  an allow-listed key or returns a status without touching it. A PUT needs
 *  props whose resultKey equals the requested key exactly; missing props deny
 *  every write. */
export async function handleGateOutbound(
  req: Request,
  bucket: OutboundBucket,
  props?: GateOutboundProps,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.host !== GATE_R2_HOST) return new Response("forbidden", { status: 403 });

  const target = resolveOutboundTarget(url.pathname);
  if (!target) return new Response("forbidden", { status: 403 });

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
