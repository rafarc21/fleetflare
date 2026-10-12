# Plan — one cli/diag.ts: errText fold + body decode (refs #400)

Sweep-5 finding F2 (parent #394). Two shapes of one concern, each duplicated:

1. `err instanceof Error ? err.message : String(err)` inline at 30 sites
   across 10 cli files. Two already name it `errText` (ff.ts, accounts.ts)
   and export-locally; the other 28 are anonymous.
2. The "decode a Worker error body" dance (HTML `<title>` else JSON `.error`
   else plain slice) written 3x: repair-failure.ts, inspect-request.ts, and
   beside it the destroy/recycle TimeoutError triage (NOT ours).

## New module: apps/fleet/cli/diag.ts

Pure, Bun/node-free imports (same convention as repair-failure.ts's header).

- `errText(err: unknown): string` — `err instanceof Error ? err.message : String(err)`.
- `decodeBody(status: number, text: string, maxChars: number): string` —
  returns the detail AFTER the `status` (no label, no status prefix):
  HTML `<title>` trimmed, else JSON `.error` string capped at maxChars,
  else `text.trim().slice(0, maxChars)`. Parameterized by cap because today's
  two decoders differ only in cap (repair 2000, inspect 300) and inspect has
  no JSON branch — callers that want today's exact inspect behavior pass
  `Number.MAX_SAFE_INTEGER`? NO — inspect migrates to the SAME decodeBody with
  300; the JSON branch is a strictly-better decode for a 409 refusal body
  and both decoders converge on one shape. repair-failure.ts keeps its own
  copy (shared with rescue verbs, Claude lane); only inspect-request.ts migrates.

## Migrate (message-extraction sites only; `err.name` triage lines stay inline)

- fleet.ts: 635, 900, 1884, 2012, 2119, 2420, 2491, 2739 (8 sites)
- accounts.ts: fold local `errText` → import (13 uses)
- ff.ts: fold local `errText` → import (3 uses)
- orca-workspace.ts: 9 sites
- reap.ts: 6 sites
- context-salvage.ts: 106, junior.ts: 196, status-poll.ts: 40
- inspect-request.ts: 41 + decoder 46-48 → `decodeBody(res.status, text, 300)`

NOT touched: destroy-outcome.ts, recycle-outcome.ts (Claude lane rescue);
fleet.ts:2010, inspect-request.ts:32 name-triage lines; accounts-format.ts
(surveyed: zero sites there).

## TDD

1. New `apps/fleet/test/cli.diag.test.ts` golden table: errText (Error,
   non-Error string, non-Error object), decodeBody (HTML title, JSON error
   field, JSON without error field, plain text, empty body, cap applied).
2. RED: run it against missing diag.ts — fails to import.
3. GREEN: implement diag.ts.
4. Migrate sites one file per commit. Existing wording asserted unchanged
   by existing suites: cli.repair-failure.test.ts, cli.inspect-request.test.ts,
   cli.accounts-format.test.ts, bun/accounts-cli.test.ts, bun/fleet-reap.test.ts,
   bun/orca-workspace.test.ts, bun/context-salvage.test.ts, bun/ff-file-task-retry.test.ts,
   bun/rescue-push.test.ts.
5. `bun run check` + `bun run english-check` exit 0 (one at a time, gate budget).
