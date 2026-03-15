#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"

cd "$BACKEND_DIR"

pnpm exec vitest run \
  test/demand-forecast.service.spec.ts \
  test/simulation.service.spec.ts

pnpm run typecheck
