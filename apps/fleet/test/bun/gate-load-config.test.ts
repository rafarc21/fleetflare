// #715: where a PR's gate config comes from. The fleet repo's `gates` map wins;
// otherwise the PR repo's OWN root fleet.json `gate` block, read at the PR base
// sha. Never the PR head: a PR must not be able to edit its own gate.
import { describe, it, expect } from "bun:test";
import { loadGateConfig, type FleetJsonReader } from "../../src/gate/load-config";

const FLEET = "acme/fleet";
const PR_REPO = "acme/example";
const BASE = "b".repeat(40);
const BLOCK = { install: "x", legs: ["lint"], vitestCmd: "t", pathRules: ["a/**"] };

/** A reader over an in-memory repo map. Records every (repo, ref) it is asked for.
 *  A missing file reads null, the same as a malformed one. */
function reader(files: Record<string, Record<string, unknown>>) {
  const calls: { repo: string; ref: string }[] = [];
  const read: FleetJsonReader = async (repo, ref) => {
    calls.push({ repo, ref });
    return files[`${repo}@${ref}`] ?? null;
  };
  return { read, calls };
}

const input = { repo: PR_REPO, fleetRepo: FLEET, baseSha: BASE };

describe("loadGateConfig: lookup order", () => {
  it("the fleet repo's gates map entry wins, and the PR repo is never read", async () => {
    const r = reader({
      [`${FLEET}@HEAD`]: { gates: { [PR_REPO]: { ...BLOCK, vitestCmd: "mapped" } } },
      [`${PR_REPO}@${BASE}`]: { gate: { ...BLOCK, vitestCmd: "own-block" } },
    });
    const cfg = await loadGateConfig(input, r.read);
    expect(cfg?.vitestCmd).toBe("mapped");
    expect(r.calls.some((c) => c.repo === PR_REPO)).toBe(false);
  });

  it("the map key matches the PR repo case-insensitively", async () => {
    const r = reader({ [`${FLEET}@HEAD`]: { gates: { "Acme/Example": { ...BLOCK, vitestCmd: "m" } } } });
    expect((await loadGateConfig(input, r.read))?.vitestCmd).toBe("m");
  });

  it("no map entry -> the PR repo's own root fleet.json gate block, read at baseSha", async () => {
    const r = reader({
      [`${FLEET}@HEAD`]: { gates: {} },
      [`${PR_REPO}@${BASE}`]: { gate: { ...BLOCK, vitestCmd: "own" } },
    });
    const cfg = await loadGateConfig(input, r.read);
    expect(cfg?.vitestCmd).toBe("own");
    expect(r.calls).toEqual([
      { repo: FLEET, ref: "HEAD" },
      { repo: PR_REPO, ref: BASE },
    ]);
  });

  it("the PR repo's block is fetched at the base sha, never at HEAD", async () => {
    const r = reader({ [`${FLEET}@HEAD`]: {}, [`${PR_REPO}@${BASE}`]: { gate: BLOCK } });
    await loadGateConfig(input, r.read);
    const own = r.calls.filter((c) => c.repo === PR_REPO);
    expect(own).toEqual([{ repo: PR_REPO, ref: BASE }]);
    expect(own.some((c) => c.ref === "HEAD")).toBe(false);
  });

  it("the fleet repo with no map entry reads its own block at baseSha, not HEAD", async () => {
    const r = reader({ [`${FLEET}@HEAD`]: {}, [`${FLEET}@${BASE}`]: { gate: { ...BLOCK, vitestCmd: "fleet" } } });
    const cfg = await loadGateConfig({ repo: FLEET, fleetRepo: FLEET, baseSha: BASE }, r.read);
    expect(cfg?.vitestCmd).toBe("fleet");
    expect(r.calls.filter((c) => c.repo === FLEET).map((c) => c.ref)).toEqual(["HEAD", BASE]);
  });

  it("a gates entry in the PR repo's own fleet.json is ignored: only the fleet repo's map counts", async () => {
    const r = reader({
      [`${FLEET}@HEAD`]: {},
      [`${PR_REPO}@${BASE}`]: { gates: { [PR_REPO]: { ...BLOCK, vitestCmd: "self-declared" } } },
    });
    expect(await loadGateConfig(input, r.read)).toBeNull();
  });
});

describe("loadGateConfig: skip (null)", () => {
  it("the PR repo has no fleet.json at the base sha -> null", async () => {
    const r = reader({ [`${FLEET}@HEAD`]: {} });
    expect(await loadGateConfig(input, r.read)).toBeNull();
  });

  it("the PR repo's fleet.json has no gate block -> null", async () => {
    const r = reader({ [`${FLEET}@HEAD`]: {}, [`${PR_REPO}@${BASE}`]: { roles: ["pilot"] } });
    expect(await loadGateConfig(input, r.read)).toBeNull();
  });

  it("the PR repo's gate block is malformed -> null", async () => {
    const r = reader({ [`${FLEET}@HEAD`]: {}, [`${PR_REPO}@${BASE}`]: { gate: { install: "x" } } });
    expect(await loadGateConfig(input, r.read)).toBeNull();
  });

  it("a malformed map entry is null and never falls through to the PR repo's block", async () => {
    const r = reader({
      [`${FLEET}@HEAD`]: { gates: { [PR_REPO]: { install: "x" } } },
      [`${PR_REPO}@${BASE}`]: { gate: BLOCK },
    });
    expect(await loadGateConfig(input, r.read)).toBeNull();
    expect(r.calls.some((c) => c.repo === PR_REPO)).toBe(false);
  });

  it("an unreadable fleet repo fleet.json (malformed) -> null, and the PR repo is never read", async () => {
    const r = reader({ [`${PR_REPO}@${BASE}`]: { gate: BLOCK } });
    expect(await loadGateConfig(input, r.read)).toBeNull();
    expect(r.calls.some((c) => c.repo === PR_REPO)).toBe(false);
  });
});
