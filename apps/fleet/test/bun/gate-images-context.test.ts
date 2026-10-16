import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Every image wrangler.example.jsonc names must build. A COPY source missing
 * from its build context fails only at deploy, on the operator's machine, so
 * this checks the context statically: each COPY/ADD source that is not
 * `--from=<stage>` must exist under the image's build_context.
 *
 * Both shapes the example uses: a container entry (`image` = Dockerfile path,
 * context = `image_build_context`, else the Dockerfile's own directory) and a
 * named entry of a Durable Object's `images` map (`dockerfile`, `build_context`).
 */
const FLEET = join(import.meta.dir, "..", "..");
const EXAMPLE = join(FLEET, "wrangler.example.jsonc");

type Built = { name: string; dockerfile: string; context: string };

function example(): { containers: Record<string, unknown>[] } {
  const text = readFileSync(EXAMPLE, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(text);
}

/** Every image the example builds, named by where it sits. */
function namedImages(): Built[] {
  const out: Built[] = [];
  for (const c of example().containers) {
    const name = String(c.class_name);
    if (typeof c.image === "string") {
      out.push({
        name,
        dockerfile: c.image,
        context: typeof c.image_build_context === "string" ? c.image_build_context : dirname(c.image),
      });
    }
    const images = c.images as Record<string, { dockerfile?: string; build_context?: string }> | undefined;
    for (const [key, img] of Object.entries(images ?? {})) {
      if (typeof img.dockerfile !== "string") continue; // a digest-pinned `image` ref builds nothing here
      out.push({
        name: `${name}.images.${key}`,
        dockerfile: img.dockerfile,
        context: img.build_context ?? dirname(img.dockerfile),
      });
    }
  }
  return out;
}

/** COPY/ADD sources of a Dockerfile, continuation lines joined, `--from=` copies left out. */
function copySources(src: string): string[] {
  const joined = src.replace(/\\\n/g, " ");
  const out: string[] = [];
  for (const raw of joined.split("\n")) {
    const m = raw.trim().match(/^(COPY|ADD)\s+(.*)$/);
    if (!m) continue;
    const args = m[2].split(/\s+/).filter((a) => !a.startsWith("--"));
    if (raw.includes("--from=")) continue;
    out.push(...args.slice(0, -1));
  }
  return out;
}

const images = namedImages();

test("the example names the gate image", () => {
  expect(images.map((i) => i.name)).toContain("GateRunnerDO.images.gate");
});

describe.each(images)("$name", ({ dockerfile, context }) => {
  test("every COPY/ADD source exists under its build context", () => {
    const df = join(FLEET, dockerfile);
    expect(existsSync(df)).toBe(true);
    const ctx = join(FLEET, context);
    const missing = copySources(readFileSync(df, "utf8")).filter((s) => !existsSync(join(ctx, s)));
    expect({ context, missing }).toEqual({ context, missing: [] });
  });
});
