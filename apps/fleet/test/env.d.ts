import type { Env as FleetEnv } from "../src/env";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Tells `cloudflare:test`'s `env` what shape to expect — without this, tsc
// sees an empty `Cloudflare.Env` and every env.DB / env.TEST_MIGRATIONS
// access fails to resolve. TEST_MIGRATIONS is test-only (see
// vitest.config.ts), so it's added here rather than on the real Env.
//
// The augmentation target moved in the vitest 4 line of
// vitest-pool-workers: `cloudflare:test` used to type `env` as its own
// `ProvidedEnv` interface, and now types it as `Cloudflare.Env` — the
// workers-types global that `wrangler types` also generates into. Declaring
// it here merges with the empty one workers-types ships.
declare global {
  namespace Cloudflare {
    interface Env extends FleetEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_CONTAINER_SERVER_SRC: string;
      TEST_STUDIO_BRINGUP_SRC: string;
      TEST_DOCKERFILE_STUDIO_SRC: string;
      TEST_DOCKERFILE_TASK_SRC: string;
      TEST_STUDIO_FLEET_SRC: string;
      TEST_TERMINAL_TEMPLATE_SRC: string;
      TEST_CLI_FLEET_SRC: string;
      TEST_STUDIO_DO_SRC: string;
      TEST_SURVIVAL_DELIVERY_SRC: string;
      TEST_FLEET_JSON: string;
      TEST_PILOT_ROLE_MD: string;
      TEST_ORG_JSON: string;
      TEST_SCRATCH_ROLE_MD: string;
      TEST_BLUEPRINT_README: string;
      TEST_LEAD_GATE_SRC: string;
      TEST_SESSION_REEMIT_SRC: string;
      TEST_COMPLETION_GATE_SRC: string;
    }
  }
}
