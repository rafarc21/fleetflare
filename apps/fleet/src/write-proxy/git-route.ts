/**
 * Issue #7: /fleet/git/github.com/<owner>/<repo>.git/... -- a git smart-HTTP
 * proxy, the only push path a public-repo studio has (its own token is
 * read-only, mode.ts; `git push` reaches here through pushInsteadOf,
 * container-config.ts).
 *
 * upload-pack (fetch, ls-remote) passes straight through on a read token: the
 * git wrapper's own dry-run probe asks the push URL for its HEAD and refs.
 *
 * receive-pack (push):
 *   - the advertisement is rewritten (pktline.ts): `no-thin`, so every delta
 *     base travels in the pack and the pack alone is the whole of what lands;
 *     push options, signed pushes and report-status-v2 are withdrawn.
 *   - the request is parsed fail closed: commands, then the pack
 *     (pack.ts: trailer verified, deltas resolved in-pack only, capped).
 *   - every ref name, commit, tag, blob and tree path (scan-push.ts) goes
 *     through board/leak.ts's leakGuard: confirmed-private skips, missing
 *     list refuses, a hit names the pattern index only.
 *   - clean: the SAME bytes go to GitHub on the Worker's write token, and
 *     GitHub's reply streams back. What was scanned is what lands.
 *   - refused: a report-status `ng` per ref, which git prints as
 *     `! [remote rejected] <ref> (<reason>)`; a plain 403 when the client
 *     asked for no report.
 */
import { LeakGateError, type LeakCheck } from "../board/leak";
import type { StudioStatus } from "../studio/types";
import { parsePack } from "./pack";
import { parseReceivePackRequest, PktError, refusalReport, rewriteReceivePackAdvert } from "./pktline";
import { pushText } from "./scan-push";
import { studioFromRequest, studioWorkRepo } from "./studio-auth";

export const PUSH_BODY_CAP = 16 * 1024 * 1024;
// Worker memory is 128 MB: body + inflated objects + their decoded text.
export const PUSH_INFLATE_CAP = 24 * 1024 * 1024;

const PATH_RE = /^\/fleet\/git\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const FORWARD_HEADERS = ["git-protocol", "content-type", "accept", "content-encoding"];

export interface GitProxyPorts {
  rows: () => Promise<StudioStatus[]>;
  defaultRepo: string;
  /** One request to github.com with the Worker's token for `repo`: read for
   *  upload-pack, write for receive-pack. Adds the Authorization header. */
  upstream: (url: string, init: RequestInit, access: "read" | "write", repo: string) => Promise<Response>;
  check: LeakCheck;
}

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

/** The body, or null past `cap` -- counted on the real bytes, never trusting
 *  a header. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

function forwardHeaders(req: Request, drop: string[] = []): Headers {
  const h = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = req.headers.get(name);
    if (v !== null && !drop.includes(name)) h.set(name, v);
  }
  return h;
}

function passThrough(res: Response): Response {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "content-encoding"]) {
    const v = res.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

export async function handleGitProxy(req: Request, ports: GitProxyPorts): Promise<Response> {
  const url = new URL(req.url);
  const m = PATH_RE.exec(url.pathname);
  if (!m) return text("not found", 404);
  const studio = await studioFromRequest(req, await ports.rows());
  if (!studio) return text("unauthorized", 401, { "www-authenticate": 'Basic realm="fleet"' });
  const [, owner, name, action] = m;
  const repo = `${owner}/${name}`.toLowerCase();
  if (repo !== studioWorkRepo(studio, ports.defaultRepo)) {
    return text(`fleet: this studio writes only its own work repo, not ${repo}`, 403);
  }
  const upstreamBase = `https://github.com/${owner}/${name}.git`;

  if (action === "info/refs") {
    if (req.method !== "GET") return text("method not allowed", 405);
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") return text("unsupported service", 400);
    const up = `${upstreamBase}/info/refs?service=${service}`;
    if (service === "git-upload-pack") {
      return passThrough(await ports.upstream(up, { method: "GET", headers: forwardHeaders(req) }, "read", repo));
    }
    const res = await ports.upstream(up, { method: "GET", headers: forwardHeaders(req, ["git-protocol"]) }, "write", repo);
    if (!res.ok) return passThrough(res);
    let advert: Uint8Array;
    try {
      advert = rewriteReceivePackAdvert(new Uint8Array(await res.arrayBuffer()));
    } catch {
      return text("fleet: write proxy: unreadable ref advertisement from GitHub", 502);
    }
    return new Response(advert, {
      headers: { "content-type": "application/x-git-receive-pack-advertisement", "cache-control": "no-cache" },
    });
  }

  if (req.method !== "POST") return text("method not allowed", 405);
  if (action === "git-upload-pack") {
    return passThrough(await ports.upstream(`${upstreamBase}/git-upload-pack`,
      { method: "POST", headers: forwardHeaders(req), body: req.body }, "read", repo));
  }
  return receivePack(req, ports, repo, `${upstreamBase}/git-receive-pack`);
}

async function receivePack(req: Request, ports: GitProxyPorts, repo: string, upstreamUrl: string): Promise<Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > PUSH_BODY_CAP) return tooLarge();
  const encoding = (req.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") return text(`fleet: write proxy: unsupported content-encoding ${encoding}`, 415);
  let body: Uint8Array | null;
  try {
    body = await readCapped(encoding === "gzip" && req.body
      ? req.body.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      : req.body, PUSH_BODY_CAP);
  } catch {
    return text("fleet: write proxy: request body could not be read", 400);
  }
  if (body === null) return tooLarge();

  let parsed: ReturnType<typeof parseReceivePackRequest>;
  try {
    parsed = parseReceivePackRequest(body);
  } catch (err) {
    return text(`fleet: write proxy: ${err instanceof PktError ? err.message : "bad push request"}`, 400);
  }
  const refs = parsed.commands.map((c) => c.ref);
  const refuse = (message: string, status: number) => {
    if (!parsed.caps.includes("report-status")) return text(message, status);
    let report: Uint8Array;
    try {
      report = refusalReport(refs, message, parsed.caps);
    } catch {
      return text(message, status); // a ref too long for one pkt-line
    }
    return new Response(report, {
      headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" },
    });
  };

  let texts: string;
  try {
    const objects = parsed.pack === null ? [] : await parsePack(parsed.pack, { maxInflated: PUSH_INFLATE_CAP });
    texts = pushText(refs, objects);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refuse(`fleet: write proxy: pack refused (${why}) -- nothing was pushed`, 400);
  }
  try {
    await ports.check(repo, [texts]);
  } catch (err) {
    if (err instanceof LeakGateError) return refuse(err.message, 403);
    return refuse("fleet: leak gate: scanner error -- refusing (fail closed)", 403);
  }
  const res = await ports.upstream(upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body,
  }, "write", repo);
  return passThrough(res);
}

function tooLarge(): Response {
  return text(
    `fleet: write proxy: push over ${PUSH_BODY_CAP / 1024 / 1024} MiB -- split it into smaller pushes`, 413,
  );
}
