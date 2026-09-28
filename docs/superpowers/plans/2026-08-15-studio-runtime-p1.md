# Studio Runtime P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pilot studio agent (persistent interactive Claude Code in a Cloudflare container) attachable from Mac terminal and iPhone, with clipboard image paste.

**Architecture:** New `StudioDO` (subclass of `@cloudflare/sandbox` Sandbox) beside the untouched task lane. Worker routes under `/studio/*` bridge WebSocket↔tmux PTY, accept image paste, provision, and report status. Mac side: single-file bun CLI. iPhone: Tailscale SSH (native apps) + minimal xterm.js fallback page.

**Tech Stack:** Cloudflare Workers + Durable Objects, `@cloudflare/sandbox` (new dep), bun, tmux, Tailscale userspace, vitest-pool-workers, xterm.js (page only).

**Spec:** `docs/superpowers/specs/2026-08-15-studio-runtime-p1-design.md`

## Global Constraints

- Branch `35-terminal-watch`, base `origin/staging`. Existing 177 tests stay green after every task.
- Batch lane untouched: zero diffs under `container/server.ts`, `container/deploy-server.ts`, `src/agents/`, `src/deploy/`, `src/tasks/`.
- claude pin `@anthropic-ai/claude-code@2.1.224` everywhere.
- `@cloudflare/sandbox`: resolve newest 0.x once in Task 1, freeze; SDK npm version and Docker base tag MUST match.
- Studio id regex: `^([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$` (repo--role; segments never contain `--`, so `a--b--c` rejects). Reject everything else with 400.
- Paste: mime allowlist `image/png`, `image/jpeg`, `image/webp`; max 10 MB (10_485_760 bytes).
- No secret ever in a response body: every new serialization passes `redactCreds` (existing, `container/server.ts` pattern; Worker-side equivalent in `src/events/log.ts` — reuse whichever exports).
- Commits: conventional, small, after each green test cycle. All work in `apps/fleet/` unless stated.
- Caveman compression in docs/commits; code and tests written normal.

## File Structure (locked)

```
apps/fleet/
  src/studio/
    ids.ts          # id parse/validate
    types.ts        # ProvisionConfig, StudioStatus, shared types
    frames.ts       # WS frame protocol (shared Worker+CLI via relative import)
    auth.ts         # Access JWT / service-token verification
    sandbox-api.ts  # ONLY file touching @cloudflare/sandbox API (adapter)
    do.ts           # StudioDO class
    routes.ts       # /studio/* router
    registry.ts     # studio rows (extends existing registry pattern)
  cli/
    fleet.ts        # entry: ls | attach | paste
    backoff.ts      # reconnect delay (pure)
    paste-mac.ts    # pngpaste probe + upload
  container/
    Dockerfile.studio
    studio-bringup.sh   # tmux session create, claude launch, tailscale up
  page/
    terminal.html   # xterm.js fallback page (bundled asset)
  test/
    studio.ids.test.ts
    studio.frames.test.ts
    studio.auth.test.ts
    studio.routes.test.ts
    studio.registry.test.ts
    studio.refresh.test.ts
    cli.backoff.test.ts
  test-integration/
    attach.e2e.ts   # local-docker only, separate runner
fleet/blueprint/          # repo root (fleetflare-agency layout mirrored in websites repo)
  roles/pilot.md
  org.json
fleet.json                # websites repo root
```

---

### Task 1: Pin SDK, scaffold StudioDO binding, id validation

**Files:**
- Modify: `apps/fleet/package.json`, `apps/fleet/wrangler.jsonc`
- Create: `apps/fleet/src/studio/ids.ts`, `apps/fleet/src/studio/types.ts`, `apps/fleet/src/studio/do.ts` (minimal), `apps/fleet/test/studio.ids.test.ts`

**Interfaces:**
- Produces: `parseStudioId(raw: string): { repo: string; role: string; full: string } | null`; `StudioStatus = { id: string; state: "provisioning"|"running"|"degraded"|"stopped"; tailscaleHost: string|null; lastRefresh: string|null; error: string|null }`; `ProvisionConfig = { repo: string; role: string; blueprintRef: string }`; DO binding name `STUDIO`, class `StudioDO`.

- [ ] **Step 1: Resolve and freeze SDK version**

