// Fixture for "#193: 8 real processes x 25 writes keep all 200 keys": one
// `fleet` process's worth of registry traffic -- get, a short sleep so the
// processes interleave, set -- against a throwaway registry file and lock
// dir. Spawned by orca-workspace.test.ts, never run directly, and never
// pointed at the real ~/.fleet.
import { fileWorkspaceRegistry } from "../../cli/orca-workspace";

const [path, lockDir, worker] = process.argv.slice(2);
const registry = fileWorkspaceRegistry(path, lockDir);
for (let i = 0; i < 25; i++) {
  const key = `w${worker}--k${i}`;
  registry.get(key);
  await Bun.sleep(Math.random() * 3);
  await registry.set(key, `wt-${worker}-${i}`);
}
