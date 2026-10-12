# Oversized-functions sweep 25 — apps/fleet/cli (2026-10-12)

Ref #589. Analysis only, read-only, no code changed. Twenty-fifth
maintainability sweep; scope `apps/fleet/cli/**` only. Function bodies
measured with the TypeScript compiler API (start of body's opening `{` to
its matching `}`), 257 top-level functions surveyed, threshold strictly
>120 body lines. Four findings, all GLM-OK. Line refs at origin/main
`30bceb7`.

**Tier rule:** GLM-OK = none of auth, secrets, credentials, rescue,
failover, accounts routing, deploy, migrations, write-proxy, leak-gate.
CLAUDE-ONLY = touches any of those.

**Counting rule:** a function's body is measured with the TypeScript
compiler API — the line of the body's opening `{` through the line of its
matching `}` inclusive — never by brace-counting. A hand-rolled brace
matcher mis-measured 8+ functions across this scope because signature
type-level braces (`Promise<{ exitCode: number }>`, 9 sites in `cli/`)
read as body braces to a naive counter. Nested function declarations
count as body lines of their enclosing function (lifting one out is a
finding's proposed fix, not a measurement artifact). Threshold strictly
>120: nothing at exactly 120 would be filed. Next-largest below the
threshold, for context: `main` fleet.ts:2976 (115), `reapDeps`
fleet.ts:2427 (86), `formatTable` fleet.ts:384 (82), `cmdLs` fleet.ts:878
(79). All four findings consume `Credentials` (or call `loadCredentials`)
somewhere in their flow but touch no credentials machinery — the
loading/validation lives in `loadCredentials` (fleet.ts:92), which no
finding proposes to move: GLM-OK. Largest below-threshold twins for
reference only: `pollAfterNoAnswer` recycle-outcome.ts:316 (62) and
destroy-outcome.ts:170 (60).

## Findings

| # | finding | body lines | lane |
|--:|---|---:|---|
| 1 | cmdAttach — fleet.ts:2729, 232-line body: WS attach client with 6 nested closures and a reconnect loop | 232 | GLM-OK |
| 2 | runReap — reap.ts:250, 179-line body: list/load/floor/select/dry-run/apply phases inline in one function | 179 | GLM-OK |
| 3 | ensure — orca-workspace.ts:620, 155-line body (incl. 26 comment lines in one block): worktree half, terminal half, duplicate reconcile inline | 155 | GLM-OK |
| 4 | main — ff.ts:448, 135-line body: repo detect, decision, pre-spawn filing, attach/spawn/provision branches inline | 135 | GLM-OK |

### S25-F1. `cmdAttach` — fleet.ts:2729, body 2729-2960 (232 lines) — GLM-OK

- **Files:** `cli/fleet.ts:2729` — `export async function cmdAttach(creds:
  Credentials, id: string): Promise<void>`, body `:2729-2960`. The nested
  pieces: `sendResize` `:2747`, `handlePaste` `:2756-2781`, `handleChunk`
  `:2788-2797`, `connectOnce` `:2804-2902`, `waitOrExit` `:2911-2929`, the
  `for (;;)` reconnect loop `:2932-2957`.
- **Body shape (the seams):**
  - `:2730-2735` — enter raw mode on TTY + `process.on("exit",
    restoreTerminal)` safety net. I/O.
  - `:2737-2738` — shared loop state (`currentWs`, `attempt`). glue.
  - `:2747-2754` — nested `sendResize` + SIGWINCH listener. Pure frame
    derivation via `resizeFrameFor(process.stdout)` then WS send.
  - `:2756-2781` — nested `handlePaste`: clipboard PNG grab →
    `uploadPaste` → send path as WS binary, or forward raw ctrl-v byte on
    failure. I/O (spawns pngpaste, network POST, ws.send). Self-contained
    given (creds, id, ws).
  - `:2788-2797` — nested `handleChunk`: classifyInput branch into
    escape/paste/forward. orchestration. Self-contained given (ws, chunk).
  - `:2804-2902` — nested `connectOnce`: full single-connection lifecycle —
    new WebSocket, connect-abandon timer (`:2824-2830`), stale-view
    watchdog interval (`:2831-2841`), serialized stdin pump onData
    (`:2843-2852`), settle-once finish (`:2854-2866`),
    open/message/close/error listeners (`:2868-2900`). 97-line promise
    executor. Closes over only creds, id, currentWs, sendResize,
    handleChunk.
  - `:2911-2929` — nested `waitOrExit`: backoff wait during which a
    standalone ctrl-] exits early. Self-contained given (ms).
  - `:2932-2957` — `for (;;)` reconnect loop: connect → ctrl-] break →
    attachRefusal refusal probe (`:2940-2946`, exits 1) →
    nextAttempt/reconnectDelayMs → waitOrExit.
  - `:2959` — process.exit(0).
