// #1080: one git bundle per run, built by one leg, read by every other leg.
// Pure pieces only: key shape, leg plan, leg request/outbound props, the
// outbound allow-list for the bundle key, and the non-fatal bundle step.
import { describe, it, expect } from "bun:test";
import { bundleKeyFor, planBundleLeg, type PlannedLeg } from "../../src/gate/fanout";
import { BUNDLE_LEG, buildLegEnvVars, gateOutboundProps } from "../../src/gate/leg-env";
import { bundleStepEnabled, legRequest, runBundleStep, type BundleStepRunner } from "../../src/gate/leg-run";
import { parseLegs } from "../../src/gate/config";
import {
  GATE_R2_HOST,
  MAX_BUNDLE_BYTES,
  handleGateOutbound,
  resolveOutboundTarget,
  type GateOutboundProps,
  type OutboundBucket,
} from "../../src/gate/outbound-handler";

const HEAD = "f".repeat(40);
const BASE = "a".repeat(40);
const BUNDLE_KEY = `gate-bundles/acme/example/run-a/${HEAD}.bundle`;
const OTHER_BUNDLE_KEY = `gate-bundles/acme/example/run-b/${HEAD}.bundle`;
const RUN_KEY = "gate/acme/example/runs/7/run-a/shard-lint.json";

/** A planned ordinary leg: the shape fanout.ts hands to legRequest. */
const LEG: PlannedLeg = {
  leg: "lint", commit: `${BASE}..${HEAD}`, installCmd: "bun install", legCmd: "bun run lint",
  resultKey: RUN_KEY, baselineKeys: [],
};

describe("bundleKeyFor (#1080: keyed by run and head sha, under a top-level prefix)", () => {
  it("names the bundle under gate-bundles, the repo, the run and the head sha", () => {
    expect(bundleKeyFor("acme", "example", "run-a", HEAD)).toBe(BUNDLE_KEY);
  });
  it("sits outside the gate/ prefix, so a bucket lifecycle rule can expire it", () => {
    expect(bundleKeyFor("acme", "example", "run-a", HEAD).startsWith("gate/")).toBe(false);
  });
});

describe("planBundleLeg (#1080: the one leg that builds the bundle)", () => {
  it("is a leg named bundle, over the base..head range, with its own result key and no install or test command", () => {
    const planned = planBundleLeg({ owner: "acme", repo: "example", pr: 7, runId: "run-a", headSha: HEAD, baseSha: BASE });
    expect(planned).toEqual({
      leg: BUNDLE_LEG, commit: `${BASE}..${HEAD}`, installCmd: "", legCmd: "",
      resultKey: "gate/acme/example/runs/7/run-a/shard-bundle.json", baselineKeys: [], timeoutMin: 5,
    });
  });
});

describe("leg request and leg env carry the run's bundle key (#1080)", () => {
  it("a leg with a bundle key gets GATE_BUNDLE_KEY in its container env", () => {
    const body = legRequest("acme", "example", LEG, { baseRef: "main", pr: "7", private: false, bundleKey: BUNDLE_KEY });
    expect(buildLegEnvVars(body).GATE_BUNDLE_KEY).toBe(BUNDLE_KEY);
  });

  it("a leg with no bundle key gets no GATE_BUNDLE_KEY, so it clones as before", () => {
    const body = legRequest("acme", "example", LEG, { baseRef: "main", pr: "7", private: false });
    expect(buildLegEnvVars(body)).not.toHaveProperty("GATE_BUNDLE_KEY");
  });

  it("an ordinary leg's outbound props read the run's bundle, and cannot write it", () => {
    const body = legRequest("acme", "example", LEG, { baseRef: "main", pr: "7", private: false, bundleKey: BUNDLE_KEY });
    expect(gateOutboundProps(body)).toEqual({ resultKey: RUN_KEY, bundleKey: BUNDLE_KEY });
  });

  it("the bundle leg's outbound props may write the run's bundle key, and only that one", () => {
    const planned = planBundleLeg({ owner: "acme", repo: "example", pr: 7, runId: "run-a", headSha: HEAD, baseSha: BASE });
    const body = legRequest("acme", "example", planned, { baseRef: "main", pr: "7", private: false, bundleKey: BUNDLE_KEY });
    expect(gateOutboundProps(body)).toEqual({
      resultKey: planned.resultKey, bundleKey: BUNDLE_KEY, bundleWriter: true,
    });
  });

  it("a leg with no bundle key gets no bundle props at all", () => {
    const body = legRequest("acme", "example", LEG, { baseRef: "main", pr: "7", private: false });
    expect(gateOutboundProps(body)).toEqual({ resultKey: RUN_KEY });
  });
});

