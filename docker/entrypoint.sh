#!/usr/bin/env bash
# mcp-amazon-cart entrypoint
#
# Three concerns, in start order:
#   1. Xvfb on :$DISPLAY_NUM (default :99) under a supervisor loop so transient
#      stale-lock + crash failures don't leave the container in a
#      "healthy MCP, dead display" zombie state.
#   2. x11vnc bound to that display so John can VNC in from any tailnet device
#      for first-run Amazon login + occasional re-auth.
#   3. exec node /app/dist/server.js as PID 2 (under tini, which is PID 1).
#      Direct node exec — NOT `npm start` — so V8 OOM exits the container
#      cleanly and Docker's restart_policy gives us a fresh /tmp.
#
# Supervisor pattern source: ~/dev/browser-pool-stealth-patchright/entrypoint.sh
# (web-p1s-stealth-pool, "Container can survive Xvfb death silently" lesson,
# Verified 2026-05-27). Adaptations:
#   - This entrypoint adds an x11vnc supervisor (P1s has no VNC).
#   - Slightly more conservative respawn budget (5 fails / 60s) — same as P1s.
#   - x11vnc password is rendered to a file at runtime from $VNC_PASSWORD;
#     we never bake it into the image. The -passwd command-line flag would
#     leak via `ps`, so we use -rfbauth on a file mode 0600 owned by root.

set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
MCP_HTTP_PORT="${MCP_HTTP_PORT:-3000}"
VNC_PORT_INTERNAL="${VNC_PORT:-5900}"
USER_DATA_DIR="${USER_DATA_DIR:-/data/user-data}"
VNC_PASSWORD="${VNC_PASSWORD:-}"

# Ensure the persistent user-data dir exists (mounted as a named volume).
# The first-run after a fresh volume needs the directory present before
# Playwright's launchPersistentContext touches it.
mkdir -p "$USER_DATA_DIR"

# ─────────────────────────────────────────────────────────────────────
# Xvfb supervisor — copy/adapt from P1s, verified pattern
# ─────────────────────────────────────────────────────────────────────
xvfb_supervisor() {
    local fail_count=0
    local fail_window_start
    fail_window_start=$(date +%s)
    while true; do
        # Clean any stale lock/socket from a prior Xvfb. Xvfb writes
        # /tmp/.X{N}-lock during normal startup and only removes it on a
        # clean exit. A crash leaves it behind and every subsequent spawn
        # fails with "Server is already active for display N".
        rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

        echo "[xvfb-supervisor] starting Xvfb :${DISPLAY_NUM}" >&2
        Xvfb ":${DISPLAY_NUM}" -screen 0 1920x1080x24 -nolisten tcp
        local rc=$?
        echo "[xvfb-supervisor] Xvfb exited (rc=${rc}). Will respawn." >&2

        local now elapsed
        now=$(date +%s)
        elapsed=$((now - fail_window_start))
        if [ "$elapsed" -gt 60 ]; then
            fail_count=0
            fail_window_start=$now
        fi
        fail_count=$((fail_count + 1))
        if [ "$fail_count" -ge 5 ]; then
            echo "[xvfb-supervisor] Xvfb crashed ${fail_count} times in ${elapsed}s — killing PID 1 to trigger container restart" >&2
            # tini is PID 1; killing it causes the container to exit
            # non-zero and Docker's restart policy reschedules a clean
            # start with a fresh /tmp.
            kill -TERM 1 2>/dev/null || true
            exit 1
        fi
        sleep 1
    done
}

