#!/bin/sh
# Test fixture for board issue #276: a fake "chromium" binary that never
# exits and never errors on unrecognized args, simulating a genuinely-hung
# `chromium.launch()` (Chrome process starts but never completes its CDP
# handshake -- a real-world failure mode under container resource/memory
# pressure). Real binaries like /bin/cat or /usr/bin/yes were tried first
# and both actually REJECT quickly in this environment: they validate their
# own args and error on chromium's own unrecognized flags, so they only ever
# reproduce a FAST launch failure, not a hang. This script ignores every
# argv entirely (`$@` is never referenced) and `exec`s a process that never
# returns, so playwright-core's launch() has nothing to time out on except
# our own bounded guard.
exec sleep infinity
