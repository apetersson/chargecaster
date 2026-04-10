#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_CONFIG_PATH="${ROOT_DIR}/config.local.yaml"
DEFAULT_DB_PATH="${ROOT_DIR}/data/db/backend.sqlite"
DEFAULT_VENV_DIR="${ROOT_DIR}/.venv-load-forecast"
REQUIREMENTS_PATH="${ROOT_DIR}/backend/ml/requirements.txt"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Train the load-forecast model locally against a SQLite snapshot.

Options:
  --config PATH         Config file to use (default: ${DEFAULT_CONFIG_PATH})
  --db PATH             SQLite DB to train against (default: ${DEFAULT_DB_PATH})
  --venv PATH           Virtualenv for ML deps (default: ${DEFAULT_VENV_DIR})
  --base-python PATH    Python used to create the virtualenv (default: python3)
  --model-dir PATH      Override load_forecast.model_dir for this run
  --bundle-latest       Bundle the newest trained artifact into backend/assets/load-forecast/current
  --skip-install        Skip dependency installation if the venv already exists
  -h, --help            Show this help

Environment overrides:
  CHARGECASTER_CONFIG
  CHARGECASTER_STORAGE_PATH
  CHARGECASTER_LOAD_FORECAST_VENV
  CHARGECASTER_LOAD_FORECAST_MODEL_DIR
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

list_model_versions() {
  local model_base_dir="$1"
  if [[ ! -d "${model_base_dir}" ]]; then
    return
  fi
  find "${model_base_dir}" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
}

resolve_model_base_dir() {
  local db_path="$1"
  local explicit_model_dir="$2"
  if [[ -n "${explicit_model_dir}" ]]; then
    python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${explicit_model_dir}"
    return
  fi

  local db_dir
  db_dir="$(cd "$(dirname "${db_path}")" && pwd)"
  local models_parent
  if [[ "$(basename "${db_dir}")" == "db" ]]; then
    models_parent="$(cd "${db_dir}/.." && pwd)"
  else
    models_parent="${db_dir}"
  fi
  printf '%s\n' "${models_parent}/models/load-forecast"
}

CONFIG_PATH="${CHARGECASTER_CONFIG:-${DEFAULT_CONFIG_PATH}}"
DB_PATH="${CHARGECASTER_STORAGE_PATH:-${DEFAULT_DB_PATH}}"
VENV_DIR="${CHARGECASTER_LOAD_FORECAST_VENV:-${DEFAULT_VENV_DIR}}"
BASE_PYTHON="python3"
MODEL_DIR="${CHARGECASTER_LOAD_FORECAST_MODEL_DIR:-}"
BUNDLE_LATEST="false"
SKIP_INSTALL="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --db)
      DB_PATH="$2"
      shift 2
      ;;
    --venv)
      VENV_DIR="$2"
      shift 2
      ;;
    --base-python)
      BASE_PYTHON="$2"
      shift 2
      ;;
    --model-dir)
      MODEL_DIR="$2"
      shift 2
      ;;
    --bundle-latest)
      BUNDLE_LATEST="true"
      shift
      ;;
    --skip-install)
      SKIP_INSTALL="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_command pnpm
require_command "${BASE_PYTHON}"

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "Config file not found: ${CONFIG_PATH}" >&2
  exit 1
fi

if [[ ! -f "${DB_PATH}" ]]; then
  echo "SQLite DB not found: ${DB_PATH}" >&2
  exit 1
fi

if [[ ! -f "${REQUIREMENTS_PATH}" ]]; then
  echo "Requirements file not found: ${REQUIREMENTS_PATH}" >&2
  exit 1
fi

mkdir -p "$(dirname "${VENV_DIR}")"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  echo "Creating ML virtualenv at ${VENV_DIR}"
  "${BASE_PYTHON}" -m venv "${VENV_DIR}"
fi

VENV_PYTHON="${VENV_DIR}/bin/python"
STAMP_PATH="${VENV_DIR}/.requirements.sha256"
REQUIREMENTS_HASH="$(shasum -a 256 "${REQUIREMENTS_PATH}" | awk '{print $1}')"
CURRENT_HASH="$(cat "${STAMP_PATH}" 2>/dev/null || true)"

