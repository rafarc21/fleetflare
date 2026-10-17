// Issue #1147 item 4: `enable_request_signal` is measured — in production
// (15s ping) a dropped client fails in 15.1s WITH the flag but 60.2s WITHOUT
// it (the 30s background limit cuts detection off). So every deployed
// wrangler config must keep the flag; the only committed config allowed to
// omit it is test/workerd/wrangler.noflag.jsonc, the no-flag control
// llm-disconnect-workerd.test.ts spins up to characterize the inert path.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const FLEET = path.resolve(import.meta.dir, "../..");

const flagsOf = (file: string): string[] =>
  (Bun.JSONC.parse(readFileSync(file, "utf8")) as { compatibility_flags?: string[] }).compatibility_flags ?? [];

describe("enable_request_signal is kept in every deployed wrangler config (issue #1147 item 4)", () => {
  it("the example config and both committed deployed configs carry the flag", () => {
    const flagged = [
      path.join(FLEET, "wrangler.example.jsonc"),
      path.join(FLEET, "test", "wrangler.test.jsonc"),
      path.join(FLEET, "test", "workerd", "wrangler.jsonc"),
    ];
    for (const file of flagged) {
      expect(flagsOf(file), file).toContain("enable_request_signal");
    }
  });

  it("the no-flag control is the sole committed config without the flag", () => {
    const control = path.join(FLEET, "test", "workerd", "wrangler.noflag.jsonc");
    expect(flagsOf(control), control).not.toContain("enable_request_signal");
  });
});