// Sweep 33 F7 (refs #751 / #733): the routes-studio provision harness —
// envWithFakeStudio, fakeStudioNamespace, fakeStorage, fakeFetchBlueprintFile,
// decodeRolePrompt, STUDIO_ID, FAKE — that studio.routes-handle.test.ts and
// studio.routes-accounts.test.ts kept as byte-identical copies since their
// split from one suite (PR #728). The other envWithFakeStudio sites (paste,
// grid, burn-window-expiry, ws) have different signatures and stay local.
// fakeRescueAnswer is module state the fake namespace's exec reads; because ES
// module bindings are read-only on the importing side, tests flip it through
// setFakeRescueAnswer/resetFakeRescueAnswer rather than direct reassignment.

import { vi } from "vitest";
import { env } from "cloudflare:test";
import {
  provisionWithStorage, getStatusWithStorage, restartWithStorage,
  STATUS_KEY, PROVISIONED_OK,
  type ProvisionDeps, type StudioStorage, type RoleEnv,
} from "../../src/studio/provision";
import {
  ensureSpawnToken, recycleWithSync, checkAndRecordReadiness,
  checkProvisionedGated, wakeStudioWith, provisionWithFreshVerdict,
  statusDetailWithStorage, clearSessionGuard, RESCUE_CLEAN,
  type SpawnTokenStorage,
} from "../../src/studio/do";
import { runDestroy, type DestroyOutcome } from "../../src/studio/destroy";
import { PANE_PROBE_CMD } from "../../src/studio/wake";
import { recordStudio } from "../../src/studio/registry";
import type { SessionSyncDeps, SessionSyncStorage } from "../../src/studio/session-sync";
import type { StudioStatus, ProvisionConfig } from "../../src/studio/types";
import type { Env } from "../../src/env";
import { fakeBlueprintFiles, fakeBlueprintFetch } from "./blueprint-fixture";

// ROLE_PROMPT_B64 is base64 of UTF-8 and every prompt now carries the house
// rules, whose em dashes are multi-byte — bare atob() hands back Latin-1.
export const decodeRolePrompt = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// A live StudioDO cannot be constructed under vitest-pool-workers: it is
// container-backed, and `env.STUDIO.get(...).fetch(...)` throws "Containers
// have not been enabled for this Durable Object class" (see
// src/studio/provision.ts's header, which also records the separate
// `tracing` import problem that Task 5's Step 0 resolved). This fake stands in for
// `env.STUDIO.get(...)` the same way test/telegram.webhook.test.ts's
// `fakeAgent` stands in for a live AgentDO — except its methods call the
// REAL exported provisionWithStorage/getStatusWithStorage/restartWithStorage
// (src/studio/provision.ts), over a plain in-memory StudioStorage (the same
// port do.ts's real methods pass `this.ctx.storage` through — review round
// 2, Important 2: this stub used to hand-copy do.ts's own read/compute/write
// sequence, which could drift from the real thing undetected; now there is
// exactly one copy of that sequence, and both do.ts and this fake call it).
// `sbExecFake` is the "sandbox mocked" half of the brief's test design, done
// via dependency injection (this codebase's established pattern for exactly
// this class of untestable-DO problem — see advanceTask/advanceDeploy)
// rather than `vi.mock`, which can never reach a module a live DO never
// successfully loads in the first place.
export const STUDIO_ID = "websites--pilot";

// Task 11: canned blueprint content, routed by path — stands in for do.ts's
// real fetchBlueprintFile (mintRepoToken + github/api.ts's fetchRepoFile).
// The triple + dispatcher come from helpers/blueprint-fixture.ts (refs
// #750); THIS suite's own args (repo, roles, role md, prompt) stay spelled
// here — the divergence is load-bearing. The built strings round-trip
// through the real parseFleetJson/parseRoleFile (src/studio/blueprint.ts)
// so the "provision happy path" / idempotent / registry tests below keep
// landing on state:"running".
export const FAKE_ROLE_PROMPT = "You are pilot. Work carefully. Small commits.";
export const FAKE = fakeBlueprintFiles({
  repo: "acme-org/websites", roles: ["pilot"],
  roleMd: { name: "pilot", prompt: FAKE_ROLE_PROMPT },
});
export function fakeFetchBlueprintFile(): ProvisionDeps["fetchBlueprintFile"] {
  return vi.fn(fakeBlueprintFetch(FAKE));
}

