import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import * as authModule from "../src/studio/auth";
import { handleStudio } from "../src/studio/routes";
import { StudioDO } from "../src/studio/do";
import {
  pasteWithStorage, PASTE_MIME_EXT, PASTE_MAX_BYTES, PASTE_SEQ_KEY, type PasteDeps, type SeqStorage,
} from "../src/studio/paste";
import type { Env } from "../src/env";

// Same fake-DO-namespace approach as test/studio.routes.test.ts's
// fakeStudioNamespace: a live StudioDO cannot be constructed under
// vitest-pool-workers (container-backed — see provision.ts's header), so the
// fake's `pasteImage` calls the REAL exported pasteWithStorage (src/studio/
// paste.ts) over a plain in-memory SeqStorage, instead of hand-copying do.ts's
// read/compute/write sequence. `writeFile` is the "sandbox mocked" half (the
// same seam do.ts's real pasteImage plugs sbWriteFile into).
const STUDIO_ID = "websites--pilot";

function fakeSeqStorage(): SeqStorage {
  const map = new Map<string, number>();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
  };
}

function fakeStudioNamespace(writeFile: PasteDeps["writeFile"]) {
  const storage = fakeSeqStorage();
  const deps: PasteDeps = { writeFile };
  const stub = {
    pasteImage: (contentType: string, bytes: Uint8Array) => pasteWithStorage(deps, storage, contentType, bytes),
  };
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => stub as unknown as ReturnType<Env["STUDIO"]["get"]>,
    storage,
  };
}

function envWithFakeStudio(writeFile: PasteDeps["writeFile"] = vi.fn(async () => {})) {
  const fakeNs = fakeStudioNamespace(writeFile);
  return { testEnv: { ...env, STUDIO: fakeNs } as unknown as Env, fakeNs };
}

function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}

function pasteReq(id: string, contentType: string, body: Uint8Array, extraHeaders: Record<string, string> = {}) {
  return authorizedReq(`/studio/${id}/paste`, {
    method: "POST",
    headers: { "Content-Type": contentType, ...extraHeaders },
    body,
  });
}