describe("resolveOutboundTarget: the bundle key allow-list (#1080)", () => {
  it("allows the run's bundle key, keyed by a 40-hex head sha", () => {
    expect(resolveOutboundTarget(`/${BUNDLE_KEY}`)).toEqual({ bucket: "STUDIO_ARCHIVE", key: BUNDLE_KEY });
  });

  it("refuses a bundle key whose last segment is not a 40-hex sha", () => {
    expect(resolveOutboundTarget("/gate-bundles/acme/example/run-a/main.bundle")).toBeNull();
    expect(resolveOutboundTarget(`/gate-bundles/acme/example/run-a/${HEAD}0.bundle`)).toBeNull();
  });

  it("refuses a bundle key that climbs out of its run", () => {
    expect(resolveOutboundTarget("/gate-bundles/acme/example/../../baselines/x.bundle")).toBeNull();
  });

  it("refuses the old gate/ bundle path, so no key outside the new prefix is ever a bundle", () => {
    expect(resolveOutboundTarget(`/gate/acme/example/bundles/run-a/${HEAD}.bundle`)).toBeNull();
  });
});

/** The outbound bucket in memory: enough for the bundle rules. */
function fakeBucket(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const bucket: OutboundBucket = {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : { body: new Response(v).body, size: v.length };
    },
    async head(key) {
      const v = store.get(key);
      return v === undefined ? null : { size: v.length };
    },
    async put(key, value, opts) {
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && store.has(key)) return null;
      store.set(key, await new Response(value).text());
      return { key };
    },
  };
  return { bucket, store };
}

const r2 = (method: string, key: string, body?: string, headers?: Record<string, string>) =>
  new Request(`http://${GATE_R2_HOST}/${key}`, { method, body, headers });

const LEG_PROPS: GateOutboundProps = { resultKey: RUN_KEY, bundleKey: BUNDLE_KEY };
const BUILDER_PROPS: GateOutboundProps = { resultKey: RUN_KEY, bundleKey: BUNDLE_KEY, bundleWriter: true };

describe("bundle GET and PUT are scoped to the run (#1080)", () => {
  it("a leg reads its own run's bundle", async () => {
    const { bucket } = fakeBucket({ [BUNDLE_KEY]: "PACK" });
    const res = await handleGateOutbound(r2("GET", BUNDLE_KEY), bucket, LEG_PROPS);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PACK");
  });

  it("a missing bundle is a 404, so the leg falls back to cloning", async () => {
    const { bucket } = fakeBucket();
    expect((await handleGateOutbound(r2("GET", BUNDLE_KEY), bucket, LEG_PROPS)).status).toBe(404);
  });

  it("a leg with no bundle key in its props cannot read a bundle: 403", async () => {
    const { bucket } = fakeBucket({ [BUNDLE_KEY]: "PACK" });
    expect((await handleGateOutbound(r2("GET", BUNDLE_KEY), bucket, { resultKey: RUN_KEY })).status).toBe(403);
  });

  it("a leg cannot read another run's bundle", async () => {
    const { bucket } = fakeBucket({ [OTHER_BUNDLE_KEY]: "PACK" });
    expect((await handleGateOutbound(r2("GET", OTHER_BUNDLE_KEY), bucket, LEG_PROPS)).status).toBe(403);
  });

  it("only the bundle leg writes the bundle, once (201, then 412)", async () => {
    const { bucket, store } = fakeBucket();
    const first = await handleGateOutbound(r2("PUT", BUNDLE_KEY, "PACK"), bucket, BUILDER_PROPS);
    expect(first.status).toBe(201);
    expect(store.get(BUNDLE_KEY)).toBe("PACK");
    expect((await handleGateOutbound(r2("PUT", BUNDLE_KEY, "PACK2"), bucket, BUILDER_PROPS)).status).toBe(412);
  });

  it("an ordinary leg cannot write the bundle, even with its bundle key: 403, bucket untouched", async () => {
    const { bucket, store } = fakeBucket();
    expect((await handleGateOutbound(r2("PUT", BUNDLE_KEY, "PACK"), bucket, LEG_PROPS)).status).toBe(403);
    expect(store.has(BUNDLE_KEY)).toBe(false);
  });

  it("the builder cannot write another run's bundle: 403", async () => {
    const { bucket, store } = fakeBucket();
    expect((await handleGateOutbound(r2("PUT", OTHER_BUNDLE_KEY, "PACK"), bucket, BUILDER_PROPS)).status).toBe(403);
    expect(store.has(OTHER_BUNDLE_KEY)).toBe(false);
  });

  it("a bundle over the size cap is refused before it is buffered: 413", async () => {
    const { bucket, store } = fakeBucket();
    const res = await handleGateOutbound(
      r2("PUT", BUNDLE_KEY, "PACK", { "content-length": String(MAX_BUNDLE_BYTES + 1) }), bucket, BUILDER_PROPS,
    );
    expect(res.status).toBe(413);
    expect(store.has(BUNDLE_KEY)).toBe(false);
  });
});

