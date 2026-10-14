# #416 Carried Review Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four remaining #332 review-round findings (#416 items 1, 2, 3-tail, 4, 5): pr-landed.ts comment accuracy, open-prs route scan parallelism, per-task scan-failure signal, behavioral cmdDestroy tests replacing source pins, and cross-studio subrequest-budget documentation.

**Architecture:** One shared module change (pr-landed.ts comments + `OpenTaskPr.readFailed` field consumed by open-prs.ts), one route change (routes.ts `Promise.all` over studios + budget math comment), one test-file migration (source-pin tests → subprocess behavioral tests). Item 3's route-level half (`unknown: [studioId]` array) shipped in #417; only the per-task tail remains.

**Tech Stack:** Cloudflare Workers (Hono-free native routes), Vitest (`@cloudflare/vitest-pool-workers` for src), Bun test for cli subprocess tests, tsc.

**Spec:** https://github.com/rafarc21/fleetflare/issues/416 (board task, with the #417 status comment narrowing scope: item 3 route-half done; items 1, 2, 4, 5, and 3's per-task tail remain)

## Global Constraints

- All repository content English (CI: `bun run scripts/english-check.ts`).
- `bun run test-lies-check` must stay clean: no tautological tests, no source-reading tests (item 4 deletes the last source-pin family), no own-module mocks.
- One heavy gate at a time: `bun run check` (5 tsc projects), full vitest, full bun test never run in parallel with each other or a bundler build.
- Full test suite belongs to CI/merge gate; run only the files this change touches.
- Push after the first RED-test commit and after every commit (`LEFTHOOK=0 git push`).
- Tests use fake names (e.g. `acme-org/websites`, `websites--web-studio`), never private names — public repo.
- Comments follow this repo's own conventions: measured facts with dates, issue refs, "why" reasoning next to the rule.

---

### Task 1: pr-landed.ts — third-caller comment accuracy (item 1) + `OpenTaskPr.readFailed` (item 3-tail, data half)

**Files:**
- Modify: `apps/fleet/src/board/pr-landed.ts:1-11` (header), `:24-53` (bound doc comment), `:56-64` (`OpenTaskPr`), `:132-164` (loop)
- Test: `apps/fleet/test/board.pr-landed.test.ts` (add 2 tests, update existing exact-object literals)

**Interfaces:**
- Consumes: `BoardApi`, `showTask`, `findLatestResultEnvelope` — unchanged.
- Produces: `OpenTaskPr` gains `readFailed: boolean` (true when that task's `showTask` threw OR answered `{ok:false}`; false when read fine, regardless of whether an envelope/PR was found). Existing callers (webhook.ts Path 2 filters `prNumber !== null` and never reads `readFailed`; task-reap routes.ts maps to `ReapTaskInput` which doesn't carry it) are untouched — the field is additive.

- [ ] **Step 1: Write the failing tests** in `test/board.pr-landed.test.ts`, inside the top `describe("openTasksWithLatestPr")`, after the "a thrown lookup for one task reports null and does not stop the others" test:

```ts
  // #416 item 3-tail: the scan must be able to distinguish "read this task,
  // found no PR" from "could not read this task" — open-prs.ts turns the
  // second into a scan failure (its own `unknown` marker), while this scan's
  // own callers (promote-close, reap) keep reading prNumber: null either way.
  it("a read failure for one task reports readFailed: true — prNumber: null alone no longer claims 'looked'", async () => {
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = fakeApi({
      listComments: vi.fn(async (_repo: string, number: number) => {
        if (number === 12) throw new Error("boom");
        return [envelopeComment(docB)];
      }),
    });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 }), view({ number: 13 })]);
    expect(result).toEqual([
      { taskNumber: 12, prNumber: null, readFailed: true },
      { taskNumber: 13, prNumber: 11, readFailed: false },
    ]);
  });

  it("a clean read with no envelope reports readFailed: false — 'no PR found' is never 'could not read'", async () => {
    const api = fakeApi({ listComments: vi.fn(async () => []) });
    const result = await openTasksWithLatestPr(api, "o/r", [view({ number: 12 })]);
    expect(result).toEqual([{ taskNumber: 12, prNumber: null, readFailed: false }]);
  });
```

