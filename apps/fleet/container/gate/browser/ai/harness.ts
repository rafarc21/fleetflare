// apps/fleet/container/gate/browser/ai/harness.ts
//
// AI-leg harness for the gate (board #1345). A gate "AI leg" runs a consumer
// repo's AI-driven spec against a REAL model and must fail the run on a REAL
// regression, so the harness never trusts prose: a case declares the model
// calls it will make (>=3 distinct input phrasings), the structural checks it
// asserts on the response, and the red chips (refusal/error phrasing) that mark
// a failed call.
//
// Guards, each fail-closed:
//   1. N/N repeats — every run must pass (each input phrasing, `repeat` times,
//      default 3). One red run makes the case red. A non-integer or non-finite
//      repeat is a config error, never a silent zero-run green.
//   2. Red-chip detectors — any hit in a model's visible text marks that run
//      red. Configurable per repo; localized detectors (Portuguese) come from
//      config, never the English default. Chips and structural asserts are both
//      evaluated: a model that apologises its way out of a missing tool call
//      fails on the chip even when the structure happens to hold.
//   3. Negative-control self-test — `expectRedChip` declares a chip the case
//      REQUIRES to fire (the model is expected to refuse). The run passes only
//      when the named chip IS detected, so a detector that regresses turns the
//      case red instead of green.
//   4. A thrown run or per-attempt timeout — red, never swallowed.
//   5. Missing AI secret — RED "AI DID-NOT-RUN", never a skipped-green. No
//      environment means no result, not a pass.
//   6. Floor mode — when the real route is blocked, the leg routes to a
//      Workers AI stand-in model instead of failing. Floor works WITHOUT a real
//      secret and marks its result `floor: true`, visibly distinct from a real
//      green. Blocked with no stand-in is DID-NOT-RUN.
//
// Pure TypeScript, no Worker bindings, no network: the transport (`RunModel`)
// and the environment are injected, so bun test drives every guard without a
// real model or a real secret.

/** One model turn the harness drives. `run` does the real call; tests inject a stub. */
export interface RunModel {
  /** Visible assistant text from the call (the prose the chips scan). */
  text: string;
  /** Structural blocks: tool calls, thinking, results. Assertions read these,
   *  never `text`. */
  toolCalls?: Array<{ name: string; input?: unknown }>;
  thinking?: string;
}

/** What a runner needs to know about the call it is making: which model id, and
 *  whether it is a floor-mode stand-in run. */
export interface RunContext {
  modelId: string;
  floor: boolean;
}

/** A model-turn transport. Returns the model's response, or throws a
 *  `ModelUnavailable` when no model is reachable (missing secret, blocked
 *  route). A generic throw is a red run, not a transport failure. */
export interface ModelRunner {
  run(input: unknown, ctx: RunContext): Promise<RunModel>;
}

/** Thrown by a runner when no model is reachable (missing secret, blocked route).
 *  Distinct from a generic throw: this is infra, and ends the case as
 *  DID-NOT-RUN rather than a failed run. */
export class ModelUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ModelUnavailable";
  }
}

/** A per-attempt timeout: the runner did not return in time. A failed run. */
class AITimeout extends Error {
  constructor() {
    super("AI attempt timed out");
    this.name = "AITimeout";
  }
}

/** One structural assert on a model response. `path` names the field it reads
 *  (`"toolCalls"`, `"thinking"`, `"toolCalls.0.name"`), so a failure message
 *  names the structure that failed, never a prose paraphrase. */
export interface StructuralAssert {
  path: string;
  /** Assertion predicate. Return false to fail the run. */
  check: (model: RunModel) => boolean;
  /** Why this must hold; carried into the failure description. */
  reason: string;
}

/** One red-chip detector. `match` returns true when the visible text carries
 *  the chip. Configured per repo, so a consumer can add its own refusal phrase. */
export interface RedChipDetector {
  name: string;
  match: (text: string) => boolean;
}

/** Default red-chip detectors: the English refusal shapes plus the Portuguese
 *  refusal phrase the task names (detector below). A consumer repo overrides
 *  or extends this set on the case (`redChips`); the default is a config, not
 *  the only answer. */
