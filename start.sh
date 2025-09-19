#!/bin/bash
set -euo pipefail

mkdir -p /run/nginx /public/data
chown -R nginx:nginx /run/nginx /var/lib/nginx || true
chown -R app:app /public/data || true

SNAPSHOT_PATH="/public/data/latest.json"
if [ ! -f "$SNAPSHOT_PATH" ]; then
  cat <<'JSON' > "$SNAPSHOT_PATH"
{
  "timestamp": null,
  "interval_seconds": null,
  "house_load_w": null,
  "current_soc_percent": null,
  "next_step_soc_percent": null,
  "recommended_soc_percent": null,
  "recommended_final_soc_percent": null,
  "price_snapshot_eur_per_kwh": null,
  "projected_cost_eur": null,
  "projected_grid_energy_kwh": null,
  "forecast_hours": null,
  "forecast_samples": null,
  "trajectory": [],
  "warnings": [],
  "errors": []
}
JSON
  chown app:app "$SNAPSHOT_PATH"
  chmod 664 "$SNAPSHOT_PATH"
fi

python -u /app/controller.py &
controller_pid=$!

nginx -g 'daemon off;' &
nginx_pid=$!

term_handler() {
  kill -TERM "$controller_pid" 2>/dev/null || true
  kill -TERM "$nginx_pid" 2>/dev/null || true
}

trap term_handler TERM INT

while true; do
  wait -n "$controller_pid" "$nginx_pid"
  exit_code=$?
  term_handler
  wait "$controller_pid" 2>/dev/null || true
  wait "$nginx_pid" 2>/dev/null || true
  exit $exit_code
done
