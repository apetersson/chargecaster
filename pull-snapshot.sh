#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PULL_SNAPSHOT_ENV_FILE:-$ROOT/.env.pull-snapshot}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

DATA_DIR="$ROOT/data"
LOCAL_DB_DIR="${LOCAL_DB_DIR:-$DATA_DIR/db}"
REMOTE_SSH_TARGET="${REMOTE_SSH_TARGET:-}"
REMOTE_DB_DIR="${REMOTE_DB_DIR:-}"

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd rsync
require_cmd ssh

if [[ -z "$REMOTE_DB_DIR" ]]; then
  echo "REMOTE_DB_DIR must be set in $ENV_FILE or the environment" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

timestamp="$(date '+%Y%m%d-%H%M%S')"
backup_dir="$DATA_DIR/db-backup-$timestamp"
tmp_parent="${TMPDIR:-/tmp}"
staging_dir="$(mktemp -d "$tmp_parent/chargecaster-db-pull.XXXXXX")"

cleanup() {
  if [[ -d "$staging_dir" ]]; then
    rm -rf "$staging_dir"
  fi
}
trap cleanup EXIT

log "Checking remote source ${REMOTE_SSH_TARGET}:${REMOTE_DB_DIR}"
ssh "$REMOTE_SSH_TARGET" "test -d '$REMOTE_DB_DIR'"

log "Downloading remote DB into staging dir $staging_dir"
rsync -av --delete \
  "${REMOTE_SSH_TARGET}:${REMOTE_DB_DIR}/" \
  "$staging_dir/"

if [[ ! -f "$staging_dir/backend.sqlite" ]]; then
  echo "Remote DB snapshot did not contain backend.sqlite" >&2
  exit 1
fi

if [[ -d "$LOCAL_DB_DIR" ]]; then
  log "Archiving existing DB to $backup_dir"
  mv "$LOCAL_DB_DIR" "$backup_dir"
fi

log "Installing downloaded DB into $LOCAL_DB_DIR"
mv "$staging_dir" "$LOCAL_DB_DIR"
staging_dir=""

log "Done"
log "Backup: $backup_dir"
log "Active DB: $LOCAL_DB_DIR"
