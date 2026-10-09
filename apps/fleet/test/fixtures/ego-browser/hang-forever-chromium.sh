#!/bin/sh
# Test fixture for board issue #276: a fake "chromium" binary that never
# exits and never errors on unrecognized args, simulating a genuinely-hung
# `chromium.launch()` (Chrome process starts but never completes its CDP
# handshake). Real binaries like /bin/cat or /usr/bin/yes reject chromium's
# flags quickly, so they only reproduce a FAST launch failure, not a hang.
# This script ignores every argv entirely.
#
# Like real Chromium (zygote/renderer/crashpad), it forks a child before
# hanging, so a test can check the WHOLE tree dies on a launch timeout, not
# just the top pid. Both pids go to $EGO_BROWSER_TEST_HANG_PIDFILE when set.
# Linux-only: `sleep infinity` is GNU coreutils.
sleep infinity &
if [ -n "$EGO_BROWSER_TEST_HANG_PIDFILE" ]; then
  echo "$$ $!" > "$EGO_BROWSER_TEST_HANG_PIDFILE"
fi
exec sleep infinity
