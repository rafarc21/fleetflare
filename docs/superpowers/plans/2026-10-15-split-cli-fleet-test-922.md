# Split cli.fleet.test.ts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Split `apps/fleet/test/cli.fleet.test.ts` into two focused test files: `cli.readiness-format.test.ts` and `cli.fleet-ls.test.ts`, moving whole describe blocks verbatim and keeping shared fixtures local to each file.

**Architecture:** No production code changes; pure test-file reorganization. The readiness formatters belong together because they exercise `cli/readiness-format.ts` rendering; the ls/totals tests belong together because they exercise row-level `fleet ls` output and the #513 staleness budget pins.

**Tech Stack:** Vitest, TypeScript, `@fleetflare/fleet` test conventions.

**Spec:** Issue https://github.com/rafarc21/fleetflare/issues/922

## Global Constraints

- Move describe blocks whole; titles verbatim.
- Shared setup: in-file `row`/`burn` fixtures + `DEAD_FRAME` import duplicated from `test/studio.failover-real-panes.test.ts`.
- `formatDeadAccounts` renders `CLAUDE_CODE_OAUTH_TOKEN_n` as inert fixture strings only.
- No closing keywords (#907 remains open).
- Never import `cli/fleet.ts` from test files; keep Bun-free-module split (`cli/fleet-totals.ts` and `cli/readiness-format.ts` only).
- Each new file must type-check under root `tsconfig.json` and pass under `vitest run`.

## File Structure

- `apps/fleet/test/cli.readiness-format.test.ts` — new; holds readiness-format describe blocks `:38-1045`.
- `apps/fleet/test/cli.fleet-ls.test.ts` — new; holds `fleetTotals`, `formatDeadAccounts`, `formatActivity`, `lsJsonRows`, and staleness-budget describe blocks (`:38-66`, `:1046-1560`).
- `apps/fleet/test/cli.fleet.test.ts` — delete; superseded by the two new files.

## Task 1: Create cli.readiness-format.test.ts

**Files:**
- Create: `apps/fleet/test/cli.readiness-format.test.ts`
- Source: `apps/fleet/test/cli.fleet.test.ts:1-1045`

- [ ] **Step 1: Copy the readiness-format slice**

Copy lines `1-1045` of `cli.fleet.test.ts` into the new file.
Keep imports exactly as they are:

```typescript
import { describe, expect, it } from "vitest";
import { fleetTotals } from "../cli/fleet-totals";
import {
  ageSeconds,
  formatReady, formatCheckedAt, formatAge, readyOverride, formatSession, formatState, formatSessionGuards,
  formatObservedLines, formatSurvivalBriefs, formatActivity, ACTIVITY_DO_STALE_SECONDS, lsJsonRows,
  formatDeadAccounts,
} from "../cli/readiness-format";
```

Remove any imports the file no longer needs after the split (Task 3 cleanup).

- [ ] **Step 2: Run the new file in isolation**

```bash
cd /workspace/fleetflare/apps/fleet
npx vitest run test/cli.readiness-format.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 3: Commit**

```bash
git add apps/fleet/test/cli.readiness-format.test.ts
git commit -m "test(fleet): S45-F9 split readiness-format tests into cli.readiness-format.test.ts (refs #907, refs #922)"
```

## Task 2: Create cli.fleet-ls.test.ts

**Files:**
- Create: `apps/fleet/test/cli.fleet-ls.test.ts`
- Source: `apps/fleet/test/cli.fleet.test.ts:1046-1560` plus the shared setup block `:1-37` and the `fleetTotals` block `:38-66`.

- [ ] **Step 1: Build the new file**

Copy the shared setup block `cli.fleet.test.ts:1-37` plus the `fleetTotals` block `:38-66`, then copy `:1046-1560` (formatDeadAccounts through staleness-budget twins).

Imports needed (trim to what this file uses):

```typescript
import { describe, expect, it } from "vitest";
import { fleetTotals } from "../cli/fleet-totals";
import {
  formatDeadAccounts, formatActivity, lsJsonRows, ACTIVITY_DO_STALE_SECONDS,
} from "../cli/readiness-format";
import type { StudioStatus } from "../src/studio/types";
import type { Burn } from "../src/studio/burn";
import { emptyObserved } from "../src/studio/observed";
import { readActivityFrame, nextActivity, type Activity } from "../src/studio/activity";
import type { MemberAlert } from "../src/studio/member-alerts";
import { SHIP_TRANSCRIPT_SECONDS } from "../src/studio/ship-cadence";
import { DEAD_FRAME } from "./studio.failover-real-panes.test";
import { row, burnRow } from "./helpers/studio-row";
```

Definitions copied from the original setup block:

```typescript
const burn = (o: Partial<Burn> = {}) => burnRow({ window5hStart: "2026-08-16T00:00:00.000Z", ...o });
const status = (o: Partial<StudioStatus> = {}) => row({ id: "websites--pilot", state: "running", ...o });
```

- [ ] **Step 2: Run the new file in isolation**

```bash
cd /workspace/fleetflare/apps/fleet
npx vitest run test/cli.fleet-ls.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 3: Commit**

```bash
git add apps/fleet/test/cli.fleet-ls.test.ts
git commit -m "test(fleet): S45-F9 split ls rows + totals tests into cli.fleet-ls.test.ts (refs #907, refs #922)"
```

## Task 3: Delete cli.fleet.test.ts and finalize

**Files:**
- Delete: `apps/fleet/test/cli.fleet.test.ts`

- [ ] **Step 1: Remove the old file**

```bash
rm apps/fleet/test/cli.fleet.test.ts
```

- [ ] **Step 2: Verify no stray references**

```bash
grep -R "cli\.fleet\.test" apps/fleet || true
```

Expected: no matches inside `apps/fleet`.

- [ ] **Step 3: Run both new files together**

```bash
cd /workspace/fleetflare/apps/fleet
npx vitest run test/cli.readiness-format.test.ts test/cli.fleet-ls.test.ts
```

Expected: both suites pass.

- [ ] **Step 4: Type-check the test project**

```bash
cd /workspace/fleetflare/apps/fleet
npx tsc --noEmit -p test
```

Expected: no type errors.

- [ ] **Step 5: Commit the deletion**

```bash
git add apps/fleet/test/cli.fleet.test.ts
git commit -m "test(fleet): S45-F9 remove superseded cli.fleet.test.ts after split (refs #907, refs #922)"
```

## Self-Review

1. Spec coverage: all 15 describe blocks from the original file are accounted for — readiness-format file gets `:38-1045` (13 describes), fleet-ls file gets `:38-66` + `:1046-1560` (fleetTotals, formatDeadAccounts, formatActivity, lsJsonRows, staleness twins).
2. Placeholder scan: no TBD/TODO/fill-in-left-later steps; every command and expected outcome is explicit.
3. Type consistency: imports copied verbatim except for trimming unused ones; fixture builders `row`, `burnRow`, and `DEAD_FRAME` kept identical.
