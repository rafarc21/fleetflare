import { describe, expect, test } from "bun:test";
import {
  decideDesktopChange, extractCopySources, hashContent, isPinned, recordedDesktopSha, repin,
  type DesktopImageEntry,
} from "../../scripts/gate-desktop-image";

/**
 * Issue #1314: a digest-pinned `desktop` named image on GateRunnerDO is
 * invisible to `wrangler deploy` (wrangler treats a `{ "image": ... }` entry
 * as already-built). The probe detects a Dockerfile.gate-desktop change with
 * NO docker: it hashes the Dockerfile + its COPY sources and compares against
 * a `dockerfile-sha:` marker the operator records next to the pin.
 */
describe("isPinned", () => {
  test("a dockerfile entry is not pinned — wrangler builds it", () => {
    const entry: DesktopImageEntry = { dockerfile: "./container/Dockerfile.gate-desktop", build_context: "./container" };
    expect(isPinned(entry)).toBe(false);
  });

  test("an absent desktop entry is not pinned", () => {
    expect(isPinned(undefined)).toBe(false);
  });

  test("a digest-pinned image ref is pinned", () => {
    const entry: DesktopImageEntry = { image: "registry.example.com/acct/repo@sha256:" + "a".repeat(64) };
    expect(isPinned(entry)).toBe(true);
  });
});

describe("hashContent", () => {
  test("deterministic for the same parts", () => {
    expect(hashContent(["a", "b"])).toBe(hashContent(["a", "b"]));
  });

  test("different content -> different hash", () => {
    expect(hashContent(["a", "b"])).not.toBe(hashContent(["a", "c"]));
  });

  test("order-sensitive (no 'ab'+'c' == 'a'+'bc' collision)", () => {
    expect(hashContent(["ab", "c"])).not.toBe(hashContent(["a", "bc"]));
  });

  test("64-char lowercase hex", () => {
    expect(hashContent(["x"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("extractCopySources", () => {
  test("extracts COPY/ADD sources, skipping flags and --from= stage copies", () => {
    const src = [
      "FROM x",
      "COPY --from=src /a /",
      "COPY foo bar baz /dest/",
      "ADD --chown=root qux /",
      "RUN true",
    ].join("\n");
    expect(extractCopySources(src)).toEqual(["foo", "bar", "baz", "qux"]);
  });

  test("joins line continuations", () => {
    const src = "COPY \\\n  one \\\n  two /dest/";
    expect(extractCopySources(src)).toEqual(["one", "two"]);
  });
});

describe("recordedDesktopSha", () => {
  test("finds a dockerfile-sha marker", () => {
    const text = `"desktop": { "image": "repo@sha256:aa" /* dockerfile-sha: ${"a".repeat(64)} */ }`;
    expect(recordedDesktopSha(text)).toBe("a".repeat(64));
  });

  test("null when the marker is absent", () => {
    expect(recordedDesktopSha(`"desktop": { "image": "repo@sha256:aa" }`)).toBe(null);
  });

  test("null when the marker value is not 64 hex", () => {
    expect(recordedDesktopSha(`/* dockerfile-sha: not-a-sha */`)).toBe(null);
  });
});

describe("decideDesktopChange", () => {
  test("a missing recorded sha is changed (fail closed)", () => {
    expect(decideDesktopChange(null, "a".repeat(64))).toBe("changed");
  });

  test("recorded matches current -> no-change", () => {
    expect(decideDesktopChange("a".repeat(64), "a".repeat(64))).toBe("no-change");
  });

  test("recorded differs from current -> changed", () => {
    expect(decideDesktopChange("a".repeat(64), "b".repeat(64))).toBe("changed");
  });
});

describe("repin", () => {
  test("swaps the digest, keeps the repo path", () => {
    expect(repin("registry.example.com/acct/repo@sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)))
      .toBe("registry.example.com/acct/repo@sha256:" + "b".repeat(64));
  });

  test("a ref with no digest returns null", () => {
    expect(repin("registry.example.com/acct/repo", "sha256:" + "b".repeat(64))).toBe(null);
  });
});