// #1144 (refs #715): a status text names its run by the full run id, so
// `fleet gate watch` is handed an id the status route can look up. A reply
// that is not JSON prints one line naming the HTTP status, never raw HTML.
import { describe, it, expect } from "bun:test";
import { pendingStatusArgs, verdictToStatusArgs } from "../../src/gate/fanout";
import { rerunStatusArgs } from "../../src/gate/infra-rerun";
import { gateServiceErrorLine } from "../../cli/gate";
import type { LegResult } from "../../src/gate/verdict";

// The shape the Workflow instance ids take (gate-<repoKey>-<sha>, rerun-<id>).
const RUN = `gate-0123456789abcdef-${"a".repeat(40)}`;
const RERUN = `rerun-${RUN}`;
const green = (leg: string): LegResult => ({ leg, state: "success" });
const red = (leg: string): LegResult => ({ leg, state: "failure", description: "exit 1" });

describe("status texts name the run by its full id (#1144)", () => {
  it("the run-start status carries the full run id, not an 8-char cut", () => {
    expect(pendingStatusArgs(RUN, 3).description).toBe(`running (run ${RUN}) — 3 legs`);
  });

  it("an all-green roster carries the full run id", () => {
    const args = verdictToStatusArgs({ state: "success" }, { expected: ["lint"], results: [green("lint")], runId: RUN });
    expect(args.description).toBe(`1/1 green (run ${RUN})`);
  });

  it("a red roster carries the full run id after the leg list", () => {
    const args = verdictToStatusArgs(
      { state: "failure", description: "x" },
      { expected: ["lint", "bun-1"], results: [green("lint"), red("bun-1")], runId: RUN },
    );
    expect(args.description).toBe(`1/2 green; red: bun-1 (run ${RUN})`);
  });

  it("a rerun's status names the rerun id in full, so it never shares the first run's tag", () => {
    expect(rerunStatusArgs(RERUN).description).toBe(`rerun after infra error (run ${RERUN})`);
    expect(rerunStatusArgs(RERUN).description).not.toBe(rerunStatusArgs(RUN).description);
  });

  it("the tag an operator copies from a status text is the run id the status route looks up", () => {
    const description = pendingStatusArgs(RERUN, 4).description;
    const copied = /\(run (\S+?)\)/.exec(description)?.[1];
    expect(copied).toBe(RERUN);
  });

  it("a long red roster still fits GitHub's 140-char limit and ends with the full run id", () => {
    const expected = Array.from({ length: 12 }, (_, i) => `vitest-${i + 1}-with-a-long-name`);
    const args = verdictToStatusArgs(
      { state: "failure", description: "x" },
      { expected, results: expected.map((l) => red(l)), runId: RUN },
    );
    expect(args.description.length).toBeLessThanOrEqual(140);
    expect(args.description.endsWith(`(run ${RUN})`)).toBe(true);
  });
});

describe("gateServiceErrorLine: a non-JSON reply prints one line, never raw HTML (#1144)", () => {
  it("a Cloudflare HTML error page names the HTTP status and the gate service error", () => {
    const html = "<!DOCTYPE html><html><body>Error 1101</body></html>";
    expect(gateServiceErrorLine(530, html)).toBe("fleet gate-watch: HTTP 530 gate service error (non-JSON reply)");
  });

  it("a JSON error from the route names its error text", () => {
    expect(gateServiceErrorLine(404, JSON.stringify({ error: "no such gate run", runId: "rerun-ga" })))
      .toBe("fleet gate-watch: HTTP 404 gate service error: no such gate run");
  });

  it("the line never carries the raw body, so no HTML reaches the terminal", () => {
    const line = gateServiceErrorLine(502, "<!DOCTYPE html><html>" + "x".repeat(500));
    expect(line).not.toContain("<");
    expect(line.length).toBeLessThan(200);
  });
});
