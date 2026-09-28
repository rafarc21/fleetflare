import { DurableObject } from "cloudflare:workers";
import type { Item, MediaRef, ReviewState } from "./types";
import { emptyState } from "./types";

export class ReviewRoom extends DurableObject {
  private async load(release: string): Promise<ReviewState> {
    return (await this.ctx.storage.get<ReviewState>("state")) ?? emptyState(release);
  }
  private async persist(s: ReviewState): Promise<void> {
    s.updated = new Date().toISOString();
    await this.ctx.storage.put("state", s);
  }
  private ensureItem(s: ReviewState, id: string): Item {
    if (!s.items[id]) s.items[id] = { status: "", note: "", media: [] };
    return s.items[id];
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const release = url.searchParams.get("release") || "";
    const s = await this.load(release);

    if (url.pathname === "/state") return Response.json(s);

    if (url.pathname === "/item" && req.method === "PUT") {
      const id = url.searchParams.get("id")!;
      const body = (await req.json()) as { status?: string; note?: string };
      const it = this.ensureItem(s, id);
      if (typeof body.status === "string") it.status = body.status;
      if (typeof body.note === "string") it.note = body.note;
      await this.persist(s);
      return new Response("ok");
    }

    if (url.pathname === "/media-ref" && req.method === "PUT") {
      const id = url.searchParams.get("id")!;
      const ref = (await req.json()) as MediaRef;
      this.ensureItem(s, id).media.push(ref);
      await this.persist(s);
      return new Response("ok");
    }

    if (url.pathname === "/media-ref" && req.method === "DELETE") {
      const key = url.searchParams.get("key")!;
      for (const id of Object.keys(s.items)) {
        s.items[id].media = s.items[id].media.filter((m) => m.key !== key);
      }
      await this.persist(s);
      return new Response("ok");
    }

    if (url.pathname === "/meta" && req.method === "PUT") {
      const body = (await req.json()) as Partial<ReviewState>;
      if (Array.isArray(body.addedRoles)) s.addedRoles = body.addedRoles;
      if (Array.isArray(body.addedItems)) s.addedItems = body.addedItems;
      await this.persist(s);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }
}