// One Map behind both keys, exactly as the real DurableObjectStorage is one
// keyspace. `get` needs the cast because the port's `get` is a keyed overload
// pair (see StudioStorage's doc comment) and no single non-overloaded
// implementation signature is assignable to both members; `put` needs none.
// Recycle: widened to also satisfy SessionSyncStorage (recycleWithSync's
// own pre-destroy syncSessionTick call needs it) — same one-Map-behind-
// every-key shape, cast rather than typed exactly, the same way
// test/studio.session.test.ts's own fakeCombinedStorage already casts `put`
// for the identical reason (a plain, non-overloaded implementation can't
// structurally satisfy every SessionSyncStorage overload's own value type
// without pulling in Burn/BurnCursor; nothing in THIS file's tests ever
// reads/writes a real burn value, so the cast is honest — see
// silentSyncDeps below, whose exec never produces bytes that would make
// syncSessionTick's own burn-parsing step do anything).
export function fakeStorage(): StudioStorage & SpawnTokenStorage & SessionSyncStorage {
  // Fleet Spawn P3, Task 4: `| boolean` added for KEEP_ALIVE_KEY (R-P3-6) —
  // same one-Map-behind-every-key shape, one more value type in the union.
  const map = new Map<string, StudioStatus | RoleEnv | string | boolean>();
  return {
    get: (async (key: string) => map.get(key)) as (StudioStorage & SpawnTokenStorage & SessionSyncStorage)["get"],
    put: (async (key: string, value: StudioStatus | RoleEnv | string | boolean) => {
      map.set(key, value);
    }) as (StudioStorage & SpawnTokenStorage & SessionSyncStorage)["put"],
    delete: (async (key: string) => map.delete(key)) as NonNullable<SessionSyncStorage["delete"]>,
  };
}

