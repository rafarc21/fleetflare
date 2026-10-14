import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { getFlag, setFlag, incrementCounter, scanStateTaskKeys, flagIsSet, markEpisode, clearEpisode } from "../src/state";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("fleet_state", () => {
  it("returns null for an unset key", async () => {
    expect(await getFlag(env.DB, "paused")).toBeNull();
  });

  it("sets and overwrites", async () => {
    await setFlag(env.DB, "paused", "1", 1000);
    expect(await getFlag(env.DB, "paused")).toBe("1");
    await setFlag(env.DB, "paused", "0", 2000);
    expect(await getFlag(env.DB, "paused")).toBe("0");
  });
});

// PR #9 review, BLOCKER F1: incrementCounter is the single atomic D1
// statement ratelimit.ts's fix rests on — see its own doc comment.
describe("incrementCounter", () => {
  it("starts a fresh key at 1", async () => {
    expect(await incrementCounter(env.DB, "n", 1000)).toBe(1);
  });

  it("increments an existing key and returns the new total", async () => {
    expect(await incrementCounter(env.DB, "n", 1000)).toBe(1);
    expect(await incrementCounter(env.DB, "n", 1001)).toBe(2);
    expect(await incrementCounter(env.DB, "n", 1002)).toBe(3);
    expect(await getFlag(env.DB, "n")).toBe("3");
  });

  it("tracks each key independently", async () => {
    expect(await incrementCounter(env.DB, "a", 0)).toBe(1);
    expect(await incrementCounter(env.DB, "b", 0)).toBe(1);
    expect(await incrementCounter(env.DB, "a", 0)).toBe(2);
  });

  it("exactly `cap` of N concurrent increments on the same key see a value <= cap", async () => {
    // The atomicity proof this table's row rests on: N genuinely concurrent
    // increments against the SAME key must produce N distinct sequential
    // totals (1..N), never two callers seeing the same post-increment value.
    const n = 20;
    const results = await Promise.all(
      Array.from({ length: n }, () => incrementCounter(env.DB, "race", 0)),
    );
    expect(new Set(results).size).toBe(n);
    expect(Math.max(...results)).toBe(n);
  });
});