Run: `cd apps/fleet && bun pm view @cloudflare/sandbox version`
Record the exact `0.x.y`. `bun add @cloudflare/sandbox@<0.x.y> --exact`. Then read `node_modules/@cloudflare/sandbox/dist/index.d.ts` and record in a comment block at the top of (future) `sandbox-api.ts` scratch notes: exact names/signatures for (a) `getSandbox`, (b) session/PTY creation + stream handles + resize, (c) `writeFile` (or equivalent), (d) `exec`. These feed Task 4/5. Do not guess; copy from the d.ts.

- [ ] **Step 2: Failing test for id validation**

```ts
// apps/fleet/test/studio.ids.test.ts
import { describe, it, expect } from "vitest";
import { parseStudioId } from "../src/studio/ids";

describe("parseStudioId", () => {
  it("accepts repo--role", () => {
    expect(parseStudioId("websites--pilot")).toEqual({ repo: "websites", role: "pilot", full: "websites--pilot" });
  });
  for (const bad of ["Websites--pilot", "websites/pilot", "a--b--c", "..--x", "websites--", "--pilot", "web%2Fsites--x", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(parseStudioId(bad)).toBeNull());
  }
});
```

- [ ] **Step 3: Run, verify fails** — `bun run test -- studio.ids` → FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
// apps/fleet/src/studio/ids.ts
const ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)--([a-z0-9]+(?:-[a-z0-9]+)*)$/;
export function parseStudioId(raw: string) {
  const m = ID_RE.exec(raw);
  if (!m) return null;
  return { repo: m[1], role: m[2], full: raw };
}
```

```ts
// apps/fleet/src/studio/types.ts
export type StudioState = "provisioning" | "running" | "degraded" | "stopped";
export interface StudioStatus {
  id: string; state: StudioState;
  tailscaleHost: string | null; lastRefresh: string | null; error: string | null;
}
export interface ProvisionConfig { repo: string; role: string; blueprintRef: string; }
```

```ts
// apps/fleet/src/studio/do.ts  (minimal for binding; grows in Tasks 3-6)
import { Sandbox } from "@cloudflare/sandbox";
export class StudioDO extends Sandbox {}
```

`wrangler.jsonc`: add container entry `{ "class_name": "StudioDO", "image": "./container/Dockerfile.studio", "instance_type": "standard-2" }`, DO binding `{ "class_name": "StudioDO", "name": "STUDIO" }`, migration `{ "tag": "<next>", "new_sqlite_classes": ["StudioDO"] }`. Copy the exact shape of the existing AgentDO entries. Until Task 7 writes the Dockerfile, point `image` at a one-line placeholder Dockerfile `FROM docker.io/cloudflare/sandbox:<frozen tag>` created now.

- [ ] **Step 5: Run tests + full suite** — `bun run test` → new tests PASS, 177 old PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(fleet): studio scaffold, SDK pin, id validation"`

---

### Task 2: WS frame protocol (shared)

**Files:**
- Create: `apps/fleet/src/studio/frames.ts`, `apps/fleet/test/studio.frames.test.ts`

**Interfaces:**
- Produces: `encodeResize(cols: number, rows: number): string` (JSON text frame); `parseFrame(data: string | ArrayBuffer): { type: "data"; bytes: Uint8Array } | { type: "resize"; cols: number; rows: number } | { type: "ignore" }`. Contract: binary WS frames = terminal bytes; text frames = JSON control (`{"t":"resize","cols":n,"rows":n}`); unknown text → `ignore`, never throw.

- [ ] **Step 1: Failing tests**

```ts
// apps/fleet/test/studio.frames.test.ts
import { describe, it, expect } from "vitest";
import { encodeResize, parseFrame } from "../src/studio/frames";

describe("frames", () => {
  it("resize round-trips", () => {
    const f = parseFrame(encodeResize(120, 40));
    expect(f).toEqual({ type: "resize", cols: 120, rows: 40 });
  });
  it("binary is data", () => {
    const f = parseFrame(new Uint8Array([27, 91, 65]).buffer);
    expect(f.type).toBe("data");
    expect([...(f as any).bytes]).toEqual([27, 91, 65]);
  });
  it("unknown text ignored", () => expect(parseFrame('{"t":"x"}')).toEqual({ type: "ignore" }));
  it("garbage text ignored", () => expect(parseFrame("not json")).toEqual({ type: "ignore" }));
  it("non-positive resize ignored", () => expect(parseFrame('{"t":"resize","cols":0,"rows":-1}')).toEqual({ type: "ignore" }));
});
```

