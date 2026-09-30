import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #84: a cold rebuild (empty build cache) of an unchanged container/
 * gave all three images new digests, and wrangler replaced every running
 * studio. The fix makes the builds reproducible; scripts/image-repro-check.sh
 * proves it by building twice (heavy, not in this suite). This test holds the
 * cheap, static half: the rules each Dockerfile must keep so that proof stays
 * true after the next edit.
 */
const CONTAINER = join(import.meta.dir, "..", "..", "container");
const FILES = ["Dockerfile", "Dockerfile.deploy", "Dockerfile.studio"];

type Instr = { op: string; args: string; stage: number };

/** Dockerfile instructions, continuation lines joined, comments dropped. */
function parse(src: string): Instr[] {
  const out: Instr[] = [];
  let buf = "";
  let stage = -1;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!buf && (line === "" || line.startsWith("#"))) continue;
    if (buf && line.startsWith("#")) continue;
    buf += (buf ? " " : "") + line.replace(/\\$/, "").trim();
    if (line.endsWith("\\")) continue;
    const m = buf.match(/^(\S+)\s*(.*)$/)!;
    const op = m[1].toUpperCase();
    if (op === "FROM") stage++;
    out.push({ op, args: m[2], stage });
    buf = "";
  }
  return out;
}

const docs = FILES.map((f) => ({ f, src: readFileSync(join(CONTAINER, f), "utf8") }))
  .map(({ f, src }) => ({ f, src, ins: parse(src) }));

describe.each(docs)("$f", ({ f, ins }) => {
  const last = Math.max(...ins.map((i) => i.stage));
  const final = ins.filter((i) => i.stage === last);

  test("fixes SOURCE_DATE_EPOCH before the first FROM and in every stage", () => {
    expect(ins[0]).toMatchObject({ op: "ARG", stage: -1 });
    expect(ins[0].args).toMatch(/^SOURCE_DATE_EPOCH=\d+$/);
    for (let s = 0; s <= last; s++) {
      expect(ins.some((i) => i.stage === s && i.op === "ARG" && i.args === "SOURCE_DATE_EPOCH")).toBe(true);
    }
  });

  test("every base image is pinned by digest", () => {
    const froms = ins.filter((i) => i.op === "FROM");
    expect(froms.length).toBeGreaterThan(0);
    for (const i of froms) expect(i.args).toMatch(/@sha256:[0-9a-f]{64}(\s|$)/);
  });

  test("every RUN of the final stage is wrapped in repro-seal begin/end", () => {
    const runs = final.filter((i) => i.op === "RUN");
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect(r.args).toStartWith("--mount=type=tmpfs,target=/tmp repro-seal begin &&");
      expect(r.args).toEndWith("&& repro-seal end");
    }
  });

  test("the final stage takes no file straight from the build context", () => {
    // COPY keeps the checkout's own mtimes; only the normalized src stage may.
    for (const c of final.filter((i) => i.op === "COPY" || i.op === "ADD")) {
      expect(`${c.op} ${c.args}`).toMatch(/^COPY --from=src /);
    }
  });

  test("no floating install", () => {
    const text = ins.filter((i) => i.op === "RUN").map((i) => i.args).join("\n");
    expect(text).not.toMatch(/@latest\b/);
    expect(text).not.toMatch(/\|\s*(ba)?sh\b/);
    for (const m of text.matchAll(/bun (?:install -g|x) (\S+)/g)) {
      expect(m[1]).toMatch(/@\d+\.\d+\.\d+$/);
    }
    for (const m of text.matchAll(/curl [^&]*-o (\S+) https:\/\/\S+/g)) {
      expect(text).toContain(`  ${m[1]}" | sha256sum -c -`);
    }
  });

  test(`${f} ships the apt snapshot date shared by all three`, () => {
    expect(ins.some((i) => i.stage === last && i.op === "ARG" && /^APT_SNAPSHOT=\d{8}T\d{6}Z$/.test(i.args))).toBe(true);
  });
});

test("all three images share one SOURCE_DATE_EPOCH and one APT_SNAPSHOT", () => {
  const pick = (re: RegExp) => new Set(docs.map(({ src }) => src.match(re)?.[1]));
  for (const values of [pick(/^ARG SOURCE_DATE_EPOCH=(\d+)$/m), pick(/^ARG APT_SNAPSHOT=(\S+)$/m)]) {
    expect(values.has(undefined)).toBe(false);
    expect(values.size).toBe(1);
  }
});