function authorized() {
  vi.spyOn(authModule, "verifyAccess").mockResolvedValue(null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /studio/:id/paste", () => {
  it("401 without an Access header (real verifyAccess, not mocked)", async () => {
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(
      new Request(`https://x/studio/${STUDIO_ID}/paste`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3]),
      }),
      testEnv,
    );
    expect(res.status).toBe(401);
  });

  it("400 on a malformed studio id (auth mocked ok)", async () => {
    authorized();
    const { testEnv } = envWithFakeStudio();
    const res = await handleStudio(pasteReq("BAD_ID", "image/png", new Uint8Array([1, 2, 3])), testEnv);
    expect(res.status).toBe(400);
  });

  it("415 on an unsupported content type (text/plain), and the sandbox is never touched", async () => {
    authorized();
    const writeFile = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(writeFile);
    const res = await handleStudio(pasteReq(STUDIO_ID, "text/plain", new Uint8Array([1, 2, 3])), testEnv);
    expect(res.status).toBe(415);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("413 from the Content-Length header alone (11MB declared, tiny real body) — rejected before any write", async () => {
    authorized();
    const writeFile = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(writeFile);
    const res = await handleStudio(
      pasteReq(STUDIO_ID, "image/png", new Uint8Array([1, 2, 3]), { "Content-Length": "11000000" }),
      testEnv,
    );
    expect(res.status).toBe(413);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("413 on a real oversized body with NO Content-Length header (hard cap on actual bytes read)", async () => {
    authorized();
    const writeFile = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(writeFile);
    const oversized = new Uint8Array(PASTE_MAX_BYTES + 1);
    const res = await handleStudio(pasteReq(STUDIO_ID, "image/png", oversized), testEnv);
    expect(res.status).toBe(413);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("413 on a real oversized body whose Content-Length header LIES small", async () => {
    authorized();
    const writeFile = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(writeFile);
    const oversized = new Uint8Array(PASTE_MAX_BYTES + 1);
    const res = await handleStudio(pasteReq(STUDIO_ID, "image/png", oversized, { "Content-Length": "5" }), testEnv);
    expect(res.status).toBe(413);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("200 on success: writes exactly /workspace/.paste/img-1.png with the exact bytes sent", async () => {
    authorized();
    const captured: { path: string; bytes: Uint8Array }[] = [];
    const writeFile = vi.fn(async (path: string, bytes: Uint8Array) => {
      captured.push({ path, bytes });
    });
    const { testEnv } = envWithFakeStudio(writeFile);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 253, 254, 255]);

    const res = await handleStudio(pasteReq(STUDIO_ID, "image/png", bytes), testEnv);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("/workspace/.paste/img-1.png");
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/workspace/.paste/img-1.png");
    expect([...captured[0].bytes]).toEqual([...bytes]);
  });

  it("a second paste against the same studio advances the counter to img-2", async () => {
    authorized();
    const writeFile = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(writeFile);

    const first = await handleStudio(pasteReq(STUDIO_ID, "image/png", new Uint8Array([1])), testEnv);
    expect(((await first.json()) as { path: string }).path).toBe("/workspace/.paste/img-1.png");

    const second = await handleStudio(pasteReq(STUDIO_ID, "image/png", new Uint8Array([2])), testEnv);
    expect(((await second.json()) as { path: string }).path).toBe("/workspace/.paste/img-2.png");
  });

  it("maps each of the three allowed mime types to its own extension (png/jpeg->jpg/webp)", async () => {
    authorized();
    const writeFile = vi.fn(async () => {});
    const { testEnv } = envWithFakeStudio(writeFile);
    const cases: [string, string][] = [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
    ];
    for (const [contentType, ext] of cases) {
      const res = await handleStudio(pasteReq(STUDIO_ID, contentType, new Uint8Array([1])), testEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string };
      expect(body.path.endsWith(`.${ext}`)).toBe(true);
    }
  });

  it("500 with no path in the body when the sandbox write fails, and a retry gets the NEXT number — the seq is reserved before the write is attempted, so a failure leaves a gap rather than risking a collision", async () => {
    authorized();
    let shouldFail = true;
    const writeFile = vi.fn(async () => {
      if (shouldFail) throw new Error("sandbox writeFile failed: /workspace/.paste/img-1.png");
    });
    const { testEnv } = envWithFakeStudio(writeFile);

    const failed = await handleStudio(pasteReq(STUDIO_ID, "image/png", new Uint8Array([1, 2, 3])), testEnv);
    expect(failed.status).toBe(500);
    const text = await failed.text();
    expect(text).not.toContain("path");
    expect(text).not.toContain("img-1.png");

    // Deliberate trade (see paste.ts's own comment on pasteWithStorage): the
    // seq is reserved (get+put) BEFORE the write is attempted, so a failed
    // write still consumes number 1 — a retry gets img-2.png, not a reused
    // img-1.png. A numbering gap on failure is the accepted cost of closing
    // the concurrent-collision window (below).
    shouldFail = false;
    const retried = await handleStudio(pasteReq(STUDIO_ID, "image/png", new Uint8Array([4, 5, 6])), testEnv);
    expect(retried.status).toBe(200);
    const body = (await retried.json()) as { path: string };
    expect(body.path).toBe("/workspace/.paste/img-2.png");
  });

  it("StudioDO implements pasteImage (structural guard — a missing method is silently never dispatched)", () => {
    const own = Object.getOwnPropertyNames(StudioDO.prototype);
    expect(own).toContain("pasteImage");
  });
});

describe("PASTE_MAX_BYTES", () => {
  it("is the 10_485_760 byte cap from the brief", () => {
    expect(PASTE_MAX_BYTES).toBe(10_485_760);
  });
});

describe("PASTE_MIME_EXT", () => {
  it("allows exactly the three image mimes, mapped to their extensions", () => {
    expect(PASTE_MIME_EXT).toEqual({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
  });
});

describe("pasteWithStorage (pure logic, no HTTP layer)", () => {
  it("rejects a content type outside the allowlist", async () => {
    const storage = fakeSeqStorage();
    const writeFile = vi.fn(async () => {});
    await expect(pasteWithStorage({ writeFile }, storage, "text/plain", new Uint8Array([1]))).rejects.toThrow();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("two concurrent pastes reserve distinct sequence numbers — the second is started before the first's write settles (reviewer's exact repro shape: neither call is awaited before the next starts)", async () => {
    // Reproduces the finding directly: under the OLD ordering (get -> write
    // -> put), a non-storage await (writeFile) sat between the read and the
    // write of pasteSeq. On a real DO that gap lets a second concurrent
    // pasteImage call interleave its own `get` before the first call's
    // `put` lands — both compute the same seq, one write silently clobbers
    // the other, both callers get 200. The fix reserves the number (get
    // immediately followed by put) BEFORE ever calling writeFile.
    //
    // This is deliberately NOT a plain `Promise.all([callA, callB])` with no
    // synchronization: verified empirically (throwaway script, not
    // committed) that shape collides under BOTH the old and the fixed code
    // against a plain in-memory fake — both `get` calls fire synchronously,
    // before either call's continuation has a chance to run its own `put`,
    // so it can't discriminate the bug from the fix at all. The gate below
    // makes the interleaving deterministic instead of hoping a particular
    // microtask race wins: call B is started only once call A has
    // DEMONSTRABLY reached its write — which, by code order, can only
    // happen after A's own get+put has already completed under the fix.
    const storage = fakeSeqStorage();
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let signalFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    let writeCalls = 0;
    const writeFile = vi.fn(async () => {
      writeCalls += 1;
      if (writeCalls === 1) {
        signalFirstWriteStarted();
        await firstWriteBlocked;
      }
    });

    // Call A started, NOT awaited — call B is created before `first` is
    // ever awaited (only a side-channel signal is awaited below, never
    // `first` itself), matching the reviewer's "two un-awaited calls" shape.
    const first = pasteWithStorage({ writeFile }, storage, "image/png", new Uint8Array([1]));
    await firstWriteStarted;

    const second = pasteWithStorage({ writeFile }, storage, "image/png", new Uint8Array([2]));
    const secondResult = await second;

    releaseFirstWrite();
    const firstResult = await first;

    expect(firstResult.path).toBe("/workspace/.paste/img-1.png");
    expect(secondResult.path).toBe("/workspace/.paste/img-2.png");
    expect(await storage.get(PASTE_SEQ_KEY)).toBe(2);
  });
});