- [ ] **Step 2: Run, fails.** `bun run test -- studio.frames`

- [ ] **Step 3: Implement**

```ts
// apps/fleet/src/studio/frames.ts
export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ t: "resize", cols, rows });
}
export function parseFrame(data: string | ArrayBuffer) {
  if (typeof data !== "string") return { type: "data" as const, bytes: new Uint8Array(data) };
  try {
    const j = JSON.parse(data);
    if (j?.t === "resize" && Number.isInteger(j.cols) && Number.isInteger(j.rows) && j.cols > 0 && j.rows > 0)
      return { type: "resize" as const, cols: j.cols, rows: j.rows };
  } catch {}
  return { type: "ignore" as const };
}
```

- [ ] **Step 4: Pass + full suite green.**
- [ ] **Step 5: Commit** — `feat(fleet): studio WS frame protocol`

---

### Task 3: Access auth verification

**Files:**
- Create: `apps/fleet/src/studio/auth.ts`, `apps/fleet/test/studio.auth.test.ts`
- Modify: `apps/fleet/src/env.ts` (add `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` vars)

**Interfaces:**
- Produces: `verifyAccess(req: Request, env: Env, fetcher?: typeof fetch): Promise<Response | null>` — `null` = authorized; otherwise 401/403 `Response`. Checks `Cf-Access-Jwt-Assertion` header: RS256 verify against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (JWKS cached in module map 1h), `aud` must include `ACCESS_AUD`, `exp` in future. `fetcher` param exists so tests inject a mock JWKS.

- [ ] **Step 1: Failing tests** — generate an RSA keypair in-test via WebCrypto, sign a JWT, serve JWKS through mock fetcher.

```ts
// apps/fleet/test/studio.auth.test.ts
import { describe, it, expect } from "vitest";
import { verifyAccess } from "../src/studio/auth";
// helpers: makeKeypair(), signJwt(priv, {aud, exp}), jwksFetcher(pub) — build with crypto.subtle
// (generateKey RS256, exportKey "jwk"; sign header.payload with RSASSA-PKCS1-v1_5)

const env = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud123" } as any;

describe("verifyAccess", () => {
  it("null on valid jwt", async () => { /* signed with matching aud, future exp -> expect null */ });
  it("401 when header missing", async () => {
    const r = await verifyAccess(new Request("https://x/studio/a--b/status"), env, fetch);
    expect(r?.status).toBe(401);
  });
  it("403 on wrong aud", async () => { /* aud mismatch -> 403 */ });
  it("403 on expired", async () => { /* exp past -> 403 */ });
  it("403 on bad signature", async () => { /* signed with different key -> 403 */ });
});
```

Write the three `/* */` bodies out fully in the test file — each builds a JWT with the helper and asserts status. No skipped cases.

- [ ] **Step 2: Run, fails.**
- [ ] **Step 3: Implement** — ~70 lines: split token, base64url-decode header/payload, pick JWKS key by `kid`, `crypto.subtle.importKey("jwk", …, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, false, ["verify"])`, `crypto.subtle.verify` over `header.payload`, then `aud`/`exp` checks. Cache JWKS per team domain in a module-level `Map<string, {fetched: number; keys: JsonWebKey[]}>`, TTL 3600s.
- [ ] **Step 4: Pass + suite green.**
- [ ] **Step 5: Commit** — `feat(fleet): access jwt verification for studio routes`

---

### Task 4: Routes + registry + provision/status (DO logic, sandbox mocked)

**Files:**
- Create: `apps/fleet/src/studio/routes.ts`, `apps/fleet/src/studio/registry.ts`, `apps/fleet/src/studio/sandbox-api.ts`, `apps/fleet/test/studio.routes.test.ts`, `apps/fleet/test/studio.registry.test.ts`
- Modify: `apps/fleet/src/studio/do.ts`, `apps/fleet/src/index.ts` (mount `/studio/`)