Also update every existing exact-object `toEqual` result literal in the file to carry the field: each element `{ taskNumber: X, prNumber: Y }` becomes `{ taskNumber: X, prNumber: Y, readFailed: false }`; every `prNumber: null` element from a CLEAN read becomes `..., readFailed: false`; the pre-existing thrown-lookup test's task-12 element becomes `readFailed: true`.

- [ ] **Step 2: Run to verify RED**: `cd apps/fleet && bun vitest run test/board.pr-landed.test.ts` — the new tests FAIL (property missing) and the updated exact-object tests FAIL too.

- [ ] **Step 3: Implement.** In `src/board/pr-landed.ts`:

Replace the `OpenTaskPr` doc comment + interface (lines 56-64) with:

```ts
/** One open task, and the PR number its latest result envelope names —
 *  `null` when there is no envelope yet, or the newest one names no `pr`
 *  artifact. `null` is carried rather than the task being dropped: both
 *  callers report "no PR artifact found" as its own outcome, not a silent
 *  omission. `readFailed` (#416 item 3-tail) says which side of the
 *  distinction a `prNumber: null` came from: `true` is "this task's
 *  comments could not be read at all" (a thrown showTask or its own
 *  `{ok:false}`), `false` is "read fine, the envelope names no PR". The two
 *  original callers ignore it — promote-close and task-reap degrade per
 *  task and `null` is their degrade answer either way; open-prs.ts reads
 *  it to fail its whole scan (a false zero to --strict-unmerged), which is
 *  why it cannot be re-derived there from `prNumber === null` alone. */
export interface OpenTaskPr {
  taskNumber: number;
  prNumber: number | null;
  readFailed: boolean;
}
```

In the loop (lines 141-163): declare `let readFailed = false;` beside `let prNumber: number | null = null;`; set `readFailed = true;` inside BOTH the `else` branch (the `{ok:false}` showTask, keeping the existing console.error) and the `catch` (the thrown showTask, same); push `{ taskNumber: task.number, prNumber, readFailed }`.

- [ ] **Step 4: Run to verify GREEN**: `cd apps/fleet && bun vitest run test/board.pr-landed.test.ts` — all pass. Also `bun vitest run test/board.open-prs.test.ts test/board.routes.test.ts test/studio.task-reap.test.ts` (existing consumers — none read the new field, so all must stay green as-is).

- [ ] **Step 5: Header comment fix (item 1).** Replace the file header (lines 1-11) with:

```ts
// Board issue #8: the ONE shared "which open tasks claim a PR in their
// latest envelope" scan, written once and walked from three directions:
//   - src/github/promote-close.ts (push-triggered, run inside ctx.waitUntil):
//     a push just landed; check whether any open task's claimed PR shows up
//     in THAT push's own commit list.
//   - src/studio/task-reap.ts (poll-triggered, no push exists): the SAME
//     question, answered by asking GitHub directly whether the claimed PR's
//     merge commit is now an ancestor of the default branch.
//   - src/board/open-prs.ts (#332's studio-scoped read, synchronous route
//     handler, one bounded scan per studio per request, NOT inside
//     ctx.waitUntil): which of one studio's assigned tasks' envelopes name
//     a PR, asked for that studio's unmerged-PR answer only.
// No caller re-implements the envelope scan itself — only HOW "landed" (or
// "unmerged") is decided differs, and that decision lives entirely in each
// caller.
//
// Reuses src/board/verify.ts's own findLatestResultEnvelope (comments
// scanned BACKWARDS for the newest intent:"result" envelope) — board task
// #119's precedent for "the current truth about a task's result lives in
// its newest result envelope, not necessarily its last comment", applied
// here instead of re-derived.
```

