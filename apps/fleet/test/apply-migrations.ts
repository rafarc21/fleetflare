// Applies the D1 schema to the isolated test database before each test file
// runs. Without this, vitest-pool-workers boots env.DB with no tables — no
// version of the package auto-applies migrations from wrangler.jsonc's
// migrations_dir; it must be wired up explicitly. See vitest.config.ts, which
// reads the migrations on the Node side and passes them in as the
// TEST_MIGRATIONS binding.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