export function fakeStudioNamespace(
  sbExecFake: ProvisionDeps["sbExec"],
  fetchBlueprintFile: ProvisionDeps["fetchBlueprintFile"] = fakeFetchBlueprintFile(),
  // Recycle: destroy()/awaitReady() have no real container to touch in this
  // fake — no-op defaults, overridable so a test can prove they ran and in
  // what order (see the recycle describe block below), the same injection
  // style sbExecFake/fetchBlueprintFile already use for do.ts's other
  // untestable-DO surfaces.
  destroyFake: () => Promise<void> = vi.fn(async () => {}),
  awaitReadyFake: () => Promise<void> = vi.fn(async () => {}),
  checkResults?: ({ stdout?: string } | null)[],
  // Board task #124 (code review round): `destroyStudio`'s OWN open-task
  // check — `openTaskChecker`'s shape (board/routes.ts), a fail-CLOSED
  // sibling of task #118's assignedBriefResolver, NOT that resolver reused —
  // overridable so a test can prove the refusal, same injection style
  // destroyFake/awaitReadyFake above already establish. `{ ok: true,
  // hasOpenTask: false }` (the default) is a POSITIVE confirmation of "no
  // open task", which is what keeps every OTHER route test in this file
  // (none of which is about destroy's refusal gate) behaving as a plain
  // successful destroy.
  checkOpenTaskFake: (
    studioId: string, workRepoSlug: string,
  ) => Promise<{ ok: true; hasOpenTask: boolean } | { ok: false; message: string }> =
    async () => ({ ok: true, hasOpenTask: false }),
  // The container's answer to the wake command. Overridable so a test can
  // prove a dead tmux window surfaces as a failed wake rather than a silent
  // 200 — the whole reason runWake returns an outcome instead of throwing.
  wakeResult?: { code: number; stdout: string; stderr: string },
  // Board issue #82: this studio's own recorded status, as `wakeStudio`
  // itself now reads it (never the D1 registry mirror) before it lets a
  // single keystroke through. "running" by default so every OTHER route
  // test in this file, none of which is about the stopped gate, keeps
  // exercising a plain successful wake.
  wakeRecordedState: string | null = "running",
  // What the pane probe answers before the wake types anything. Claude-in-
  // the-pane by default, for the same reason wakeRecordedState defaults to
  // "running" above — overridable so a test can prove the gate refuses a
  // bash pane.
  wakePaneProbeResult: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "studio:claude claude\n", stderr: "" },
) {
  const storage = fakeStorage();
  // The studio's own recorded state, as the gated routes read it (see
  // checkProvisioned/wakeStudio below). `null` = never provisioned.
  const gateStorage = fakeStorage();
  if (wakeRecordedState !== null) {
    void gateStorage.put(STATUS_KEY, {
      id: STUDIO_ID, state: wakeRecordedState as StudioStatus["state"], tailscaleHost: null, lastRefresh: null, error: null,
    } as StudioStatus);
  }
  let checkCount = 0;
  // Every command that reached the provisioned-check port, so a test can
  // prove the READ-ONLY route runs the identical command recycle does —
  // which is what puts it under the same `never calls exit` assertion
  // test/studio.session.test.ts already pins on provisionedCheckCmd.
  const checkCmds: string[] = [];
  // Every command the wake route actually handed the container.
  const wakeCmds: string[] = [];
  const wakeExecResult = wakeResult ?? { code: 0, stdout: "", stderr: "" };
  // Fleet Spawn P3, Task 4 (R-P3-6): stands in for do.ts's real
  // `setKeepAlive: (v) => sbSetKeepAlive(this, v)` wiring — tracked instead
  // of calling the real adapter, same posture every other field on this
  // `deps` object already takes toward the DO it stands in for.
  const setKeepAliveCalls: boolean[] = [];
  const deps: ProvisionDeps = {
    sbExec: sbExecFake,
    recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
    now: () => "2026-08-16T00:00:00.000Z",
    fetchBlueprintFile,
    setKeepAlive: async (keepAlive: boolean) => { setKeepAliveCalls.push(keepAlive); },
  };
  // P3 Task 2: mirrors do.ts's real provision() — ensureSpawnToken (the SAME
  // function the class method calls) makes sure a token exists, persists it
  // and publishes the hash as one early sequence, THEN the long provisioning
  // runs. The class method additionally reassigns `this.envVars` between
  // those two steps; nothing here has a container to inherit it. Named (not
  // inline in `stub`) so recycle below can call the exact same path provision
  // does, rather than a second hand-copy that could drift from it.
  async function provisionFn(cfg: ProvisionConfig): Promise<StudioStatus> {
    await ensureSpawnToken(storage, STUDIO_ID, deps.recordStudio);
    return provisionWithStorage(deps, storage, cfg, "acme-org/websites");
  }
  // Recycle's own pre-destroy sync is exercised directly in
  // test/studio.session.test.ts (against recycleWithSync's real signature,
  // with real syncSessionTick command shapes) — this file's fakes never
  // exercise it either, the same restraint restartStudio's own fake above
  // already takes toward restartWithSync's pre-restart sync. A silent,
  // always-succeeding no-op keeps route-level `calls` arrays exactly as
  // predictable as before this fix: destroy, awaitReady, then provision's
  // own execs, nothing else.
  const silentSyncDeps: SessionSyncDeps = {
    // Dispatches by command shape (mirrors test/studio.session.test.ts's own
    // fakeSyncDeps): the tar+stat command needs a numeric size ("0"), the
    // read command needs valid base64 (""), which decodes to zero bytes,
    // matching that declared size. Getting this wrong doesn't break
    // anything (recycleWithSync's own try/catch swallows a sync failure
    // either way — see its doc comment), it would just print spurious
    // console.error noise on every recycle test for no reason.
    // recycleWithSync's post-provision container check (provision.ts's
    // provisionedCheckCmd) rides this same port. Injectable, in order, for
    // the same reason destroy/awaitReady are: it is the one place a test can
    // say "provisioning claimed success but the container is bare" — the
    // 2026-08-25 incident — without a real container to make bare. Default
    // exit 0, so every recycle test that is not about that stays a plain
    // success.
    exec: async (cmd: string) => {
      if (cmd.includes("pane_current_command")) {
        checkCmds.push(cmd);
        const verdict = checkResults?.[checkCount++];
        // The verdict rides STDOUT, never an exit code — the command must
        // never call `exit`, which would kill the session shell rather than
        // the command (provision.ts's PROVISIONED_OK). `null` means "this
        // exec throws", the shape the live false negative took.
        if (verdict === null) throw new Error("Session 'sandbox-default' shell exited (exit code: 0)");
        return { code: 0, stdout: verdict === undefined ? PROVISIONED_OK : (verdict.stdout ?? ""), stderr: "" };
      }
      // Issue #62: rescue-push answers a real verdict — an unparseable one is
      // now an UNCONFIRMED rescue, which refuses destroy/recycle.
      if (cmd.includes("status --porcelain")) return fakeRescueAnswer;
      return { code: 0, stdout: cmd.startsWith("mkdir -p") ? "0\n1758067200" : "", stderr: "" }; // #202: size + tar-start watermark
    },
    r2Put: async () => {},
    r2List: async () => [],
    r2Delete: async () => {},
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    notify: async () => {},
    burnAlertThresholdTokens: 0,
  };
  const stub = {
    // Issue #37: mirrors StudioDO.provision exactly — the real method wraps
    // its own core in provisionWithFreshVerdict so the row it answers with
    // carries the verdict measured AFTER provisioning, never the one the last
    // syncSession tick left behind. `recycle` below deliberately passes the
    // UNWRAPPED provisionFn, exactly as the real StudioDO.recycle passes
    // provisionCore: recycleWithSync runs its own post-provision check, and
    // wrapping here would make every recycle pay for two.
    provision: (cfg: ProvisionConfig) =>
      provisionWithFreshVerdict(silentSyncDeps, storage, STUDIO_ID, provisionFn, deps.recordStudio, cfg),
    // Issue #104: GET /studio/:id/status now answers the detail view.
    getStatusDetail: () => statusDetailWithStorage(storage as unknown as Parameters<typeof statusDetailWithStorage>[0], STUDIO_ID),
    // POST /studio/:id/check. Calls the REAL exported checkAndRecordReadiness
    // (do.ts) over the same fake exec port every other check on this stub
    // rides — a hand-copy here would defeat the point of one shared check.
    checkNow: async () => {
      const fresh = await checkAndRecordReadiness(silentSyncDeps, storage, STUDIO_ID, deps.recordStudio);
      return fresh ?? getStatusWithStorage(storage, STUDIO_ID);
    },
    // Board #140. Calls the REAL exported clearSessionGuard (do.ts), same
    // "hand-copy would defeat the point" reasoning checkNow's own comment
    // above gives.
    clearSessionGuard: async () => {
      const cleared = await clearSessionGuard(storage, deps.recordStudio);
      return cleared ?? getStatusWithStorage(storage, STUDIO_ID);
    },
    restartStudio: () => restartWithStorage(deps, storage, STUDIO_ID, "rafarc21/fleetflare"),
    // Root-cause fix for the stranded-image bug, second review pass: calls
    // the REAL exported recycleWithSync (do.ts) rather than a hand-copy —
    // review round 2's own lesson elsewhere in this file (see provisionFn's
    // comment) applies just as much here, and recycleWithSync is now where
    // the destroy-then-await-ready-then-provision ordering AND the
    // degraded-status-on-failure behavior actually live.
    // #96: errors are marked `remote`, as Workers RPC marks an error the DO's
    // own code threw — so the route tells them apart from a Worker->DO failure.
    recycle: (cfg: ProvisionConfig, discardUnsynced = false) =>
      recycleWithSync(
        silentSyncDeps, storage, STUDIO_ID, destroyFake, awaitReadyFake, provisionFn, deps.recordStudio, cfg,
        // Task 4's memory adapters: the learning-harvest itself
        // (silentSyncDeps' own catch-all answers its exec with "", so
        // harvestLearnings throws and recycleWithSync's try/catch swallows
        // it — same harmless-noise shape rescue-push already has here, per
        // this block's own comment above) is exercised for real in
        // test/studio.session.test.ts; no route-level test needs either
        // adapter called, so plain no-ops.
        async () => "unused",
        async () => {},
        { discardUnsynced, lastSyncedAt: async () => null },
      ).catch((err: Error) => { throw Object.assign(err, { remote: true }); }),
    // Board task #124: POST /studio/:id/destroy. Calls the REAL exported
    // runDestroy (src/studio/destroy.ts) — same "hand-copy would defeat the
    // point" reasoning `recycle`'s own comment above gives — reusing
    // destroyFake (the SAME container-kill fake recycle's own tests use) and
    // silentSyncDeps (recycle's own pre-destroy sync fake) so a destroy test
    // gets the identical harmless-noise sync/rescue/harvest posture recycle's
    // tests already rely on, without a third hand-copy of either.
    destroyStudio: (force: boolean): Promise<DestroyOutcome> =>
      runDestroy(
        checkOpenTaskFake, STUDIO_ID, "acme-org/websites", force,
        silentSyncDeps, storage, STUDIO_ID, destroyFake, deps.recordStudio, "websites",
        async () => "unused",
        async () => {},
      ).catch((err: Error) => { throw Object.assign(err, { remote: true }); }), // #96: see recycle above
    // GET /studio/:id/provisioned and POST /studio/:id/wake (issue #100
    // N3): the REAL bodies StudioDO.checkProvisioned / StudioDO.wakeStudio
    // forward to — checkProvisionedGated and wakeStudioWith (do.ts) — so the
    // stopped gate these routes rely on is the one production runs. One
    // difference from the DO, stated: they read `gateStorage`, seeded from
    // wakeRecordedState, not `storage` above, so every other route test in
    // this file keeps its own storage untouched. wakeCmds is what lets a
    // route test prove the container was handed the identical command
    // test/bun/wake-cmd.test.ts ran against a real tmux, and that a stopped
    // or non-claude studio never sees it at all. Not a maestro, so no sweep.
    checkProvisioned: (repo: string) => checkProvisionedGated(gateStorage, silentSyncDeps, repo, STUDIO_ID),
    wakeStudio: (prompt: string) =>
      wakeStudioWith(
        gateStorage,
        async (cmd: string) => {
          wakeCmds.push(cmd);
          return cmd === PANE_PROBE_CMD ? wakePaneProbeResult : wakeExecResult;
        },
        { isMaestro: false, armSweep: async () => {}, prompt },
      ),
  };
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => stub as unknown as ReturnType<Env["STUDIO"]["get"]>,
    storage,
    setKeepAliveCalls,
    checkCmds,
    wakeCmds,
  };
}

