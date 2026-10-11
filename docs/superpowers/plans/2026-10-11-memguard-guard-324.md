# Plan — #324 S2-F9: createGuard(io, cfg) for container/memguard.ts

Sweep 2 F9 (GLM-OK, behavior-preserving). Problem: 17 of 18 exports test-only — pure selection fns (isProtected, protectedSet, pickVictim, adjPlan, adjScan, decide, step, nextTickMs, initialState, refreshLeadParentPid, newAdjCache) leak internals as interface; the real tick loop lives untested in main() (:576-601), only exercised by memguard-docker.test.ts which skips without Docker.

## Steps

1. RED: new test/bun/memguard-guard.test.ts — fake GuardIo scripted over N ticks: below threshold no-op; over threshold SIGTERMs largest non-protected; kill() throws (victim exited) → settles; lead pid changes mid-run → protection follows; adj pass runs on interval, log lines exact.
2. GREEN: container/memguard.ts gains GuardIo interface {readProcs, readMemory, resolveLeadParentPid, kill, setAdj, log, now} + createGuard(io, cfg, opts).tick() holding pids + adj cache + guard state internally; main() = build real io (fs + spawn + process.kill + appendFileSync) + loop. Log lines byte-identical.
3. Internalize: the pure fns become non-exported; pct computed once (pctOf); tests migrate from internal fns to tick() (CD "replace, don't layer" — same coverage, new seam).
4. Verify: bun test test/bun/memguard-select.test.ts test/bun/memguard-guard.test.ts + docker test skipped-no-docker; tsc --noEmit -p container + src; english-check; test-lies-check.

## Behavior preserved

Same kill/adj decisions, same log lines, same tick cadence. No consumer of internalized exports outside tests (verified: only studio-bringup.sh runs the script; memguard-log.ts parses log text, imports nothing).
