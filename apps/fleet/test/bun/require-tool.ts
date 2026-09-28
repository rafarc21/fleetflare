import { describe, test } from "bun:test";

/** The subset of `describe`'s own call shape every caller here actually
 *  uses — a plain `(name, fn) => void`, never `.skip`/`.only`/`.each`
 *  chained off the returned value. Kept narrow on purpose so the
 *  loud-failure branch below never has to impersonate the rest of
 *  `describe`'s static surface. */
type DescribeLike = (name: string, fn: () => void) => void;

/**
 * `LOCALCI_IMAGE` marks the pinned Linux image `scripts/localci/Dockerfile`
 * builds (baked in there via `ENV LOCALCI_IMAGE=1`) — the one localci.sh's
 * docker-mode lanes actually run tests in. It is deliberately a NEW name,
 * distinct from `LOCALCI_RUN` (a per-invocation run id) and `LOCALCI_RUNNER`
 * (mac/studio host selection) in localci.sh itself: neither of those means
 * "this container is the tool-pinned image," and native-mode runs (`IMAGE
 * native`, no docker at all) never set it, so a studio's own sandboxed
 * container is treated the same as any other dev machine.
 */
export const LOCALCI_IMAGE_ENV = "LOCALCI_IMAGE";

function isInPinnedImage(): boolean {
  return process.env[LOCALCI_IMAGE_ENV] === "1";
}

function missingTools(tools: readonly string[]): string[] {
  return tools.filter((t) => Bun.which(t) === null);
}

/**
 * Issue #356 — the local-ci Linux image lacked `zstd`, so install-cache's own
 * `hasGnuTar() && hasZstd()` gate silently `describe.skip`ped every one of
 * its security tests in CI, on the one image that is supposed to guarantee
 * the tool. A skip that looks identical whether a dev's Mac lacks a tool or
 * the pinned CI image itself regressed is not a skip anyone can trust.
 *
 * `requireTools(tools)` returns a `describe` a caller can invoke exactly like
 * `bun:test`'s own, picking one of three behaviours:
 *
 *  - every named tool is on PATH: the real `describe` — no behaviour change.
 *  - a tool is missing and `LOCALCI_IMAGE` is unset (an arbitrary dev
 *    machine, or this very studio's own sandboxed container): `describe.skip`,
 *    exactly today's ad-hoc `Bun.which(...) !== null ? describe : describe.skip`
 *    pattern this replaces — no behaviour change outside the image.
 *  - a tool is missing and `LOCALCI_IMAGE=1` IS set (the pinned localci
 *    image, which is supposed to guarantee every tool named here): the suite
 *    still runs, but as exactly ONE test that fails loudly, naming every
 *    missing tool — the same "never a quiet skip" shape git-wrapper.test.ts's
 *    issue #310 handling already uses for a real-git-but-no-timeout Mac lane,
 *    generalized to an arbitrary tool list and gated on the image flag
 *    instead of applying unconditionally.
 *
 * `label` names the suite in both the real and loud-failure cases; keep it
 * descriptive, it is the only thing distinguishing one loud failure from
 * another in a CI log.
 */
export function requireTools(tools: string | readonly string[], label: string): DescribeLike {
  const wanted = typeof tools === "string" ? [tools] : tools;
  const missing = missingTools(wanted);
  if (missing.length === 0) return describe;
  if (!isInPinnedImage()) return describe.skip;
  return (name: string, _fn: () => void): void => {
    describe(name, () => {
      test(`missing on PATH inside the pinned localci image: ${missing.join(", ")}`, () => {
        throw new Error(
          `${LOCALCI_IMAGE_ENV}=1 (this IS the pinned localci image, which is supposed to guarantee ` +
            `every tool below) but the following tool(s) needed by "${label}" are not on PATH: ` +
            `${missing.join(", ")}. Add them to scripts/localci/Dockerfile's apt-get install line.`,
        );
      });
    });
  };
}
