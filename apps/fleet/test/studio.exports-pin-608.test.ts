import { describe, it, expect } from "vitest";
import * as provision from "../src/studio/provision";
import * as installCache from "../src/studio/install-cache";

// Sweep 24 finding S24-F11 (issue #608, refs #588): the module surface
// is a contract; exports with no reader are drift. These 18 names are
// file-internal by design — the 8 value exports pinned at runtime here,
// the 10 type-only exports pinned by `@ts-expect-error` below (a type
// export leaves no runtime trace, so the absence that matters is the
// compile error these directives suppress once the names are gone).
describe("provision/install-cache module surface (#608)", () => {
  it("keeps the 8 fossil value exports off the export surface", () => {
    const p = provision as Record<string, unknown>;
    expect(p.KEEP_ALIVE_KEY).toBeUndefined();
    expect(p.guardedCloneCmd).toBeUndefined();
    expect(p.verifyBringupLanded).toBeUndefined();
    expect(p.TAILNET_DOWN_PATH).toBeUndefined();
    expect(p.freshSessionNoteFor).toBeUndefined();
    const c = installCache as Record<string, unknown>;
    expect(c.INSTALL_CACHE_KEEP_GENERATIONS).toBeUndefined();
    expect(c.INSTALL_COMPLETE_MARKER).toBeUndefined();
    expect(c.INSTALL_CACHE_URL_TTL_SECONDS).toBeUndefined();
  });

  // 7 provision.ts + 3 install-cache.ts type-only exports, each pinned
  // by one directive — RED today as TS2578 "Unused '@ts-expect-error'
  // directive" because every name is still on the surface.
  it("keeps the 10 fossil type exports off the export surface", () => {
    // @ts-expect-error SessionAdoption is not exported
    const _a: provision.SessionAdoption = null as never;
    // @ts-expect-error OpsHouseRulesOutcome is not exported
    const _b: provision.OpsHouseRulesOutcome = null as never;
    // @ts-expect-error R2PresignEnv is not exported
    const _c: installCache.R2PresignEnv = null as never;
    // @ts-expect-error InstallCacheRestoreOutcome is not exported
    const _d: installCache.InstallCacheRestoreOutcome = null as never;
    // @ts-expect-error InstallCacheDirRestoreResult is not exported
    const _e: installCache.InstallCacheDirRestoreResult = null as never;
    // @ts-expect-error InstallCacheRestoreResult is not exported
    const _f: installCache.InstallCacheRestoreResult = null as never;
    // @ts-expect-error InstallCacheFailureRecord is not exported
    const _g: installCache.InstallCacheFailureRecord = null as never;
    // @ts-expect-error InstallCacheSaveOutcome is not exported
    const _h: installCache.InstallCacheSaveOutcome = null as never;
    // @ts-expect-error InstallCacheDirSaveResult is not exported
    const _i: installCache.InstallCacheDirSaveResult = null as never;
    // @ts-expect-error InstallCacheSaveResult is not exported
    const _j: installCache.InstallCacheSaveResult = null as never;
    expect([_a, _b, _c, _d, _e, _f, _g, _h, _i, _j]).toHaveLength(10);
  });
});
