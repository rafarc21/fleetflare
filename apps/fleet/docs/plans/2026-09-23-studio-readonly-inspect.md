# Read-only studio inspection that never attaches a tmux client (board issue #47)

## The corruption, as measured

`acme-os--pilot`, 2026-09-23, operator watching live: text rendered with
characters from a partial repaint interleaved into it — stray leading
fragments (`Ne`, `Tr`, `My`, `Ag`), each one the first 1-2 characters of the
PREVIOUS line, spliced into the line above it by a redraw mid-write.

The pty is shared (`src/studio/terminal.ts`): every `fleet attach` opens a
WebSocket onto the SAME container pty, which is `container/studio-shell.sh`'s
`tmux attach -d -t studio` (falling back to `tmux new-session -A`). tmux's own
render options decide what a client joining or leaving that shared session
does to everyone else's view. The mechanism issue #47 names —
`window-size latest` + `aggressive-resize on` — has already been closed
separately (`container/studio-bringup.sh`'s tmux-render-options region, commit
`ce0304e`, issue #43): the file now sets `window-size largest` and
`aggressive-resize off`, and reads both back from the live server as proof
they took. That fix is not this task's to redo, and it does not remove the
underlying trigger: an attach is still a real tmux client joining the shared
session, and any future render-option regression (or a genuinely small
attaching client) can still touch it. The only way to never trigger it at all
is to never attach a client in the first place — which nothing before this
task could do. Every liveness signal this fleet had ("is this studio alive
and doing something") required someone to open a shell and look.

## The mechanism this task uses instead

`sbExec` (`src/studio/sandbox-api.ts`) already exists and already runs
container commands without any tmux client:

```ts
export async function sbExec(
  sb: SandboxHandle, cmd: string, env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = env ? await sb.exec(cmd, { env }) : await sb.exec(cmd);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}
```

`sb.exec` runs inside the container-server's own long-lived exec session
("sandbox-default", a plain shell process the container-server owns) — a
completely different code path from `sbAttachPty`, the ONLY function in this
file that ever touches a pty:

```ts
export async function sbAttachPty(
  sb: SandboxPtyHost, opts: { cols: number; rows: number },
): Promise<PtyHandle> {
  await sb.createSession({ id: STUDIO_SESSION_ID }).catch(() => {});
  const upgrade = new Request("https://studio/pty", {
    headers: { Upgrade: "websocket", Connection: "Upgrade" },
  });
  const res = await proxyTerminal(sb, STUDIO_SESSION_ID, upgrade, {
    cols: opts.cols, rows: opts.rows, shell: STUDIO_SHELL,
  });
  ...
}
```

`STUDIO_SHELL` is `/opt/fleet/studio-shell.sh`, baked into the image, whose
entire body is:

```sh
while true; do
  tmux select-window -t studio:claude 2>/dev/null || true
  setsid --ctty --wait tmux attach -d -t studio 2>/dev/null \
    || setsid --ctty --wait tmux new-session -A -s studio -n claude
  sleep 0.3
done
```

That is `fleet attach`'s whole path: `cmdAttach` (`cli/fleet.ts`) opens a
WebSocket at `/studio/:id/ws/terminal`, `terminal.ts`'s `TerminalBridge`
answers it via `ensurePty()` -> `sbAttachPty` -> `proxyTerminal`, which spawns
`studio-shell.sh` inside the container, which runs `tmux attach -d`. A REAL
tmux client, every time — `-d` even detaches every OTHER client as it joins.

`sbExec` never runs `studio-shell.sh`, never opens that WebSocket, and
therefore never runs `tmux attach` at all — it is a sibling code path in the
same file, not a variant of the attach path. The commands this task hands to
`sbExec` are `tmux display-message` and `tmux capture-pane -p`: one-shot
control invocations of the tmux CLI against the already-running server, the
exact category `provisionedCheckCmd` (`provision.ts`) already uses for
`pane_current_command` and `wakeCmd`'s own `PANE_PROBE_CMD` (`wake.ts`)
already use for the identical reason.

### Verified against real tmux, not asserted

`man tmux`/`tmux(1)` documents `capture-pane` as writing the pane's contents to
a buffer (or, with `-p`, stdout) — it is a read of already-rendered screen
state, not an interactive attach. Rather than take that on faith,
`test/bun/inspect-cmd.test.ts` runs the actual `inspectCmd` output against a
real, throwaway tmux 3.2a server (same isolation discipline as
`test/bun/pane-probe.test.ts`/`wake-cmd.test.ts`) and reads back:

- `tmux list-clients -t studio` before and after — **empty in both cases**. A
  real `tmux attach` would print one line per client; a one-shot `tmux <cmd>`
  invocation never registers as a session client at all.
- `tmux show-options -gv window-size` / `show-window-options -gv
  aggressive-resize` before and after — **byte-identical**. The exact settings
  issue #47 names as the corruption trigger are provably untouched.
- The active window, before and after selecting a DIFFERENT window and
  running the inspect command — **unchanged**. Nothing is selected, nothing
  switched; an operator attaching later sees no trace (same requirement
  `provisionedCheckCmd`'s own doc comment already states and
  `pane-probe.test.ts` already proves for the sibling wake-probe command).

Manual spot-check (this file's own author, before the automated suite was
written), against a plain local tmux server:

```
$ tmux -L probe new-session -d -s studio -n claude 'bash -c "printf HELLO_LINE_1\nHELLO_LINE_2\n; sleep 300"'
$ tmux -L probe list-clients -t studio        # (nothing)
$ tmux -L probe capture-pane -p -t studio:claude
HELLO_LINE_1nHELLO_LINE_2n
...
$ tmux -L probe list-clients -t studio        # still nothing
```

## Modal safety — verified, not asserted

Requirement 3: a lead parked on an interactive modal (Claude Code's
rate-limit prompt, where any keystroke lands on it and Enter selects
whichever line is highlighted — one line from "Upgrade your plan"). Manual
spot-check, a pane running a blocking `read -p "rate limit -- Upgrade your
plan" x`:

```
$ tmux -L modal capture-pane -p -t studio:claude
rate limit -- Upgrade your plan
$ tmux -L modal capture-pane -p -t studio:claude   # run again
rate limit -- Upgrade your plan
$ ls result.txt   # would exist iff the read() ever completed
ls: cannot access 'result.txt': No such file or directory
```

Two `capture-pane -p` calls against a pane genuinely blocked on `read`, and
the read never receives input. `test/bun/inspect-cmd.test.ts`'s "sends ZERO
keystrokes" test automates exactly this: the pane runs the same blocking
`read -p` with the actual modal text, `inspectCmd` is run twice (polling, the
way a coordinator would), and the test asserts the marker file the `read`
would have written on completion never appears — while the tail it captured
still contains the modal prompt text. `capture-pane -p` sends no bytes to the
pane's process; there is no `send-keys` anywhere on this path (pinned by a
forbidden-substring test in `test/studio.inspect.test.ts`).

## Shape chosen: `fleet inspect <id>`, not `fleet exec <id> -- <command>`

The issue offers both ("shape is yours") and gives `inspect` as its own
concrete example. Chosen over a general exec passthrough for three reasons:

1. **The exact three facts a coordinator asks for are fixed and small** —
   `pane_current_command`, checkout presence, pane tail — and a narrow,
   named function can pin the FORBIDDEN command list (`attach`, `send-keys`,
   `new-session`, `select-window`, ...) once, centrally, as a unit test. A
   general `fleet exec <id> -- <command>` accepts an arbitrary string; "read-
   only by contract" is a comment, not an enforced property, and a caller
   could construct `tmux attach` (or worse, an arbitrary destructive shell
   command) through it. Every existing command-builder in this codebase
   (`provisionedCheckCmd`, `wakeCmd`, `discoverRescueRefsCmd`) is a narrow,
   named, pinned function for the identical reason.
2. **The stopped-container gate is total, not best-effort.** `runInspect`
   answers "stopped" or "never provisioned" ENTIRELY from the DO's own
   recorded status before `exec` is ever called (see below) — a shape that
   generalizes cleanly to one fixed command, but would need re-deriving (or
   trusting a caller to re-derive) for every arbitrary command a general
   `exec` verb might run.
3. **Reuses an established pattern in this exact codebase**, rather than
   inventing a new one: `wake.ts`'s `runGatedWake` is the sibling "gate a
   container touch behind recorded state, then run ONE fixed command" shape,
   already shipped, already tested the same way. `inspect.ts`'s `runInspect`
   is deliberately its structural twin.

A general `fleet exec` remains buildable later on top of the same `sbExec`
primitive if a real need for one shows up; nothing here forecloses it.

## Stopped-container refusal

`sbExec` STARTS a container that is not running — the exact fact
`runGatedWake`'s own doc comment (`wake.ts`) and `sweepMaestro`'s `isStopped`
gate (`do.ts`) already state, and the reason `decideHeal` (`do.ts`) refuses to
self-heal anything but a `running` studio. `runInspect` (`src/studio/
inspect.ts`) takes the identical two-gate shape `runGatedWake` already
established:

```ts
export async function runInspect(
  deps: InspectDeps, repo: string, tailLines: number = INSPECT_DEFAULT_TAIL_LINES,
): Promise<InspectOutcome> {
  let state: string | null;
  try { state = await deps.recordedState(); }
  catch (err) { return { ok: false, error: ... }; }

  if (state === null) return { ok: false, error: "refused: this studio was never provisioned ..." };
  if (state === "stopped") return { ok: false, error: "refused: this studio is stopped — reading it would start its container and cost money silently. Provision it first." };

  // only now does anything touch the container:
  const res = await deps.exec(inspectCmd(repo, tailLines));
  ...
}
```

`recordedState` is wired (`StudioDO.inspect`, `do.ts`) to `this.ctx.storage`
directly — never the D1 registry mirror — the same ruling `sweepMaestro`'s own
`isStopped` and `wakeStudioOnAssignment`'s `recordedState` already state: a
stale mirror could still read "running" over a container the operator just
stopped. The refusal happens before `deps.exec` is called at all — pinned by
`test/studio.inspect.test.ts`'s `expect(exec).not.toHaveBeenCalled()` on both
the `stopped` and the never-provisioned (`null`) paths.

`degraded` and `provisioning` studios are NOT refused — their containers are
already running (billing already in progress), so reading them costs nothing
extra; only `stopped` (deliberately shut down) and `null` (never provisioned,
no container to read) refuse.

## What `fleet inspect <id>` returns

`checkoutExists` (`/workspace/<repo>/.git` present), `paneCommand`
(`pane_current_command` for `studio:claude` — proves whether `claude` is
running vs `bash`/anything else; `null` when the window itself does not
exist, tmux 3.2a's own silent fallback to the current pane, the same
footgun `PANE_PROBE_CMD`'s doc comment already documents and guards against
by naming the window it actually answered about), and `tail` (the last
`INSPECT_DEFAULT_TAIL_LINES` — 60 — lines of that pane's buffer via
`tmux capture-pane -p -S -<n>`, overridable with `?lines=`). Same known limit
`provisionedCheckCmd`/`PANE_PROBE_CMD` already carry: `paneCommand` answers
ALIVE-or-DEAD, never WORKING-or-STOPPED.

## Files touched

- `src/studio/inspect.ts` (new) — `inspectCmd`, `parseInspectOutput`,
  `runInspect`, `InspectDeps`/`InspectOutcome`/`InspectSnapshot`.
- `src/studio/do.ts` — `StudioDO.inspect(repo, tailLines?)`, wired exactly
  like `wakeStudioOnAssignment`.
- `src/studio/routes.ts` — `GET /studio/:id/inspect`, added to `ROUTE_RE`.
  Always 200 (same posture `POST /wake` already takes): the refusal rides
  the JSON body's `ok` field. `tail` is redacted at this output boundary
  (`redactSecrets`), same as `GET /provisioned`'s `reason` and `POST
  /check`'s `readiness.reason` — raw pane content can carry anything the
  studio ever echoed, secrets included.
- `src/studio/cli-args.ts` — `{ cmd: "inspect"; id: string }`, parse case,
  `VERBS.inspect` help entry.
- `cli/fleet.ts` — `cmdInspect`, wired into `main()`.
- `test/studio.inspect.test.ts` (new) — pure `inspectCmd`/
  `parseInspectOutput` assertions plus `runInspect`'s gating, mirroring
  `test/studio.wake.test.ts`'s `runGatedWake` describe block exactly.
- `test/bun/inspect-cmd.test.ts` (new) — real-tmux proof: zero clients, zero
  window-size/aggressive-resize change, zero window switch, zero keystrokes
  delivered to a blocked `read`, correct tail/pane/checkout content.
- `test/studio.cli-args.test.ts` — one `inspect` parse test added.

## Verified vs. not verified

Verified: command construction (forbidden-substring + exact-shape tests),
the stopped/never-provisioned refusal logic (fake `{recordedState, exec}`
deps, `exec` proven uncalled), output parsing (including malformed/empty
input), and — genuinely, against a real tmux 3.2a server, not simulated —
zero clients created, zero window-size/aggressive-resize change, zero window
switch, and zero keystrokes delivered to a pane blocked on a modal-shaped
`read`.

NOT verified: the full path against a live remote studio container (`GET
/studio/:id/inspect` through a real Cloudflare Sandbox `sb.exec`, a real
`STUDIO` Durable Object, a real deployed Worker). This environment is itself
a studio container reached FROM the fleet Worker via `sbExec`/CLI, not a
place that can exercise the Worker-to-container round trip end to end — the
same limit every other `sbExec`-based feature in this codebase (`wake.ts`,
`provision.ts`) documents and accepts. `bun run check`/`test`/`bun-test` are
what this task can run, and all three are green.