/** Issue #62 follow-up: what the fake namespace's rescue-push exec answers.
 *  A real script always prints a verdict; a test flips this to a killed exec. */
let fakeRescueAnswer: { code: number; stdout: string; stderr: string } = { code: 0, stdout: RESCUE_CLEAN, stderr: "" };

/** Issue #62: tests flip the rescue-push verdict to a killed exec, then back. */
export function setFakeRescueAnswer(answer: { code: number; stdout: string; stderr: string }): void {
  fakeRescueAnswer = answer;
}

export function resetFakeRescueAnswer(): void {
  fakeRescueAnswer = { code: 0, stdout: RESCUE_CLEAN, stderr: "" };
}

export function envWithFakeStudio(
  sbExecFake: ProvisionDeps["sbExec"] = vi.fn(),
  fetchBlueprintFile?: ProvisionDeps["fetchBlueprintFile"],
  destroyFake?: () => Promise<void>,
  awaitReadyFake?: () => Promise<void>,
  checkResults?: ({ stdout?: string } | null)[],
  checkOpenTaskFake?: (
    studioId: string, workRepoSlug: string,
  ) => Promise<{ ok: true; hasOpenTask: boolean } | { ok: false; message: string }>,
  wakeResult?: { code: number; stdout: string; stderr: string },
  // Board issue #82: threaded through to fakeStudioNamespace's own new
  // params, same reason/defaults given there.
  wakeRecordedState?: string | null,
  wakePaneProbeResult?: { code: number; stdout: string; stderr: string },
) {
  const fakeNs = fakeStudioNamespace(
    sbExecFake, fetchBlueprintFile, destroyFake, awaitReadyFake, checkResults, checkOpenTaskFake, wakeResult,
    wakeRecordedState, wakePaneProbeResult,
  );
  // AGENT_REPO pinned, not inherited: `env` here is wrangler.jsonc's own
  // `vars` (vitest.config.ts binds the real config), and STUDIO_ID below is
  // the literal "websites--pilot". resolveWorkRepo (src/studio/repo.ts) 400s
  // when a bodyless provision's id segment disagrees with the fleet default,
  // so a deployed AGENT_REPO that is not a `websites` slug turns every
  // bodyless provision in this file into a 400 — which is the route working,
  // not a regression. Measured 2026-09-12, when AGENT_REPO was repointed to
  // rafarc21/fleetflare: 22 of these failed at once.
  //
  // Same pin, same reason, as test/board.routes.test.ts, board.fleet-routes,
  // memory.routes and studio.spawn already carry.
  return {
    testEnv: { ...env, AGENT_REPO: "acme-org/websites", STUDIO: fakeNs } as unknown as Env,
    fakeNs,
  };
}

/** Worker->DO stub's named method throws `err` instead of answering. */
export function envWithThrowingVerb(method: string, err: Error) {
  const { testEnv, fakeNs } = envWithFakeStudio();
  const stub = fakeNs.get();
  const failingNs = { ...fakeNs, get: () => ({ ...stub, [method]: async () => { throw err; } }) };
  return { ...testEnv, STUDIO: failingNs } as unknown as Env;
}
