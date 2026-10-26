import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #1011: GateRunnerDO's image must run fleetflare's real lanes. The
 * vitest lane needs node (scripts/localci/localci.sh: vitest is
 * `#!/usr/bin/env node`); the bun-test lane needs tmux and chromium at
 * /usr/local/bin/chromium (the ego-browser shim launches that exact path).
 * fleetflare's gate also runs Rust-workspace lanes, so the image ships a pinned
 * Rust toolchain (#1037) that these tests pin positively.
 * Static only: a real build needs a docker daemon, which the gate lacks.
 */
const DOCKERFILE = join(import.meta.dir, "..", "..", "container", "Dockerfile.gate");
const src = readFileSync(DOCKERFILE, "utf8");

/** Dockerfile text with comment lines dropped, so a commented-out install never passes. */
const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

describe("Dockerfile.gate runs the real lanes", () => {
  test("installs node from a version-pinned tarball checked against its sha256", () => {
    expect(code).toMatch(
      /https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/node-v\d+\.\d+\.\d+-linux-x64\.tar\.xz/,
    );
    expect(code).toMatch(/[0-9a-f]{64}\s+\/tmp\/node-v\d+\.\d+\.\d+-linux-x64\.tar\.xz/);
    expect(code).toMatch(/sha256sum -c -/);
  });

  test("installs tmux from the apt snapshot", () => {
    expect(code).toMatch(/apt-get install -y --no-install-recommends[^&]*\btmux\b/);
  });

  test("installs chromium at /usr/local/bin/chromium via pinned playwright", () => {
    expect(code).toMatch(/bun x playwright@\d+\.\d+\.\d+ install chromium --with-deps/);
    expect(code).toMatch(/ln -sf \S+ \/usr\/local\/bin\/chromium/);
  });

  test("installs the gate legs' tools: python3, procps, C toolchain, Rust 1.96 (#1037)", () => {
    expect(code).toMatch(
      /apt-get install -y --no-install-recommends[^&]*\bpython3\b[^&]*\bprocps\b/,
    );
    for (const pkg of ["python3", "procps", "zstd", "gcc", "g\\+\\+", "make", "libc6-dev", "jq", "binutils"]) {
      // (?!\w), not a trailing \b: g++ ends in a non-word char, and \b there
      // only matches before a word char — \bg\+\+\b could never match the
      // space-delimited package list, only a glued "g++x" token. For the
      // word-ending packages the two are identical.
      expect(code).toMatch(new RegExp(`apt-get install -y --no-install-recommends[^&]*\\b${pkg}(?!\\w)`));
    }
  });

  test("installs a pinned Rust toolchain via checksum-verified rustup-init (#1037)", () => {
    expect(code).toMatch(/static\.rust-lang\.org\/rustup\/archive\/1\.28\.2\/x86_64-unknown-linux-gnu\/rustup-init/);
    expect(code).toMatch(/[0-9a-f]{64}\s+\/tmp\/rustup-init/);
    expect(code).toMatch(/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1\.96\.0/);
    expect(code).toMatch(/-c rustfmt,clippy,llvm-tools-preview -t wasm32-unknown-unknown/);
    expect(code).toMatch(/rustc --version && cargo --version && python3 --version && pgrep --version/);
  });

  test("ships container/gate/browser/ to /opt/fleet-gate/browser via FLEET_GATE_BROWSER (#1342)", () => {
    // The guard (#1344) + AI harness (#1345) land under container/gate/browser/.
    // The Dockerfile must COPY that dir through the normalized src stage and
    // expose its runtime path so a consumer spec can resolve it.
    expect(code).toMatch(/^COPY gate\/browser\/ \/src\/gate-browser\//m);
    expect(code).toMatch(/cp -R \/src\/gate-browser\/\. \/src\/app\/opt\/fleet-gate\/browser\//);
    expect(code).toMatch(/^ENV FLEET_GATE_BROWSER=\/opt\/fleet-gate\/browser$/m);
  });

  test("the browser harness rides /src/app/, after the heavy base COPY (#1342)", () => {
    // The final stage COPYs /src/base/ at line 34, BEFORE the apt/node/rust/
    // chromium layers; /src/app/ lands at the end (COPY --from=src /src/app/).
    // The harness must go into /src/app, or any gate/browser edit invalidates
    // every heavy layer's cache and the image rebuild is not incremental.
    const baseCopy = code.indexOf("COPY --from=src /src/base/ /");
    const appCopy = code.indexOf("COPY --from=src /src/app/ /");
    const harness = code.indexOf("cp -R /src/gate-browser/. /src/app/opt/fleet-gate/browser/");
    expect(baseCopy).toBeGreaterThan(0);
    expect(appCopy).toBeGreaterThan(baseCopy);
    expect(harness).toBeGreaterThan(0);
    // The src-stage copy into /src/app must sit before the final app COPY.
    expect(code.indexOf("/src/app/opt/fleet-gate/browser")).toBeLessThan(appCopy);
  });

  test("every install step in the final stage stays inside repro-seal begin/end", () => {
    // The src stage only lays out files (no install), as in Dockerfile.deploy. A RUN runs until the next column-0 instruction.
    const final = code.slice(code.lastIndexOf("\nFROM "));
    const runs = [...final.matchAll(/^RUN ([\s\S]*?)(?=^[A-Z]+ |(?![\s\S]))/gm)].map((m) => m[1].trim());
    expect(runs.length).toBeGreaterThan(0);
    for (const body of runs) {
      expect(body).toStartWith("--mount=type=tmpfs,target=/tmp repro-seal begin");
      expect(body).toMatch(/repro-seal end$/);
    }
  });
});
