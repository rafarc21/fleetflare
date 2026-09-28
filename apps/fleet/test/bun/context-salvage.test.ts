// Board issue #57: `.context/` is gitignored evidence a blind `orca worktree
// rm` would destroy with no trace. `salvageContext` copies it out FIRST and
// never silently deletes it — see cli/context-salvage.ts's own header.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inventoryContext, listContextFiles, salvageContext, salvageDestinationFor,
} from "../../cli/context-salvage";

function worktreeWithContext(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-salvage-wt-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ".context", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const FIXED_NOW = () => new Date("2026-09-23T10:00:00.000Z");

// ---------------------------------------------------------------------------
// inventoryContext — pure, no I/O.

test("inventoryContext classifies screenshots separately from other context files", () => {
  const inv = inventoryContext(["shot1.png", "shot2.jpg", "notes/2026-09-23.md", "log.txt"]);
  expect(inv.screenshotCount).toBe(2);
  expect(inv.contextFileCount).toBe(2);
  expect(inv.totalCount).toBe(4);
});

test("inventoryContext on an empty list", () => {
  expect(inventoryContext([])).toEqual({ screenshotCount: 0, contextFileCount: 0, totalCount: 0 });
});

test("inventoryContext matches image extensions case-insensitively", () => {
  const inv = inventoryContext(["A.PNG", "b.JPEG", "c.gif", "d.webp"]);
  expect(inv.screenshotCount).toBe(4);
  expect(inv.contextFileCount).toBe(0);
});

// ---------------------------------------------------------------------------
// listContextFiles — real filesystem.

test("listContextFiles is empty for a worktree with no .context directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-salvage-wt-"));
  try {
    expect(listContextFiles(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listContextFiles walks nested directories, relative to .context itself", () => {
  const dir = worktreeWithContext({ "shot.png": "x", "notes/a.md": "y", "notes/deep/b.md": "z" });
  try {
    expect(new Set(listContextFiles(dir))).toEqual(new Set(["shot.png", "notes/a.md", "notes/deep/b.md"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// salvageDestinationFor — dated and studio-id-stamped.

test("salvageDestinationFor stamps the destination with the studio id and a timestamp", () => {
  const dest = salvageDestinationFor({ root: "/root", now: FIXED_NOW }, "websites--maestro");
  expect(dest).toBe(join("/root", "websites--maestro-2026-09-23T10-00-00-000Z"));
});

test("salvageDestinationFor never collides for two different studios torn down at the same instant", () => {
  const a = salvageDestinationFor({ root: "/root", now: FIXED_NOW }, "websites--maestro");
  const b = salvageDestinationFor({ root: "/root", now: FIXED_NOW }, "websites--pilot");
  expect(a).not.toBe(b);
});

// ---------------------------------------------------------------------------
// salvageContext — the whole flow.

test("an absent .context/ is a no-op, not a refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-salvage-wt-"));
  const root = mkdtempSync(join(tmpdir(), "fleet-salvage-dest-"));
  try {
    const outcome = salvageContext(dir, "websites--maestro", { root, now: FIXED_NOW });
    expect(outcome).toEqual({ kind: "empty" });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a populated .context/ is copied whole to a dated, studio-stamped destination", () => {
  const dir = worktreeWithContext({ "shot.png": "PNGDATA", "notes/a.md": "note a" });
  const root = mkdtempSync(join(tmpdir(), "fleet-salvage-dest-"));
  try {
    const outcome = salvageContext(dir, "websites--maestro", { root, now: FIXED_NOW });
    expect(outcome.kind).toBe("salvaged");
    if (outcome.kind !== "salvaged") throw new Error("unreachable");
    expect(outcome.inventory).toEqual({ screenshotCount: 1, contextFileCount: 1, totalCount: 2 });
    expect(outcome.destination).toBe(join(root, "websites--maestro-2026-09-23T10-00-00-000Z"));
    expect(readFileSync(join(outcome.destination, "shot.png"), "utf8")).toBe("PNGDATA");
    expect(readFileSync(join(outcome.destination, "notes", "a.md"), "utf8")).toBe("note a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a copy failure refuses rather than silently losing the evidence, naming what was found", () => {
  const dir = worktreeWithContext({ "shot.png": "x", "shot2.png": "y", "notes/a.md": "z" });
  // The destination ROOT is itself a plain file, not a directory, so
  // `mkdirSync(destination, {recursive:true})` throws ENOTDIR no matter who
  // runs the test (root included, unlike a permission-bit failure) — the
  // exact "copy cannot happen" case salvageContext must not paper over.
  const parent = mkdtempSync(join(tmpdir(), "fleet-salvage-dest-"));
  const root = join(parent, "not-a-directory");
  writeFileSync(root, "not a directory");
  try {
    const outcome = salvageContext(dir, "websites--maestro", { root, now: FIXED_NOW });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.inventory).toEqual({ screenshotCount: 2, contextFileCount: 1, totalCount: 3 });
    expect(outcome.why).toContain("salvage of .context/ failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
