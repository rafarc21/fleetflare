/**
 * Board issue #57: `.context/` is gitignored evidence living inside a studio's
 * Orca worktree — screenshots, working notes, anything a lead or member wrote
 * that never went into a commit. A REAL incident found 11 screenshots and 24
 * context files across two studio worktrees that a blind `orca worktree rm`
 * would have destroyed with no trace. This module exists so a teardown never
 * does that silently: either the evidence is copied somewhere durable BEFORE
 * the worktree is removed, or the removal is refused and the caller is told
 * exactly what is stuck there.
 *
 * Deliberately has no Orca import and does no `orca` shelling out — pure
 * filesystem, synchronous, so it is unit-testable with a real `mkdtempSync`
 * fixture (this repo's own established pattern for fs-touching bun:test —
 * see test/bun/blueprint-credential.test.ts, bringup-hooks.test.ts) and does
 * not need the injected-`run` machinery cli/orca-workspace.ts carries for
 * the parts of teardown that DO talk to Orca.
 */
import { existsSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ContextInventory {
  screenshotCount: number;
  contextFileCount: number;
  totalCount: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Pure classification of a flat list of paths relative to a `.context/`
 * directory — no I/O, so it is covered by a fast test independent of the
 * real filesystem walk `listContextFiles` does below. Kept separate for
 * exactly that reason: this is the part board issue #57 calls out as
 * testable with "a fake directory listing".
 */
export function inventoryContext(relFilePaths: string[]): ContextInventory {
  const screenshotCount = relFilePaths.filter((p) => IMAGE_EXT.test(p)).length;
  return {
    screenshotCount,
    contextFileCount: relFilePaths.length - screenshotCount,
    totalCount: relFilePaths.length,
  };
}

/**
 * Every file under `<worktreePath>/.context`, recursively, as paths relative
 * to `.context` itself (`"shot.png"`, `"notes/2026-09-23.md"`). `[]` when the
 * directory does not exist — an already-clean worktree, not an error.
 */
export function listContextFiles(worktreePath: string): string[] {
  const dir = join(worktreePath, ".context");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(nextRel);
      else out.push(nextRel);
    }
  };
  walk("");
  return out;
}

export type SalvageOutcome =
  | { kind: "empty" }
  | { kind: "salvaged"; destination: string; inventory: ContextInventory }
  | { kind: "refused"; inventory: ContextInventory; why: string };

export interface SalvageDestination {
  /** Durable root, e.g. `join(homedir(), "fleet-teardown-salvage")`. */
  root: string;
  now: () => Date;
}

/**
 * Dated AND studio-id-stamped, so two teardowns — of the same studio torn
 * down twice, or of two different studios in the same minute — never
 * clobber each other's salvaged evidence.
 */
export function salvageDestinationFor(dest: SalvageDestination, studioId: string): string {
  const stamp = dest.now().toISOString().replace(/[:.]/g, "-");
  return join(dest.root, `${studioId}-${stamp}`);
}

/**
 * Copies `.context/` out of a worktree BEFORE it can be removed. Never
 * silently deletes: an empty/absent `.context/` is a no-op (`"empty"`); a
 * populated one is copied whole to `salvageDestinationFor`'s path and
 * reported (`"salvaged"`, with the destination and the inventory so the
 * caller can print both); a copy that throws (destination unwritable, disk
 * full, whatever) is `"refused"` with the inventory still attached — the
 * caller MUST NOT proceed to remove the worktree on that outcome, and can
 * name exactly what is stuck there from the inventory alone.
 */
export function salvageContext(worktreePath: string, studioId: string, dest: SalvageDestination): SalvageOutcome {
  const files = listContextFiles(worktreePath);
  const inventory = inventoryContext(files);
  if (inventory.totalCount === 0) return { kind: "empty" };
  const destination = salvageDestinationFor(dest, studioId);
  try {
    mkdirSync(destination, { recursive: true });
    cpSync(join(worktreePath, ".context"), destination, { recursive: true });
    return { kind: "salvaged", destination, inventory };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { kind: "refused", inventory, why: `salvage of .context/ failed: ${why}` };
  }
}
