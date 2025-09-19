# batteryctl

A price-aware controller that toggles a Fronius battery between manual SoC targets and auto mode based on day-ahead tariffs. The controller produces a live snapshot that drives a static React dashboard, all packaged into a single Docker container.

## Features

- EVCC integration for live battery state, PV/grid power, and tariff snapshots.
- Optional market-price feed (defaults to [awattar](https://api.awattar.de)) with configurable horizon and priority.
- Dynamic programming optimiser that chooses hourly charge/discharge actions subject to battery capacity and house load.
- Static React/TypeScript dashboard (bundled with Vite) served by nginx at port `8080`.
- Atomic CSV logging of decisions and JSON snapshots for external consumers.

---

## Project Layout

```
.
├── controller.py         # Scheduler loop invoking the optimiser periodically
├── core.py               # Optimiser, EVCC + market-data helpers, persistence utilities
├── evaluate_once.py      # CLI entry point for single-shot evaluations / testing
├── config.yaml.sample    # Example configuration with Fronius / EVCC / market data settings
├── Dockerfile            # Multi-stage build (frontend -> runtime with nginx + controller)
├── docker-compose.yml    # Single container exposing port 8080 and persistent volumes
├── frontend/             # React + Vite TypeScript frontend
├── snapshots/            # Host-mounted snapshot directory (JSON state for the dashboard)
└── tests/                # Pytest suite covering optimiser behaviour
```

---

## Prerequisites

- Python 3.11+ (for local testing) with `pip`
- Node.js 20.x (only required if you want to run the frontend locally outside Docker)
- Docker 24+ (with BuildKit / buildx enabled)
- Docker Compose v2 (`docker compose` command)

---

## Configuration

Copy the sample configuration and adjust to your environment:

```bash
cp config.yaml.sample config.yaml
```

Key sections:

- `fronius`: HTTP digest credentials + endpoints for battery control.
- `evcc`: Base URL to the EVCC API (`/api/state`, `/api/tariff`). Set `enabled: false` if you only rely on market data.
- `market_data`: Toggle awattar (or provide your own API). When `prefer_market` is true, this feed overrides EVCC forecasts.
- `price.grid_fee_eur_per_kwh`: Grid surcharge automatically added to every price sample.
- `state.path`: CSV log file path (inside the container the default is `/data/state.csv`).
- `public.snapshot_path`: Where the controller writes the latest JSON payload (defaults to `/public/data/latest.json`).

For the dashboard to retain the latest optimisation snapshot between restarts, make sure the host volume mapped to `/public/data` is writable.

---

## Running Locally (CLI)

Run a one-off simulation using the CLI entry point:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python evaluate_once.py --config config.yaml --pretty
```

This prints the JSON result and, when `market_data.enabled` is true, will fetch tariffs from awattar if EVCC data is missing.

---

## Frontend Development (Optional)

If you want hot reload while tweaking the dashboard:

```bash
cd frontend
yarn install
yarn dev
```

The dev server runs on `http://localhost:5173` and fetches snapshots from `/data/latest.json`, so you can proxy requests or run the controller in parallel.

---

## Docker: Build & Run

### Build multi-arch image

The Dockerfile performs a two-stage build: Vite compiles the frontend, then nginx + Python run in the runtime image.

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t apetersson/batteryctl:local \
  .
```

For local testing (without pushing), you can drop `--platform` and `-t` and use standard `docker build`.

### Start via docker-compose

`docker-compose.yml` runs the container, mounts configuration/state/snapshot folders, and maps port 8080:

```bash
docker compose up --build -d
```

Visit `http://localhost:8080` to view the dashboard. The controller logs appear via `docker compose logs -f`.

Volumes:

- `./config.yaml` → `/app/config.yaml` (read-only)
- `./state` → `/data`
- `./snapshots` → `/public/data` (contains `latest.json` for the frontend)

Stop the stack:

```bash
docker compose down
```

---

## Publishing Workflow

1. **Tag previous release** – if you just cut a new version, capture the old `latest` manifest (using `docker buildx imagetools create`).
2. **Build multi-arch** – `docker buildx build --platform linux/amd64,linux/arm64 -t apetersson/batteryctl:vX.Y.Z -t apetersson/batteryctl:latest . --push`
3. **Retag old manifest** – `docker buildx imagetools create --tag apetersson/batteryctl:vOld digest`
4. **Verify** – `docker buildx imagetools inspect apetersson/batteryctl:vX.Y.Z`

Example commands from the latest release:

```bash

# Build and push new release as v0.0.2 + latest
new_version=v0.0.3
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t apetersson/batteryctl:$new_version \
  -t apetersson/batteryctl:latest \
  . \
  --push
```

---

## Snapshot JSON Schema

`public/data/latest.json` contains the latest optimiser output. Fields include:

- `timestamp`: ISO timestamp of the simulation.
- `current_soc_percent`, `next_step_soc_percent`, `recommended_soc_percent`
- `price_snapshot_eur_per_kwh`: latest price + grid fee.
- `projected_cost_eur`, `projected_grid_energy_kwh`
- `trajectory`: array of hourly slots with start/end ISO strings, SOC progression, grid energy drawn, price per kWh.
- `warnings`, `errors`: arrays with any warnings encountered while fetching data or applying commands.

This file is safe to expose read-only on your LAN, and can be used by third-party dashboards or scripts.

---

## Testing

Run the Python suite:

```bash
pytest
```

The tests cover the optimiser, price normalisation, and basic trajectory generation. Extend the test suite if you customise the optimiser or add new data sources.

---

## Troubleshooting

- **No forecast available**: Check both `evcc` and `market_data` settings. The controller logs an error listing both endpoints it attempted.
- **Dashboard stale**: Ensure `/public/data/latest.json` is being updated. Inspect `docker compose logs` for `snapshot write failed` warnings and verify the host volume is writable.
- **Digest auth failures**: Fronius endpoints require precise usernames/passwords; double-check the `fronius` section and the inverter’s digest auth settings.
- **Cache issues**: Browsers cache favicons aggressively. Force-reload (`Shift+Cmd+R` / `Ctrl+F5`) after deploying a new image.

---

## License

This project is provided as-is. Adapt configuration and code to fit your hardware, tariff contracts, and safety requirements.
