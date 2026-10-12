import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bun-lane shared `writeCredentials` for the five suites whose copies were
 *  byte-identical (sweep 18, F3). Fixture secrets only, never real ones. */
export function writeCredentials(home: string, workerUrl: string) {
  mkdirSync(join(home, ".fleet"), { recursive: true });
  const path = join(home, ".fleet", "credentials");
  writeFileSync(path, JSON.stringify({ workerUrl, accessClientId: "id", accessClientSecret: "secret" }));
  chmodSync(path, 0o600);
}
