import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Board issue #334: wrangler.jsonc is the operator's own deployed config.
 * wrangler.example.jsonc is what anyone else starts from — every
 * operator-specific feature OFF, and none of the operator's ids, domains or
 * database ids in it.
 */
const EXAMPLE = join(import.meta.dir, "../../wrangler.example.jsonc");

function vars(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(text).vars ?? {};
}

describe("wrangler.example.jsonc (#334)", () => {
  test("exists and parses", () => {
    expect(existsSync(EXAMPLE)).toBe(true);
    expect(() => vars(EXAMPLE)).not.toThrow();
  });

  test("turns every operator-specific feature off", () => {
    const v = vars(EXAMPLE);
    expect(v.FLEET_TELEGRAM).toBe("off");
    expect(v.FLEET_DIRECTUS).toBe("off");
    expect(v.FLEET_AUTO_FAILOVER ?? "off").toBe("off");
  });

  test("carries none of the operator's own ids, domains or database ids", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    // Fragments are split so this canary itself never names the real values
    // it's guarding against in plain text — join at runtime to check.
    const leakFragments = [
      ["5745", "84467"],
      ["454", "3871"],
      ["1525", "80265"],
      ["yin", "flow"],
      ["arvi", "os"],
      ["yang", "flow"],
      ["c9ee", "4e75"],
      ["raf", "arc21"],
    ];
    for (const parts of leakFragments) {
      const leak = parts.join("");
      expect({ leak, found: text.includes(leak) }).toEqual({ leak, found: false });
    }
  });

  // Moved from test/config.fleet-repo.test.ts (deleted by #329 — the real
  // deployed wrangler.jsonc it pinned no longer lives in this repo). #341:
  // FLEET_OPS_REPO names the operator's own private ops repo, exactly the
  // kind of operator-specific value this template must never ship with a
  // real value already filled in — the public default is memory off.
  test("does not set FLEET_OPS_REPO: the public default is memory off (#341)", () => {
    const v = vars(EXAMPLE);
    expect(v.FLEET_OPS_REPO).toBeUndefined();
  });

  // #330: the caveman plugin is an operator opt-in, baked at build through
  // the StudioDO image's build ARG. The template names the knob, set off.
  test("the StudioDO image declares ENABLE_CAVEMAN_PLUGIN, off by default (#330)", () => {
    const text = readFileSync(EXAMPLE, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const studio = (JSON.parse(text).containers as { class_name: string; image_vars?: Record<string, string> }[])
      .find((c) => c.class_name === "StudioDO");
    expect(studio?.image_vars?.ENABLE_CAVEMAN_PLUGIN).toBe("false");
  });

  // #379 round 2 (maestro ruling): wrangler 4.141 defaults DO code updates to
  // "deferred, up to 5 min". The fleet keeps the old behaviour -- new code
  // reaches every Durable Object at deploy -- stated explicitly.
  test("durable_objects.code_update_strategy is explicit: immediate (#379)", () => {
    const text = readFileSync(EXAMPLE, "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(JSON.parse(text).durable_objects?.code_update_strategy).toEqual({ mode: "immediate" });
  });
});
