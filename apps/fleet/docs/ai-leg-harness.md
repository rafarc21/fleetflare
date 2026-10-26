# AI-leg harness (gate)

Board #1345. The gate's "AI leg" runs a consumer repo's AI-driven spec against
a REAL model and must fail the run on a REAL regression, so the harness never
trusts prose. A case declares the model call it makes, the structural checks it
asserts on the response, and the red chips (refusal/sorry/error phrasing) that
mark a failed call.

Files:

- `apps/fleet/container/gate/browser/ai/harness.ts` — the harness, pure
  TypeScript (no Worker bindings, no network). Transport (`ModelRunner`) and
  environment (`AIEnv`) are injected, so bun test drives every guard without a
  real model or secret.
- `apps/fleet/test/bun/gate-ai-harness.test.ts` — the guard tests (RED/GREEN
  source for the mutation report).

## The four guards (each fail-closed)

1. **N/N repeats.** A case runs `repeat` times (default 3) and needs EVERY
   attempt to pass. One red attempt makes the case red. Flaky-first-try
   tolerance must never read as green.
2. **Red-chip detectors.** Any hit in a model's visible text (configurable;
   default covers "I couldn't…", "Não consegui…", "Something went wrong",
   "sorry", "I am unable to…") marks that attempt RED. Chips are checked
   BEFORE structural asserts, so a model that apologises its way out of a
   missing tool call still fails.
3. **Missing AI secret.** A case that cannot reach a real model is RED
   `"AI DID-NOT-RUN"`, never a skipped-green. No environment means no result,
   not a pass.
4. **Floor mode.** When the real route is blocked, an env switch routes the leg
   to a Workers AI stand-in model instead of failing. The stand-in is declared,
   never guessed: `floorStandIn` returns a reason when the route is blocked and
   no stand-in is configured, and the case is DID-NOT-RUN.

## Case shape

```ts
import { runAICase, type AICase, type ModelRunner } from "./harness";

const cse: AICase = {
  name: "weather",
  input: { city: "Paris" },
  asserts: [{ path: "toolCalls", check: (m) => (m.toolCalls ?? []).length > 0, reason: "one tool call" }],
  // redChips omitted -> defaultRedChipDetectors()
};

const result = await runAICase(cse, runner, {
  realModelSecret: process.env.AI_SECRET,
  standInModel: process.env.AI_STAND_IN_MODEL,
  realRouteBlocked: process.env.AI_FLOOR_MODE === "on",
});
```

`result` is one of:

- `{ status: "green", attempts }` — every attempt passed.
- `{ status: "red", description, attempts }` — at least one attempt red; the
  description names the attempt, the chips hit, and the failed assert paths.
- `{ status: "did-not-run", description }` — no real-model secret, blocked route
  with no stand-in, or a `ModelUnavailable` from the runner.

## Structural asserts, never prose

An assert names a field path (`"toolCalls"`, `"thinking"`,
`"toolCalls.0.name"`) and a predicate; `evaluateAsserts` returns the failed
paths, and a failure message names the structure that failed. Never
string-match the model's visible text to decide a pass — that is the red-chip
job, and it only ever turns a pass into a red, never a red into a pass.

## Floor mode

`floorStandIn(env)` is pure and tested alone: unblocked route → real model;
blocked + stand-in present → stand-in; blocked + none → unavailable. The
stand-in model id and its input override (`standInInput`) are carried on the
case, not guessed by the harness.

## Result envelope

The harness returns the case result; the leg that runs it folds each case into
the gate's leg verdict (browser-leg semantics land in a sibling task). A case
whose status is `did-not-run` must become a RED leg — the "never skip-green"
rule is enforced here, not by the verdict layer.