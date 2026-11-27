// Issue #1476 round 2 review finding: `cli/models.ts`'s `cmdModelsLs` (the
// `fleet models` STUDIO table) and `cli/fleet.ts`'s `fetchLeadAssignments`
// (the `fleet ls` ACCOUNT column / --json feed) both grew new
// resolved/stored branching the round added — `GET /studio/models`'s
// `assignments` entries went from a bare id string to
// `{ stored, resolved: string | null }` (models-route.ts's own
// resolveStaleId) — with zero test coverage of either branch. Per
// CODING_STANDARDS.md "New behavior needs a new test": one case per branch,
// for both consumers.
//
// Model: test/bun/cli.fleet-ls-infer.test.ts's "cmdLs — the wiring" describe
// — a Bun.serve stand-in for the Worker (neither function takes an
// injectable fetchImpl), console.log captured by reassignment for the
// display half, the exported function's return value asserted directly for
// the data half.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cmdModelsLs } from "../../cli/models";
import { fetchLeadAssignments, type Credentials } from "../../cli/fleet";

type Assignments = Record<string, { stored: string; resolved: string | null }>;

const CREDS_BASE: Omit<Credentials, "workerUrl"> = { accessClientId: "cid", accessClientSecret: "csecret" };

describe("GET /studio/models assignments — resolved/stored branches (#1476 round 2)", () => {
  let assignmentsAnswer: Assignments;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/studio/models") {
          return Response.json({ models: [], assignments: assignmentsAnswer });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  function creds(): Credentials {
    return { workerUrl: server.url.toString(), ...CREDS_BASE };
  }

  /** Captures cmdModelsLs's stdout lines (the table is several console.log
   *  calls) — same reassignment-capture the INFER wiring suite uses. */
  async function lsLines(): Promise<string[]> {
    const out: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
    try {
      await cmdModelsLs(creds());
    } finally {
      console.log = realLog;
    }
    return out;
  }

  describe("cmdModelsLs — the STUDIO table's MODEL cell", () => {
    test("stored === resolved: the bare id, no suffix", async () => {
      assignmentsAnswer = { "websites--pilot": { stored: "@cf/meta/glm-5.3", resolved: "@cf/meta/glm-5.3" } };
      const lines = await lsLines();
      expect(lines).toContain(`${"websites--pilot".padEnd(33)} @cf/meta/glm-5.3`);
    });

    test("a stale pin (resolved !== stored, resolved non-null): '<resolved> (was <stored>)'", async () => {
      assignmentsAnswer = {
        "websites--pilot": { stored: "@cf/moonshotai/kimi-k2.7-code", resolved: "@cf/qwen/qwen3.8-27b" },
      };
      const lines = await lsLines();
      expect(lines).toContain(
        `${"websites--pilot".padEnd(33)} @cf/qwen/qwen3.8-27b (was @cf/moonshotai/kimi-k2.7-code)`,
      );
    });

    test("resolved === null (genuinely unresolvable): '<stored> (unresolved)'", async () => {
      assignmentsAnswer = { "websites--pilot": { stored: "@cf/some/typo-id", resolved: null } };
      const lines = await lsLines();
      expect(lines).toContain(`${"websites--pilot".padEnd(33)} @cf/some/typo-id (unresolved)`);
    });
  });

  describe("fetchLeadAssignments — the Record<studio, string> degrade (#1476 round 2)", () => {
    test("stored === resolved: the record carries the bare id", async () => {
      assignmentsAnswer = { "websites--pilot": { stored: "@cf/meta/glm-5.3", resolved: "@cf/meta/glm-5.3" } };
      const out = await fetchLeadAssignments(creds());
      expect(out).toEqual({ "websites--pilot": "@cf/meta/glm-5.3" });
    });

    test("a stale pin: the record carries the RESOLVED id, not the stale stored one", async () => {
      assignmentsAnswer = {
        "websites--pilot": { stored: "@cf/moonshotai/kimi-k2.7-code", resolved: "@cf/qwen/qwen3.8-27b" },
      };
      const out = await fetchLeadAssignments(creds());
      expect(out).toEqual({ "websites--pilot": "@cf/qwen/qwen3.8-27b" });
    });

    test("resolved === null: the record falls back to stored, so leadModelOf still has a string", async () => {
      assignmentsAnswer = { "websites--pilot": { stored: "@cf/some/typo-id", resolved: null } };
      const out = await fetchLeadAssignments(creds());
      expect(out).toEqual({ "websites--pilot": "@cf/some/typo-id" });
    });
  });
});
