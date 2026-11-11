#!/usr/bin/env bash
# Install for Linux into the box's own node_modules volumes, start one virtual display with a
# window manager on it, then run whatever the box was asked to run.
set -euo pipefail

DISPLAY_NUMBER=1
SCREEN="${SCREEN:-1920x1080x24}"
SOCKET="/tmp/.X11-unix/X${DISPLAY_NUMBER}"
SOCKET_TRIES=100

if ! bun install --frozen-lockfile >/tmp/bun-install.log 2>&1; then
  cat /tmp/bun-install.log
  exit 1
fi

# Electron fetches its binary on first use; doing it here keeps that download out of a test's
# launch timeout.
(cd packages/desktop && node -e 'require("electron")' >/dev/null)

mkdir -p -m 1777 /tmp/.X11-unix
Xvfb ":${DISPLAY_NUMBER}" -screen 0 "${SCREEN}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq "${SOCKET_TRIES}"); do
  [ -S "${SOCKET}" ] && break
  sleep 0.1
done
if [ ! -S "${SOCKET}" ]; then
  cat /tmp/xvfb.log
  exit 1
fi
export DISPLAY=":${DISPLAY_NUMBER}"

# Without a window manager nothing has focus, and a window without focus gets no key events.
openbox >/tmp/openbox.log 2>&1 &

exec "$@"
