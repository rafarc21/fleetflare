# #265 mutation check: `exists`'s 404 branch, RED then GREEN (2026-10-09)

The plan (docs/superpowers/plans/2026-10-09-github-api-ghrequest-265.md —
"Prove they bite (mutation check)" under Characterization tests FIRST, and
the RED/GREEN story under Verification) requires temporarily breaking one
existence fn's 404 branch, watching a test go RED, reverting, and recording
the run in the PR evidence. Review round 1 found that record existed nowhere
durable on the branch; this file is it.

The check, in order, with an otherwise clean tree:

1. In `apps/fleet/src/github/api.ts`, the ONE private `exists` helper's
   `if (res.status === 404) return false;` was flipped to
   `if (res.status === 404) return true;` — uncommitted, nothing else
   touched.
2. `bun run vitest run test/github.api.test.ts` (from `apps/fleet`) — the
   single test file, no other gate alongside it. RED: the six 404 tests
   fail, one per existence fn (`pullRequestExists`, `branchExists`,
   `commitExists`, `issueExists`, `pathExists`, `compareExists`); the
   other 104 still pass.
3. Mutation reverted (`git checkout -- apps/fleet/src/github/api.ts`);
   `git diff` clean again.
4. The same single-file run again: 110/110 green.

Both blocks below are the real command output, unedited. The RED block is
the run's output minus only the ten leading lines before the per-file
summary (the vitest banner and node_modules sourcemap warnings); its final
eight lines are the `tail -8` of the run. The GREEN block is the `tail -8`
of the reverted run, verbatim.

## RED — `exists` mutated to answer 404 with `true`

```text
 ❯ test/github.api.test.ts (110 tests | 6 failed) 69ms
     × 404: false, not a throw 8ms
     × 404: false, not a throw 0ms
     × 404: false, not a throw 1ms
     × 404: false, not a throw 0ms
     × 404: false, not a throw 0ms
     × 404: false, not a throw 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/github.api.test.ts > pullRequestExists > 404: false, not a throw
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/github.api.test.ts:706:57
    704|   it("404: false, not a throw", async () => {
    705|     respond = () => new Response('{"message":"Not Found"}', { status: …
    706|     expect(await pullRequestExists("tok", "o/r", 4242)).toBe(false);
       |                                                         ^
    707|   });
    708|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/6]⎯

 FAIL  test/github.api.test.ts > branchExists > 404: false, not a throw
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/github.api.test.ts:730:61
    728|   it("404: false, not a throw", async () => {
    729|     respond = () => new Response('{"message":"Not Found"}', { status: …
    730|     expect(await branchExists("tok", "o/r", "release/1.0")).toBe(false…
       |                                                             ^
    731|   });
    732|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/6]⎯

 FAIL  test/github.api.test.ts > commitExists > 404: false, not a throw
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/github.api.test.ts:754:56
    752|   it("404: false, not a throw", async () => {
    753|     respond = () => new Response('{"message":"Not Found"}', { status: …
    754|     expect(await commitExists("tok", "o/r", "abc123")).toBe(false);
       |                                                        ^
    755|   });
    756|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/6]⎯

 FAIL  test/github.api.test.ts > issueExists > 404: false, not a throw
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/github.api.test.ts:778:50
    776|   it("404: false, not a throw", async () => {
    777|     respond = () => new Response('{"message":"Not Found"}', { status: …
    778|     expect(await issueExists("tok", "o/r", 126)).toBe(false);
       |                                                  ^
    779|   });
    780|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/6]⎯

 FAIL  test/github.api.test.ts > pathExists > 404: false, not a throw
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/github.api.test.ts:802:86
    800|   it("404: false, not a throw", async () => {
    801|     respond = () => new Response('{"message":"Not Found"}', { status: …
    802|     expect(await pathExists("tok", "o/r", "fleet/blueprint/roles/pilot…
       |                                                                                      ^
    803|   });
    804|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/6]⎯

 FAIL  test/github.api.test.ts > compareExists > 404: false, not a throw
AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ test/github.api.test.ts:828:75
    826|   it("404: false, not a throw", async () => {
    827|     respond = () => new Response('{"message":"Not Found"}', { status: …
    828|     expect(await compareExists("tok", "o/r", "release/1.0", "feat/ship…
       |                                                                           ^
    829|   });
    830|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/6]⎯


 Test Files  1 failed (1)
      Tests  6 failed | 104 passed (110)
   Start at  16:25:22
   Duration  6.80s (transform 3.01s, setup 5.64s, import 105ms, tests 69ms, environment 0ms)

error: "vitest" exited with code 1
```

## GREEN — mutation reverted, same test file

```text
Sourcemap for "/workspace/fleetflare/apps/fleet/node_modules/@cloudflare/sandbox/node_modules/@cloudflare/containers/dist/lib/helpers.js" points to missing source files
Sourcemap for "/workspace/fleetflare/apps/fleet/node_modules/@cloudflare/sandbox/node_modules/@cloudflare/containers/dist/lib/utils.js" points to missing source files

 Test Files  1 passed (1)
      Tests  110 passed (110)
   Start at  16:26:08
   Duration  6.07s (transform 2.58s, setup 4.91s, import 98ms, tests 110ms, environment 0ms)

```
