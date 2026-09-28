import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { configDefaults, defineConfig } from "vitest/config";
import { createFetchMock } from "miniflare";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers does not auto-apply D1 migrations from wrangler.jsonc's
// migrations_dir — it must be read here (Node side) and applied in a
// setupFile (worker side, via cloudflare:test). See test/apply-migrations.ts.
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

// container/server.ts runs in the agent container, not in this Worker, and
// calls Bun.serve at module top level — it can never be imported by a test.
// Tests that need to assert on it (test/container.args.test.ts) get its
// source as text instead, read here on the Node side because workerd has no
// filesystem. Same wiring as TEST_MIGRATIONS above.
const containerServerSrc = await readFile(path.join(rootDir, "container", "server.ts"), "utf8");

// Task 3 (P2 plane 2) fix round: container/studio-bringup.sh is shell, not a
// TS module with exported command-builder functions — its C2 verification
// gate (manifest check, part-count/size/hash re-verify, temp-dir atomic mv)
// can't be exercised by importing anything. Same "no filesystem in workerd"
// wiring as containerServerSrc just above: test/studio.session.test.ts
// asserts on this raw source text instead, so a future edit that silently
// weakens/removes the verification gate fails a test, not just a manual
// bash re-check.
const studioBringupSrc = await readFile(path.join(rootDir, "container", "studio-bringup.sh"), "utf8");

// Security (operator directive 2026-08-19): both container images' `ENV
// IS_SANDBOX=1` line is what unlocks --dangerously-skip-permissions for
// claude running as root (studio-bringup.sh / server.ts's runClaude argv,
// both source-pinned above/below). Dockerfiles are neither TS modules nor
// importable — same "no filesystem in workerd" wiring as containerServerSrc/
// studioBringupSrc above: test/container.args.test.ts source-pins this raw
// text so a future edit that silently drops the ENV line fails a test, not
// just a manual re-read (the real unlock is proven separately, by the Docker
// image smoke test — a static Dockerfile can only be text-matched here).
const dockerfileStudioSrc = await readFile(path.join(rootDir, "container", "Dockerfile.studio"), "utf8");
const dockerfileTaskSrc = await readFile(path.join(rootDir, "container", "Dockerfile"), "utf8");

// Fleet Spawn P3, Task 3: container/studio-fleet has no `.ts` extension by
// design (it is baked verbatim into the studio image and directly exec'd via
// its own shebang — see that file's own header, and Dockerfile.studio's COPY
// of it), so it is outside `tsc -p container`'s `**/*.ts` include and cannot
// be imported by a test either way. Same "no filesystem in workerd" wiring
// as studioBringupSrc just above: test/container.studio-fleet.test.ts
// source-pins its contract (route, header, exit codes, help text) against
// this raw text, the same technique that file already uses for
// container/studio-bringup.sh.
const studioFleetSrc = await readFile(path.join(rootDir, "container", "studio-fleet"), "utf8");

// Task 6 (P3 close-out, ruling 2): src/studio/do.ts's own source text.
// StudioDO is container-backed and CANNOT be constructed under
// vitest-pool-workers (see that file's own header), so its constructor body
// — the blockConcurrencyWhile that loads the persisted spawn token into
// `envVars` before any exec can start a container — is unreachable by import.
// The pure resolution it calls (loadOrMintSpawnToken) is unit-tested
// directly; this binding is what lets test/studio.refresh.test.ts pin the
// WIRING, the same source-pin technique already used for
// container/server.ts, studio-bringup.sh and studio-fleet above.
const studioDoSrc = await readFile(path.join(rootDir, "src", "studio", "do.ts"), "utf8");

// Issue #249 (PR4b): the survival re-brief's delivery module, source-pinned
// for the SAME reason do.ts is — the guarantee under test is a NEGATIVE one
// ("this feature introduces no second single-flight wake path, no second
// wakeLock, and no container exec of its own"), which no amount of calling the
// function can demonstrate. See test/studio.survival-delivery.test.ts's
// "shared single-flight" block.
const survivalDeliverySrc = await readFile(path.join(rootDir, "src", "studio", "survival-delivery.ts"), "utf8");

