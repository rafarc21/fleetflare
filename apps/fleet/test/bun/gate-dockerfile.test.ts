import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #1011: GateRunnerDO's image must run fleetflare's real lanes. The
 * vitest lane needs node (scripts/localci/localci.sh: vitest is
 * `#!/usr/bin/env node`); the bun-test lane needs tmux and chromium at
 * /usr/local/bin/chromium (the ego-browser shim launches that exact path).
 * fleetflare has no Rust, so the rustup/cargo-nextest layer must not return.
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

  test("has no rustup, cargo or cargo-nextest layer", () => {
    expect(code).not.toMatch(/rustup/i);
    expect(code).not.toMatch(/cargo/i);
    expect(code).not.toMatch(/nextest/i);
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
