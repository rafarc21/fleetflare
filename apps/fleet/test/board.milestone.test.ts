import { describe, it, expect } from "vitest";
import {
  BACKLOG_MILESTONE_TITLE,
  parseMilestoneGoal,
  parseMilestoneOwner,
  renderMilestoneDescription,
} from "../src/board/milestone";

// The pure milestone helpers: `fleet sprint open` writes a description these
// two functions render/read, and the backlog milestone's title is a fixed
// string so "which milestone is the backlog" is answerable without a
// convention nobody documented.

describe("BACKLOG_MILESTONE_TITLE", () => {
  it("is the fixed lowercase title, so the backlog is findable by name", () => {
    expect(BACKLOG_MILESTONE_TITLE).toBe("backlog");
  });
});

describe("renderMilestoneDescription", () => {
  it("writes owner and goal on two lines under `Owner:` and `Goal:` prefixes", () => {
    expect(renderMilestoneDescription({ owner: "websites--web-studio", goal: "Ship the board" }))
      .toBe("Owner: websites--web-studio\nGoal: Ship the board");
  });

  it("keeps the exact two-line shape even for empty strings", () => {
    expect(renderMilestoneDescription({ owner: "", goal: "" })).toBe("Owner: \nGoal: ");
  });
});

describe("parseMilestoneOwner", () => {
  it("reads the owner back out of a rendered description", () => {
    expect(parseMilestoneOwner("Owner: websites--web-studio\nGoal: Ship the board"))
      .toBe("websites--web-studio");
  });

  it("trims whitespace around the owner", () => {
    expect(parseMilestoneOwner("Owner:   websites--web-studio   \nGoal: x")).toBe("websites--web-studio");
  });

  it("returns null when the Owner line is absent", () => {
    expect(parseMilestoneOwner("Goal: Ship the board")).toBeNull();
    expect(parseMilestoneOwner("")).toBeNull();
  });

  it("does not confuse a Goal line or a substring for the Owner line", () => {
    expect(parseMilestoneOwner("Not Owner: x\nOwner: real")).toBe("real");
    expect(parseMilestoneOwner("The Owner: real was here")).toBeNull();
  });
});

describe("parseMilestoneGoal", () => {
  it("reads the goal back out of a rendered description", () => {
    expect(parseMilestoneGoal("Owner: x\nGoal: ship it")).toBe("ship it");
  });

  it("returns empty string when the Goal line is absent", () => {
    expect(parseMilestoneGoal("Owner: x")).toBe("");
  });
});