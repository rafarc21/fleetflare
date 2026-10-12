// Issue #519 (sweep 13): grabClipboardPng's `await file.delete().catch(() => {})`
// used to swallow EVERY cleanup failure with no trace. A delete failure that
// is not ENOENT (the tmp file was never there / already cleaned — silent BY
// DESIGN, pinned below) must log one console.error while still returning
// the bytes the paste already succeeded with.
//
// bun:test lane, same as print-attach-handle.test.ts: cli/paste-mac.ts
// touches Bun.spawn/Bun.file, bun-only globals vitest-pool-workers cannot
// host. Both are patched on the `Bun` global for the duration of each test
// and restored after — no real pngpaste, no real /tmp writes.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { grabClipboardPng } from "../../cli/paste-mac";

const PASTE_TMP_PATH = "/tmp/fleet-paste.png";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface FakeFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  delete(): Promise<void>;
}

/** Patch Bun.spawn to a fake pngpaste that "writes" the tmp file (tracked by
 *  `spawn`/`delete` closures the test controls), and Bun.file to a fake of
 *  the tmp file. Returns handles so each test can set its own delete()
 *  behavior. Restores both originals in afterEach. */
function fakeBun() {
  const realSpawn = Bun.spawn;
  const realFile = Bun.file;
  let deleted: ((path: string) => Promise<void>) | undefined;
  let content: Uint8Array | null = null;
  const spawn = (cmd: string[], _opts: unknown) => {
    expect(cmd).toEqual(["pngpaste", PASTE_TMP_PATH]);
    content = PNG_BYTES;
    return { exited: Promise.resolve(0) };
  };
  const file = (path: string): FakeFile => {
    expect(path).toBe(PASTE_TMP_PATH);
    return {
      arrayBuffer: async () => {
        if (content === null) throw new Error("no file");
        const ab = new ArrayBuffer(content.byteLength);
        new Uint8Array(ab).set(content);
        return ab;
      },
      delete: () => (deleted ? deleted(path) : Promise.resolve()),
    };
  };
  (Bun as unknown as { spawn: unknown }).spawn = spawn;
  (Bun as unknown as { file: unknown }).file = file;
  return {
    setDelete: (fn: (path: string) => Promise<void>) => { deleted = fn; },
    restore: () => {
      (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
      (Bun as unknown as { file: unknown }).file = realFile;
    },
  };
}

let fake: ReturnType<typeof fakeBun>;
let errSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fake = fakeBun();
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  fake.restore();
});

describe("grabClipboardPng — best-effort cleanup (#519)", () => {
  test("a non-ENOENT delete failure (EPERM) still returns the bytes AND logs one console.error", async () => {
    fake.setDelete(() => {
      const e = new Error("unlink permission denied") as NodeJS.ErrnoException;
      e.code = "EPERM";
      return Promise.reject(e);
    });
    const bytes = await grabClipboardPng();
    expect(bytes).not.toBeNull();
    expect(bytes).toEqual(PNG_BYTES);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0].join(" ")).toContain("EPERM");
  });

  // Already green today: ENOENT is the one delete failure that stays silent
  // by design — the tmp file never existed or a concurrent paste already
  // cleaned it, exactly the cosmetic-cleanup case the site's own comment
  // names. Pinned so the #519 fix cannot over-log it.
  test("an ENOENT delete stays silent and still returns the bytes (already green: ENOENT is silent by design)", async () => {
    fake.setDelete(() => {
      const e = new Error("no such file") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      return Promise.reject(e);
    });
    const bytes = await grabClipboardPng();
    expect(bytes).not.toBeNull();
    expect(bytes).toEqual(PNG_BYTES);
    expect(errSpy).not.toHaveBeenCalled();
  });
});
