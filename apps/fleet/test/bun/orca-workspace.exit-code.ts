// Fixture for "a broken orca never changes its caller's exit code": a process
// whose only work is one ensureStudioWorkspace against a runner that throws.
// It must still exit 0. Spawned by orca-workspace.test.ts, never run directly.
import { ensureStudioWorkspace } from "../../cli/orca-workspace";

await ensureStudioWorkspace("websites--maestro", "websites · maestro (idle)", {
  env: { TERM_PROGRAM: "Orca" },
  hasBinary: () => "orca",
  log: () => {},
  run: async () => { throw new Error("orca is wedged"); },
  lock: (_id: string, fn: () => Promise<unknown>) => fn(),
  registry: { get: () => undefined, set: () => {} },
} as never);
