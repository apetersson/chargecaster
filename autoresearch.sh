#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
PYTHON_BIN="${AUTORESEARCH_PYTHON:-}"
if [[ -z "$PYTHON_BIN" && -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT/.venv/bin/python"
fi
if [[ -z "$PYTHON_BIN" ]]; then
  PYTHON_BIN="${PYTHON:-python3}"
fi
CONFIG_PATH="${AUTORESEARCH_CONFIG:-$ROOT/config.local.yaml}"
DB_PATH="${CHARGECASTER_STORAGE_PATH:-$ROOT/data/db/backend.sqlite}"
TMP_ROOT="${AUTORESEARCH_TMP_ROOT:-$ROOT/.autoresearch}"
EVAL_DAYS="${AUTORESEARCH_EVAL_DAYS:-14}"
HORIZON_HOURS="${AUTORESEARCH_HORIZON_HOURS:-24}"
HEARTBEAT_SECONDS="${AUTORESEARCH_HEARTBEAT_SECONDS:-20}"

mkdir -p "$TMP_ROOT"
RUN_DIR="$(mktemp -d "$TMP_ROOT/run.XXXXXX")"
TRAIN_DIR="$RUN_DIR/trained"
MODEL_DIR="$RUN_DIR/model"
mkdir -p "$MODEL_DIR/current"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

ensure_node_tools() {
  if (cd "$BACKEND_DIR" && pnpm exec tsx --version >/dev/null 2>&1); then
    return
  fi

  log "Node tool links missing; running pnpm install --frozen-lockfile"
  (cd "$ROOT" && pnpm install --frozen-lockfile)
}

run_training() {
  local log_path="$1"
  local start_ts
  start_ts="$(date +%s)"

  "$PYTHON_BIN" ml/train_load_forecast.py \
    --config "$CONFIG_PATH" \
    --db "$DB_PATH" \
    --output-dir "$TRAIN_DIR" \
    >"$log_path" 2>&1 &
  local train_pid=$!

  while kill -0 "$train_pid" 2>/dev/null; do
    sleep "$HEARTBEAT_SECONDS"
    if kill -0 "$train_pid" 2>/dev/null; then
      local now elapsed
      now="$(date +%s)"
      elapsed=$((now - start_ts))
      log "Training still running (${elapsed}s elapsed)"
    fi
  done

  wait "$train_pid"
}

echo "Running Chargecaster autoresearch benchmark"
echo "  config: $CONFIG_PATH"
echo "  db:     $DB_PATH"
echo "  run:    $RUN_DIR"
echo "  python: $PYTHON_BIN"

cd "$BACKEND_DIR"

log "Preparing node-based replay tooling"
ensure_node_tools

log "Starting forecast training"
if ! run_training "$RUN_DIR/train.log"; then
  echo "Training failed. Tail of $RUN_DIR/train.log:" >&2
  tail -n 50 "$RUN_DIR/train.log" >&2 || true
  exit 1
fi

log "Training finished; staging trained artifact"
cp -R "$TRAIN_DIR"/. "$MODEL_DIR/current/"

log "Starting simulator replay evaluation"
pnpm exec tsx scripts/replay-load-forecast.ts \
  --config "$CONFIG_PATH" \
  --db "$DB_PATH" \
  --model-dir "$MODEL_DIR" \
  --days "$EVAL_DAYS" \
  --horizon-hours "$HORIZON_HOURS"

log "Replay evaluation finished"
