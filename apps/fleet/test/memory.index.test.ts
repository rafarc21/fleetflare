import { describe, it, expect } from "vitest";
import {
  MEMORY_INDEX_PATH, MEMORY_ARCHIVE_DIR,
  parseMemoryIndex, renderMemoryIndex, renderIndexLine,
  archivePathFor, harvestDateOf, indexEntryFromFile,
  type IndexEntry,
} from "../src/memory/index-file";

describe("memory paths", () => {
  // MEMORY_DIR's real behavior coverage: archivePathFor below already pins
  // the real "fleet/memory/" literal against a real consumer. These two
  // assertions exercise the TEMPLATE concatenation (`${MEMORY_DIR}/INDEX.md`,
  // `${MEMORY_DIR}/archive`), not a re-declaration of MEMORY_DIR itself.
  it("index and archive live under fleet/memory/", () => {
    expect(MEMORY_INDEX_PATH).toBe("fleet/memory/INDEX.md");
    expect(MEMORY_ARCHIVE_DIR).toBe("fleet/memory/archive");
  });

  it("archivePathFor keeps the studio subdirectory, so an archived file is still traceable to who learned it", () => {
    expect(archivePathFor("fleet/memory/websites--pilot/2026-08-27T17-50-08-684Z-0-a-fact.md"))
      .toBe("fleet/memory/archive/websites--pilot/2026-08-27T17-50-08-684Z-0-a-fact.md");
  });

  it("archivePathFor refuses a path already inside archive/ — demotion is one-way, never re-nested", () => {
    expect(() => archivePathFor("fleet/memory/archive/x/y.md")).toThrow(/already archived/);
  });

  it("archivePathFor refuses anything outside fleet/memory/", () => {
    expect(() => archivePathFor("docs/x.md")).toThrow(/fleet\/memory/);
  });
});

describe("parseMemoryIndex", () => {
  it("reads a plain line", () => {
    const { entries } = parseMemoryIndex("- [CF rollout](a/b.md) — bump the digest, rollout_step_percentage:100\n");
    expect(entries).toEqual([
      { title: "CF rollout", target: "a/b.md", archived: 0, summary: "bump the digest, rollout_step_percentage:100" },
    ]);
  });

  it("reads a merged line's archived count — the citation that keeps the original reachable", () => {
    const { entries } = parseMemoryIndex("- [CF rollout](cloudflare-container-image-rollout.md, +2 archived) — why\n");
    expect(entries[0]).toEqual({
      title: "CF rollout", target: "cloudflare-container-image-rollout.md", archived: 2, summary: "why",
    });
  });

  it("ignores preamble prose and blank lines", () => {
    const md = "# Fleet memory index\n\nOne line per fact.\n\n- [a](a.md) — one\n- [b](b.md) — two\n";
    expect(parseMemoryIndex(md).entries.map((e) => e.title)).toEqual(["a", "b"]);
  });

  it("a bullet that is not an entry is not silently swallowed", () => {
    expect(() => parseMemoryIndex("- [broken](a.md\n")).toThrow(/line 1/);
  });

  it("an empty index is an empty entry list, never a throw — the bootstrap case", () => {
    expect(parseMemoryIndex("").entries).toEqual([]);
  });
});

describe("renderMemoryIndex", () => {
  const entries: IndexEntry[] = [
    { title: "a", target: "s/a.md", archived: 0, summary: "one" },
    { title: "b", target: "s/b.md", archived: 3, summary: "two" },
  ];

  it("round-trips through parse", () => {
    expect(parseMemoryIndex(renderMemoryIndex(entries)).entries).toEqual(entries);
  });

  it("renders the archived-count citation only when there is one", () => {
    expect(renderIndexLine(entries[0])).toBe("- [a](s/a.md) — one");
    expect(renderIndexLine(entries[1])).toBe("- [b](s/b.md, +3 archived) — two");
  });

  it("carries a preamble telling a reader the files are fetchable and archive/ is greppable", () => {
    const md = renderMemoryIndex(entries);
    expect(md).toMatch(/archive/);
    expect(md).toMatch(/fetch/i);
  });
});

describe("harvestDateOf", () => {
  it("reads the timestamp harvestLearnings itself writes", () => {
    expect(harvestDateOf("2026-08-27T17-50-08-684Z-0-t5-live-proof.md")?.toISOString())
      .toBe("2026-08-27T17:50:08.684Z");
  });

  it("is null for a hand-written file — an undatable file is never auto-demoted", () => {
    expect(harvestDateOf("cloudflare-container-image-rollout.md")).toBeNull();
  });
});

describe("indexEntryFromFile", () => {
  const md = '---\nname: 2026-08-27T17-50-08-684Z-0-a-fact\ndescription: "wrangler diffs the image digest, not rollout_step_percentage"\nmetadata:\n  type: learning\n---\n\nwrangler diffs the image digest, not rollout_step_percentage:100.\n';

  it("builds a line from the harvested frontmatter — the bootstrap index needs no agent judgment", () => {
    expect(indexEntryFromFile("fleet/memory/websites--pilot/2026-08-27T17-50-08-684Z-0-a-fact.md", md)).toEqual({
      title: "2026-08-27T17-50-08-684Z-0-a-fact",
      target: "websites--pilot/2026-08-27T17-50-08-684Z-0-a-fact.md",
      archived: 0,
      summary: "wrangler diffs the image digest, not rollout_step_percentage",
    });
  });

  it("falls back to the filename and the first body line when there is no frontmatter", () => {
    const entry = indexEntryFromFile("fleet/memory/shared/hand-written.md", "grep still works when the index is stale\n");
    expect(entry.title).toBe("hand-written");
    expect(entry.summary).toBe("grep still works when the index is stale");
  });
});
