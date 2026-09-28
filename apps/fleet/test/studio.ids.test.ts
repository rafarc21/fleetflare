import { describe, it, expect } from "vitest";
import {
  buildStudioId, isIdSegment, nextFreeInstance, parseStudioId, parseStudioTarget,
} from "../src/studio/ids";

describe("parseStudioId", () => {
  it("accepts repo--role as instance 1", () => {
    expect(parseStudioId("websites--pilot")).toEqual({
      repo: "websites", role: "pilot", instance: 1, full: "websites--pilot",
    });
  });
  for (const bad of ["Websites--pilot", "websites/pilot", "a--b--c", "..--x", "websites--", "--pilot", "web%2Fsites--x", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(parseStudioId(bad)).toBeNull());
  }

  // Board #21. A studio id becomes a DNS label: container/studio-bringup.sh
  // runs `tailscale up --hostname="$STUDIO_ID"`, and `fleet ls`'s HOST column
  // is that label plus the tailnet suffix (observed:
  // `fleetflare--web-studio-8.example-tailnet.ts.net`). A dot inside the id would
  // split that label in two, so the grammar keeps refusing dots and
  // repo.ts's repoIdSegment folds them to hyphens BEFORE they reach here.
  for (const dotted of ["exampleorg.com--maestro", "demosite.life--web-studio", "a--b.c"]) {
    it(`rejects a DOT so the tailnet hostname stays one label: ${JSON.stringify(dotted)}`,
      () => expect(parseStudioId(dotted)).toBeNull());
  }
});

// Issue #269. The third segment is an instance number and nothing else, which
// is what keeps `--<n>` from ever reading as part of a hyphenated role.
describe("parseStudioId — instance suffix (#269)", () => {
  it("reads a third numeric segment as the instance number", () => {
    expect(parseStudioId("websites--pilot--2")).toEqual({
      repo: "websites", role: "pilot", instance: 2, full: "websites--pilot--2",
    });
  });

  it("keeps a hyphenated role whole at instance 1 AND at instance >= 2", () => {
    expect(parseStudioId("fleetflare--web-studio")).toEqual({
      repo: "fleetflare", role: "web-studio", instance: 1, full: "fleetflare--web-studio",
    });
    expect(parseStudioId("fleetflare--web-studio--2")).toEqual({
      repo: "fleetflare", role: "web-studio", instance: 2, full: "fleetflare--web-studio--2",
    });
    expect(parseStudioId("exampleorg-com--release-studio--11")).toEqual({
      repo: "exampleorg-com", role: "release-studio", instance: 11,
      full: "exampleorg-com--release-studio--11",
    });
  });

  // maestro is a singleton role, and wake-events.ts's maestroIdFor builds its
  // id by hand. The suffix-aware grammar must still read that id the way it
  // always did, or every webhook wake would aim at nothing.
  it("still reads a hand-built maestro id as instance 1", () => {
    expect(parseStudioId("foo--maestro")).toEqual({
      repo: "foo", role: "maestro", instance: 1, full: "foo--maestro",
    });
  });

  it("accepts a two-digit and a many-digit instance", () => {
    expect(parseStudioId("a--b--10")?.instance).toBe(10);
    expect(parseStudioId("a--b--12")?.instance).toBe(12);
    expect(parseStudioId("a--b--123")?.instance).toBe(123);
  });

  // `--1` is the SAME studio as the bare form, so accepting it would give one
  // studio two ids — two D1 rows, two DO names, two `studio:` labels.
  for (const bad of [
    "websites--pilot--1", "websites--pilot--0", "websites--pilot--01",
    "websites--pilot--02", "websites--pilot--2x", "websites--pilot--x2",
    "websites--pilot---2", "websites--pilot--2--3", "websites--pilot--",
    "websites--pilot--+2", "websites--pilot-- 2", "websites--pilot--2.0",
    "websites--pilot--1e2", "websites--web--studio--2",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(parseStudioId(bad)).toBeNull());
  }

  it("round-trips every valid id through buildStudioId unchanged", () => {
    for (const id of [
      "websites--pilot", "websites--pilot--2", "fleetflare--web-studio",
      "fleetflare--web-studio--2", "exampleorg-com--release-studio--11",
      "foo--maestro", "a--b--123", "2024--pilot--3",
    ]) {
      const parsed = parseStudioId(id);
      expect(parsed, id).not.toBeNull();
      expect(buildStudioId(parsed!)).toBe(id);
      expect(parsed!.full).toBe(id);
    }
  });
});

