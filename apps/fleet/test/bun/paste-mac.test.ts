// apps/fleet/test/bun/paste-mac.test.ts
// Issue #498 (sweep 11 finding S11-F10, refs #467): grabClipboardPng, the
// clipboard probe behind `fleet paste` and attach's ctrl-v intercept, had
// zero coverage. Its only platform dependency is Bun.spawn(["pngpaste", …])
// plus Bun.file — both live under bun on any OS — so each lane runs the real
// function in a child bun process under a PATH this file fully controls.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASTE_MAC = join(import.meta.dir, "../../cli/paste-mac");
// The module's fixed, non-injectable tmp path — tests own its cleanup.
const PASTE_TMP = "/tmp/fleet-paste.png";

// The fake pngpaste body must not PATH-lookup its tools: its PATH holds
// only the fake itself.
const CP = existsSync("/bin/cp") ? "/bin/cp" : "/usr/bin/cp";

const tempDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Bun.spawn's argv resolution ignores in-process `process.env.PATH` mutations
 * (measured here, and same family as issue #353's Bun.which startup
 * snapshot), so each lane spawns a child bun that imports the real module
 * under an explicitly controlled env instead.
 */
async function grabUnderPath(path: string): Promise<Uint8Array | null> {
  const dir = tmpDir("paste-mac-helper-");
  const helper = join(dir, "helper.ts");
  // No catch here on purpose: an error escaping the module must crash the
  // child (non-zero exit), not silently pass as "no image".
  writeFileSync(helper, `
import { grabClipboardPng } from ${JSON.stringify(PASTE_MAC)};
const r = await grabClipboardPng();
console.log(r === null ? "null" : Buffer.from(r).toString("base64"));
`);
  const proc = Bun.spawn({
    cmd: [process.execPath, helper],
    env: { PATH: path },
    cwd: dir,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(code).toBe(0);
  const answer = out.trim();
  return answer === "null" ? null : Uint8Array.from(Buffer.from(answer, "base64"));
}

/** Installs an executable fake pngpaste (its shebang resolves absolutely,
 *  so a bin-only PATH is enough to run it). */
function writeFakePngpaste(bin: string, body: string) {
  const fake = join(bin, "pngpaste");
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
}

beforeEach(() => { rmSync(PASTE_TMP, { force: true }); });
afterEach(() => {
  // The fixed tmp path is shared machine-wide, so no lane may leave it dirty.
  rmSync(PASTE_TMP, { force: true });
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("grabClipboardPng (cli/paste-mac)", () => {
  test("pngpaste missing from PATH resolves null (ENOENT swallowed)", async () => {
    const bin = tmpDir("paste-mac-empty-bin-");
    expect(await grabUnderPath(bin)).toBe(null);
  });

  test("pngpaste exit 1 (no image) resolves null and leaves a pre-existing tmp file untouched", async () => {
    const bin = tmpDir("paste-mac-exit1-bin-");
    writeFakePngpaste(bin, "exit 1");
    // A leftover screenshot from an earlier paste sits at the fixed tmp path:
    // a "no image" answer must not serve it up as this clipboard's bytes.
    writeFileSync(PASTE_TMP, Uint8Array.from([0xde, 0xad, 0x00, 0xbe, 0xef]));
    expect(await grabUnderPath(bin)).toBe(null);
    // The early return fired before any read or delete touched the path.
    expect(existsSync(PASTE_TMP)).toBe(true);
  });

  test("pngpaste success returns the exact clipboard bytes and removes the tmp file", async () => {
    const bin = tmpDir("paste-mac-ok-bin-");
    const fixtureDir = tmpDir("paste-mac-fixture-");
    const fixture = join(fixtureDir, "clip.png");
    // 0x00 bytes inside prove byte-exact handling — string coercion would
    // stop or mangle the payload here.
    const payload = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x41, 0xff, 0x10, 0x00, 0x7f,
    ]);
    writeFileSync(fixture, payload);
    // The second cp snapshots $1 mid-flight, proving the tmp file really
    // existed before the module deleted it.
    const probe = join(fixtureDir, "mid-flight.png");
    writeFakePngpaste(bin, `${CP} '${fixture}' "$1"\n${CP} "$1" '${probe}'`);
    expect(await grabUnderPath(bin)).toEqual(payload);
    expect(existsSync(probe)).toBe(true);
    expect(existsSync(PASTE_TMP)).toBe(false);
  });
});