// Task 6 (P2 ride-along, reconnect floor-loop): page/terminal.template.html
// ships as one static file with no bundler of its own (see that file's own
// header) — its copy of cli/backoff.ts's nextAttempt is hand-inlined, same
// as reconnectDelayMs already is. Same "no filesystem in workerd" wiring as
// containerServerSrc/studioBringupSrc above: test/cli.backoff.test.ts pins
// this raw source text so a future edit to either side's copy without
// updating the other fails a test, instead of silently drifting.
const terminalTemplateSrc = await readFile(path.join(rootDir, "page", "terminal.template.html"), "utf8");

// Issue #123: `fleet attach`'s reconnect loop lives in cli/fleet.ts, which is
// never imported under test (see its own header). test/cli.backoff.test.ts
// pins that the loop consults attachRefusal and exits non-zero on it.
const cliFleetSrc = await readFile(path.join(rootDir, "cli", "fleet.ts"), "utf8");

// Task 11: the real blueprint files this task ships — repo root is two
// levels up from apps/fleet (this is the websites repo playing both the
// blueprint host and the client, per the task brief). Same "no filesystem
// in workerd" reason as containerServerSrc above: test/studio.blueprint.test.ts
// reads these through the env bindings below instead of importing them, so
// the actual shipped files (not just synthetic fixtures) are proven to
// parse against src/studio/blueprint.ts.
const repoRoot = path.join(rootDir, "..", "..");
const testFleetJson = await readFile(path.join(repoRoot, "fleet.json"), "utf8");
const testPilotRoleMd = await readFile(path.join(repoRoot, "fleet", "blueprint", "roles", "pilot.md"), "utf8");
const testOrgJson = await readFile(path.join(repoRoot, "fleet", "blueprint", "org.json"), "utf8");
// Fleet Spawn P3, Task 3: the real `scratch` role file this task ships,
// bound the same way testPilotRoleMd is just above (see that constant's own
// comment for why — repo root is two levels up from apps/fleet).
const testScratchRoleMd = await readFile(path.join(repoRoot, "fleet", "blueprint", "roles", "scratch.md"), "utf8");
// Fleet Spawn P3, Task 4 (R-P3-3): the blueprint directory's own README —
// same "no filesystem in workerd" wiring as testFleetJson/testPilotRoleMd
// above. Source-pinned by test/studio.blueprint.test.ts so a future edit
// that drops the coherence rule it documents fails a test, not just a
// manual re-read.
const testBlueprintReadme = await readFile(path.join(repoRoot, "fleet", "blueprint", "README.md"), "utf8");

// Board issue #2 (gates single source): the three hook scripts moved out of
// studio-bringup.sh's own heredocs into real files at the repo root
// (gates/*.sh) — both cloud bring-up (a `cp` from the blueprint clone) and
// the new Mac `fleet gates install` verb read from these same files. Same
// "no filesystem in workerd" wiring as testFleetJson/testPilotRoleMd above:
// test/studio.session.test.ts source-pins their contents directly, exactly
// as it used to pin the heredoc bodies extracted out of studioBringupSrc.
const testLeadGateSrc = await readFile(path.join(repoRoot, "gates", "lead-gate.sh"), "utf8");
const testSessionReemitSrc = await readFile(path.join(repoRoot, "gates", "session-reemit.sh"), "utf8");
const testCompletionGateSrc = await readFile(path.join(repoRoot, "gates", "completion-gate.sh"), "utf8");

