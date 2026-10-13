// apps/fleet/test/bun/helpers/fleet-cli.ts
// Sweep 33 finding S33-F1 (refs #733, #745): the three-part setup every
// bun-lane CLI suite copied — the cli/fleet.ts path, a tmpDir() that stacks
// every temp dir it makes, and the afterEach that empties that stack. The
// helper sits one level deeper than the suites, so the fleet.ts join needs
// three `..`, not two. cleanupTempDirs is a plain export, not a wired
// afterEach: bun:test hooks registered at helper import time would fire once
// for the helper's own module scope, not per-suite — each suite wires its
// own `afterEach(cleanupTempDirs)`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FLEET = join(import.meta.dir, "../../../cli/fleet.ts");

const tempDirs: string[] = [];

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}