**Interfaces:**
- Consumes: `parseStudioId`, `verifyAccess`, frames (Task 2), types (Task 1).
- Produces:
  - `handleStudio(req: Request, env: Env): Promise<Response>` — mounted in `index.ts` for paths starting `/studio/`.
  - `sandbox-api.ts` adapter (sole SDK toucher): `sbExec(sb, cmd: string): Promise<{ code: number; stdout: string; stderr: string }>`; `sbWriteFile(sb, path: string, bytes: Uint8Array): Promise<void>`; `sbAttachPty(sb, opts: { cols: number; rows: number }): Promise<{ readable: ReadableStream<Uint8Array>; write(b: Uint8Array): void; resize(c: number, r: number): void; close(): void }>` — implement bodies against the d.ts names recorded in Task 1.
  - StudioDO RPC methods: `provision(cfg: ProvisionConfig): Promise<StudioStatus>`, `getStatus(): Promise<StudioStatus>`, `restartStudio(): Promise<StudioStatus>`.
  - `registry.ts`: `listStudios(env): Promise<StudioStatus[]>`, `recordStudio(env, status: StudioStatus): Promise<void>` following the existing `src/agents/registry.ts` storage pattern.

- [ ] **Step 1: Failing route tests** (vitest-pool-workers, real DO, sandbox layer mocked by injecting a fake `sandbox-api` via `vi.mock`):

```ts
// apps/fleet/test/studio.routes.test.ts — outline; write all bodies fully
// - 401 without Access header on GET /studio/websites--pilot/status
// - 400 on GET /studio/BAD_ID/status (auth mocked ok)
// - provision happy path: POST /studio/websites--pilot/provision -> 200 {state:"running"}
//   asserts fake sbExec saw: tailscale up, git clone, studio-bringup.sh
// - provision idempotent: second POST -> 200, fake exec bringup called with
//   guard (`tmux has-session -t studio ||`) — exactly one clone
// - status scrubbed: seed error containing "ghs_secretsecret"; GET status body
//   must not contain "ghs_"
```

- [ ] **Step 2: Run, fails.**
- [ ] **Step 3: Implement** routes (auth → id parse → DO stub call), DO `provision` (state machine provisioning→running, stores `StudioStatus` in `this.ctx.storage`, calls `sbExec` sequence, records to registry), `getStatus` (scrub via existing redact util before return), registry (copy existing agents registry storage idioms).
- [ ] **Step 4: Pass + suite green.**
- [ ] **Step 5: Commit** — `feat(fleet): studio provision/status routes and registry`

---

### Task 5: Terminal WS bridge

**Files:**
- Modify: `apps/fleet/src/studio/do.ts`, `apps/fleet/src/studio/routes.ts`, `apps/fleet/src/index.ts`, `apps/fleet/package.json` (devDeps)
- Create: `apps/fleet/test/studio.ws.test.ts`

**Step 0 (controller ruling, Task 4 discovery):** `@cloudflare/sandbox`'s bundle imports `tracing` from `cloudflare:workers`; the pinned `@cloudflare/vitest-pool-workers` workerd lacks that export, so `StudioDO` is not yet exported from `src/index.ts` — a deploy blocker. Resolve first: upgrade `@cloudflare/vitest-pool-workers` + `wrangler` devDeps to versions whose workerd provides `tracing` (verify with the full suite), then export `StudioDO` from `src/index.ts`. Fallback if no upgrade works: separate test entry (wrangler `main` shim for tests) that omits StudioDO, documented in the task report. The export must exist and the suite must stay green before any WS work starts.

**Interfaces:**
- Consumes: `sbAttachPty`, `parseFrame`/`encodeResize`.
- Produces: `GET /studio/:id/ws/terminal` (header `Upgrade: websocket`) → 101; server↔client contract from Task 2. Constant `WS_BUFFER_MAX = 1_048_576` bytes: if a socket's buffered amount exceeds it, oldest queued output for that socket is dropped (terminal semantics: stale bytes worthless; tmux redraw recovers).

- [ ] **Step 1: Failing tests** (pool-workers WebSocket client against the DO, `sbAttachPty` mocked with a controllable pair of streams):
  - upgrade without auth → 401 (no 101).
  - client binary frame → arrives at pty `write` with same bytes.
  - pty readable emits bytes → client receives binary frame.
  - text resize frame → pty `resize(cols, rows)` called.
  - two clients: both receive pty output; input from both reaches `write`.
  - client disconnect → pty stays open (session persists) while second client attached; last client disconnect → `close()` called.
