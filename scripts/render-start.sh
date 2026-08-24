#!/bin/sh
# Production start for 512 MB hosts (Render free).
# Heap is capped so Node cannot grow until the kernel OOM-kills the dyno.
set -eu
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=384 --no-warnings}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"

echo "[render] migrate"
npm run db:migrate

# Prefer the standalone server (no next CLI, less RAM). Fall back to next start.
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
  cd .next/standalone
  echo "[render] standalone server"
  exec node server.js
fi

echo "[render] next start"
exec npx next start -H 0.0.0.0 -p "${PORT:-3000}"