// sendMessage() (src/telegram/api.ts) makes a genuine outbound fetch() to the
// real Telegram API. Left unmocked, any test that reaches AgentDO's toHuman
// path makes a live request to api.telegram.org and depends on third-party
// egress to pass CI reliably.
//
// This intercepts that one origin and replies with a failure status, so
// sendMessage still throws exactly as it does today — res.ok is false, so it
// hits its own existing `if (!res.ok) throw ...` branch, the same branch a
// live 404 from the real API exercises. AgentDO's catch around sendMessage is
// what tests 1-3 in agents.do.test.ts (and the webhook dispatch tests) are
// built to exercise; this must not change that.
//
// Configured here (Node side) rather than in a worker-side setup file: the
// vitest 4 line of vitest-pool-workers dropped `fetchMock` from the
// "cloudflare:test" module entirely. Miniflare's own per-worker `fetchMock`
// option is the replacement, and it takes an undici MockAgent built by
// miniflare's `createFetchMock()` (its own pinned undici — a MockAgent from
// the hoisted top-level undici fails miniflare's `instanceof` check). Being
// pool-level, it also no longer has to be re-armed per test the way the old
// setup file did to survive the pool's own resetMockAgent() hook.
const fetchMock = createFetchMock();
fetchMock.disableNetConnect();
fetchMock
  .get("https://api.telegram.org")
  .intercept({ path: () => true, method: () => true })
  .reply(404, { ok: false, error_code: 404, description: "Not Found" })
  .persist();

// vitest-pool-workers >= 0.13 (the vitest 4 line) dropped the
// "@cloudflare/vitest-pool-workers/config" subpath and the
// `defineWorkersConfig` wrapper: the pool is now an ordinary Vite plugin
// (`cloudflareTest(...)`) and everything that used to live under
// `test.poolOptions.workers` is that plugin's argument instead. Same options,
// same wrangler.jsonc, different mounting point — see task-5-report.md's Step 0
// section for why the upgrade was mandatory (workerd's `tracing` export).
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Issue #329 critical fix round: the real, account-specific
      // wrangler.jsonc no longer lives in this repo (see scripts/deploy.sh's
      // header) — a fresh clone has NO operator config anywhere. This points
      // instead at wrangler.test.jsonc, a fake-but-valid, committed stand-in
      // built for exactly this: it gives vitest-pool-workers real D1/R2/DO/
      // container bindings to construct, with none of it deploy-real. Never
      // repoint this back at "./wrangler.jsonc" — `bun run test` must pass
      // with zero operator config present, from a completely fresh clone.
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        fetchMock,
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          TEST_CONTAINER_SERVER_SRC: containerServerSrc,
          TEST_STUDIO_BRINGUP_SRC: studioBringupSrc,
          TEST_DOCKERFILE_STUDIO_SRC: dockerfileStudioSrc,
          TEST_DOCKERFILE_TASK_SRC: dockerfileTaskSrc,
          TEST_STUDIO_FLEET_SRC: studioFleetSrc,
          TEST_TERMINAL_TEMPLATE_SRC: terminalTemplateSrc,
          TEST_CLI_FLEET_SRC: cliFleetSrc,
          TEST_STUDIO_DO_SRC: studioDoSrc,
          TEST_SURVIVAL_DELIVERY_SRC: survivalDeliverySrc,
          TEST_FLEET_JSON: testFleetJson,
          TEST_PILOT_ROLE_MD: testPilotRoleMd,
          TEST_ORG_JSON: testOrgJson,
          TEST_SCRATCH_ROLE_MD: testScratchRoleMd,
          TEST_BLUEPRINT_README: testBlueprintReadme,
          TEST_LEAD_GATE_SRC: testLeadGateSrc,
          TEST_SESSION_REEMIT_SRC: testSessionReemitSrc,
          TEST_COMPLETION_GATE_SRC: testCompletionGateSrc,
          TELEGRAM_WEBHOOK_SECRET: "test-secret",
          TELEGRAM_BOT_TOKEN: "test-token",
          CLAUDE_CODE_OAUTH_TOKEN: "test-oauth",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // studio.studio-blueprint.test.ts and studio.files.test.ts (P4a-1 T6)
    // both run on bun:test, not vitest (no workerd/cloudflare:test needed)
    // — they still match vitest's own default *.test.ts glob, so without
    // this they load under vitest-pool-workers too and fail on the
    // unresolvable "bun:test" import. Excluded here the same way they're
    // excluded from the root tsconfig project (see tsconfig.json's own
    // comment) — same files, same reason, two different tools that both
    // auto-discover by filename.
    exclude: [...configDefaults.exclude, "test/bun/**/*.test.ts", "test/studio.studio-blueprint.test.ts", "test/studio.files.test.ts"],
  },
});
