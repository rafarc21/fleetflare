# Task 1037 — gate image adds python3, procps, C toolchain, Rust 1.96 (refs #1037, #715)

Dockerfile.gate edit + the tests that pin its text. TDD: tests first.

Measured why (#1037): 94 bun-lane tests fail in the gate image —
bringup gates run python3 (absent), pgrep/ps need procps (absent).
A Rust-workspace repo needs a pinned Rust toolchain plus a C linker.

## Changes
1. apt RUN line: append python3 procps zstd gcc g++ make libc6-dev jq
   binutils. Keep --no-install-recommends, repro-seal wrapper, APT_SNAPSHOT.
2. New RUN after the node step, same repro-seal wrapper, tmpfs mount:
   rustup-init 1.28.2 (sha256-pinned) installs Rust 1.96.0
   (rustfmt, clippy, llvm-tools-preview, wasm32 target), then
   rustc/cargo/python3/pgrep --version verify.
3. Two tests pin "no rustup/cargo" (gate-dockerfile.test.ts,
   gate-server.test.ts) — flip to positive pins.
   reproducible-images.test.ts has no rustup pins (verified: grep).
4. Header comment "No Rust: fleetflare has none" updated.

## Verification
Targeted only: bun test test/bun/gate-dockerfile.test.ts
test/bun/gate-server.test.ts test/bun/reproducible-images.test.ts.
RED first (new pins fail on current Dockerfile), GREEN after the edit.
No docker in the studio: no build. Maestro builds locally pre-merge.