# ─────────────────────────────────────────────────────────────────────
# x11vnc supervisor — same shape as Xvfb's, single-process restart loop
# ─────────────────────────────────────────────────────────────────────
x11vnc_supervisor() {
    # If no VNC password was supplied, refuse to start x11vnc. We do NOT
    # silently fall back to -nopw — an unauthenticated VNC bound to a host
    # interface (even tailnet-only) is too easy to misconfigure into the
    # public internet. Better to fail loudly.
    if [ -z "$VNC_PASSWORD" ]; then
        echo "[x11vnc-supervisor] VNC_PASSWORD is empty; x11vnc will NOT start. " \
             "Set VNC_PASSWORD in the compose Env to enable VNC bootstrap." >&2
        return 0
    fi

    # Stage the password into a 0600 file. -storepasswd writes the file
    # in x11vnc's own format (NOT the same as ~/.vnc/passwd from vncpasswd
    # in older TightVNC — but x11vnc -rfbauth understands its own format
    # so we keep the toolchain self-consistent).
    local pwfile=/root/.vnc/passwd
    mkdir -p /root/.vnc
    chmod 700 /root/.vnc
    # -storepasswd prompts unless given the password as $1 and file as $2.
    x11vnc -storepasswd "$VNC_PASSWORD" "$pwfile" >/dev/null 2>&1
    chmod 600 "$pwfile"

    local fail_count=0
    local fail_window_start
    fail_window_start=$(date +%s)
    while true; do
        echo "[x11vnc-supervisor] starting x11vnc on :${DISPLAY_NUM} listening on ${VNC_PORT_INTERNAL}" >&2
        # -display: target our supervised Xvfb
        # -rfbauth: read password from the file (not the command line — ps leak)
        # -rfbport: which TCP port x11vnc binds (inside the container)
        # -forever: keep serving after a client disconnects
        # -shared: allow multiple simultaneous viewers (useful if John has VNC
        #          open on phone + laptop while debugging an Amazon CAPTCHA)
        # -noxdamage: more compatible with Xvfb (no damage extension)
        # -bg=false: stay in foreground so the supervisor sees death
        x11vnc \
            -display ":${DISPLAY_NUM}" \
            -rfbauth "$pwfile" \
            -rfbport "${VNC_PORT_INTERNAL}" \
            -forever -shared -noxdamage \
            || true
        echo "[x11vnc-supervisor] x11vnc exited; will respawn after 1s" >&2

        local now elapsed
        now=$(date +%s)
        elapsed=$((now - fail_window_start))
        if [ "$elapsed" -gt 60 ]; then
            fail_count=0
            fail_window_start=$now
        fi
        fail_count=$((fail_count + 1))
        if [ "$fail_count" -ge 5 ]; then
            echo "[x11vnc-supervisor] x11vnc crashed ${fail_count} times in ${elapsed}s — giving up (Xvfb + MCP keep running)" >&2
            return 1
        fi
        sleep 1
    done
}

# ─────────────────────────────────────────────────────────────────────
# Start supervisors in the background and wait for Xvfb socket
# ─────────────────────────────────────────────────────────────────────
xvfb_supervisor &
XVFB_SUP_PID=$!

# Wait for the X socket to appear before launching x11vnc or the MCP.
# Without this, Chrome's first navigation races the display and fails;
# x11vnc fails to connect to the display and respawns.
SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"
for _ in $(seq 1 50); do
    if [ -e "$SOCKET" ]; then
        echo "[entrypoint] Xvfb socket ready at $SOCKET" >&2
        break
    fi
    sleep 0.1
done

if [ ! -e "$SOCKET" ]; then
    echo "[entrypoint] WARNING: Xvfb socket did not appear within ~5s; proceeding anyway" >&2
fi

# Now start x11vnc supervisor (in background).
x11vnc_supervisor &
X11VNC_SUP_PID=$!

# Forward SIGTERM/SIGINT to children so docker stop is graceful.
# tini handles SIGCHLD reaping; we just propagate the shutdown signal.
shutdown() {
    echo "[entrypoint] caught shutdown signal; stopping supervisors" >&2
    kill "$XVFB_SUP_PID" "$X11VNC_SUP_PID" 2>/dev/null || true
    exit 0
}
trap shutdown INT TERM

# ─────────────────────────────────────────────────────────────────────
# Launch the MCP HTTP server.
# Direct `exec node` — see header comment for why not `npm start`.
# Track 3's compiled output lives at /app/dist/server.js (matches
# madebydia upstream main: dist/server.js).
# ─────────────────────────────────────────────────────────────────────
echo "[entrypoint] launching MCP server: node /app/dist/server.js" >&2
echo "[entrypoint]   PORT=${MCP_HTTP_PORT}  DISPLAY=:${DISPLAY_NUM}  HEADLESS=${HEADLESS:-true}" >&2
echo "[entrypoint]   USER_DATA_DIR=${USER_DATA_DIR}" >&2

# Track 3's server reads $PORT (madebydia upstream) — re-export so it matches.
export PORT="$MCP_HTTP_PORT"

exec node /app/dist/server.js
