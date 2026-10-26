# gate browser legs

This directory ships into the gate image at `/opt/fleet-gate/browser`
(`container/Dockerfile.gate` COPYs the whole `gate/browser/` tree through the
normalized `src` stage; consumer specs resolve it via the
`FLEET_GATE_BROWSER` env var).

Stub. The two real modules land as their own tasks merge:

- `guard/` — the repo-agnostic Playwright fixture + reporter (#1344).
- `ai/` — the AI leg harness, N/N repeats + red-chip detectors (#1345).

No image rebuild is needed when those land: the COPY already globs the whole
directory, so adding `guard/` and `ai/` here is picked up on the next image
window.