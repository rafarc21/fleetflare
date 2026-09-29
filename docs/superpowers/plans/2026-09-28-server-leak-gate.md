# Server-side Leak Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Studios on public repos hold read-only GitHub credentials; pushes and gh writes go through Worker routes that scan with the ops denylist, then write with the Worker's token.

**Architecture:** New `src/write-proxy/` module. Git smart-HTTP proxy
(`/fleet/git/...`): upload-pack passes through, receive-pack parsed (pkt-line +
packfile, own inflater), scanned via `board/leak.ts`'s `leakGuard`, forwarded
byte-identical. gh op RPC (`/fleet/gh`). Studio credential minted read-only in
`proxy` mode. Container: `pushInsteadOf` + Worker credential helper; gh
wrapper hands write verbs to baked `fleet-gh-proxy` client.

**Tech Stack:** TypeScript, Cloudflare Workers (vitest-pool-workers), bun:test
lane with real git + `git http-backend`, bash wrappers.

**Spec:** `docs/superpowers/specs/2026-09-28-server-leak-gate-design.md`

## Global Constraints

- Public repo. Fake terms only in tests: `acmeclient`, `999999999`, `example-org`.
- Refusals name pattern INDEX only (`leakHitMessage`). Never a term.
- Fail closed: any parse error, unknown, or exception = refuse.
- Body cap 16 MiB (`PUSH_BODY_CAP = 16 * 1024 * 1024`); inflated cap 64 MiB (`PUSH_INFLATE_CAP`).
- `src/write-proxy/{inflate,pack,pktline,scan-push}.ts` import nothing Worker-only: bun lane loads them.
- Write mode off unless work repo on `FLEET_WRITE_PROXY_REPOS` (#13 review); listed + App + confirmed private = `direct`.
- Never fall back to write PAT for studio credential.
- Heavy test runs under `lockf -k /tmp/fleetflare-gate.lock`.
- Keep `bun run check`, `bun run test`, `bun run bun-test`, english-check green.

## Review Focus

1. Pack with trailing junk / truncated / wrong trailer SHA — refuse, never forward. (Task 2 tests)
2. Client ignoring `no-thin` (REF_DELTA base absent) — refuse. (Task 2 test)
3. Delete-only push (no pack) — accepted, ref name still scanned. (Task 3/5 tests)
4. Studio token for repo A pushing path repo B — 403. (Task 5 test)
5. Old image without `fleet-gh-proxy` in proxy mode — gh write verb refuses with clear message, not silent real-gh 403. (Task 7 test)

---

### Task 1: zlib inflater with consumed-byte count

**Files:**
- Create: `apps/fleet/src/write-proxy/inflate.ts`
- Test: `apps/fleet/test/bun/write-proxy-inflate.test.ts`, `apps/fleet/test/write-proxy.inflate.test.ts`

**Interfaces:**
- Produces: `inflateZlib(buf: Uint8Array, offset: number, maxOut: number): { data: Uint8Array; next: number }` — throws `InflateError` on bad header, bad block, adler32 mismatch, output over `maxOut`.

- [ ] Step 1: bun test: random + text + empty inputs deflated by `node:zlib.deflateSync` (levels 0,1,9), concatenated with junk after; assert `data` equals input and `next` equals compressed length. Corrupt adler → throws. `maxOut` smaller than output → throws.
- [ ] Step 2: run, FAIL (module missing).
- [ ] Step 3: implement RFC1950/1951 inflater (stored, fixed, dynamic Huffman; tinf-style tables), adler32 verify, return `next` after the 4-byte adler.
- [ ] Step 4: run bun test + workerd test on one fixed fixture (hex literal from zlib), PASS.
- [ ] Step 5: commit `feat(write-proxy): zlib inflater reporting bytes consumed (#7)`.

### Task 2: packfile parser + push text

**Files:**
- Create: `apps/fleet/src/write-proxy/pack.ts`, `apps/fleet/src/write-proxy/scan-push.ts`
- Test: `apps/fleet/test/bun/write-proxy-pack.test.ts`

**Interfaces:**
- Consumes: `inflateZlib`.
- Produces:
  - `type GitObject = { type: "commit" | "tree" | "blob" | "tag"; data: Uint8Array; oid: string }`
  - `parsePack(pack: Uint8Array, limits: { maxInflated: number }): Promise<GitObject[]>` — throws `PackError(message)`. Verifies: `PACK`, version 2|3, count, trailer SHA-1 (crypto.subtle), nothing after trailer, per-entry inflated size, OFS/REF delta bases in-pack, oid = sha1(`<type> <len>\0` + data).
  - `pushText(refs: string[], objects: GitObject[]): string` — ref names, commit/tag raw text, blob text (UTF-8 non-fatal), tree full paths from each commit root + every in-pack tree's entry names.

- [ ] Step 1: bun tests with a real repo (`git init`, commits, a file edited twice so `pack-objects` deltas it): build pack via `git pack-objects --stdout --revs` (with `--delta-base-offset` and without, for OFS vs REF). Assert every object oid set equals `git rev-list --objects --all` set; `pushText` contains commit message, `dir/sub/file.txt`, blob line. Negative: trailing byte → PackError; flipped trailer → PackError; truncated → PackError; `--thin` pack against an excluded base → PackError ("delta base not in pack").
- [ ] Step 2: run, FAIL.
- [ ] Step 3: implement. Delta apply: varint src/dst size, copy (0x80) + insert ops, bounds-checked. Tree parse: `<mode> <name>\0<20 bytes>`.
- [ ] Step 4: PASS.
- [ ] Step 5: commit `feat(write-proxy): packfile parser and push text extraction (#7)`.

### Task 3: pkt-line: advertisement rewrite, request parse, refusal report

**Files:**
- Create: `apps/fleet/src/write-proxy/pktline.ts`
- Test: `apps/fleet/test/write-proxy.pktline.test.ts`

**Interfaces:**
- Produces:
  - `rewriteReceivePackAdvert(body: Uint8Array): Uint8Array` — drops `push-options`, `push-cert=*`, `report-status-v2`, `atomic` kept; adds `no-thin`. Throws on malformed.
  - `parseReceivePackRequest(body: Uint8Array): { commands: {old: string; new: string; ref: string}[]; caps: string[]; pack: Uint8Array | null }` — throws `PktError`. Refuses caps `push-options`, `push-cert`. `pack` null iff all commands delete; non-delete without pack → throw.
  - `refusalReport(refs: string[], message: string, caps: string[]): Uint8Array` — `unpack ok` + `ng <ref> <msg>` per ref, flush; wrapped in side-band band 1 (+ band 2 message line) when caps has `side-band-64k`/`side-band`.

- [ ] Step 1: tests: advert fixture (GitHub-shaped) → caps rewritten; request with 2 commands + pack bytes → parsed; delete-only → pack null; `push-options` cap → throws; report bytes equal hand-built pkt-lines, both plain and sideband.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS (`bun run test -- write-proxy.pktline`).
- [ ] Step 5: commit `feat(write-proxy): receive-pack pkt-line parse, advert rewrite, refusal report (#7)`.

### Task 4: write mode + read-only studio credential

**Files:**
- Create: `apps/fleet/src/write-proxy/mode.ts`
- Modify: `apps/fleet/src/env.ts` (add `FLEET_WRITE_PROXY_REPOS?`, `GITHUB_READ_TOKEN?`, `FLEET_RESCUE_GITHUB_TOKEN?`), `apps/fleet/src/studio/credentials.ts` (add `credentialClearCmd()`), `apps/fleet/src/studio/do.ts` (`runRefreshCredential` + `refreshDeps`)
- Test: `apps/fleet/test/write-proxy.mode.test.ts`, `apps/fleet/test/studio.credentials.test.ts`

**Interfaces:**
- Produces:
  - `writeProxyOn(env, workRepo): boolean` — true only for a repo on `FLEET_WRITE_PROXY_REPOS`.
  - `resolveWriteMode(env, repo, isPrivate: (r) => Promise<boolean>): Promise<"direct" | "proxy">` — lookup throw = proxy.
  - `readTokenEnvName(owner)` = `GITHUB_READ_TOKEN_<OWNER>`; `studioReadToken(env, repo): Promise<string | null>` — App: `mintRepoToken(env, repo, {permissions: {contents: "read", pull_requests: "read", issues: "read"}})`; PAT: per-owner read token, else `GITHUB_READ_TOKEN`, else null.
  - `RefreshDeps.mintToken: () => Promise<string | null>`; null → exec `credentialClearCmd()`.
  - `credentialClearCmd()`: removes `/workspace/.git-credentials`, `$HOME/.config/gh/hosts.yml`; exit 0 if absent.

- [ ] Step 1: tests: mode off/private/public/lookup-throws; App path mint called with read perms (inject mint); PAT path read token precedence, never write PAT; `runRefreshCredential` with null token execs clear cmd.
- [ ] Step 2: FAIL. Step 3: implement; `refreshDeps.mintToken` = `resolveWriteMode` then direct → `mintRepoToken(env, repo)`, proxy → `studioReadToken`. Step 4: PASS.
- [ ] Step 5: commit `feat(write-proxy): read-only studio credential in proxy mode (#7)`.

### Task 5: git proxy route

**Files:**
- Create: `apps/fleet/src/write-proxy/studio-auth.ts`, `apps/fleet/src/write-proxy/git-route.ts`
- Modify: `apps/fleet/src/index.ts` (mount `/fleet/git/` before `/fleet/` catch-all), `apps/fleet/src/board/routes.ts` (export `realLeakDeps`)
- Test: `apps/fleet/test/write-proxy.git-route.test.ts`, `apps/fleet/test/bun/write-proxy-e2e.test.ts`

**Interfaces:**
- Produces:
  - `studioFromRequest(req, rows): Promise<SpawnParent | null>` — spawn token from `X-Fleet-Spawn-Token` or Basic password.
  - `GitProxyPorts = { rows(): Promise<StudioStatus[]>; defaultRepo: string; upstream(url: string, init: RequestInit, access: "read" | "write", repo: string): Promise<Response>; check: LeakCheck }`
  - `handleGitProxy(req: Request, ports: GitProxyPorts): Promise<Response>`; `handleFleetGit(req, env)` wires real ports (App write mint `{contents: "write"}`, PAT `repoToken`; `leakGuard(realLeakDeps(...))`).
  - Path: `/fleet/git/github.com/<owner>/<repo>(.git)?/(info/refs|git-upload-pack|git-receive-pack)`.

- [ ] Step 1: vitest: no auth → 401 + `WWW-Authenticate`; wrong repo → 403; advert rewritten; clean push forwarded byte-identical (fake upstream records body); hit → 200 report with `ng` + `#1`, upstream never called; denylist missing → `ng` with missing message; body over cap → 413; gzip body handled.
- [ ] Step 2: bun e2e: `Bun.serve` wraps `handleGitProxy` with upstream = `git http-backend` CGI on a bare repo (`GIT_HTTP_EXPORT_ALL`, `http.receivepack=true`); real `git push` via `url.<proxy>.pushInsteadOf`. Clean branch lands (`git -C bare rev-parse`); commit with `acmeclient` message refused, stderr has `#1`, bare untouched; `-o x` push refused by client; second push after delta-able edit lands (no-thin honored); delete-only push lands.
- [ ] Step 3: FAIL. Step 4: implement. Step 5: PASS both lanes.
- [ ] Step 6: commit `feat(write-proxy): /fleet/git receive-pack proxy with leak scan (#7)`.

### Task 6: gh op route

**Files:**
- Create: `apps/fleet/src/write-proxy/gh-route.ts`
- Modify: `apps/fleet/src/index.ts` (mount `/fleet/gh`)
- Test: `apps/fleet/test/write-proxy.gh-route.test.ts`

**Interfaces:**
- Produces:
  - `GhOp` union per spec §6.2; `parseGhOp(body: unknown): GhOp` throws `GhOpError` (400) on unknown op, extra field, bad type.
  - `ghOpTexts(op): string[]`; `ghOpRequest(op, repo): { method; url; body }`.
  - `handleGhProxy(req, ports: { rows; defaultRepo; github(req: {method; url; body}, repo): Promise<Response>; check: LeakCheck })`; `handleFleetGh(req, env)`.

- [ ] Step 1: tests per op (request shape), hit → 422 + index + GitHub not called, 503 on missing list, extra field → 400, auth/repo → 401/403, GitHub error status passed through.
- [ ] Step 2: FAIL. Step 3: implement (`pr-ready` = GraphQL: read PR `node_id` via REST, then fixed mutation text). Step 4: PASS.
- [ ] Step 5: commit `feat(write-proxy): /fleet/gh write op allowlist with leak scan (#7)`.

### Task 7: container config + gh wrapper dispatch

**Files:**
- Modify: `apps/fleet/src/studio/gh-wrapper.ts` (proxy dispatch), `apps/fleet/src/studio/provision.ts` (`applyLeakGate` writes mode config), `apps/fleet/src/studio/do.ts` (wire `writeProxyMode` port)
- Create: `apps/fleet/src/write-proxy/container-config.ts`
- Test: `apps/fleet/test/bun/write-proxy-config.test.ts`, `apps/fleet/test/bun/gh-wrapper.test.ts`, `apps/fleet/test/studio.provision.test.ts`

**Interfaces:**
- Produces:
  - `WRITE_PROXY_MARKER = "/opt/fleet/write-proxy"`, `GH_PROXY_CLIENT = "fleet-gh-proxy"`.
  - `writeProxyConfigCmd(mode, workerUrl, realGit = STUDIO_REAL_GIT_PATH): string` — proxy: set pushInsteadOf + reset/add credential helper for `<url>/fleet/git/` + write marker; direct: unset both + rm marker. Idempotent.
  - `ProvisionDeps.writeProxyMode?: (slug) => Promise<"direct" | "proxy">`.
  - gh wrapper: after scan, marker present and verb in set → `exec fleet-gh-proxy "$@"`; client missing → refuse `STUDIO_GH_PROXY_MISSING`.

- [ ] Step 1: bun test: run config cmd twice against `HOME=tmp` real git; `git config --get-regexp` shows exactly one pushInsteadOf and helper list `['', helper]`; direct mode clears. `git credential fill` for worker URL yields `$FLEET_SPAWN_TOKEN`. gh wrapper: marker + `pr create` → fake client argv; marker + `pr view` → real gh; marker + missing client → refusal.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: commit `feat(write-proxy): studio push/gh routing to the Worker in proxy mode (#7)`.

### Task 8: `fleet-gh-proxy` client

**Files:**
- Create: `apps/fleet/container/gh-proxy.ts`
- Modify: `apps/fleet/container/Dockerfile.studio` (COPY + ln to `/usr/local/bin/fleet-gh-proxy`), `apps/fleet/container/tsconfig.json` if needed
- Test: `apps/fleet/test/bun/gh-proxy-client.test.ts`

**Interfaces:**
- Produces: `translate(argv: string[], ctx: { readFile(p): string; stdin(): string; currentBranch(): string; prNumber(sel?: string): number; defaultBranch(): string }): GhOp` (throws `UsageError` naming the unsupported flag); `main()` posts to `${FLEET_WORKER_URL}/fleet/gh` with `X-Fleet-Spawn-Token`, prints `html_url`, exit 1 with Worker message on non-2xx.

- [ ] Step 1: tests: `pr create -t T -b B --draft` → op; `--body-file -` reads stdin; `pr comment 12 -b x`; `pr comment -b x` uses ctx.prNumber; `issue comment https://github.com/o/r/issues/5 -b x` → 5; `pr review 3 --approve -b ok`; `--fill` → UsageError naming `--fill`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: commit `feat(write-proxy): fleet-gh-proxy client translating gh write verbs (#7)`.

### Task 9: docs + config surface

**Files:**
- Modify: `README.md` (leak gate section: layer 2, operator actions), `docs/threat-model.md` (wrapper bypass closed for public repos), `apps/fleet/wrangler.example.jsonc` (FLEET_WRITE_PROXY_REPOS note), blueprint house rules if they mention direct gh writes.

- [ ] Step 1: edit. Step 2: `bun run apps/fleet/scripts/english-check.ts`. Step 3: commit `docs(write-proxy): server-side leak gate operator notes (#7)`.

### Final

- [ ] `lockf -k /tmp/fleetflare-gate.lock bun run check && bun run test && bun run bun-test` in `apps/fleet`.
- [ ] Whole-branch review (subagent), fix, push, PR ready.