if [[ "${SKIP_INSTALL}" != "true" ]]; then
  if [[ "${CURRENT_HASH}" != "${REQUIREMENTS_HASH}" ]] || ! "${VENV_PYTHON}" -c 'import catboost, yaml' >/dev/null 2>&1; then
    echo "Installing ML dependencies into ${VENV_DIR}"
    "${VENV_PYTHON}" -m pip install --upgrade pip
    "${VENV_PYTHON}" -m pip install -r "${REQUIREMENTS_PATH}"
    printf '%s\n' "${REQUIREMENTS_HASH}" > "${STAMP_PATH}"
  fi
fi

if ! "${VENV_PYTHON}" -c 'import catboost, yaml' >/dev/null 2>&1; then
  echo "Virtualenv is missing required packages. Re-run without --skip-install." >&2
  exit 1
fi

TEMP_CONFIG="$(mktemp -t chargecaster-train-config)"
cleanup() {
  rm -f "${TEMP_CONFIG}"
}
trap cleanup EXIT

SOURCE_CONFIG="${CONFIG_PATH}" \
OUTPUT_CONFIG="${TEMP_CONFIG}" \
VENV_PYTHON="${VENV_PYTHON}" \
MODEL_DIR="${MODEL_DIR}" \
"${VENV_PYTHON}" - <<'PY'
import os
from pathlib import Path

import yaml

source_path = Path(os.environ["SOURCE_CONFIG"])
output_path = Path(os.environ["OUTPUT_CONFIG"])
venv_python = os.environ["VENV_PYTHON"]
model_dir = os.environ.get("MODEL_DIR", "").strip()

with source_path.open("r", encoding="utf-8") as handle:
    config = yaml.safe_load(handle) or {}

load_forecast = config.get("load_forecast") or {}
load_forecast["python_executable"] = venv_python
if model_dir:
    load_forecast["model_dir"] = model_dir
config["load_forecast"] = load_forecast

with output_path.open("w", encoding="utf-8") as handle:
    yaml.safe_dump(config, handle, sort_keys=False)
PY

MODEL_BASE_DIR="$(resolve_model_base_dir "${DB_PATH}" "${MODEL_DIR}")"

echo "Training load forecast locally"
echo "  config: ${CONFIG_PATH}"
echo "  db: ${DB_PATH}"
echo "  venv: ${VENV_DIR}"
echo "  temp config: ${TEMP_CONFIG}"
echo "  model dir: ${MODEL_BASE_DIR}"

BEFORE_VERSIONS="$(list_model_versions "${MODEL_BASE_DIR}")"

(
  cd "${ROOT_DIR}"
  export CHARGECASTER_CONFIG="${TEMP_CONFIG}"
  export CHARGECASTER_STORAGE_PATH="${DB_PATH}"
  if [[ -n "${MODEL_DIR}" ]]; then
    export CHARGECASTER_LOAD_FORECAST_MODEL_DIR="${MODEL_DIR}"
  fi
  pnpm --filter chargecaster-backend load-forecast:train
)

AFTER_VERSIONS="$(list_model_versions "${MODEL_BASE_DIR}")"
LATEST_VERSION="$(comm -13 <(printf '%s\n' "${BEFORE_VERSIONS}") <(printf '%s\n' "${AFTER_VERSIONS}") | tail -n 1 || true)"

if [[ -z "${LATEST_VERSION}" ]]; then
  LATEST_VERSION="$(printf '%s\n' "${AFTER_VERSIONS}" | grep -E '^[0-9]{8}T[0-9]{9}Z$' | tail -n 1 || true)"
fi

if [[ -n "${LATEST_VERSION}" ]]; then
  echo "Latest artifact version: ${LATEST_VERSION}"
  echo "Latest artifact path: ${MODEL_BASE_DIR}/${LATEST_VERSION}"
else
  echo "Training finished, but no artifact directory was found under ${MODEL_BASE_DIR}" >&2
fi

if [[ "${BUNDLE_LATEST}" == "true" ]]; then
  if [[ -z "${LATEST_VERSION}" ]]; then
    echo "Cannot bundle because no latest artifact version was found." >&2
    exit 1
  fi
  (
    cd "${ROOT_DIR}"
    export CHARGECASTER_CONFIG="${TEMP_CONFIG}"
    export CHARGECASTER_STORAGE_PATH="${DB_PATH}"
    if [[ -n "${MODEL_DIR}" ]]; then
      export CHARGECASTER_LOAD_FORECAST_MODEL_DIR="${MODEL_DIR}"
    fi
    pnpm --filter chargecaster-backend load-forecast:bundle -- "${LATEST_VERSION}"
  )
  echo "Bundled artifact into ${ROOT_DIR}/backend/assets/load-forecast/current"
fi
