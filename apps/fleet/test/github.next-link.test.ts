import { describe, it, expect } from "vitest";
import { nextPageLink } from "../src/github/next-link";

// Board issue #362: one shared RFC 8288 rel="next" Link-header parser,
// replacing the two hand-rolled copies that used to live in
// board/api.ts and github/api.ts. Golden table — every case answers for
// BOTH old copies (characterized 2026-10-11), except the empty-URL case,
// where the old board copy returned "" and github's returned null; the
// shared module unifies on null (fail closed — an empty next URL
// is a link that cannot be followed, so the walk ends, same posture
// as the board caller's off-host check).

describe("nextPageLink", () => {
  it("returns null for a null header (no Link header at all)", () => {
    expect(nextPageLink(null)).toBe(null);
  });

  it("pulls the URL out of a single next entry", () => {
    expect(
      nextPageLink('<https://api.github.com/repos/o/r/issues?per_page=100&page=2>; rel="next"'),
    ).toBe("https://api.github.com/repos/o/r/issues?per_page=100&page=2");
  });

  it("finds next when it is the first of several entries", () => {
    expect(
      nextPageLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
    ).toBe("https://api.github.com/x?page=2");
  });

  it("finds next when it is the last of several entries", () => {
    expect(
      nextPageLink('<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"'),
    ).toBe("https://api.github.com/x?page=3");
  });

  it("returns null on the last page (prev/last only)", () => {
    expect(
      nextPageLink('<https://api.github.com/x?page=4>; rel="prev", <https://api.github.com/x?page=5>; rel="last"'),
    ).toBe(null);
  });

  it("returns null for an entry with no rel at all", () => {
    expect(nextPageLink("<https://api.github.com/x?page=2>")).toBe(null);
  });

  it("does not match the unquoted rel form", () => {
    expect(nextPageLink("<https://api.github.com/x?page=2>; rel=next")).toBe(null);
  });

  it("returns null when only rel=\"prev\" is present", () => {
    expect(nextPageLink('<https://api.github.com/x?page=1>; rel="prev"')).toBe(null);
  });

  it("returns null for an empty URL in the next entry — fail closed, a link that cannot be followed is never followed", () => {
    expect(nextPageLink('<>; rel="next"')).toBe(null);
  });

  it("does not match a longer rel token like nextpage", () => {
    expect(nextPageLink('<https://api.github.com/x>; rel="nextpage"')).toBe(null);
  });

  it("does not match when rel comes after another parameter", () => {
    expect(nextPageLink('<https://api.github.com/x>; title="x"; rel="next"')).toBe(null);
  });

  it("requires the rel value to be exactly next, not a token list", () => {
    expect(nextPageLink('<https://api.github.com/x>; rel="next prev"')).toBe(null);
  });

  it("tolerates whitespace around the entry", () => {
    expect(
      nextPageLink('  <https://api.github.com/x?page=2>  ;  rel="next"  '),
    ).toBe("https://api.github.com/x?page=2");
  });

  it("returns null for an empty header string", () => {
    expect(nextPageLink("")).toBe(null);
  });

  it("returns null when there are no angle brackets at all", () => {
    expect(nextPageLink('https://api.github.com/x; rel="next"')).toBe(null);
  });
});
