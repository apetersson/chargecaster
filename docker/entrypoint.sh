#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/app"
BACKEND_ROOT="${APP_ROOT}/backend"

BATTERYCTL_CONFIG="${BATTERYCTL_CONFIG:-${APP_ROOT}/config.yaml}"
export BATTERYCTL_CONFIG
export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4000}"

if [ ! -e "${BATTERYCTL_CONFIG}" ] && [ -f "${APP_ROOT}/config.yaml.sample" ]; then
  cp "${APP_ROOT}/config.yaml.sample" "${BATTERYCTL_CONFIG}"
fi

if [ ! -d /data ]; then
  echo "/data mount not present; bind the volume so user $(id -un) can persist state" >&2
  exit 1
fi

if [ ! -L "${APP_ROOT}/data" ]; then
  rm -rf "${APP_ROOT}/data" 2>/dev/null || true
  ln -s /data "${APP_ROOT}/data"
fi

mkdir -p /data/db

if [ ! -r "${BATTERYCTL_CONFIG}" ]; then
  echo "Config ${BATTERYCTL_CONFIG} must be readable by user $(id -un)" >&2
  exit 1
fi

if ! touch /data/db/.write-test 2>/dev/null; then
  echo "User $(id -un) requires write access to /data/db for SQLite state" >&2
  exit 1
fi
rm -f /data/db/.write-test 2>/dev/null || true

cd "${BACKEND_ROOT}"

"${BACKEND_ROOT}/node_modules/.bin/tsx" "${BACKEND_ROOT}/src/main.ts" &
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
