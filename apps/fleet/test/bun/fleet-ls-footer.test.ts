// #299 review: `fleet ls` must PRINT readStudioRows' footer on stdout — the
// reason every ROW reads `?`. readStudioRows' own tests prove the footer is
// built; this proves cmdLs puts it on screen (stdout, so `2>&1 | grep` and
// plain `| grep` both keep it).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cmdLs } from "../../cli/fleet";
import type { OrcaDeps } from "../../cli/orca-workspace";
import type { StudioStatus } from "../../src/studio/types";

const STUDIO: StudioStatus = {
  id: "websites--pilot", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
  lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: null, repoSlug: null,
};

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: () => Response.json([STUDIO]) });
});
afterAll(() => server.stop(true));

/** Outside Orca: makes no orca call, so the footer names that source. */
const NOT_UNDER_ORCA: OrcaDeps = {
  env: { TERM_PROGRAM: "Apple_Terminal" },
  hasBinary: () => "orca",
  registry: { get: () => undefined, set: async () => {} },
  log: () => {},
  run: async () => { throw new Error("no orca call expected"); },
  lock: (_id, fn) => fn(),
};

test("#299: fleet ls prints the ROW `?` footer on stdout", async () => {
  const out: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  try {
    await cmdLs({ workerUrl: server.url.toString(), accessClientId: "", accessClientSecret: "" }, false, NOT_UNDER_ORCA);
  } finally {
    console.log = realLog;
  }
  expect(out.some((l) => l.startsWith("ROW ?: not running under Orca"))).toBe(true);
});