- [ ] **Step 2: Run, fails.**
- [ ] **Step 3: Implement** in `StudioDO.fetch` upgrade path: `WebSocketPair`, `this.ctx.acceptWebSocket(server)` (hibernation API — matches how the SDK's own Sandbox handles WS; if Sandbox base class reserves `webSocketMessage`, delegate via distinct tags per attach), fan-out set of sockets, single shared pty per DO created lazily, buffer-cap enforcement before `send`.
- [ ] **Step 4: Pass + suite green.**
- [ ] **Step 5: Commit** — `feat(fleet): studio terminal websocket bridge`

---

### Task 6: Paste route

**Files:**
- Modify: `apps/fleet/src/studio/do.ts`, `apps/fleet/src/studio/routes.ts`
- Create: `apps/fleet/test/studio.paste.test.ts`

**Interfaces:**
- Produces: `POST /studio/:id/paste` body=bytes, header `Content-Type` ∈ allowlist → 200 `{ "path": "/workspace/.paste/img-<n>.<ext>" }`. `<n>` = monotonic counter in DO storage key `pasteSeq`. 415 wrong mime, 413 > 10_485_760.

- [ ] **Step 1: Failing tests** — 415 (`text/plain`), 413 (11 MB Uint8Array), success: fake `sbWriteFile` captured path `/workspace/.paste/img-1.png` + exact bytes; second paste → `img-2.png`.
- [ ] **Step 2: Run, fails.**
- [ ] **Step 3: Implement** (ext from mime map; bytes = `await req.arrayBuffer()` with length guard BEFORE buffering via `Content-Length` check + hard cap on read).
- [ ] **Step 4: Pass + suite green.**
- [ ] **Step 5: Commit** — `feat(fleet): studio image paste route`

---

### Task 7: GitHub token refresh alarm

**Files:**
- Modify: `apps/fleet/src/studio/do.ts`
- Create: `apps/fleet/test/studio.refresh.test.ts`

**Interfaces:**
- Consumes: existing `src/github/app.ts` token mint (read its exported signature first; reuse, do not duplicate).
- Controller ruling (Task 4 discovery): this task ALSO owns the initial credential at provision time — provision calls the same mint + credential-file write that the refresh loop uses, so the clone works on private repos. One code path, two call sites.
- Produces: on `provision`, schedule named refresh every 3000s (50 min) via the same `schedule()` idiom `src/agents/do.ts:216` uses (Container/Sandbox owns `alarm()` — never override it, spec of AgentDO comment at `src/agents/do.ts:263`). Refresh: mint token → `sbExec` writes `/workspace/.git-credentials` + `git config credential.helper store` (idempotent) → `lastRefresh` updated. Failure: `state: "degraded"`, error stored (scrubbed), existing telegram notify util called once per consecutive-failure streak.

- [ ] **Step 1: Failing tests** — provision schedules refresh; refresh success updates `lastRefresh` and leaves state `running`; mint throws → `degraded` + telegram mock called once; second consecutive failure → no second telegram call; success after failure → state back to `running`.
- [ ] **Step 2: Run, fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Pass + suite green.**
- [ ] **Step 5: Commit** — `feat(fleet): studio github token refresh loop`

---

### Task 8: Studio image + bring-up script + Tailscale

**Files:**
- Create: `apps/fleet/container/Dockerfile.studio` (replaces Task 1 placeholder), `apps/fleet/container/studio-bringup.sh`

**Interfaces:**
- Consumes: env injected by DO at provision: `TS_AUTHKEY`, `CLAUDE_CODE_OAUTH_TOKEN` (name as used by existing task lane — copy from existing wrangler/DO env wiring), `GH_TOKEN`, `STUDIO_ID`, `ROLE_PROMPT_B64`, `ROLE_ALLOWED_TOOLS`.
- Produces: image where `studio-bringup.sh` is idempotent: starts `tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale` (background) + `tailscale up --ssh --authkey="$TS_AUTHKEY" --hostname="$STUDIO_ID"`; `tmux has-session -t studio 2>/dev/null || tmux new-session -d -s studio -n claude`; window 0 runs `claude --continue --append-system-prompt "$(echo "$ROLE_PROMPT_B64" | base64 -d)" --allowedTools $ROLE_ALLOWED_TOOLS` (first run: without `--continue` when no session exists — guard with `[ -d ~/.claude/projects ]`); `tmux list-windows -t studio | grep -q shell || tmux new-window -t studio -n shell`.

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM docker.io/cloudflare/sandbox:<frozen tag from Task 1>
RUN apt-get update && apt-get install -y --no-install-recommends tmux git curl ca-certificates \
 && curl -fsSL https://tailscale.com/install.sh | sh \
 && rm -rf /var/lib/apt/lists/*
# bun + gh: copy the exact install lines from container/Dockerfile (task image) verbatim
RUN bun install -g @anthropic-ai/claude-code@2.1.224
COPY container/studio-bringup.sh /opt/fleet/studio-bringup.sh
RUN chmod 0755 /opt/fleet/studio-bringup.sh
```

- [ ] **Step 2: Build locally** — `docker build -f container/Dockerfile.studio -t studio-test .` → succeeds.
- [ ] **Step 3: Smoke** — `docker run --rm -e STUDIO_ID=t --entrypoint bash studio-test -c "tmux -V && claude --version && tailscale version"` → three version lines.
- [ ] **Step 4: Wire provision** — DO `provision` `sbExec("/opt/fleet/studio-bringup.sh")` already asserted by Task 4 fakes; update fake expectations if command string changed. Suite green.
- [ ] **Step 5: Commit** — `feat(fleet): studio container image with tmux+tailscale bringup`

---

### Task 9: fleet CLI — ls, attach, paste

**Files:**
- Create: `apps/fleet/cli/fleet.ts`, `apps/fleet/cli/backoff.ts`, `apps/fleet/cli/paste-mac.ts`, `apps/fleet/test/cli.backoff.test.ts`

**Interfaces:**
- Consumes: `/studio/*` routes; frames via relative import `../src/studio/frames`.
- Produces: `fleet ls` (GET registry list, table); `fleet attach <id>` (raw-mode WS client); `fleet paste <id>` (manual paste fallback). Credentials file `~/.fleet/credentials` JSON `{ "workerUrl": "...", "accessClientId": "...", "accessClientSecret": "..." }`, sent as `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers (Access service-token flow — edge mints the JWT the Worker verifies). `backoff.ts`: `reconnectDelayMs(attempt: number, rnd?: () => number): number` — base 500, cap 10_000, exponential, plus-only jitter [0, +25%].

- [ ] **Step 1: Failing backoff tests** — attempt 1 ∈ [500,625]; attempt 2 ∈ [1000,1250]; attempt 20 ≤ 12_500; deterministic with `rnd: () => 0` → exact 500/1000/…/10000 cap.
- [ ] **Step 2: Run, fails.** Implement `backoff.ts`. Pass. Commit `feat(fleet): cli backoff`.
- [ ] **Step 3: Implement attach client** (manual-tested; keep logic thin):
  - stdin raw (`process.stdin.setRawMode(true)`), enter alternate screen on connect, restore sequence on exit (copy the exact escape lists from hatcher's `RESTORE_TERMINAL_SEQUENCE` — they're the field-tested set).
  - byte loop: `0x1d` (ctrl-]) → local exit; `0x16` (ctrl-v) → `paste-mac.ts` probe: `pngpaste /tmp/fleet-paste.png` exit 0 → POST `/paste` → on 200 write returned path + trailing space as WS data; pngpaste missing or no image → forward `0x16`. Everything else → forward.
  - SIGWINCH → `encodeResize(process.stdout.columns, process.stdout.rows)`.
  - close → reconnect with `reconnectDelayMs`, status line to stderr; ctrl-] during wait exits.
- [ ] **Step 4: `fleet ls` + `fleet paste`** — plain fetch + table / manual upload path print.
- [ ] **Step 5: Suite green (backoff tests only automated). Commit** — `feat(fleet): fleet cli attach/ls/paste`

---

### Task 10: xterm.js fallback page

**Files:**
- Create: `apps/fleet/page/terminal.html`
- Modify: `apps/fleet/src/studio/routes.ts` (serve `GET /studio/:id/terminal` — HTML with inlined bundled xterm), `apps/fleet/wrangler.jsonc` if asset rule needed
- Note: `bun add -d xterm@<current>`; bundle at build into the html (single self-contained file; no CDN).

**Interfaces:** Consumes `/ws/terminal` + frames contract. Produces: page with `<div id=t>`, xterm attached, WS binary passthrough, resize→`encodeResize`, on-screen key row (`esc`, `tab`, `ctrl`, `↑`, `↓`, `ctrl-b`) as buttons injecting bytes.

- [ ] **Step 1: Build page** (Access cookie authenticates the browser; same-origin WS carries it — no token UI).
- [ ] **Step 2: Manual test via `wrangler dev`** — connect, type, resize, key row buttons emit correct bytes (verify against `showkey -a`-style echo in shell window).
- [ ] **Step 3: Commit** — `feat(fleet): xterm fallback page`

---

### Task 11: Blueprint skeleton + fleet.json + provision reads them

**Files:**
- Create (fleetflare-agency repo layout inside this repo): `fleet/blueprint/roles/pilot.md`, `fleet/blueprint/org.json`, `fleet.json` (repo root)
- Modify: `apps/fleet/src/studio/do.ts` (provision fetches role file via existing `src/github/api.ts` raw-content pattern at `blueprintRef`)
- Create: `apps/fleet/test/studio.blueprint.test.ts`

**Interfaces:**
- Produces: `pilot.md` frontmatter `{ name: "pilot", skills: [], allowedTools: "Bash(git *) Bash(gh *) Bash(bun *) Bash(fleet *) Edit Write", may_spawn: [], reports_to: "operator", gates: [] }` + body = pilot system prompt (write a real 10-line prompt: role, repo, gate rules, INBOX convention). `org.json`: `{ "edges": { "cto": ["release", "qa", "dev"] }, "gates": { "merge": ["release"], "deploy": ["release"] } }`. `fleet.json`: `{ "blueprint": { "repo": "acme-org/websites", "ref": "<tag-or-sha>" }, "roles": ["pilot"], "instance_type": "standard-2" }`. Parser: `parseRoleFile(md: string)` + `parseFleetJson(s: string)` in `src/studio/blueprint.ts` returning typed objects or throwing `BlueprintError` with field name.

- [ ] **Step 1: Failing parser tests** — valid role parses; missing `allowedTools` → `BlueprintError` mentioning field; `fleet.json` unknown role vs blueprint → error.
- [ ] **Step 2: Run, fails. Implement `src/studio/blueprint.ts`. Pass.**
- [ ] **Step 3: Wire provision** — fetch both files at `blueprintRef`, pass `ROLE_PROMPT_B64` + `ROLE_ALLOWED_TOOLS` env to bring-up (Task 4 fakes updated). Suite green.
- [ ] **Step 4: Commit** — `feat(fleet): blueprint skeleton and provision wiring`

---

### Task 12: Integration + acceptance + delivery

**Files:**
- Create: `apps/fleet/test-integration/attach.e2e.ts`, `apps/fleet/package.json` script `"test:integration": "bun test-integration/attach.e2e.ts"` (requires local docker; excluded from vitest)

**Steps:**
- [ ] **Step 1: Integration script** — starts `wrangler dev` (spawn, wait for ready line), provisions `websites--pilot` against local, opens WS, asserts: echo round-trip through real tmux; resize reflected (`tmux display -p '#{window_width}'`); paste file checksum matches; WS drop + reconnect shows same tmux screen (capture-pane before/after). Exits non-zero on any failure.
- [ ] **Step 2: Run integration locally** — green, output pasted into PR.
- [ ] **Step 3: Deploy + real provision** (existing deploy flow; secrets: `TS_AUTHKEY` reusable non-ephemeral user-device key created in Tailscale admin, Access service token minted, `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` set).
- [ ] **Step 4: Manual acceptance checklist** — run every item from spec §Testing/Manual (Mac iTerm, agentastic tab, lid-close reconnect, ctrl-v screenshot, container kill → `--continue`, iPhone Moshi over Tailscale, fallback page, isolation with a second scratch studio, latency echo measure, batch-lane task e2e, RC experiment window 2 pass/fail record). Record results in PR body.
- [ ] **Step 5: Full suite + lint + check** (`bun run build/lint/check` per repo checklist) → green.
- [ ] **Step 6: PR** to staging, body: spec+plan links, acceptance results, latency number, RC verdict. `Co-Authored-By` + generated-with footer per repo convention.

---

## Self-review notes (done at write time)

- Spec coverage: every spec section maps to a task (org/blueprint→11, runtime→1/4/8, routes→4/5/6, refresh→7, CLI/paste→9, page→10, Tailscale→8/12, RC experiment→12.4, expanded testing→distributed + 12). Governor/monitor, R2 sync, grid, spawn = P2/P3 by spec.
- No placeholder scan: SDK names intentionally resolved by procedure (Task 1 Step 1) and consumed only through `sandbox-api.ts` — adapter signatures are fully specified here.
- Type consistency: `StudioStatus`/`ProvisionConfig` defined Task 1, consumed 4-7; frame contract defined Task 2, consumed 5/9/10; `reconnectDelayMs` defined 9.
