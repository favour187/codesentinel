#!/bin/sh
# Production start for 512 MB hosts (Render free).
set -eu
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384 --no-warnings}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
# Render sets HOSTNAME to the container name. Next standalone binds that
# interface and health checks get 502. Always listen on all interfaces.
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"

# Schema is applied on first request via ensureSchema()/bootstrap.
# Running tsx migrate here regularly OOMs the 512 MB instance before listen.

if [ -f .next/standalone/server.js ]; then
  mkdir -p .next/standalone/.next
  if [ -d .next/static ] && [ ! -d .next/standalone/.next/static ]; then
    cp -R .next/static .next/standalone/.next/static
  fi
  if [ -d public ] && [ ! -d .next/standalone/public ]; then
    cp -R public .next/standalone/public
  fi
  if [ -d fixtures ] && [ ! -d .next/standalone/fixtures ]; then
    cp -R fixtures .next/standalone/fixtures
  fi
  echo "[render] standalone on ${HOSTNAME}:${PORT}"
  cd .next/standalone
  exec node server.js
fi

echo "[render] next start on ${HOSTNAME}:${PORT}"
exec npx next start -H 0.0.0.0 -p "${PORT}"
