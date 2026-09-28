import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

async function room() {
  const id = env.REVIEW_ROOM.idFromName("2026-07-29-fixround");
  return { stub: env.REVIEW_ROOM.get(id) };
}
const j = (b: any) => JSON.stringify(b);

describe("ReviewRoom", () => {
  it("returns empty state then upserts an item", async () => {
    const { stub } = await room();
    let res = await stub.fetch("https://do/state?release=2026-07-29-fixround");
    let s: any = await res.json();
    expect(s.items).toEqual({});

    await (await stub.fetch("https://do/item?release=2026-07-29-fixround&id=abc", {
      method: "PUT", body: j({ status: "rejected", note: "clipped" }),
    })).text();
    res = await stub.fetch("https://do/state?release=2026-07-29-fixround");
    s = await res.json();
    expect(s.items.abc).toEqual({ status: "rejected", note: "clipped", media: [] });
    expect(s.updated).not.toBe("");
  });

  it("appends a media ref and persists meta", async () => {
    const { stub } = await room();
    await (await stub.fetch("https://do/item?release=2026-07-29-fixround&id=abc", {
      method: "PUT", body: j({ status: "issues" }),
    })).text();
    await (await stub.fetch("https://do/media-ref?release=2026-07-29-fixround&id=abc", {
      method: "PUT", body: j({ key: "k1", name: "shot.png", type: "image/png" }),
    })).text();
    await (await stub.fetch("https://do/meta?release=2026-07-29-fixround", {
      method: "PUT", body: j({ addedItems: [{ id: "x", role: "r", pr: 0, lab: "L", where: "W" }] }),
    })).text();
    const s: any = await (await stub.fetch("https://do/state?release=2026-07-29-fixround")).json();
    expect(s.items.abc.media[0].key).toBe("k1");
    expect(s.addedItems[0].id).toBe("x");
  });
});
