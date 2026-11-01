import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRoleFile, roleBringupEnv } from "../../src/studio/blueprint";
import { parseStudioFile, studioBringupEnv } from "../../src/studio/studio-blueprint";

// Issue #1463: pin `effort: high` on the pilot role and the web-studio
// studio, so a lead launches with `--effort high` regardless of claude's
// own CLI default drift. Read the real shipped files (same technique as
// bringup-mcp-config.test.ts), not synthetic fixtures.
const BLUEPRINT = join(import.meta.dir, "../../../../fleet/blueprint");

describe("effort pin — issue #1463", () => {
  test("pilot role parses effort high and roleBringupEnv emits ROLE_EFFORT=high", () => {
    const pilot = parseRoleFile(readFileSync(join(BLUEPRINT, "roles", "pilot.md"), "utf8"));
    expect(pilot.effort).toBe("high");
    expect(roleBringupEnv(pilot).ROLE_EFFORT).toBe("high");
  });

  test("web-studio parses effort high and studioBringupEnv emits ROLE_EFFORT=high", () => {
    const web = parseStudioFile(readFileSync(join(BLUEPRINT, "studios", "web-studio", "studio.md"), "utf8"));
    expect(web.effort).toBe("high");
    expect(studioBringupEnv(web, []).ROLE_EFFORT).toBe("high");
  });

  test("release-studio and maestro stay unpinned — no effort frontmatter, empty ROLE_EFFORT", () => {
    const release = parseStudioFile(readFileSync(join(BLUEPRINT, "studios", "release-studio", "studio.md"), "utf8"));
    const maestro = parseStudioFile(readFileSync(join(BLUEPRINT, "studios", "maestro", "studio.md"), "utf8"));
    expect(release.effort).toBeUndefined();
    expect(maestro.effort).toBeUndefined();
  });
});