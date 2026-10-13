// apps/fleet/test/bun/paste-cmd.test.ts
// Issue #547 (sweep 19 finding S19-F3, refs #539): `fleet paste`'s upload
// failure had no owner -- cmdPaste let uploadPaste's throw propagate to
// main()'s generic catch, so a failed upload printed `fleet: paste upload
// failed: ...` with no `fleet paste:` frame. No test exercised the verb
// end to end at all. Same pattern as test/bun/memory-cmd.test.ts (a real
// `Bun.spawn` of cli/fleet.ts, a temp HOME holding a synthetic credentials
// file, a local Bun.serve standing in for the Worker) plus test/bun/
// paste-mac.test.ts's fake `pngpaste`: grabClipboardPng's only platform
// dependency is the spawned `pngpaste`, so a bin-only PATH fully controls
// what the child's clipboard holds -- an empty bin dir IS "no image".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, FLEET, tmpDir } from "./helpers/fleet-cli";

// grabClipboardPng's fixed, non-injectable tmp path -- shared machine-wide,
// so no lane may leave it dirty (same ownership as paste-mac.test.ts).
const PASTE_TMP = "/tmp/fleet-paste.png";
// The fake pngpaste must not PATH-lookup its tools: its PATH holds only the
// fake itself.
const CP = existsSync("/bin/cp") ? "/bin/cp" : "/usr/bin/cp";

beforeEach(() => { rmSync(PASTE_TMP, { force: true }); });
afterEach(() => {
  rmSync(PASTE_TMP, { force: true });
  cleanupTempDirs();
});

function writeCredentials(home: string, workerUrl: string) {
  mkdirSync(join(home, ".fleet"));
  const path = join(home, ".fleet", "credentials");
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "id", accessClientSecret: "secret" }));
  chmodSync(path, 0o600);
}

// 0x00 bytes inside prove byte-exact handling through the whole chain
// (Bun.file read, fetch body) -- string coercion would mangle the payload
// here. Asserted on the POST the stand-in receives, not just the probe's
// return value (paste-mac.test.ts owns that half).
const CLIPBOARD_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x41, 0xff, 0x10, 0x00, 0x7f,
]);
const ID = "websites--pilot";
const UPLOADED_PATH = `/data/${ID}/paste/001.png`;

/** Bun.serve standing in for the Worker's paste route. Records every
 *  request (method, full path, POST body bytes) so tests can pin the URL
 *  shape and prove the no-image refusal never POSTs at all. */
function startPasteWorker() {
  const requests: { method: string; path: string; body?: Uint8Array }[] = [];
  const state = { pasteStatus: 200 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === `/studio/${ID}/paste` && req.method === "POST") {
        requests.push({ method: "POST", path: url.pathname, body: new Uint8Array(await req.arrayBuffer()) });
        if (state.pasteStatus !== 200) return new Response("boom", { status: state.pasteStatus });
        return Response.json({ path: UPLOADED_PATH });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requests, state };
}

/** A bin whose only executable is a fake pngpaste that "pastes" the fixed
 *  fixture bytes (its shebang and cp resolve absolutely, so a bin-only PATH
 *  is enough to run it). */
function clipboardBin(): string {
  const bin = tmpDir("paste-cmd-bin-");
  const fixture = join(bin, "clip.png");
  writeFileSync(fixture, CLIPBOARD_BYTES);
  const fake = join(bin, "pngpaste");
  writeFileSync(fake, `#!/bin/sh\n${CP} '${fixture}' "$1"\n`);
  chmodSync(fake, 0o755);
  return bin;
}

/** Spawns the real CLI. `bin` is the child's WHOLE PATH: pngpaste resolves
 *  there (or ENOENTs when the dir is empty), and nothing else the paste
 *  path spawns needs a PATH at all. The cwd is a temp dir with no .git,
 *  same hermeticity as memory-cmd.test.ts. */
async function run(args: string[], home: string, cwd: string, bin: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, FLEET, ...args],
    env: { PATH: bin, HOME: home },
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

function setup(bin: string) {
  const home = tmpDir("paste-cmd-home-");
  const cwd = tmpDir("paste-cmd-cwd-");
  const worker = startPasteWorker();
  writeCredentials(home, `http://127.0.0.1:${worker.server.port}`);
  return { bin, home, cwd, worker };
}

describe("fleet paste", () => {
  test("a 500 from POST /studio/:id/paste exits 1 with the fleet paste: owner frame on stderr, no path on stdout", async () => {
    const { bin, home, cwd, worker } = setup(clipboardBin());
    try {
      worker.state.pasteStatus = 500;
      const r = await run(["paste", ID], home, cwd, bin);

      expect(r.code).toBe(1);
      // THE owner frame (issue #547): before the fix this line read `fleet:
      // paste upload failed: ...` -- main()'s generic catch, no `fleet
      // paste:` at the front.
      expect(r.err.trim()).toBe("fleet paste: paste upload failed: 500 boom");
      expect(r.out).toBe("");
    } finally {
      worker.server.stop(true);
    }
  });

  test("a 200 prints the path line on stdout, exit 0, stderr empty, and POSTs the exact clipboard bytes", async () => {
    const { bin, home, cwd, worker } = setup(clipboardBin());
    try {
      const r = await run(["paste", ID], home, cwd, bin);

      expect(r.code).toBe(0);
      expect(r.out.trim()).toBe(UPLOADED_PATH);
      expect(r.err).toBe("");
      expect(worker.requests.length).toBe(1);
      expect(worker.requests[0].method).toBe("POST");
      expect(worker.requests[0].path).toBe(`/studio/${ID}/paste`);
      expect(worker.requests[0].body).toEqual(CLIPBOARD_BYTES);
    } finally {
      worker.server.stop(true);
    }
  });

  test("no image (pngpaste missing from PATH): exit 1, the exact refusal line, ZERO POSTs reach the Worker", async () => {
    const { bin, home, cwd, worker } = setup(tmpDir("paste-cmd-empty-bin-"));
    try {
      const r = await run(["paste", ID], home, cwd, bin);

      expect(r.code).toBe(1);
      expect(r.err.trim()).toBe(
        "fleet paste: no image on the clipboard (pngpaste missing, or the clipboard has no image)",
      );
      expect(r.out).toBe("");
      expect(worker.requests.length).toBe(0);
    } finally {
      worker.server.stop(true);
    }
  });
});
