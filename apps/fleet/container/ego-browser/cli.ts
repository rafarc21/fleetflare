#!/usr/bin/env bun
/**
 * The `ego-browser` command itself. Thin and short-lived: every invocation
 * is a brand new process (per ego lite's own contract -- "Task spaces,
 * tabs, and Page labels persist; JavaScript variables do not"), which is
 * why all the actual state lives in daemon.ts instead of here.
 *
 * Two entry points, both required, both producing IDENTICAL globals and
 * behavior -- they only differ in how the code string is obtained:
 *   ego-browser nodejs -e '<code>'     (code is argv)
 *   ego-browser nodejs <<'EOF' ... EOF (code is the full content of stdin)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installGlobals } from "./api";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [subcommand, ...rest] = args;
  if (subcommand !== "nodejs") {
    console.error("ego-browser: usage: ego-browser nodejs -e '<code>'   OR   ego-browser nodejs <<'EOF' ... EOF");
    process.exit(1);
  }

  let code: string;
  const eFlagAt = rest.indexOf("-e");
  if (eFlagAt !== -1) {
    code = rest[eFlagAt + 1] ?? "";
  } else {
    code = await readStdin();
  }

  // Globals installed BEFORE the module is evaluated, so a top-level
  // `await taskSpace(...)` in the user script resolves against a live RPC
  // connection from the very first line.
  installGlobals();

  const dir = mkdtempSync(join(tmpdir(), "ego-browser-"));
  const modulePath = join(dir, "script.mjs");
  try {
    writeFileSync(modulePath, code, "utf8");
    // Script runs as a genuine ESM module (per the contract: "Script runs
    // as ESM in Node"), not eval'd inline -- top-level await, import.meta,
    // etc. all behave exactly as they would in a real .mjs file.
    await import(pathToFileURL(modulePath).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    // The RPC client keeps an open unix-socket connection to the daemon
    // for the whole process lifetime (so multiple calls in one script can
    // share it) -- without an explicit exit, that open handle keeps the
    // event loop alive past the user script's own completion, and this
    // process would never return control to whatever spawned it.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