export function defaultRedChipDetectors(): RedChipDetector[] {
  return [
    { name: "couldnt", match: (t) => /couldn['’]?t/i.test(t) },
    { name: "something-went-wrong", match: (t) => /Something went wrong/i.test(t) },
    { name: "unable-to", match: (t) => /\bunable to\b|\bnot able to\b/i.test(t) },
    { name: "nao-consegui", match: (t) => /Não\s*consegui/i.test(t) }, // english-check: allow
  ];
}

/** The leg environment. `realModelSecret` proves a real model is reachable;
 *  `standInModel` is the floor-mode stand-in id; `realRouteBlocked` is floor
 *  mode's switch. */
export interface AIEnv {
  realModelId?: string;
  realModelSecret?: string;
  standInModel?: string;
  realRouteBlocked?: boolean;
}

export interface AICase {
  /** Case name, echoed in the result. */
  name: string;
  /** Input phrasings (>=3 distinct) — phrasing variety catches regressions a
   *  single prompt misses. */
  inputs: unknown[];
  /** Repeats per input phrasing. Default 3; must be an integer >= 1. */
  repeat?: number;
  /** Structural asserts that must all hold on every run. */
  asserts: StructuralAssert[];
  /** Red-chip detectors for this case. Defaults to `defaultRedChipDetectors()`. */
  redChips?: RedChipDetector[];
  /** Negative-control self-test: a chip name the case REQUIRES to fire. */
  expectRedChip?: string;
  /** Floor-mode input override; defaults to `inputs`. */
  standInInputs?: unknown[];
  /** Per-attempt timeout in ms. Absent means no timeout. */
  timeoutMs?: number;
}

/** One turn in the consumer evidence schema `ai.turns[]`. */
export interface AITurn {
  prompt: unknown;
  reply: string;
  chips: string[];
  floor: boolean;
}

/** One red run. */
export interface FailedAttempt {
  /** 1-based across all runs. */
  attempt: number;
  /** Which input phrasing this run used. */
  inputIndex: number;
  failedAsserts: string[];
  chipsHit: string[];
  /** Set when `expectRedChip` was declared but did not fire. */
  missingRedChip?: string;
  /** A generic throw's message, if the runner threw. */
  thrown?: string;
  timedOut?: boolean;
}

export interface AICaseResult {
  status: "green" | "red";
  /** Red only. */
  description?: string;
  /** True when the red is a DID-NOT-RUN (no secret, no stand-in, no model). */
  didNotRun: boolean;
  /** True when a floor stand-in ran (visibly distinct from a real green). */
  floor: boolean;
  /** Planned runs: inputs.length * repeat. */
  totalRuns: number;
  /** Runs actually executed (less than totalRuns on a DID-NOT-RUN). */
  attempts: number;
  /** Runs that passed. Green iff passed === totalRuns. */
  passed: number;
  /** Consumer evidence schema `ai.turns`. */
  turns: AITurn[];
  /** Red runs, in order. */
  failed?: FailedAttempt[];
}

/** The floor-mode stand-in selection: blocked + stand-in present -> stand-in;
 *  blocked + none -> unavailable; unblocked -> real. Pure, tested alone. */
export function floorStandIn(env: AIEnv): { floor: boolean; modelId: string | null; reason: string | null } {
  if (env.realRouteBlocked !== true) return { floor: false, modelId: null, reason: null };
  if (env.standInModel !== undefined && env.standInModel !== "") {
    return { floor: true, modelId: env.standInModel, reason: null };
  }
  return { floor: false, modelId: null, reason: "real route blocked and no stand-in model configured" };
}

/** Scan visible text for red chips. Returns the detector names that hit. */
export function detectChips(text: string, detectors: RedChipDetector[]): string[] {
  return detectors.filter((d) => d.match(text)).map((d) => d.name);
}

/** Evaluate one run's structural asserts. Returns the failed assert paths. */
export function evaluateAsserts(model: RunModel, asserts: StructuralAssert[]): string[] {
  return asserts.filter((a) => !a.check(model)).map((a) => a.path);
}

/** A valid repeat: a finite integer >= 1. Null for anything else — a NaN or
 *  fractional or string repeat is a config error, never a silent zero-run
 *  green. */
export function normalizeRepeat(repeat: unknown): number | null {
  if (typeof repeat !== "number" || !Number.isFinite(repeat) || !Number.isInteger(repeat) || repeat < 1) return null;
  return repeat;
}

async function withTimeout(p: Promise<RunModel>, ms: number): Promise<RunModel> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AITimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function didNotRun(
  reason: string, floor: boolean, totalRuns: number, attempts: number, passed: number,
  turns: AITurn[], failed: FailedAttempt[],
): AICaseResult {
  return {
    status: "red",
    description: `AI DID-NOT-RUN: ${reason}`,
    didNotRun: true,
    floor,
    totalRuns,
    attempts,
    passed,
    turns,
    failed,
  };
}

function failedDescription(name: string, passed: number, totalRuns: number, f: FailedAttempt): string {
  const parts: string[] = [];
  if (f.timedOut) parts.push("timed out");
  if (f.thrown !== undefined) parts.push(`threw: ${f.thrown}`);
  if (f.missingRedChip !== undefined) parts.push(`missing expected red chip ${f.missingRedChip}`);
  if (f.chipsHit.length > 0) parts.push(`red chips: ${f.chipsHit.join(", ")}`);
  if (f.failedAsserts.length > 0) parts.push(`failed asserts: ${f.failedAsserts.join(", ")}`);
  return `${name}: ${passed}/${totalRuns} runs passed; first failure at run ${f.attempt}${parts.length > 0 ? " (" + parts.join("; ") + ")" : ""}`;
}

/**
 * Run one AI case. Guards fire in order: repeat/inputs validation, floor
 * stand-in, missing secret, then per-run chips + asserts. Every run must pass
 * for green.
 */
export async function runAICase(
  cse: AICase,
  runner: ModelRunner,
  env: AIEnv,
  opts: { timeoutMs?: number } = {},
): Promise<AICaseResult> {
  const repeat = normalizeRepeat(cse.repeat ?? 3);
  if (repeat === null) {
    return { status: "red", description: `${cse.name}: invalid repeat (must be an integer >= 1)`, didNotRun: false, floor: false, totalRuns: 0, attempts: 0, passed: 0, turns: [], failed: [] };
  }
  if (!Array.isArray(cse.inputs) || new Set(cse.inputs.map((i) => JSON.stringify(i))).size < 3) {
    return { status: "red", description: `${cse.name}: needs at least 3 distinct input phrasings`, didNotRun: false, floor: false, totalRuns: 0, attempts: 0, passed: 0, turns: [], failed: [] };
  }
  const detectors = cse.redChips ?? defaultRedChipDetectors();
  const timeoutMs = cse.timeoutMs ?? opts.timeoutMs;

  const floor = floorStandIn(env);
  if (floor.reason !== null) {
    return didNotRun(floor.reason, false, cse.inputs.length * repeat, 0, 0, [], []);
  }
  if (!floor.floor && (env.realModelSecret === undefined || env.realModelSecret === "")) {
    return didNotRun("no real-model secret in the leg environment", false, cse.inputs.length * repeat, 0, 0, [], []);
  }

  const inputs = floor.floor ? (cse.standInInputs ?? cse.inputs) : cse.inputs;
  const modelId = floor.floor ? floor.modelId! : (env.realModelId ?? "real");
  const totalRuns = inputs.length * repeat;

  const turns: AITurn[] = [];
  const failed: FailedAttempt[] = [];
  let passed = 0;
  let attempt = 0;

  for (let i = 0; i < inputs.length; i++) {
    for (let r = 0; r < repeat; r++) {
      attempt++;
      const input = inputs[i];
      let model: RunModel;
      try {
        model = timeoutMs !== undefined
          ? await withTimeout(runner.run(input, { modelId, floor: floor.floor }), timeoutMs)
          : await runner.run(input, { modelId, floor: floor.floor });
      } catch (err) {
        if (err instanceof ModelUnavailable) {
          return didNotRun(err.message, floor.floor, totalRuns, attempt - 1, passed, turns, failed);
        }
        const isTimeout = err instanceof AITimeout;
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ attempt, inputIndex: i, failedAsserts: [], chipsHit: [], ...(isTimeout ? { timedOut: true } : { thrown: message }) });
        turns.push({ prompt: input, reply: "", chips: [], floor: floor.floor });
        continue;
      }

      const chips = detectChips(model.text, detectors);
      const failedAsserts = evaluateAsserts(model, cse.asserts);
      const expectsChip = cse.expectRedChip !== undefined;
      const chipPass = expectsChip ? chips.includes(cse.expectRedChip!) : chips.length === 0;
      turns.push({ prompt: input, reply: model.text, chips, floor: floor.floor });

      if (chipPass && failedAsserts.length === 0) {
        passed++;
        continue;
      }
      failed.push({
        attempt, inputIndex: i, failedAsserts, chipsHit: chips,
        ...(expectsChip && !chips.includes(cse.expectRedChip!) ? { missingRedChip: cse.expectRedChip } : {}),
      });
    }
  }

  if (passed === totalRuns) {
    return { status: "green", didNotRun: false, floor: floor.floor, totalRuns, attempts: attempt, passed, turns };
  }
  const first = failed[0];
  return {
    status: "red",
    description: failedDescription(cse.name, passed, totalRuns, first),
    didNotRun: false,
    floor: floor.floor,
    totalRuns,
    attempts: attempt,
    passed,
    turns,
    failed,
  };
}