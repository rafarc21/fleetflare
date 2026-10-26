// apps/fleet/container/gate/browser/ai/harness.ts
//
// AI-leg harness for the gate (board #1345). A gate "AI leg" runs a consumer
// repo's AI-driven spec against a REAL model and must fail the run on a REAL
// regression, so the harness never trusts prose: a case declares the model
// call it will make, the structural checks it will assert on the response, and
// the red chips (refusal/sorry/error phrasing) that mark a failed call.
//
// Four guards, each fail-closed:
//   1. N/N repeats — a case runs `repeat` times (default 3) and needs EVERY
//      attempt to pass. One red attempt makes the case red. Flaky-first-try
//      tolerance must never read as green.
//   2. Red-chip detectors — any hit in a model's visible text (configurable;
//      default covers "I couldn't…", "Não consegui…", "Something went wrong")
//      marks that attempt RED. Chips are checked BEFORE structural asserts so a
//      model that apologises its way out of a missing tool call still fails.
//   3. Missing AI secret — a case that cannot reach a real model is RED
//      "AI DID-NOT-RUN", never a skipped-green. No environment means no result,
//      not a pass.
//   4. Floor mode — when the real route is blocked, an env switch routes the
//      leg to a Workers AI stand-in model instead of failing. The stand-in is
//      declared, never guessed: it must be present in the env or the leg stays
//      DID-NOT-RUN.
//
// Pure TypeScript, no Worker bindings, no network: the transport (`RunModel`)
// and the environment are injected, so bun test can drive every guard without a
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

/** A model-turn transport. Returns the model's response, or throws a
 *  `ModelUnavailable` when the real route is blocked and floor mode has no
 *  stand-in. */
export interface ModelRunner {
  run(input: unknown): Promise<RunModel>;
}

/** Thrown by a runner when no model is reachable (missing secret, blocked route). */
export class ModelUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ModelUnavailable";
  }
}

/** One structural assert on a model response. `path` names the field it reads
 *  (`"toolCalls"`, `"thinking"`, `"toolCalls.0.name"`), so a failure message
 *  names the structure that failed, never a prose paraphrase. */
export interface StructuralAssert {
  path: string;
  /** Assertion predicate. Return false to fail the attempt. */
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

/** Default red-chip detectors: the example set from #1345, plus the two most
 *  common apology shapes. Kept as a factory so each case gets a fresh array. */
export function defaultRedChipDetectors(): RedChipDetector[] {
  return [
    { name: "couldnt", match: (t) => /I couldn['’]?t/i.test(t) },
    { name: "nao-consegui", match: (t) => /Não\s*consegui/i.test(t) },
    { name: "something-went-wrong", match: (t) => /Something went wrong/i.test(t) },
    { name: "sorry", match: (t) => /\bsorry\b/i.test(t) },
    { name: "unable-to", match: (t) => /I(?:'| a)m (?:unable to|not able to)/i.test(t) },
  ];
}

export interface AIEnv {
  /** Present when a real-model secret exists. Absent = DID-NOT-RUN. */
  realModelSecret?: string;
  /** The stand-in model id used only in floor mode. Absent = no stand-in. */
  standInModel?: string;
  /** True when the real route is blocked (floor mode). */
  realRouteBlocked?: boolean;
}

export interface AICase {
  /** Case name, echoed in the result. */
  name: string;
  /** Repeats for N/N. Default 3; clamped to >= 1. */
  repeat?: number;
  /** The model request this case makes. Passed to the runner verbatim. */
  input: unknown;
  /** Structural asserts that must all hold on every attempt. */
  asserts: StructuralAssert[];
  /** Red-chip detectors for this case. Defaults to `defaultRedChipDetectors()`. */
  redChips?: RedChipDetector[];
  /** Floor-mode stand-in model input override; defaults to `input`. */
  standInInput?: unknown;
}

export interface AttemptResult {
  attempt: number;
  /** Structural asserts that failed on this attempt. */
  failedAsserts: string[];
  /** Red chips hit on this attempt. */
  chipsHit: string[];
}

export type AICaseResult =
  | { status: "green"; attempts: number }
  | { status: "red"; description: string; attempts: AttemptResult[] }
  | { status: "did-not-run"; description: string };

/** The floor-mode stand-in selection: blocked + stand-in present -> stand-in;
 *  blocked + none -> unavailable; unblocked -> real. Pure, tested alone. */
export function floorStandIn(env: AIEnv): { useStandIn: boolean; reason: string | null } {
  if (env.realRouteBlocked !== true) return { useStandIn: false, reason: null };
  if (env.standInModel !== undefined && env.standInModel !== "") {
    return { useStandIn: true, reason: null };
  }
  return { useStandIn: false, reason: "real route blocked and no stand-in model configured" };
}

/** Scan visible text for red chips. Returns the detector names that hit. */
export function detectChips(text: string, detectors: RedChipDetector[]): string[] {
  return detectors.filter((d) => d.match(text)).map((d) => d.name);
}

/** Evaluate one attempt's structural asserts. Returns the failed assert paths. */
export function evaluateAsserts(model: RunModel, asserts: StructuralAssert[]): string[] {
  return asserts.filter((a) => !a.check(model)).map((a) => a.path);
}

/**
 * Run one AI case through N/N repeats. The guards fire in a fixed order:
 * missing real secret -> DID-NOT-RUN; blocked route -> floor stand-in (or
 * DID-NOT-RUN); then per attempt, chips BEFORE asserts (a chip is already red
 * even if the structure happens to hold). Every attempt must pass for green.
 */
export async function runAICase(
  cse: AICase,
  runner: ModelRunner,
  env: AIEnv,
  opts: { repeat?: number } = {},
): Promise<AICaseResult> {
  const repeat = Math.max(1, Math.floor(opts.repeat ?? cse.repeat ?? 3));
  const detectors = cse.redChips ?? defaultRedChipDetectors();

  if (env.realModelSecret === undefined || env.realModelSecret === "") {
    return { status: "did-not-run", description: "AI DID-NOT-RUN: no real-model secret in the leg environment" };
  }

  const floor = floorStandIn(env);
  if (floor.reason !== null) {
    return { status: "did-not-run", description: `AI DID-NOT-RUN: ${floor.reason}` };
  }
  const input = floor.useStandIn ? (cse.standInInput ?? cse.input) : cse.input;

  const attempts: AttemptResult[] = [];
  for (let i = 1; i <= repeat; i++) {
    let model: RunModel;
    try {
      model = await runner.run(input);
    } catch (err) {
      if (err instanceof ModelUnavailable) {
        return { status: "did-not-run", description: `AI DID-NOT-RUN: ${err.message}` };
      }
      throw err;
    }

    const chips = detectChips(model.text, detectors);
    const failedAsserts = evaluateAsserts(model, cse.asserts);
    if (chips.length > 0 || failedAsserts.length > 0) {
      attempts.push({ attempt: i, failedAsserts, chipsHit: chips });
    }
  }

  if (attempts.length === 0) {
    return { status: "green", attempts: repeat };
  }

  const first = attempts[0];
  const chips = first.chipsHit.length > 0 ? ` red chips: ${first.chipsHit.join(", ")}` : "";
  const asserts = first.failedAsserts.length > 0 ? ` failed asserts: ${first.failedAsserts.join(", ")}` : "";
  return {
    status: "red",
    description: `${cse.name}: ${attempts.length}/${repeat} attempts red (attempt ${first.attempt})${chips}${asserts}`,
    attempts,
  };
}