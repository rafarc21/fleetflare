# AI-leg harness (gate)

Board #1345. The gate's "AI leg" runs a consumer repo's AI-driven spec against
a REAL model and must fail the run on a REAL regression, so the harness never
trusts prose. A case declares the model calls it will make (at least three
distinct input phrasings), the structural checks it asserts on the response,
and the red chips (refusal/error phrasing) that mark a failed call.

Files:

- `apps/fleet/container/gate/browser/ai/harness.ts` — the harness, pure
  TypeScript (no Worker bindings, no network). Transport (`ModelRunner`) and
  environment (`AIEnv`) are injected, so bun test drives every guard without a
  real model or secret.
- `apps/fleet/test/bun/gate-ai-harness.test.ts` — the guard tests (RED/GREEN
  source for the mutation report).

## The guards (each fail-closed)

1. **N/N repeats.** Every run must pass: each input phrasing, `repeat` times
   (default 3). One red run makes the case red. A non-integer or non-finite
   repeat (`NaN`, `"three"`) is a config error — RED, never a silent
   zero-run green.
2. **Red-chip detectors.** Any hit in a model's visible text marks that run
   red. Configurable per repo. The default covers the English refusal shapes
   plus the Portuguese "Não consegui" the task names. Chips and structural <!-- english-check: allow -->
   asserts are BOTH evaluated — a model that apologises its way out of a
   missing tool call fails on the chip even when the structure happens to hold.
3. **Negative-control self-test.** `expectRedChip` declares a chip the case
   REQUIRES to fire (the model is expected to refuse). The run passes only
   when that chip IS detected, so a detector that regresses turns the case red
   instead of green.
4. **A thrown run or per-attempt timeout** (`timeoutMs`) — red, never
   swallowed. A generic throw is a failed run; only `ModelUnavailable` is
   infra.
5. **Missing AI secret.** RED `"AI DID-NOT-RUN"` — status `"red"` with
   `didNotRun: true`, never a skipped-green and never a third status the
   verdict layer would have to invent.
6. **Floor mode.** When the real route is blocked, the leg routes to a Workers
   AI stand-in model. Floor works WITHOUT a real secret and marks its result
   `floor: true`, visibly distinct from a real green. Blocked with no stand-in
   is DID-NOT-RUN.

## Case shape

```ts
import { runAICase, type AICase, type ModelRunner } from "./harness";

const cse: AICase = {
  name: "weather",
  inputs: [{ city: "Paris" }, { city: "Lisbon" }, { city: "Berlin" }],
  repeat: 3,
  asserts: [{ path: "toolCalls", check: (m) => (m.toolCalls ?? []).length > 0, reason: "one tool call" }],
  // redChips omitted -> defaultRedChipDetectors()
};

const result = await runAICase(cse, runner, {
  realModelId: process.env.AI_MODEL,
  realModelSecret: process.env.AI_SECRET,
  standInModel: process.env.AI_STAND_IN_MODEL,
  realRouteBlocked: process.env.AI_FLOOR_MODE === "on",
});
```

`result` has `status: "green" | "red"` plus `didNotRun`, `floor`, `totalRuns`,
`attempts`, `passed`, `turns`, and (red only) `failed` and `description`. Green
iff `passed === totalRuns`.

## Structural asserts, never prose

An assert names a field path (`"toolCalls"`, `"thinking"`,
`"toolCalls.0.name"`) and a predicate; `evaluateAsserts` returns the failed
paths, and a failure message names the structure that failed. Never
string-match the model's visible text to decide a pass — that is the red-chip
job, and it only ever turns a pass into a red, never a red into a pass.

## Floor mode

`floorStandIn(env)` is pure and tested alone: unblocked route → real model;
blocked + stand-in present → stand-in; blocked + none → unavailable. The
stand-in model id is passed to the runner (`RunContext.modelId`), and the
stand-in input override (`standInInputs`) is carried on the case, never
guessed.

## Evidence

The result carries the consumer evidence schema `ai.turns[{ prompt, reply,
chips[], floor }]` — one turn per run. The browser-side console buckets
(`consoleErrors`, `consoleWarnings`, `debugLogs`, `exceptions`, `badRequests`,
`canceledRequests`) are produced by the browser guard (sibling task #1344),
not this harness.

## Placement

The harness and its guard ship IN the gate image. Files stay under
`container/gate/browser/`; T1 (#1342) adds a `Dockerfile.gate` COPY to
`/opt/fleet-gate/browser` with a resolvable import path, so the harness and the
browser guard ride the same image window.