In the `OPEN_TASKS_SCAN_MAX_CANDIDATES` doc comment, replace the "The math:" paragraph (lines 30-43) with:

```ts
 * The math: three callers now share this ONE scan — github/webhook.ts's
 * deferred envelope cross-check (Path 2, inside `ctx.waitUntil`), studio/
 * task-reap.ts's reap route (via `board/routes.ts`'s `listOpenTasks`), and
 * (#332) open-prs.ts's studio-scoped read — so bounding it here bounds all
 * three for free. The two waitUntil/reap callers run it ONCE per
 * invocation; open-prs.ts runs it once PER STUDIO inside one synchronous
 * route request, and the cross-studio total is that route's own concern,
 * documented beside its Promise.all (board/routes.ts). §5's busiest repo
 * measured 2026-09-24: ~41 candidates today; issue #180 projects ~186 once
 * #163's `listIssues` pagination fix keeps a wider net visible. At 300
 * candidates * 2 subrequests (showTask: getIssue + listComments) = 600,
 * plus listTasks' own BOARD_MAX_PAGES (20) page-fetches, a single scan
 * stays comfortably under Cloudflare's 1000-subrequests-per-invocation cap
 * even past today's projection — and where wall-clock matters (the
 * synchronous route, not the deferred paths) the per-studio scans run
 * concurrently, which changes only wall-clock, never the count.
```

Keep the "KNOWN LIMITATION" paragraph as-is (still accurate).

- [ ] **Step 6: Commit + push.** Commit the failing tests FIRST (tests only), push, then commit the implementation, push:

```bash
git add apps/fleet/test/board.pr-landed.test.ts
git commit -m "test(fleet): RED — pin OpenTaskPr.readFailed before the field exists (refs #332, #416)"
LEFTHOOK=0 git push -u origin fix-416-carried-review-findings
git add apps/fleet/src/board/pr-landed.ts
git commit -m "feat(fleet): OpenTaskPr.readFailed distinguishes unread task from no-PR; header names three callers (refs #332, #416)"
LEFTHOOK=0 git push
```

Match `git log origin/main --oneline -5` style for trailers; drop Co-Authored-By if the log shows none.

### Task 2: open-prs.ts — unread task fails the scan (item 3-tail, consumer half)

**Files:**
- Modify: `apps/fleet/src/board/open-prs.ts:82-118` (loop) + module doc comment (the "Degrades per task" paragraph, lines 51-63)
- Test: `apps/fleet/test/board.open-prs.test.ts` (replace 1 test, add 1)

**Interfaces:**
- Consumes: `OpenTaskPr.readFailed` from Task 1.
- Produces: `studioOpenPrs` contract change — a task whose `showTask` could not be read fails the WHOLE scan (`{ok:false, status:502, message: ...}`), same fail-closed family as a thrown `getPullRequest`. The route's `unknown` array (from #417) carries it to the CLI.

- [ ] **Step 1: Write the failing tests** in `test/board.open-prs.test.ts`. REPLACE the existing "one task's showTask throwing degrades to nothing for THAT task" test with:

```ts
  // #416 item 3-tail: a task whose comments could not be read is a hole in
  // the scan, not a "no PR" answer — the route's `unknown` array (a failed
  // studio-wide scan) must be reachable from a per-task GitHub failure too,
  // else strict undercounts on a mid-scan GitHub hiccup (the exact gap the
  // #417 status comment left open).
  it("one task's showTask throwing fails the whole scan — {ok:false}, never a silent no-PR for that task", async () => {
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = tasksApi([view({ number: 12 }), view({ number: 13 })], { 13: [envelopeComment(docB)] }, {
      getIssue: vi.fn(async (_repo: string, number: number) => {
        if (number === 12) throw new Error("GitHub 500");
        return task({ number: 13 });
      }),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result).toEqual({
      ok: false,
      status: 502,
      message: expect.stringContaining("#12"),
    });
    expect(errors).toHaveBeenCalled();
  });

  it("a {ok:false} showTask answer for one task fails the scan the same way — both read legs, not just the thrown one", async () => {
    const docB = envelopeDoc({ artifacts: [{ kind: "pr", pr: "11" }] }, 13);
    const api = fakeApi({
      listIssues: vi.fn(async () => [view({ number: 12 }), view({ number: 13 })]),
      getIssue: vi.fn(async (_repo: string, number: number) => task({ number })),
      listComments: vi.fn(async (_repo: string, number: number) =>
        number === 13 ? [envelopeComment(docB)] : []),
    });
    vi.spyOn(boardModule, "showTask").mockImplementation(async (_api, _repo, number: number) =>
      number === 12
        ? { ok: false as const, status: 502, message: "board upstream failed" }
        : ({ ok: true as const, value: { task: task({ number }), comments: [] } } as const));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await studioOpenPrs(api, REPO, MINE);
    expect(result).toEqual({
      ok: false,
      status: 502,
      message: expect.stringContaining("#12"),
    });
    expect(errors).toHaveBeenCalled();
  });
```

Note: the `{ok:false}` leg needs the collaborator spy (`boardModule.showTask`) because a successful `getIssue` + `listComments` pair cannot reach it through the port alone — same collaborator-spy precedent the file header already documents for `listTasks`. Extend the file-header sentence to name both spies.

- [ ] **Step 2: Run RED**: `cd apps/fleet && bun vitest run test/board.open-prs.test.ts` — the 2 new tests FAIL (old contract answers `ok:true` for the thrown task).

- [ ] **Step 3: Implement** in `src/board/open-prs.ts`. Replace the loop (lines 90-118):

```ts
  const tasksWithPr = await openTasksWithLatestPr(api, repo, listed.value);
  const prs: OpenPr[] = [];
  for (const { taskNumber, prNumber, readFailed } of tasksWithPr) {
    // #416 item 3-tail: an unreadable task is a hole in the scan, never a
    // "no PR" answer for it — dropping it would let a mid-scan GitHub
    // failure read as a confirmed zero to --strict-unmerged. Same
    // fail-closed family as a thrown getPullRequest below: the whole scan
    // answers {ok:false} so the route's `unknown` carries it.
    if (readFailed) {
      console.error(`open-prs: reading task #${taskNumber} in ${repo} failed`);
      return { ok: false, status: 502, message: `reading task #${taskNumber} in ${repo} failed` };
    }
    if (prNumber === null) continue;

    try {
      const pr = await api.getPullRequest(repo, prNumber);
      // Merged is the one state that needs no warning — the work landed.
      // Closed-unmerged is the one that must NEVER warn: it can never merge,
      // so a PR closed without merging is a decision already made, and
      // warning about it would nag on every destroy forever. Only an OPEN,
      // unmerged PR is "still waiting on a human" — the exact thing the
      // warning is about.
      if (!pr.merged && pr.open) {
        prs.push({
          taskNumber,
          prNumber,
          title: pr.title,
          url: `https://github.com/${repo}/pull/${prNumber}`,
        });
      }
    } catch (err) {
      // #332 review H2: a PR whose live state cannot be read means this
      // module cannot answer the question it exists for — dropping it
      // would report a false zero to --strict-unmerged. The whole scan
      // reads as failed (the route's `unknown`), never as clean.
      console.error(`open-prs: reading PR #${prNumber} for task #${taskNumber} in ${repo} threw`, err);
      return { ok: false, status: 502, message: `reading PR #${prNumber} for task #${taskNumber} in ${repo} failed` };
    }
  }
  return { ok: true, value: prs };
