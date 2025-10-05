#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/app"
BACKEND_ROOT="${APP_ROOT}/backend"

CHARGECASTER_CONFIG="${CHARGECASTER_CONFIG:-${APP_ROOT}/config.yaml}"
export CHARGECASTER_CONFIG
export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4000}"

if [ ! -f "${CHARGECASTER_CONFIG}" ]; then
  echo "Config ${CHARGECASTER_CONFIG} not found; mount a readable config file for user $(id -un)" >&2
  exit 1
fi

if [ ! -d /data ]; then
  echo "/data mount not present; bind the volume so user $(id -un) can persist state" >&2
  exit 1
fi

mkdir -p /data/db

if [ ! -r "${CHARGECASTER_CONFIG}" ]; then
  echo "Config ${CHARGECASTER_CONFIG} must be readable by user $(id -un)" >&2
  exit 1
fi

if ! touch /data/db/.write-test 2>/dev/null; then
  echo "User $(id -un) requires write access to /data/db for SQLite state" >&2
  exit 1
fi
rm -f /data/db/.write-test 2>/dev/null || true

cd "${BACKEND_ROOT}"

node "${BACKEND_ROOT}/dist/main.js" &
backend_pid=$!

nginx -g "daemon off;" &
nginx_pid=$!

terminate() {
  kill -TERM "${backend_pid}" "${nginx_pid}" 2>/dev/null || true
}

trap terminate INT TERM

wait -n "${backend_pid}" "${nginx_pid}"
exit_code=$?

terminate
wait "${backend_pid}" 2>/dev/null || true
wait "${nginx_pid}" 2>/dev/null || true

exit "${exit_code}"
