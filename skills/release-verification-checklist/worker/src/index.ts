import type { Env, MediaRef } from "./types";
import { tokenKind, allow, inScope } from "./auth";
export { ReviewRoom } from "./review-room";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};
const cors = (r: Response) => { for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v); return r; };
const err = (s: number, m: string) => cors(new Response(m, { status: s }));

function room(env: Env, release: string) {
  return env.REVIEW_ROOM.get(env.REVIEW_ROOM.idFromName(release));
}

// Buffer the DO's response body instead of piping res.body through: the DO stub's
// stream must be fully drained or the vitest-pool-workers isolated-storage teardown
// can't confirm the DO's storage transaction closed (see CF Workers testing known-issues:
// "consume entire response bodies from fetch() calls, even if not asserting content").
async function relay(res: Response): Promise<Response> {
  const body = await res.text();
  return new Response(body, res);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    const auth = tokenKind(req, env);
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["r", release, "item", id]

    // GET /c/:release  (public) — serve the checklist UI from R2, same-origin so
    // its write-through fetches aren't blocked by a page CSP. The write token is
    // injected here from the secret (placeholder in the stored HTML), never stored.
    if (req.method === "GET" && parts[0] === "c" && parts[1]) {
      const obj = await env.MEDIA.get(`pages/${parts[1]}.html`);
      if (!obj) return err(404, "no page for this release");
      const html = (await obj.text()).split("__WRITE_TOKEN__").join(env.REVIEW_WRITE_TOKEN);
      return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // GET /r/:release  (read)
    if (req.method === "GET" && parts[0] === "r" && parts.length === 2) {
      if (!allow(auth, "read")) return err(401, "read token required");
      if (!inScope(auth, parts[1])) return err(401, "token not scoped to this release");
      const res = await room(env, parts[1]).fetch(`https://do/state?release=${encodeURIComponent(parts[1])}`);
      return cors(await relay(res));
    }

    // PUT /r/:release/item/:id  (write)
    if (req.method === "PUT" && parts[0] === "r" && parts[2] === "item" && parts[3]) {
      if (!allow(auth, "write")) return err(401, "write token required");
      if (!inScope(auth, parts[1])) return err(401, "token not scoped to this release");
      const res = await room(env, parts[1]).fetch(
        `https://do/item?release=${encodeURIComponent(parts[1])}&id=${encodeURIComponent(parts[3])}`,
        { method: "PUT", body: req.body }
      );
      return cors(await relay(res));
    }

    // PUT /r/:release/meta  (write)
    if (req.method === "PUT" && parts[0] === "r" && parts[2] === "meta") {
      if (!allow(auth, "write")) return err(401, "write token required");
      if (!inScope(auth, parts[1])) return err(401, "token not scoped to this release");
      const res = await room(env, parts[1]).fetch(
        `https://do/meta?release=${encodeURIComponent(parts[1])}`, { method: "PUT", body: req.body }
      );
      return cors(await relay(res));
    }

    // POST /r/:release/media?id=:id  (write) — multipart field "file"
    if (req.method === "POST" && parts[0] === "r" && parts[2] === "media") {
      if (!allow(auth, "write")) return err(401, "write token required");
      if (!inScope(auth, parts[1])) return err(401, "token not scoped to this release");
      const release = parts[1];
      const id = url.searchParams.get("id") || "unfiled";
      const form = await req.formData();
      // @cloudflare/workers-types v4 types FormData#get() as `string | null` only —
      // it omits the `File` case the real Workers runtime returns for file fields.
      const file = form.get("file") as File | string | null;
      if (!(file instanceof File)) return err(400, "file required");
      const key = `${release}/${id}-${Date.now()}-${file.name}`;
      await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
      const ref: MediaRef = { key, name: file.name, type: file.type };
      const refRes = await room(env, release).fetch(
        `https://do/media-ref?release=${encodeURIComponent(release)}&id=${encodeURIComponent(id)}`,
        { method: "PUT", body: JSON.stringify(ref) }
      );
      await refRes.text();
      return cors(Response.json({ ...ref, url: `/m/${encodeURIComponent(key)}` }));
    }

    // GET /m/:key  (read)
    if (req.method === "GET" && parts[0] === "m") {
      if (!allow(auth, "read")) return err(401, "read token required");
      const key = decodeURIComponent(parts.slice(1).join("/"));
      if (!inScope(auth, key.split("/")[0])) return err(401, "token not scoped to this release");
      const obj = await env.MEDIA.get(key);
      if (!obj) return err(404, "not found");
      const h = new Headers(CORS);
      h.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
      return new Response(obj.body, { headers: h });
    }

    // DELETE /r/:release/media/:key  (write)
    if (req.method === "DELETE" && parts[0] === "r" && parts[2] === "media") {
      if (!allow(auth, "write")) return err(401, "write token required");
      if (!inScope(auth, parts[1])) return err(401, "token not scoped to this release");
      const key = decodeURIComponent(parts.slice(3).join("/"));
      await env.MEDIA.delete(key);
      const delRes = await room(env, parts[1]).fetch(
        `https://do/media-ref?release=${encodeURIComponent(parts[1])}&key=${encodeURIComponent(key)}`,
        { method: "DELETE" }
      );
      await delRes.text();
      return cors(new Response("ok"));
    }

    return err(404, "not found");
  },
};