```

And rewrite the "Degrades per task, never per scan" paragraph of the module doc comment to say: the per-task degrade posture is pr-landed.ts's own, owned by the two original callers (promote-close, task-reap); THIS caller instead treats an unread task as scan-fatal — `{ok:false}` — because a dropped task would undercount to --strict-unmerged. Keep the H2 paragraph (thrown getPullRequest fails the scan) intact; the unread-task rule joins that same fail-closed family.

- [ ] **Step 4: Run GREEN**: `bun vitest run test/board.open-prs.test.ts` — all pass. Then consumers: `bun vitest run test/board.open-prs-route.test.ts` (a `{ok:false}` studioOpenPrs lands in `unknown`, already covered).

- [ ] **Step 5: Commit + push**:

```bash
git add apps/fleet/test/board.open-prs.test.ts
git commit -m "test(fleet): RED — studioOpenPrs must fail on an unread task (refs #332, #416)"
LEFTHOOK=0 git push
git add apps/fleet/src/board/open-prs.ts
git commit -m "feat(fleet): unread task fails studioOpenPrs scan — route unknown covers the per-task hole (refs #332, #416)"
LEFTHOOK=0 git push
```

### Task 3: routes.ts — Promise.all over studios (item 2) + cross-studio subrequest math (item 5)

**Files:**
- Modify: `apps/fleet/src/board/routes.ts:419-505` (the open-prs section comment + handleOpenPrsRoute loop)
- Test: `apps/fleet/test/board.open-prs-route.test.ts` (add 1 test)

**Interfaces:**
- Consumes: `studioOpenPrs`, unchanged signature.
- Produces: `handleOpenPrsRoute` behavior change only — same 200 body shape `{ repo, prs, unknown }`, scans concurrent instead of sequential. No test pins JSON key order.

- [ ] **Step 1: Write the failing test** in `test/board.open-prs-route.test.ts`, inside the main describe, after the "`{ok:false}` studioOpenPrs answer" test:

```ts
  // #416 item 2: one route request scans every studio of the repo
  // CONCURRENTLY (Promise.all), not per-studio sequentially — fleet ls
  // wall-clock drops by the studio count while the subrequest total is
  // unchanged. Pinned behaviorally, not by source text: a scan that blocks
  // until BOTH have started proves the second never waited for the first.
  it("scans the studios of one repo concurrently — a blocked first studio never delays the second's start", async () => {
    authorized();
    await seedStudio("websites--web-studio", "acme-org/websites");
    await seedStudio("websites--release-studio", "acme-org/websites");
    let started = 0;
    let bothStartedTogether = false;
    vi.spyOn(openPrsModule, "studioOpenPrs").mockImplementation(async () => {
      started += 1;
      if (started === 2) bothStartedTogether = true;
      await new Promise<void>((resolve) => {
        const check = () => (started >= 2 ? resolve() : setTimeout(check, 0));
        check();
      });
      return { ok: true as const, value: [] };
    });
    const res = await handleBoard(req("/studio/board/open-prs?repo=acme-org/websites"), testEnv, fakeApi(), reach);
    expect(res.status).toBe(200);
    expect(bothStartedTogether).toBe(true);
  });
```

- [ ] **Step 2: Run RED**: `cd apps/fleet && bun vitest run test/board.open-prs-route.test.ts` — the new test fails via timeout (sequential loop: studio 2 never starts while studio 1's scan is blocked).

- [ ] **Step 3: Implement** in `src/board/routes.ts`. Replace the for-loop in `handleOpenPrsRoute` (lines 488-503) with:

```ts
  const prs: Record<string, OpenPr[]> = {};
  const unknown: string[] = [];
  // #416 item 2: concurrent, not sequential — wall-clock drops by the
  // studio count while the subrequest total is identical (Promise.all
  // changes scheduling, never how many calls run). Each studio's result
  // lands in its own slot by input order below, never pushed as it
  // resolves, so prs/unknown ordering stays registry-stable.
  const results = await Promise.all(studios.map((studio) =>
    (async () => {
      try {
        const result = await studioOpenPrs(api, repo, studio.id);
        if (result.ok) return { id: studio.id, prs: result.value } as const;
        console.error(`open-prs: scanning ${studio.id} in ${repo} failed (${result.status}): ${result.message}`);
        return { id: studio.id, unknown: true } as const;
      } catch (err) {
        console.error(`open-prs: scanning ${studio.id} in ${repo} threw`, err);
        return { id: studio.id, unknown: true } as const;
      }
    })(),
  ));
  for (const r of results) {
    if ("unknown" in r) unknown.push(r.id);
    else prs[r.id] = r.prs;
  }
  return Response.json({ repo, prs, unknown });
