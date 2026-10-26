# Gate browser guard harness

Repo-agnostic Playwright fixture + reporter the gate injects into browser
legs. It captures CDP console/network traffic across the main page, its
iframes, dedicated workers, service workers, and `window.open` popups;
writes per-test evidence (PNG screenshot + console JSON + guard JSON); and
turns any console error/warning, any `[tag]` debug-log line, any uncaught
exception, or any non-2xx / failed request into a RED leg. Aborted/canceled
fetches are excluded and never flag. A browser leg that runs zero tests is
RED `DID-NOT-RUN`.

## Files

| File | Role |
|---|---|
| `capture.ts` | Collector + normalizers + the RED rule. Pure. |
| `attach.ts` | Auto-attach wiring for workers / service workers (non-flatten). Pure. |
| `init-script.ts` | Init-script hook from an env var, plus token-value redaction. |
| `evidence.ts` | Per-test evidence writer, RED verdict, allowlist, redaction. |
| `multi-user.ts` | Multi-user spec support: auth-force env + MailHog base. |
| `fixture.ts` | Fixture adapter: guarded page + shared collector + popup attach. |
| `reporter.ts` | Reporter adapter: per-test evidence + the DID-NOT-RUN rule. |

## Env vars

| Var | Meaning |
|---|---|
| `BROWSER_GUARD_INIT_SCRIPT` | Raw JS evaluated on every new document. Used for an App Check debug token. Its string-literal **values** are redacted from every guard write **by default** — the reporter derives them from this var, no caller input needed. |
| `BROWSER_GUARD_AUTH_FORCE` | `"on"` (exact literal, else off) marks a forced-auth multi-user spec. |
| `BROWSER_GUARD_MAILHOG` | MailHog HTTP base (e.g. `http://127.0.0.1:8025`); a spec polls `<base>/api/v2/messages`. |

## Console/network schema

The evidence buckets share one schema with the consumer walk (`#1344` comment
6412381014). Do not rename them:

`consoleErrors`, `consoleWarnings`, `debugLogs`, `exceptions`, `badRequests`,
`canceledRequests`.

Capture rules (measured, do not re-derive):

- `Runtime.enable` + `Log.enable`.
- `consoleAPICalled` `error|warning|assert` -> `consoleErrors` /
  `consoleWarnings`; `log|info|debug` whose text starts `[tag]` ->
  `debugLogs`.
- `exceptionThrown` -> `exceptions`.
- Network is **context-level**: `context.on('response')` status >= 400 ->
  `badRequests`; `context.on('requestfailed')` `net::ERR_ABORTED` ->
  `canceledRequests` (ignored by the RED rule), any other failure ->
  `badRequests`.
- HTTP faults count from Network events only: a `Log` entry with source
  `network` ("Failed to load resource") is dropped.
- Dedupe by raw float timestamp + type + text, not an ms-truncated ISO.

## Target capture (measured, do not re-derive)

- Console (main page + iframes + dedicated workers + service workers):
  page-root **non-flatten** `Target.setAutoAttach` +
  `sendMessageToTarget` / `receivedMessageFromTarget`.
- Network (main page + iframes + workers + popups from their first
  page-load): context-level `response` / `requestfailed` events.
- `window.open` popups: never auto-attached; the fixture attaches each via
  `context.on('page')`.

## Allowlist

Known-safe console/network rows a guard may tolerate. Each row needs all
three fields, a pattern of at least 4 chars matched against the underlying
console/network entry text (never the `[console]` prefix, never a
wildcard), a why of at least 8 chars, and a `#<number>` issue ref:

```ts
{ pattern: "/analytics-ping", why: "third-party telemetry beacon", issue: "#123" }
```

A finding matching a row is dropped from the verdict; the raw buckets keep
the entry.

## Per-test evidence

For each test the harness writes, into an evidence dir:

- `<test>.console.json` — the buckets under `fingerprint` + `at`.
- `<test>.png` — the screenshot the harness takes itself.
- `<test>.guard.json` — the verdict summary (buckets + `findings` +
  `failed` when RED).

## DID-NOT-RUN

Zero tests executed in a browser leg -> RED `[guard] DID-NOT-RUN: zero
tests executed`, recorded as a `did-not-run` evidence file with empty
buckets.

## Manifest contract

The fleet reads `manifest.json` at the root of a browser leg's evidence dir
to decide whether the leg really ran (#1381). `executed` alone is not proof:
an early harness wrote the SCHEDULED count there (317) while only 221 ran.
The manifest must carry the full outcome breakdown — all six counts required,
non-negative integers:

```json
{
  "executed": 221,
  "passed": 2,
  "failed": 219,
  "flaky": 0,
  "skipped": 0,
  "didNotRun": 52
}
```

The fleet verdict from those counts:

- `passed + failed + flaky == 0` -> RED `DID-NOT-RUN` (nothing reached an
  outcome).
- `didNotRun > 0` -> RED `DID-NOT-RUN` even when some tests passed.
- A manifest missing any count (the old `{executed}` alone) -> RED
  `manifest lacks counts`, never green.
- All counts present, `passed + failed + flaky > 0`, `didNotRun == 0` ->
  the only shape that greens the leg.

A count that is not a non-negative integer (`null`, a boolean, a numeric
string, a fraction, negative, `NaN`) is malformed and reads RED, never
coerced. `executed` less than `passed + failed + flaky` is inconsistent and
reads RED.

A harness writes `manifest.json` into the evidence dir; the counts are what
the fleet reads, not the scheduled test count.

## Multi-user specs

Two-account flows force a second account via `BROWSER_GUARD_AUTH_FORCE=on`
and reach the mail catcher via `BROWSER_GUARD_MAILHOG`. The
`multi-user.ts` helpers (`isAuthForced`, `mailhogBase`) are the single
place that decision lives, so a spec never re-parses the env itself.