- **Proposed split with names** (all in the same file fleet.ts, or
  extracted to a new sibling `cli/attach-client.ts`; the same-file split
  is lower risk because the module-private symbols `restoreTerminal`,
  `uploadPaste`, `ENTER_ALT_SCREEN`, `RESTORE_TERMINAL_SEQUENCE` and the
  exported `wsUrl`/`studioUrl`/`accessHeaders` are all used here):
  - `attachTerminal(creds, id)` — the raw-mode entry + reconnect loop +
    exit (current `:2729-2737` + `:2931-2959`), the only exported surface.
  - `connectOnce(creds, id, currentWsRef, handlers)` — lift the nested
    function to module scope.
  - `handlePaste(creds, id, ws)` and `handleChunk(ws, chunk)` — lift to
    module scope, module-private.
  - `waitOrExit(ms)` — lift, taking the ctrl-] listener registration with
    it.
  - Keep `sendResize` nested inside connectOnce OR lift with an explicit
    (ws) parameter — it already takes (ws).
- **Test coverage of each seam:** no direct test calls cmdAttach
  (exported but untested directly). Indirect real-process coverage:
  test/bun/attach-liveness.test.ts (9 tests) spawns real `bun cli/fleet.ts
  attach` against hand-rolled raw-TCP WS servers — pins watchdog (#151),
  connect timeout (#123), waiting/live/STALE titles, frames-reset-
  watchdog, FLEET_ATTACH_STALE_MS/FLEET_ATTACH_CONNECT_TIMEOUT_MS env
  validation; this exercises connectOnce end to end. Helper-level:
  test/cli.backoff.test.ts (vitest) covers reconnectDelayMs/nextAttempt/
  attachRefusal; test/cli.input.test.ts covers classifyInput;
  attach-liveness.test.ts unit-tests attachTitle.
  test/bun/print-attach-handle.test.ts asserts cmdPrintAttachHandle never
  touches cmdAttach's machinery. test/bun/ff-no-tty.test.ts asserts WS is
  never opened on the no-tty path. Gaps: handlePaste (clipboard path),
  the refusal-probe block, waitOrExit have no direct tests — a split that
  lifts them to module scope makes them directly testable; that is part of
  the value.
- **Risk:** closure state (`currentWs`, `attempt`) is shared across
  connectOnce/waitOrExit/reconnect loop; a mechanical lift must pass them
  explicitly, and the connect-abandon timer + watchdog interval
  registration/cleanup order (finish settles exactly once) is the
  behavior attach-liveness.test.ts pins — the split must not reorder timer
  setup relative to listener registration.
- **Lane note:** attach client; consumes Credentials for its WS URL and
  headers, touches no credentials machinery. GLM-OK.

### S25-F2. `runReap` — reap.ts:250, body 250-428 (179 lines) — GLM-OK

- **Files:** `cli/reap.ts:250` — `export async function runReap(flags:
  ReapFlags, deps: ReapDeps): Promise<{ exitCode: number }>`, body
  `:250-428`. Pure helpers it composes, already separate in the same
  module: `inScope` `:139`, `liveTasksOf` `:151`, `mirroredIdleMs` `:159`,
  `describeNotIdle` `:169`, `idleWord` `:179`, `liveReadRefusal` `:197`.
- **Body shape (the seams):**
  - `:251-258` — list studios via deps.listStudios() try/catch → exit 1.
    I/O.
  - `:259-269` — load state via deps.loadState() try/catch; sets
    floorUnknown. I/O.
  - `:270-275` — lowercase repo; prune all three state maps to registry
    (`known` set). near-pure state transform.
  - `:277` — filter running + in-scope studios (inScope). pure.
  - `:278-281` — `exit` closure: save state, return exit code.
  - `:283-305` — board read (deps.listBoard) + three floors: throw
    (`:287`), 0 rows (`:292-295`), <half-last-good (`:296-303`), set new
    baseline (`:304`), floorUnknown bail (`:305`). floor checks read as
    pure (board.length, prevRows) → ok/bad predicate.
  - `:307-345` — candidate-selection loop over running: mirrored-idle
    check, live-task branch with STALL-alarm bookkeeping (`:316-329`),
    member-alert skip, threshold skip, backoff skip, push candidate. Loop
    body reads as evaluateCandidate(s, state, flags, now) → candidate |
    skip.
  - `:346-347` — prune state.refusals to candidate set. pure.
  - `:349-355` — dry-run report + early exit(0). self-contained.
  - `:357-361` — backOff closure: stamp backoffUntil, clear refusals, log.
  - `:362-367` — refused closure: refusal counter, escalate to backoff
    at 3.
  - `:368-376` — liveRead closure: time deps.inspect (duration counts per
    review F1), then liveReadRefusal judgement.
  - `:377-426` — apply loop per candidate (body `:378-425`, 48 lines):
    heartbeat lock refresh (`:379-383`), pre-check live read
    (`:387-388`), rescue (`:389-390`), fresh task read + race check
    (`:391-402`), final live read (`:405-406`), destroy (`:407-411`),
    state cleanup + REAPED log (`:412-422`), catch → backOff
    (`:423-425`). Try body `:384-422` is 39 lines.
  - `:427` — return exit(0).
- **Proposed split with names** (same module reap.ts — every helper it
  calls, inScope, liveTasksOf, mirroredIdleMs, describeNotIdle, idleWord,
  liveReadRefusal, already exists as separate functions; the seams are
  BETWEEN them):
  - `boardFloorCheck(deps, state, floorUnknown)` — `:283-305`, returns
    floor verdict; the three floors become one pure predicate
    `boardFloorVerdict(rows, prevRows, floorUnknown)`.
  - `selectCandidates(running, state, flags, now, ...)` — `:307-347`,
    pure-ish: returns candidates + pruned refusals; the loop body is
    evaluateCandidate.
  - `reapOneCandidate({s, idleMs}, state, flags, deps, helpers)` —
    `:377-426` apply-loop body lifted, taking backOff/refused/liveRead
    closures as parameters (or a small context object); preserves
    try/catch → backOff.
  - runReap keeps: list/load/prune, floor call, dry-run branch, apply loop
    over reapOneCandidate, exit.
- **Test coverage of each seam:** the strongest of the four — runReap is
  called 63 times directly in test/bun/fleet-reap.test.ts (happy path,
  never-a-running-turn guards, stall alarm, listing-vs-destroy race, F1
  bounded-gap/lock-refresh, F2/F3 chrome refusals, F4/F5 scope and state
  floors, board-floor failures, rescue-failure/409 backoff, dry-run,
  registry-derived pruning, destroy racing) + 5 more in
  test/bun/fleet-reap-wiring.test.ts with real reapDeps wiring against a
  fake Worker + test/bun/fleet-reap-state.test.ts for the fleet.ts side
  of loadState. Every seam above is reached through ReapDeps fakes.
  formatIdleAlarm (same module) tested in fleet-reap.test.ts:636-653. A
  split here is behavior-preserving iff runReap's signature and ReapDeps
  contract stay identical — tests give the safety net.
- **Risk:** lowest of the four. The exit closure saves state on every path
  — lifted helpers must not early-return past it. The rescue call
  (`:389-390`) is injected deps.rescue orchestration only; the rescue
  implementation lives in src/studio/rescue.ts and is the rescue lane's
  own, so the split must not move that call's semantics, only its
  location.
- **Lane note:** reap lane per repo precedent
  (apps/fleet/docs/maintainability/2026-10-12-cli-coverage-sweep-11.md);
  reap ≠ rescue lane. GLM-OK.

### S25-F3. `ensure` — orca-workspace.ts:620, body 620-774 (155 lines, of which 26 lines are one comment block) — GLM-OK

- **Files:** `cli/orca-workspace.ts:620` — `async function ensure(id:
  string, title: string, deps: OrcaDeps): Promise<WorkspaceOutcome>`,
  body `:620-774`. Module-private; sole caller exported
  ensureStudioWorkspace (`:535`), which runs it under deps.lock (`:553`)
  and converts throws to `{kind: "failed"}`. The half-helpers it composes,
  already separate in the same module: studioWorkspaceName `:187`,
  isAttachTerminal `:314`, isHealthyAttach `:321`, rankAttachTerminals
  `:369`, orcaJson `:420`, resolveRepoId `:450`, findStudioWorktree
  `:603`.
- **Body shape (the seams):**
  - `:621-623` — derive worktree name; orcaJson worktree list. I/O.
  - `:625-631` — board #39 lookup: findStudioWorktree by registry id with
    path-basename fallback (heals lost registry entry). near-pure find.
  - `:633-657` — worktree half if/else: existing row (`:636-638`: pick
    selector, registry.set heal) vs create (`:639-656`: parseStudioId,
    resolveRepoId via second orcaJson list at `:642`, worktree create at
    `:648-652`, registry.set, created=true). Self-contained
    "ensureWorktreeHalf(id, deps) → {selector, created}".
  - `:659-673` — best-effort title stamp: try/catch around worktree set
    --display-name, log-only on failure. Self-contained stampDisplayName.
  - `:675-693` — comment block only (terminal-half rationale).
  - `:694-695` — orcaJson terminal list; filter to attach terminals via
    isAttachTerminal.
  - `:697-715` — duplicate reconcile (board #42): rank attach terminals,
    close every extra via terminal close, collect closedDuplicates.
    Self-contained reconcileDuplicates; loop `:710-714` is 5 lines.
  - `:717-723` — #124 M2: close unhealthy survivor (connected but
    orphaned/unwritable).
  - `:725-730` — existence shortcut: !created && kept && isHealthyAttach(
    kept, id) → return {kind: "exists", closedDuplicates}.
  - `:732-757` — comment block only (26 lines, unconfirmed stray-terminal
    hypothesis). NO CODE.
  - `:758-762` — create the real attach terminal: terminal create
    --worktree ... --title id --command "fleet attach <id>".
  - `:764-773` — stamp terminal title (terminal rename), return {kind:
    "created", closedDuplicates}.
  - No >25-line code blocks (largest: worktree-half else `:640-656`, 18
    lines).
- **Proposed split with names** (same module — the file already has
  studioWorkspaceName, orcaJson, findStudioWorktree, resolveRepoId,
  isAttachTerminal, rankAttachTerminals, isHealthyAttach as separate
  helpers; ensure is the glue that lacks decomposition):
  - `ensureWorktreeHalf(id, deps)` — `:625-657` incl. stampDisplayName,
    returns {selector, created}.
  - `reconcileAttachTerminals(id, deps)` — `:694-723`: list, dedupe,
    unhealthy-survivor close; returns {kept, closedDuplicates}.
  - `createAttachTerminal(id, selector, deps)` — `:758-773`.
  - ensure shrinks to: worktree half → reconcile → exists-shortcut check
    → create → return.
- **Test coverage of each seam:** ensure is private — not directly
  importable. Indirect heavy behavioral: test/bun/orca-workspace.test.ts
  calls exported ensureStudioWorkspace 42 times + openStudioRow 3 times
  with fake OrcaDeps proving all five file-header properties
  (never-fails-caller, no-op outside Orca, two-level idempotency, no
  focus steal, bounded timeouts) incl. concurrent-lock test (`:448`),
  registry-heal cases, duplicate-terminal reconcile, unhealthy-survivor
  replacement, title-from-#206 windows.
  test/bun/orca-workspace.exit-code.ts (spawned fixture) asserts one
  ensureStudioWorkspace against a throwing runner still exits 0.
  test/bun/orca-workspace.registry-writer.ts is a concurrent-set fixture.
  test/cli.recycle-outcome.test.ts:431-433 (vitest) asserts source
  structure: exactly one openStudioRow( call in fleet.ts's recycle path.
- **Risk:** the two comment blocks (`:675-693`, `:732-757`) are
  decision-record comments — a split MUST carry them to the helper that
  owns their code (or keep them in ensure), never delete. The
  exists-shortcut depends on `created` from the worktree half AND `kept`
  from reconcile — that cross-half state is the one thing that keeps
  ensure from being a pure pipeline; the split must thread it explicitly.
- **Lane note:** Orca workspace plumbing; no credential content.
  GLM-OK.

### S25-F4. `main` — ff.ts:448, body 448-582 (135 lines) — GLM-OK

- **Files:** `cli/ff.ts:448` — `async function main(): Promise<void>`,
  body `:448-582`. Module-private, run under `if (import.meta.main)` at
  `:584`. The helpers it composes, already separate in the same module:
  say `:77`, fail `:81`, listStudios `:90`, readOutcome `:140`,
  spawnStudio `:160`, provisionStudio `:217`, adoptTask `:305`,
  waitProvisioned `:341`, attachOrHandOff `:387`, and exported ffSpawnNew
  `:422` / fileTask `:258`. The decision and parser live in src/studio/ff.ts
  (parseFfArgs `:176`, ffDecision `:306`) and are imported.
- **Body shape (the seams):**
  - `:449-457` — parseFfArgs; help prints and returns, usage exits 1.
    orchestration over pure parser (tested in src/studio/ff.ts).
  - `:459-462` — loadCredentials() after arg shape settled. I/O
    (~/.fleet/credentials).
  - `:464-481` — detectRepo() (reads git remote); fold short name via
    repoIdSegment; refuse a name that cannot be a segment (fail), else
    announce repo/fallback reason. announce/refuse block `:475-480` reads
    as a small pure reporting step.
  - `:483-487` — ffDecision(listStudios(creds), segment, role, slug,
    --new) — network listing + pure decision; fail on error. Decision
    logic tested in src/studio/ff.ts.
  - `:489-505` — pre-spawn task filing: only when parsed.task !== null &&
    !isNew; refuse when no studio id derivable (`:498-501`); fileTask or
    adoptTask (`:502-505`). 11-line block self-contained given (creds,
    slug, id, parsed.task).
  - `:507-510` — startedAt = Date.now() budget anchor + comment.
  - `:512-550` — ATTACH BRANCH (39 lines, the only >25-line block):
    readOutcome container check (`:518`); provisioned/unverified →
    wake-hint say-lines when task exists (`:532-539`) → return
    attachOrHandOff (`:543`); else "provisioning it" + provisionStudio
    (`:548-550`). Reads as attachFastOrProvision(creds, decision,
    detected, task, segment).
  - `:551-567` — SPAWN branch: isNew sub-branch (`:552-565`, 14 lines)
    wires ffSpawnNew deps (spawn/wait/file/adopt closures), exits 1 on
    null, prints task hint, returns attachOrHandOff; else plain
    spawnStudio (`:566-567`).
  - `:568-572` — else branch: studio exists but not provisioned →
    provisionStudio, take its id.
  - `:574-581` — waitProvisioned (bounded bring-up wait, exits 1 on
    timeout) then final attachOrHandOff.
- **Proposed split with names** (same module ff.ts — say, fail,
  listStudios, readOutcome, spawnStudio, provisionStudio, adoptTask,
  waitProvisioned, attachOrHandOff already exist as private fns; fileTask
  and ffSpawnNew are exported and tested):
  - `attachFastOrProvision(...)` — `:512-550`.
  - `spawnNewStudio(...)` — `:552-565` (the ffSpawnNew deps wiring),
    thin.
  - main keeps: parse/creds/repo-detect/decision/filing-anchor + branch
    dispatch + final wait.
- **Test coverage of each seam:** main is private, import-guarded — no
  direct test. Indirect real-process: test/bun/ff-no-tty.test.ts spawns
  real cli/ff.ts against stub Worker + real git repo (3 tests: terminates
  instead of attaching with no tty; stderr says what it did; never opens
  terminal WS) — exercises the attach branch through the handoff gate.
  test/bun/ff-new-main.test.ts spawns real cli/ff.ts for --new (1 test:
  exactly one task POST, after the spawn, assigned to spawned id) —
  exercises spawn/isNew filing order. Extracted-helper direct tests:
  test/bun/ff-new-race.test.ts calls exported ffSpawnNew (4 tests);
  test/bun/ff-file-task-retry.test.ts calls exported fileTask (2 tests,
  idempotency-key retry). Gaps: plain-spawn branch (`:566-567`),
  exists-but-not-provisioned branch (`:568-572`), attach-then-provision
  fallthrough (`:545-550`), pre-spawn filing block (`:489-505` — fileTask
  tested, branch wiring not). A split lifts these branches into named,
  individually reachable fns.
- **Risk:** say/fail write to stdout/stderr and fail calls process.exit —
  lifted branch helpers must keep the same output ORDER (ff-new-main pins
  filing-after-spawn; ff-no-tty pins stderr content). The attach branch
  returns from main via `return attachOrHandOff(...)` — a lifted helper
  must return the same sentinel shape so main's return paths stay
  identical.
- **Lane note:** ff orchestration; consumes Credentials via
  loadCredentials, touches no credentials machinery. GLM-OK.

## Suggested batching

- Batch A (one deepen issue): S25-F1 cmdAttach — attach client
  extraction; new sibling module cli/attach-client.ts OR same-file
  split; add direct tests for lifted handlePaste/waitOrExit. Est:
  moderate; watch timer/listener order.
- Batch B (one deepen issue): S25-F2 runReap — phase split within
  reap.ts, runReap signature + ReapDeps contract unchanged; existing
  63-call suite is the net.
- Batch C (one deepen issue): S25-F3 ensure — three-helper split within
  orca-workspace.ts; carry decision-record comments; orca-workspace.test.ts
  42-call suite is the net.
- Batch D (one deepen issue): S25-F4 main — branch extraction within
  ff.ts; keep output order; ff-no-tty + ff-new-main real-process tests are
  the net.

Each batch = one `deepen(GLM-OK): S25-Fn <short>` issue referencing #589.

## Counts

4 GLM-OK findings (S25-F1..S25-F4) → one deepen(GLM-OK) issue each,
batched A-D above, all referencing #589. 0 CLAUDE-ONLY findings.