// #365: two callers hand-roll the "<prefix><repo>:<number>" key grammar at
// DIFFERENT depths (junior/authz.ts embeds the repo in the prefix,
// github/read-repos.ts passes the bare namespace), each with its own LIKE
// scan, startsWith re-check and digit test. These cases pin the one shared
// scanner before it exists: the LIKE-wildcard trap authz's own comment
// names, the colonless-rest depth split between the two callers, the shapes
// both reject, and the UNSORTED contract — sorting is a caller's verb.
describe("scanStateTaskKeys", () => {
  async function seed(rows: [key: string, value: string][]) {
    for (const [key, value] of rows) {
      await env.DB.prepare(`INSERT INTO fleet_state (key, value, ts) VALUES (?, ?, ?)`)
        .bind(key, value, 1).run();
    }
  }

  it("LIKE's `_` wildcard hands back a same-length decoy; the exact-prefix re-check rejects it", async () => {
    // Authz depth: the repo is IN the prefix. `we_bsite` holds an `_`, so
    // the LIKE pattern's `_` matches ANY single char — D1 returns the
    // decoy `we-bsite` row, and only the exact prefix re-check kills it.
    // A shorter decoy (`website:9`, one char less) never matches the LIKE
    // at all — `_` is exactly one char — so it would prove nothing.
    await seed([
      ["ns:acme-org/we_bsite:5", "v5"],
      ["ns:acme-org/we-bsite:9", "decoy"],
    ]);
    const rows = await scanStateTaskKeys(env.DB, "ns:acme-org/we_bsite:");
    expect(rows).toEqual([{ repo: "", number: 5, value: "v5" }]);

    // The first decoy could have died at any filter. This one passes every
    // suffix rule (bare number, digits clean) and differs from the prefix
    // only at the `_` position, so LIKE hands it back too — only the
    // exact-prefix compare can reject it.
    await seed([["ns:acme-org/wxbsite:8", "suffix-clean-decoy"]]);
    const rows2 = await scanStateTaskKeys(env.DB, "ns:acme-org/we_bsite:");
    expect(rows2).toEqual([{ repo: "", number: 5, value: "v5" }]);
  });

  it("a colonless numeric rest reads repo \"\" — grants drops it by filter, never by the scan", async () => {
    // The two callers' rules disagree on this shape: authz's prefix already
    // named the repo, so `42` is a TRUE row there; grants' bare namespace
    // makes a hand-edited `read-repos:42` one it must not read as task 42.
    // The scan itself keeps the union — which is which is a caller's depth
    // filter, not a parse rule.
    await seed([["ns:42", "v"]]);
    expect(await scanStateTaskKeys(env.DB, "ns:")).toEqual([{ repo: "", number: 42, value: "v" }]);
  });

  it("rejects a non-numeric suffix, a trailing-empty suffix, a bare non-numeric rest and an empty repo", async () => {
    await seed([
      ["ns:acme-org/repo:notanumber", "x"],
      ["ns:acme-org/repo:", "x"],
      ["ns:abc", "x"],
      ["ns::7", "x"],
    ]);
    expect(await scanStateTaskKeys(env.DB, "ns:")).toEqual([]);
  });

  it("keeps a multi-colon repo name intact, splitting at the LAST colon", async () => {
    await seed([["ns:acme-org/we:ird:5", "v"]]);
    expect(await scanStateTaskKeys(env.DB, "ns:"))
      .toEqual([{ repo: "acme-org/we:ird", number: 5, value: "v" }]);
  });

  it("passes each row's value through untouched", async () => {
    await seed([["ns:a:1", "one"], ["ns:b:2", "two"]]);
    const rows = await scanStateTaskKeys(env.DB, "ns:");
    expect(rows.map((r) => r.value)).toEqual(["one", "two"]);
  });

  it("returns rows UNSORTED, in the engine's own LIKE-return order", async () => {
    // The scan's contract is unsorted: callers own order (authz sorts
    // numerically, grants by repo localeCompare then number). Pinned against
    // the engine's return for the SAME statement the scan runs — not a
    // guessed order: D1 answers `SELECT key` alone from key's covering
    // index (sorted), but `SELECT key, value` as a rowid walk (insertion
    // order); the two statement shapes are not order-equivalent.
    await seed([["ns:b:2", "v2"], ["ns:a:1", "v1"], ["ns:c:3", "v3"]]);
    const raw = await env.DB.prepare(`SELECT key, value FROM fleet_state WHERE key LIKE ?`)
      .bind("ns:%").all<{ key: string; value: string }>();
    expect(await scanStateTaskKeys(env.DB, "ns:"))
      .toEqual([{ repo: "b", number: 2, value: "v2" },
                { repo: "a", number: 1, value: "v1" },
                { repo: "c", number: 3, value: "v3" }]);
    // The premise the equality above was written against, pinned: if the
    // engine's plan for this statement ever changes, this fails first and
    // loudly instead of the equality passing for a changed reason.
    expect(raw.results.map((r) => r.key)).toEqual(["ns:b:2", "ns:a:1", "ns:c:3"]);
  });
});

// #447 (sweep-6 F1): the three episode-marker wrappers. flagIsSet reads the
// exact "1" vocabulary every call site shares; markEpisode/clearEpisode
// write it. Absent key reads as not-set — the same null-handling getFlag's
// own contract already answers with.
describe("episode flags", () => {
  it("an absent key is not set, a \"1\" key is, a \"0\" key is not", async () => {
    expect(await flagIsSet(env.DB, "paused")).toBe(false);
    await markEpisode(env.DB, "paused", 1000);
    expect(await flagIsSet(env.DB, "paused")).toBe(true);
    await clearEpisode(env.DB, "paused", 2000);
    expect(await flagIsSet(env.DB, "paused")).toBe(false);
    expect(await getFlag(env.DB, "paused")).toBe("0");
  });

  it("markEpisode writes the literal wire value \"1\" clearEpisode resets to \"0\"", async () => {
    await markEpisode(env.DB, "k", 1000);
    expect(await getFlag(env.DB, "k")).toBe("1");
    await clearEpisode(env.DB, "k", 2000);
    expect(await getFlag(env.DB, "k")).toBe("0");
  });
});
