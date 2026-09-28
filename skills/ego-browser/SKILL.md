---
name: ego-browser
description: Use for any real-browser automation inside a studio container — navigating pages, clicking, filling forms, screenshots, semantic snapshots. This is the required tool for that job here: agent-browser is NOT installed and ego lite itself cannot install in a headless Linux container (Mac/Windows-only). `ego-browser` is a Playwright-backed shim that speaks ego lite's own documented API, already on PATH, no setup needed. Covers what IS implemented (Tier 1), what will NEVER be (user-session concepts with no container meaning), and what just isn't built yet (Tier 2).
---

# ego-browser

Every brief this fleet sends says "use the `ego-browser` skill (ego lite),
NOT agent-browser." This is that skill, and this container's real answer to
it — not ego lite itself (its installer ships macOS/Windows DMGs only and
403s on Linux), but a shim built against ego lite's own documented API
(issue #30) so a script written for one runs unmodified against the other
for everything Tier 1 covers.

## Install

Nothing to do. `ego-browser` is already on PATH in this image
(`container/Dockerfile.studio`), backed by `playwright-core` and the same
Chrome-for-Testing binary at `/usr/local/bin/chromium` the Playwright MCP
server already uses. No DMG, no GUI onboarding, no login — confirm with:

```bash
which ego-browser
```

## Entry points

Both required by the contract, both produce identical behavior — they only
differ in how the script text is obtained:

```bash
ego-browser nodejs -e '<code>'
```

```bash
ego-browser nodejs <<'EOF'
<code>
EOF
```

The code runs as a genuine ESM module in Node (via Bun) — top-level
`await`, `import.meta`, etc. all work exactly as they would in a real
`.mjs` file. The API below is injected as **globals**; the script must
**not** `import` playwright or playwright-core itself — reach for
`taskSpace`/`listTaskSpaces` directly, no import line needed for them.

## The persistence contract — read this before writing a script

**Every invocation of `ego-browser nodejs` is a brand-new Node process.**
Nothing in your script's own variables, closures, or module state survives
between invocations.

What DOES survive: task spaces, their pages, and each page's durable
`label`. This works because a long-lived daemon process lives inside the
container (auto-spawned on first use, holding the real Playwright
`Browser`/`BrowserContext`/`Page` objects and a spaceId+label registry) and
every `ego-browser` invocation is just a short-lived RPC client talking to
it over a Unix socket. So:

```js
// Round 1 — invocation A
const t = await taskSpace(7);
const p = t.page("p1");
await p.goto("https://example.com");
```

```js
// Round 2 — invocation B, a totally separate process, maybe minutes later
const t = await taskSpace(7);     // same spaceId -> resumes the SAME live space
const p = t.page("p1");            // same label -> resumes the SAME live tab
console.log(await p.url());        // "https://example.com/" — never re-navigated
```

`t.page(label)` never makes an RPC call by itself — it is a lazy handle.
The real page it points at only materializes (or is found already alive)
daemon-side on the first real action taken against it (`goto`, `url()`,
`click()`, ...).

## Tier 1 API — implemented, use this

### Entry points

- `await taskSpace(nameOrId, { profileId? })` — reuse or create an
  agent-owned task space; a new space starts with page `p1`.
- `await listTaskSpaces()` — list `{ spaceId, name }` for every known space.

### TaskSpace

- `task.spaceId`, `task.name` — plain properties, no RPC.
- `task.page(label)` — lazy `Page` handle for a durable label (no RPC).
- `await task.pages()` — list the managed `Page` handles in this space.
- `await task.newPage()` — create and durably label a blank page.
- `await task.finish({ keep })` — finish the task; `keep` is `"all"` or an
  array of page labels to retain; returns `{ retained, closed }`. An empty
  array closes the space entirely when nothing is protected.

### Page

- `page.label` — plain property, no RPC.
- `await page.goto(url, opts?)`
- `await page.reload(opts?)`
- `await page.url()`
- `await page.title()`
- `await page.info()`
- `await page.screenshot(opts?)` — `{ path?, fullPage?, clip?, scale?, raw? }`
- `await page.evaluate(fnOrString, arg?)`
- `await page.click(selector, opts?)`
- `await page.dblclick(selector, opts?)`
- `await page.hover(selector, opts?)`
- `await page.fill(selector, value, opts?)`
- `await page.press(selector, chord, opts?)`
- `await page.focus(selector, opts?)`
- `await page.selectOption(selector, valueOrValues, opts?)`
- `await page.setInputFiles(selector, pathOrPaths)`
- `await page.waitForSelector(selector, opts?)`
- `await page.waitForLoadState(state?, opts?)`
- `await page.waitForURL(urlMatcher, opts?)` — string, RegExp, or a sync
  predicate receiving a `URL`
- `await page.waitForFunction(fnOrString, arg?, opts?)`
- `await page.waitForTimeout(ms)`
- `await page.close()`
- `await page.snapshot(opts?)` — semantic snapshot with refs, the one piece
  of Tier 1 with no direct Playwright equivalent; built on top of
  `@playwright/mcp`'s own snapshot machinery rather than reinventing it,
  since the MCP server (`bunx @playwright/mcp@latest`) is already installed
  and produces this exact shape.

## NOT implemented — never will be, and fails loudly if you call it

These throw synchronously, immediately, naming themselves — never a silent
no-op:

```
Error: ego-browser: <name> is not implemented in this shim -- it is a user-session
concept with no meaning in a headless container. See the ego-browser skill for
what IS supported.
```

- `profiles()`
- `claimTaskSpace()`
- `takeOverTaskSpace()`
- `task.userPage()`
- `task.handOff()`
- `task.waitForControl()`
- `task.adopt()`
- `task.release()`

Why: these are ego lite's user-session/login-handoff concepts — claiming a
space a human is actively using, handing control back and forth between
agent and operator, resuming the tab that was active at a claim boundary.
None of that has any meaning in a headless container with no logged-in
human sitting at it (operator ruling, issue #30: login inheritance rarely
matters here, and an agent that needs a real login can create its own test
credentials). This is a deliberate boundary, not a gap to work around — if
your script needs one of these, it needs a different approach, not a
workaround for the missing method.

## NOT implemented yet — could be added later (Tier 2)

Separate from the list above, this is just unbuilt, not ruled out:
`page.mouse.*`, `page.keyboard.*`, `page.cdp`, `page.fetch`, `page.events`,
`page.acceptDialog`/`page.dismissDialog`, `page.waitForEvent`,
`page.dragAndDrop`, `page.waitForFileChooser`, `Download`, `FileChooser`,
`task.tabs()`, `task.cdp`. If a script needs one of these today, it isn't
available — don't assume it silently works.

## Example

```bash
ego-browser nodejs -e '
const t = await taskSpace("check-pricing");
const p = t.page("p1");
// replace with your own dev server URL — nothing listens on localhost:4321 by default
await p.goto("http://localhost:4321/pricing");
await p.waitForLoadState("networkidle");
console.log(await p.title());
await p.screenshot({ path: "/tmp/pricing.png", fullPage: true });
await t.finish({ keep: [] });
'
```

Resume the same space in a later invocation by reusing the same name/id and
label — no re-navigation needed, the tab is exactly where the last
invocation left it.
