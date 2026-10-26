# Gate browser guard harness

Repo-agnostic Playwright fixture + reporter the gate injects into browser
legs. It captures CDP console/network traffic, writes per-test evidence
(PNG screenshot + console JSON), and turns any console error/warning, any
`[tag]` debug-log line, or any non-2xx / failed request into a RED leg.
Aborted/canceled fetches are excluded and never flag.

## Files

| File | Role |
|---|---|
| `capture.ts` | CDP console/network capture + the RED rule. Pure. |
| `init-script.ts` | Init-script hook (`Page.addScriptToEvaluateOnNewDocument`) from an env var, plus value redaction. |
| `evidence.ts` | Per-test evidence writer: console JSON, guard JSON, screenshot. |
| `multi-user.ts` | Multi-user spec support: auth-force env + MailHog base. |
| `fixture.ts` | Fixture adapter: guarded page + capture handle. |
| `reporter.ts` | Reporter adapter: one captured test -> evidence + verdict. |

## Env vars

| Var | Meaning |
|---|---|
| `BROWSER_GUARD_INIT_SCRIPT` | Raw JS evaluated on every new document. Used for an App Check debug token. The value is **never logged**: every guard write is redacted against the raw source. |
| `BROWSER_GUARD_AUTH_FORCE` | `"on"` (exact literal, else off) marks a forced-auth multi-user spec. |
| `BROWSER_GUARD_MAILHOG` | MailHog HTTP base (e.g. `http://127.0.0.1:8025`); a spec polls `<base>/api/v2/messages`. |

## Console/network schema

The evidence buckets share one schema with the consumer walk (`#1344` comment
6412381014). Do not rename them:

`consoleErrors`, `consoleWarnings`, `debugLogs`, `exceptions`, `badRequests`,
`canceledRequests`.

Capture rules (measured, do not re-derive):

- `Runtime.enable` + `Log.enable` + `Network.enable`.
- `consoleAPICalled` `error|warning|assert` -> `consoleErrors` /
  `consoleWarnings`; `log|info|debug` whose text starts `[tag]` ->
  `debugLogs`.
- `exceptionThrown` -> `exceptions`.
- `responseReceived` status >= 400 -> `badRequests`.
- `loadingFailed` `canceled:false` -> `badRequests`; `canceled:true` ->
  `canceledRequests` (ignored by the RED rule).
- `Log.enable` replays old entries and Runtime + Log both report one line:
  dedupe by timestamp + type + text.

## Per-test evidence

For each test the harness writes, into an evidence dir:

- `<test>.console.json` — the buckets under `fingerprint` + `at`.
- `<test>.png` — the screenshot.
- `<test>.guard.json` — the verdict summary (buckets + `findings` +
  `failed` when RED).

## Multi-user specs

Two-account flows force a second account via `BROWSER_GUARD_AUTH_FORCE=on`
and reach the mail catcher via `BROWSER_GUARD_MAILHOG`. The
`multi-user.ts` helpers (`isAuthForced`, `mailhogBase`) are the single
place that decision lives, so a spec never re-parses the env itself.