```

And add the item-5 math to the section comment (after the "WHY BEST-EFFORT DEGRADE" paragraph, before the closing):

```ts
// WHY CONCURRENT (#416 item 2), with the cross-studio subrequest budget
// made explicit (#416 item 5): one studio's scan is bounded by
// OPEN_TASKS_SCAN_MAX_CANDIDATES (300) * 2 subrequests per showTask
// (getIssue + listComments), plus the studio-wide listTasks
// (<= BOARD_MAX_PAGES=20) and one getPullRequest per envelope-named PR —
// worst case ~(300 * 2) + 20 + 300 ≈ 920 per studio, and the
// 1000-subrequest cap is PER INVOCATION, so a repo with several studios
// could in principle multiply that. Today's reality is far below it
// (measured 2026-09-24: ~41 candidates on the busiest repo, ~2
// subrequests each) and a real crossing first shows up as per-studio
// degrade logs, never a silent wrong answer. Recorded rather than capped:
// the route's callers (fleet ls, destroy's strict check) read a missing
// lane as "unknown", so a capped studio would degrade loudly anyway. If a
// repo ever approaches the cap, the fix is a per-request ceiling like
// pr-landed's own bound, filed as a follow-up then.
```

- [ ] **Step 4: Run GREEN**: `cd apps/fleet && bun vitest run test/board.open-prs-route.test.ts` — all pass.

- [ ] **Step 5: Commit + push**:

```bash
git add apps/fleet/test/board.open-prs-route.test.ts
git commit -m "test(fleet): RED — open-prs route must scan studios concurrently (refs #332, #416)"
LEFTHOOK=0 git push
git add apps/fleet/src/board/routes.ts
git commit -m "perf(fleet): open-prs route scans studios concurrently; cross-studio subrequest math recorded (refs #332, #416)"
LEFTHOOK=0 git push
```

### Task 4: cli-destroy-flags.test.ts → behavioral subprocess tests (item 4)
> Executed 2026-10-12 by #466 (d060ab5): `cli-destroy-flags.test.ts` deleted, behavioral tests live in `test/bun/cli-destroy-unmerged.test.ts`. The unchecked boxes below are completed history.

**Files:**
- Delete: `apps/fleet/test/bun/cli-destroy-flags.test.ts`
- Modify: `apps/fleet/test/bun/cli-destroy-unmerged.test.ts` (extend the subprocess harness)
- Check + fix cross-references: `grep -rn "cli-destroy-flags" apps/fleet` — the unmerged-test file's header cites it; rewrite that sentence to describe the behavioral tests replacing it.

**Interfaces:**
- Consumes: the existing subprocess harness in `cli-destroy-unmerged.test.ts` (`tmpHomeWithCredentials`, `run`); a NEW `startDestroyWorker` helper modeled on the existing `startWorker` but also answering `POST /studio/<id>/destroy` and recording full `pathname + search`.
- Produces: behavioral coverage for all four source-pin claims: (a) flags reach the destroy URL query; (b) no flags = bare path; (c) strict refusal with found PRs prints + exits 1 before any destroy POST; (d) park warning prints only after a confirmed stop, never on a 500.

- [ ] **Step 1: Add the tests** to the subprocess describe block in `cli-destroy-unmerged.test.ts`:

```ts
  /** The Worker stand-in, destroy-capable: GET /studio/<id>/status answers a
   *  row (state given), GET /studio/board/open-prs answers the scripted body,
   *  POST /studio/<id>/destroy answers a stopped row, and every request is
   *  recorded WITH its query string so "which flags reached the URL" is an
   *  assertion on a real request, never a source pin. */
  function startDestroyWorker(openPrsBody: unknown, statusState: "running" | "stopped" = "stopped") {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        requests.push(`${req.method} ${u.pathname}${u.search}`);
        if (u.pathname === `/studio/${ID}/status` && req.method === "GET") {
          return Response.json({ id: ID, state: statusState, repoSlug: "acme-org/websites" });
        }
        if (u.pathname === "/studio/board/open-prs" && req.method === "GET") {
          return Response.json(openPrsBody);
        }
        if (u.pathname === `/studio/${ID}/destroy` && req.method === "POST") {
          return Response.json({ id: ID, state: "stopped", repoSlug: "acme-org/websites" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { server, requests };
  }

  test("every destroy flag reaches the request's query string — force, discard-unsynced, park (issue #59, #332)", async () => {
    const { server, requests } = startDestroyWorker({ repo: "acme-org/websites", prs: {}, unknown: [] });
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await run(["destroy", ID, "--force", "--discard-unsynced", "--park"], home);
      expect(requests).toContain(`POST /studio/${ID}/destroy?force=true&discard-unsynced=true&park=true`);
      expect(r.code).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("no flags: the destroy request carries a bare /destroy path — no empty query string", async () => {
    const { server, requests } = startDestroyWorker({ repo: "acme-org/websites", prs: {}, unknown: [] });
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      await run(["destroy", ID], home);
      expect(requests).toContain(`POST /studio/${ID}/destroy`);
    } finally {
      server.stop(true);
    }
  });

  test("strict refusal with real PRs found: prints the refusal, exits 1, and the destroy never fired", async () => {
    const { server, requests } = startDestroyWorker({
      repo: "acme-org/websites", prs: { [ID]: [pr(9), pr(31)] }, unknown: [],
    });
    const home = tmpHomeWithCredentials(`http://127.0.0.1:${server.port}`);
    try {
      const r = await run(["destroy", ID, "--strict-unmerged"], home);
      expect(r.err).toContain("fleet destroy: refusing: 2 unmerged PR(s) still open (--strict-unmerged)");
      expect(r.code).toBe(1);
      expect(requests.some((p) => p.endsWith("/destroy"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  // #332's ordering pin, behavioral: the park warning prints only on the
  // CONFIRMED teardown path — a destroy answered 500 prints none at all.
  test("park warning prints after a confirmed stop; a 500 destroy prints no park warning", async () => {
    // Confirmed stop: the warning names the PR on stderr, exit 0.
    const ok = startDestroyWorker({ repo: "acme-org/websites", prs: { [ID]: [pr(9)] }, unknown: [] });
    const okHome = tmpHomeWithCredentials(`http://127.0.0.1:${ok.server.port}`);
    try {
      const r = await run(["destroy", ID], okHome);
      expect(r.err).toContain("park warning: websites--web-studio still has 1 unmerged PR(s)");
      expect(r.code).toBe(0);
    } finally {
      ok.server.stop(true);
    }

    // A destroy answered 500: no teardown, no park warning, exit 1.
    const requests: string[] = [];
    const failServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        requests.push(`${req.method} ${u.pathname}`);
        if (u.pathname === `/studio/${ID}/status` && req.method === "GET") {
          return Response.json({ id: ID, state: "running", repoSlug: "acme-org/websites" });
        }
        if (u.pathname === "/studio/board/open-prs" && req.method === "GET") {
          return Response.json({ repo: "acme-org/websites", prs: { [ID]: [pr(9)] }, unknown: [] });
        }
        if (u.pathname === `/studio/${ID}/destroy` && req.method === "POST") {
          return new Response("destroy refused", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const failHome = tmpHomeWithCredentials(`http://127.0.0.1:${failServer.port}`);
    try {
      const r = await run(["destroy", ID], failHome);
      expect(r.err).not.toContain("park warning");
      expect(r.code).toBe(1);
    } finally {
      failServer.stop(true);
    }
  });
```

- [ ] **Step 2: Run GREEN** (tests of CURRENT behavior — expected to pass immediately; the migration's RED is the file deletion): `cd apps/fleet && bun test test/bun/cli-destroy-unmerged.test.ts`. If any NEW test fails, the CLI wiring has a real bug — STOP and report instead of forcing green.

- [ ] **Step 3: Delete the source-pin file** and fix cross-references:

```bash
git rm apps/fleet/test/bun/cli-destroy-flags.test.ts
grep -rn "cli-destroy-flags" apps/fleet --include="*.ts" --include="*.md"
```

Rewrite each hit's sentence (the unmerged-test file's header cites the source-pin technique as "the structural half" — replace with: the behavioral tests in this file now carry the structural half too: request recording proves flag wiring, refusal-before-destroy, and warning-after-stop without reading source text).

- [ ] **Step 4: Run the touched set + lies check**:

```bash
cd apps/fleet && bun test test/bun/cli-destroy-unmerged.test.ts test/bun/cli.fleet-ls-prs.test.ts
bun run test-lies-check
```

test-lies-check must stay clean and no longer scans the deleted file.

- [ ] **Step 5: Commit + push**:

```bash
git add -A apps/fleet/test/bun/
git commit -m "test(fleet): cmdDestroy source pins replaced by subprocess behavioral tests (refs #332, #416)"
LEFTHOOK=0 git push
```

### Task 5: Verification (QA) + done record

- [ ] Sequential, one heavy gate at a time, from `apps/fleet`:
  1. `bun run check` — exit 0 (5 tsc projects).
  2. `bun vitest run test/board.pr-landed.test.ts test/board.open-prs.test.ts test/board.open-prs-route.test.ts` — exit 0.
  3. `bun test test/bun/cli-destroy-unmerged.test.ts test/bun/cli.fleet-ls-prs.test.ts` — exit 0.
  4. `bun run test-lies-check` — clean, no longer counting cli-destroy-flags.test.ts.
  5. `bun run english-check` — clean.
- [ ] Write `/workspace/.fleet/done/416.json` (dev dispatch): plan path `apps/fleet/docs/plans/2026-10-12-fix-416-carried-review-findings.md`, one verification entry per command above with the real tail output, `verification_intent` mirroring the 332.json shape (PENDING-PR-FOR-https://github.com/rafarc21/fleetflare/issues/416, steps, expected).

### Task 6: Review (Code Reviewer, fresh context) — max 2 rounds

- [ ] Round 1: dispatch code-reviewer with the branch diff (`git diff origin/main...fix-416-carried-review-findings`). Spec axis (issue #416's five items vs the diff) and Standards axis (skills/deep-modules checklist + CODING_STANDARDS.md) reported separately.
- [ ] Route findings: Standards-axis → fresh Developer refactor commit; Spec-axis → back to the implementing Developer as a board-issue comment, never silently reworked.
- [ ] Round 2 only if round 1 cited blocking findings. Still cited after round 2: file one follow-up task (`fleet task new`) listing the remainder, note it in the envelope, PR proceeds.

### Task 7: PR + envelope

- [ ] PR body per `.github/pull_request_template.md`: Summary (one-paragraph verdict + the route's before/after scan shape), Evidence (verification outputs from Task 5), Merge Danger — Door: **two-way** (no path in ONE_WAY_GLOBS: src/board/**, test/**, cli/fleet.ts comment edits only), Blast Radius: one line.
- [ ] Envelope comment on https://github.com/rafarc21/fleetflare/issues/416: result, evidence, artifacts, status.

## Self-Review

- Spec coverage: item 1 → Task 1 Step 5; item 2 → Task 3; item 3-tail → Tasks 1+2; item 4 → Task 4; item 5 → Task 3 (comment) — all five covered. Item 3 route-half intentionally skipped (shipped in #417, confirmed by the issue's own status comment).
- Placeholder scan: no TBDs; every step carries its content.
- Type consistency: `readFailed` name and boolean type consistent across pr-landed.ts, open-prs.ts, and both test files. `startDestroyWorker` name used consistently in Task 4.