describe("buildStudioId", () => {
  it("omits the suffix for instance 1, absent and null alike", () => {
    expect(buildStudioId({ repo: "a", role: "web-studio" })).toBe("a--web-studio");
    expect(buildStudioId({ repo: "a", role: "web-studio", instance: 1 })).toBe("a--web-studio");
    expect(buildStudioId({ repo: "a", role: "web-studio", instance: null })).toBe("a--web-studio");
  });
  it("appends the suffix from instance 2 up", () => {
    expect(buildStudioId({ repo: "a", role: "web-studio", instance: 2 })).toBe("a--web-studio--2");
    expect(buildStudioId({ repo: "a", role: "web-studio", instance: 17 })).toBe("a--web-studio--17");
  });
});

// Issue #269's allocation rule: the LOWEST free positive instance, counting
// the bare id as 1.
describe("nextFreeInstance", () => {
  it("is 1 when the role has no studio in this repo at all", () => {
    expect(nextFreeInstance([], "websites", "pilot")).toBe(1);
    expect(nextFreeInstance(["websites--maestro", "other--pilot"], "websites", "pilot")).toBe(1);
  });
  it("is 2 when only the bare id exists", () => {
    expect(nextFreeInstance(["websites--pilot"], "websites", "pilot")).toBe(2);
  });
  it("fills the lowest HOLE rather than appending", () => {
    expect(nextFreeInstance(
      ["websites--pilot", "websites--pilot--2", "websites--pilot--4"], "websites", "pilot",
    )).toBe(3);
    expect(nextFreeInstance(["websites--pilot--2"], "websites", "pilot")).toBe(1);
    expect(nextFreeInstance(
      ["websites--pilot--2", "websites--pilot--3"], "websites", "pilot",
    )).toBe(1);
  });
  it("counts only the SAME repo and the SAME role", () => {
    expect(nextFreeInstance(
      ["other--pilot", "other--pilot--2", "websites--web-studio", "websites--web-studio--2"],
      "websites", "pilot",
    )).toBe(1);
  });
  it("is not confused by a hyphenated role that looks like a suffix of another", () => {
    expect(nextFreeInstance(["a--web-studio", "a--web-studio--2"], "a", "studio")).toBe(1);
    expect(nextFreeInstance(["a--studio", "a--web-studio--2"], "a", "web-studio")).toBe(1);
  });
  it("ignores rows whose id does not parse", () => {
    expect(nextFreeInstance(["not an id", "websites--pilot"], "websites", "pilot")).toBe(2);
  });
});

// Issue #269 item 3: `fleet task assign <n> <target>` takes three shapes. The
// ONE ambiguity — is `pilot--2` a role with an instance, or a repo "pilot"
// with a role "2"? — is resolved in favour of the instance reading, and safely:
// no fleet role is an all-digit string.
describe("parseStudioTarget", () => {
  it("reads a bare role as that role at instance 1", () => {
    expect(parseStudioTarget("pilot")).toEqual({ kind: "role", role: "pilot", instance: 1 });
    expect(parseStudioTarget("web-studio")).toEqual({ kind: "role", role: "web-studio", instance: 1 });
  });
  it("reads <role>--<k> as that role at instance k", () => {
    expect(parseStudioTarget("pilot--2")).toEqual({ kind: "role", role: "pilot", instance: 2 });
    expect(parseStudioTarget("web-studio--13")).toEqual({ kind: "role", role: "web-studio", instance: 13 });
  });
  it("normalises <role>--1 onto instance 1, the bare form", () => {
    expect(parseStudioTarget("pilot--1")).toEqual({ kind: "role", role: "pilot", instance: 1 });
  });
  it("reads a full two-segment studio id as instance 1", () => {
    expect(parseStudioTarget("websites--pilot")).toEqual({
      kind: "id", repo: "websites", role: "pilot", instance: 1,
    });
  });
  it("reads a full three-segment studio id", () => {
    expect(parseStudioTarget("websites--pilot--2")).toEqual({
      kind: "id", repo: "websites", role: "pilot", instance: 2,
    });
    expect(parseStudioTarget("fleetflare--web-studio--4")).toEqual({
      kind: "id", repo: "fleetflare", role: "web-studio", instance: 4,
    });
  });
  for (const bad of [
    "", "   ", "Pilot", "pilot--", "--pilot", "a--b--c--2", "a--b--c",
    "pilot--0", "pilot--01", "pilot---2", "websites--pilot--0",
    "websites/pilot", "demosite.life--pilot", "a--b--c--d",
  ]) {
    it(`refuses ${JSON.stringify(bad)} rather than guessing`, () => {
      expect(parseStudioTarget(bad)).toBeNull();
    });
  }
});

describe("isIdSegment", () => {
  it("accepts a folded segment and refuses the raw dotted name it came from", () => {
    expect(isIdSegment("exampleorg-com")).toBe(true);
    expect(isIdSegment("exampleorg.com")).toBe(false);
    expect(isIdSegment(undefined)).toBe(false);
  });
});
