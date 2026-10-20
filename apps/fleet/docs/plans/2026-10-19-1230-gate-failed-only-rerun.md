# Plan — task #1230: git-proxy errors as infra, failed-legs-only rerun

Branch `fix-1230-gate-failed-only-rerun`; no PR yet.

## Part C — git-proxy errors count as infra (small, first)

Two git-proxy error messages seen in production leg failures —
`remote end hung up` and `bad line length` — show up inside `checkout
failed:`/`clone failed:`/`fetch failed:` leg descriptions but match neither
`isRetryable` (leg-run.ts) nor `INFRA_CAUSE` (infra-rerun.ts). Today that
leg becomes a final `error` with no retry and no infra auto-rerun.

Fix is ONLY to `INFRA_CAUSE` in infra-rerun.ts: add both literal strings.
`isRetryable` in leg-run.ts is deliberately untouched — the title says
"git-proxy errors count as infra", which is a classification question for
the auto-rerun (`isInfraLegFailure` / `infraRerunDecision`), not a retry
question for the leg's own first/retry attempt. Whether a leg's single
clone failure should also earn its OWN retry is a separate, unscoped
decision.

## Part A — carry green legs across a rerun

### The two production bugs

1. An infra auto-rerun (`infraRerunDecision`, wired in workflow.ts) creates
   a brand-new Workflow instance with `{ repo, pr, headSha, rerunOf }`. That
   fresh run replans ALL legs from scratch and reruns every one of them,
   including legs that already passed in the first run. At a 9-23%
   infra-leg-fail rate, a 24-leg rerun fails ~23% of the time purely from
   new infra noise on legs that already succeeded.
2. There is no human-triggered equivalent: `fleet gate run --failed-only
   <pr>` does not exist, so a reviewer who sees 1 of 24 legs red has no way
   to re-test just that leg.

### The mechanism: CarryGreen

A new `CarryGreen` record (`fanout.ts`) carries one run's green leg results
into the next: `{ headSha, baseSha, configHash, legs }`. It is only ever
trusted for the SAME head sha, base sha, and leg-plan fingerprint the new
run resolves to:

- `planFingerprint(legs)` — a pure fingerprint of a plan's runnable content
  (leg name + install/cmd/timeout/image), over the WHOLE plan, distinct
  from the existing `legContent` (which compares one leg's content, with no
  name, for the `planUnionLegs` base/head-leg dedupe — a different
  purpose, kept separate on purpose so the two are never confused).
- `carriedGreenByLeg(carry, ctx)` — returns the carried legs by name ONLY
  when `headSha`, `baseSha` and `configHash` all match `ctx`; any mismatch
  (a push moved the head, fleet.json changed, a different shard count)
  returns an empty map, so the caller replans and reruns every leg exactly
  as if there were no carry at all. This is the fail-safe: a carry is never
  trusted across a sha or config it wasn't computed for.

`workflow.ts` computes the fingerprint right after planning legs, resolves
the carry against its own resolved head/base sha, and for each leg already
green in the carry, resolves immediately to that carried `LegResult`
instead of calling `runLeg` (no DO dispatch, no container). The final
verdict aggregates carried + freshly-run results exactly as it always
aggregates `results`, so `aggregateVerdict` / `verdictToStatusArgs` /
`outcomeLegs` need no changes.

The infra auto-rerun's `create()` call now passes its own green results as
the next run's `carryGreen`. `startManualGateRun` (auto-run.ts) gains an
optional `carryGreen` passthrough; when set, it ALWAYS takes the
`startFresh()` path (never reattaches to a live run) because
`--failed-only` is an explicit request to re-test specific legs — reusing
a stale live run would silently ignore that request.

`/studio/gate/start` (routes.ts) gains `failedOnly: true`: it reads the
PR's latest run's status (reusing the existing `gateRunStatus`, which
already chases through a terminated run's rerun and a rerun's own output),
requires `legs`/`baseSha`/`configHash` to be present (409 otherwise, 404 if
there is no prior run at all), and builds a `CarryGreen` from its green
legs keyed on the D1 index's recorded `headSha` (never anything out of the
status body — matching how the rest of this module already trusts the D1
index as the authoritative "what this run gated"). The new run still
targets the PR's LIVE head sha; if that has moved since `latest`,
`carriedGreenByLeg`'s headSha check naturally invalidates the carry (no
special case needed — this is the same fail-safe path a mismatched sha
always takes).

`fleet gate run --failed-only <pr>` (cli/gate.ts, cli-args.ts, fleet.ts)
is the human-triggered trigger for the same `failedOnly` body flag.

### Files touched

- `src/gate/fanout.ts` — `CarryGreen`, `planFingerprint`, `carriedGreenByLeg`.
- `src/gate/workflow.ts` — `GateWorkflowParams.carryGreen`, fingerprint +
  carry resolution after planning, carried legs skip `runLeg`, the infra
  rerun's `create()` passes its green results forward, `GateRunOutcome`'s
  two post-plan variants carry `baseSha`/`configHash`.
- `src/gate/auto-run.ts` — `GateRunParams.carryGreen`,
  `startManualGateRun`'s `carryGreen` passthrough and always-fresh path.
- `src/gate/routes.ts` — `/studio/gate/start` `failedOnly` body flag,
  `/studio/gate/status` response carries `baseSha`/`configHash`.
- `cli/gate.ts` — `GateRunOptions.failedOnly`, request body flag.
- `src/studio/cli-args.ts` — `gate-run` parsed command gains `failedOnly`,
  `gate run [--failed-only] <pr>` parsing, usage/help text.
- `cli/fleet.ts` — threads `parsed.failedOnly` into `cmdGateRun`.

### What's out of scope

- `isRetryable` in leg-run.ts (Part C note above).
- Restructuring `startManualGateRun`'s existing reattach/collision branches
  beyond the one new early-return for `carryGreen`.
- A completion record file — handled outside this task.