describe("the bundle leg name is reserved (#1080: a gate block leg named bundle would share its result key)", () => {
  it("a gate block that names a leg bundle is rejected, so it cannot shadow the bundle step's result", () => {
    expect(parseLegs(["bundle"])).toBeNull();
    expect(parseLegs([{ name: "bundle", cmd: "exit 1" }])).toBeNull();
  });

  it("other leg names still parse", () => {
    expect(parseLegs(["lint"])).toEqual([{ name: "lint", cmd: "bun run lint" }]);
  });
});

describe("bundleStepEnabled: the bundle step is behind a flag, default off (#1080 deploy skew)", () => {
  it("is off when the flag is unset, so an old gate image never sees a bundle leg", () => {
    expect(bundleStepEnabled(undefined)).toBe(false);
    expect(bundleStepEnabled("")).toBe(false);
  });

  it("is on only for the exact value 1", () => {
    expect(bundleStepEnabled("1")).toBe(true);
    expect(bundleStepEnabled("true")).toBe(false);
  });
});

describe("runBundleStep: the bundle step never fails the run (#1080)", () => {
  /** A step runner that just runs the callback and records each step name and config. */
  function fakeStep() {
    const names: string[] = [];
    const configs: { retries: { limit: number } }[] = [];
    const step: BundleStepRunner = {
      do: async (name, config, fn) => { names.push(name); configs.push(config); return fn(); },
    };
    return { step, names, configs };
  }
  const PLANNED = planBundleLeg({ owner: "acme", repo: "example", pr: 7, runId: "run-a", headSha: HEAD, baseSha: BASE });

  it("reports the bundle built when the bundle leg answers 200 with state success", async () => {
    const { step, names } = fakeStep();
    const built = await runBundleStep(step, async () => Response.json({ state: "success" }), PLANNED);
    expect(built).toBe(true);
    expect(names).toEqual(["build-bundle"]);
  });

  it("reports no bundle when the bundle leg answers 200 with state error (the DO answers 200 for a leg error)", async () => {
    const { step } = fakeStep();
    const built = await runBundleStep(step, async () => Response.json({ state: "error", description: "bundle failed" }), PLANNED);
    expect(built).toBe(false);
  });

  it("is never retried: one attempt, then the legs clone", async () => {
    const { step, configs } = fakeStep();
    await runBundleStep(step, async () => new Response("{}", { status: 503 }), PLANNED);
    expect(configs[0].retries.limit).toBe(0);
  });

  it("reports no bundle when the bundle leg answers 503, and does not throw", async () => {
    const { step } = fakeStep();
    const built = await runBundleStep(step, async () => new Response("{}", { status: 503 }), PLANNED);
    expect(built).toBe(false);
  });

  it("reports no bundle when the dispatch itself throws, and does not throw", async () => {
    const { step } = fakeStep();
    const built = await runBundleStep(step, async () => { throw new Error("DO unreachable"); }, PLANNED);
    expect(built).toBe(false);
  });
});
