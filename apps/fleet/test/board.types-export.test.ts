import { describe, it, expect } from "vitest";
import * as boardTypes from "../src/board/types";

// The module surface is a contract; exports with no reader are drift.
// isBacklog and BACKLOG_STALE_MS are file-internal by design.
describe("board/types module surface", () => {
  it("keeps isBacklog and BACKLOG_STALE_MS off the export surface", () => {
    const surface = boardTypes as Record<string, unknown>;
    expect(surface.isBacklog).toBeUndefined();
    expect(surface.BACKLOG_STALE_MS).toBeUndefined();
  });
});
