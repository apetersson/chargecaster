# Chargecaster

Chargecaster is a home battery planner and controller for price-aware, solar-aware charging.

It collects tariff data, solar expectations, live site state, and historical demand, then decides when the battery should charge, hold, limit, or stay in auto mode. The goal is not "charge as much as possible", but "use the battery intelligently": buy less expensive grid energy, increase self-consumption of PV, avoid wasteful cycling, and keep the system explainable enough that you can trust it.

The codebase is TypeScript end-to-end:

- `backend/` is a NestJS + Fastify service that assembles forecasts, runs the optimizer, stores history in SQLite, and exposes a tRPC API.
- `frontend/` is a Vite + React dashboard for the live plan, history, and backtests.
- `packages/domain/` contains the shared simulation types and domain helpers.

## Project Goals

Chargecaster is built around a few practical goals:

- Optimize battery usage, not just battery fullness.
- Prefer self-consumption of solar before exporting to the grid.
- Shift charging into cheaper hours when importing from the grid makes economic sense.
- Respect real hardware and regulatory constraints, especially "no battery-origin export" unless explicitly allowed.
- Keep a useful audit trail through snapshots, history, forecast metadata, and backtests.
- Fall back gracefully when ML or upstream data is unavailable.

In other words: this project tries to turn a residential battery into an informed energy arbitrage and self-consumption tool, without losing sight of safety and operational clarity.

## How Chargecaster Works

At a high level, every run follows the same loop:

1. Read runtime configuration, battery/inverter settings, location, tariff providers, and feature flags.
2. Fetch or assemble market prices, solar forecast, EVCC state, and live battery/house telemetry.
3. Forecast house demand.
   - Preferred path: a CatBoost load-forecast model.
   - Fallback path: a hybrid history + weather + calendar heuristic.
4. Simulate candidate charge/discharge behavior across future tariff slots.
5. Translate the chosen plan into a hardware command for the battery backend.
6. Persist the resulting snapshot and history to SQLite.
7. Serve the dashboard so you can inspect the plan, replay recent days, and compare behavior.

Some important implementation details from the source:

- Price data can be blended from multiple providers by priority, not just taken from a single feed.
- Solar and demand are modeled per future slot, then combined in the simulator.
- The optimizer explicitly reasons about feed-in tariffs, grid fees, and battery charge/discharge efficiency.
- The dashboard exposes both the immediate plan and backtest materialization so you can see whether the strategy would actually have helped.

For the detailed power-flow rules, see [docs/power_flow.md](./docs/power_flow.md).

## Forecasting Strategy

Chargecaster has two demand-forecast paths:

### 1. CatBoost model

When a valid model artifact is available and the CatBoost runtime loads successfully, the backend uses the CatBoost predictor to forecast hourly house load.

### 2. Hybrid fallback

If no artifact is available, the feature schema does not match, or the CatBoost runtime cannot be loaded, Chargecaster falls back to a non-ML hybrid forecast that combines:

- recency-weighted hour/weekday/season baselines
- nearest-neighbor matching on weather, solar, price, and recent load
- short-term rolling load context
- recent bias correction

That fallback path is deliberate: the system should still produce a useful plan even when the ML stack is unavailable.

For the fallback logic, see [docs/hybrid_simple_forecast.md](./docs/hybrid_simple_forecast.md).

## Repository Layout

```text
.
├── backend/
│   ├── assets/load-forecast/current/   # bundled seed artifact for the load model
│   ├── ml/                             # Python training/evaluation code
│   ├── scripts/                        # training, promotion, bundling helpers
│   ├── src/                            # NestJS app, forecasting, simulation, tRPC
│   └── test/
├── frontend/
│   └── src/                            # React dashboard
├── packages/domain/                    # shared domain types and math
├── config.yaml.sample                  # example runtime config
├── docker-compose.yml                  # single-container local deployment helper
└── Dockerfile                          # monolith image: backend + frontend + ML runtime
```

## What You Need For A Meaningful Deployment

Chargecaster can start in partial or degraded modes, but a meaningful real-world installation currently assumes the following:

- A Fronius-compatible inverter/battery setup that Chargecaster can read and control.
- A home battery that is actually connected to that inverter and exposed through the Fronius API.
- EVCC installed and reachable.
  - In the current codebase, EVCC is more than an optional extra feed.
  - It supplies important live site telemetry such as battery SOC, home power, grid power, solar power, EV charging power, and EV state.
  - It can also act as a fallback price source.
- Internet access for external forecast and price data.
  - tariff providers such as aWATTar or ENTSO-E
  - weather / solar forecast inputs via the Open-Meteo-based solar path
- A correctly configured site model.
  - battery capacity and limits
  - latitude / longitude / timezone
  - solar array orientation and capacity

Without those pieces, Chargecaster can still run in dry-run, fallback, or partially simulated modes, but it is much less representative of how the project is intended to be used today.

## Local Development

### Prerequisites

- Node.js 20+
- `pnpm` 9+
- Docker 24+ if you want the container workflow
- Native build tools for `better-sqlite3` and `catboost`
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `build-essential python3`
- Optional but recommended for model training: Python 3 with `pip`

### 1. Create a local config

```bash
cp config.yaml.sample config.local.yaml
```

Start with `dry_run: true` until you are comfortable with the planning output.

Important config areas:

- `fronius`: inverter/battery control endpoint
- `evcc`: practically essential for a useful live deployment today, even though the code can still run without it
- `price`: market price, grid-fee, and feed-in providers
- `location` and `solar`: required for weather and solar context
- `battery`: capacity, power limits, and SOC bounds
- `load_forecast`: model directory and self-training behavior

### Local dev vs. meaningful runtime

For UI work, simulation work, or dry-run experimentation, you do not need the full hardware stack online all the time.

For a meaningful end-to-end runtime, you should assume you need:

- Fronius inverter access
- a real battery configuration
- EVCC reachable from Chargecaster
- working tariff data sources
- working weather / solar inputs

The current system can degrade gracefully when some of these are missing, but the intended operating mode still assumes all of them are available.

### 2. Install dependencies

```bash
pnpm install
```

If a native dependency did not build correctly on a fresh machine, rebuild it explicitly:

```bash
pnpm rebuild better-sqlite3 catboost
```

### 3. Start the app in dev mode

```bash
pnpm dev
```

That starts:

- backend API on `http://localhost:4000`
- frontend dev server on `http://localhost:5173`

The frontend talks to the backend over tRPC at `http://localhost:4000/trpc`.

### Running backend and frontend separately

Backend only:

```bash
pnpm --filter chargecaster-backend backend:dev:api
```

Frontend only:

```bash
VITE_TRPC_URL=http://localhost:4000/trpc pnpm --filter chargecaster-frontend dev
```

### Runtime files created locally

- SQLite history and snapshots: `data/db/backend.sqlite`
- Trained model candidates: `data/models/load-forecast/<timestamp>/`
- Active promoted model: `data/models/load-forecast/current/`

### Quality checks

```bash
pnpm lint:all
pnpm typecheck:all
pnpm build:all
```

Backend tests:

```bash
pnpm --filter chargecaster-backend test
pnpm --filter chargecaster-backend test:e2e
```

## Build and Run the Monolith Container

The Docker image is a single-container deployment:

- the backend is bundled with esbuild
- the frontend is built to static assets
- the backend serves those static assets directly from `/public`
- the image also contains the Python/CatBoost runtime needed for forecasting and retraining

### Build the image

```bash
docker build -t chargecaster:local .
```

Optional build metadata:

```bash
docker build \
  --build-arg FRONTEND_BUILD_VERSION=dev-local \
  --build-arg BACKEND_BUILD_VERSION=dev-local \
  -t chargecaster:local .
```

### Run the image

```bash
docker run --rm \
  -p 6969:8080 \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/config.local.yaml:/app/config.yaml:ro" \
  -e CHARGECASTER_CONFIG=/app/config.yaml \
  chargecaster:local
```

Then open:

- UI: `http://localhost:6969`
- API: `http://localhost:6969/trpc`

What the container expects:

- a readable config file mounted at `/app/config.yaml`
- a writable `/data` mount for SQLite, model promotion, and runtime artifacts

### Docker Compose helper

```bash
docker compose up --build
```

The included `docker-compose.yml` already:

- builds `Dockerfile`
- maps host port `6969` to container port `8080`
- mounts `./data` to `/data`
- mounts `config.local.yaml` to `/app/config.yaml`

You can override the config path with:

```bash
CHARGECASTER_CONFIG_FILE=./config.local.yaml docker compose up --build
```

## CatBoost Load Forecast: Pre-Training and Runtime Lifecycle

The load forecast is one of the key inputs into battery optimization. If Chargecaster underestimates demand, it may discharge too aggressively. If it overestimates demand, it may buy unnecessary energy or leave usable solar on the table.

That is why the project ships with a pre-trained CatBoost artifact and also supports retraining from your own historical data.

### What is pre-trained?

The repository includes a bundled starter model in:

```text
backend/assets/load-forecast/current/
```

That directory contains:

- `model.cbm`
- `manifest.json`
- `metrics.json`
- `training.log`

On startup, if the writable runtime model directory does not yet contain a valid `current/` artifact, the backend seeds it from the bundled copy. That gives a fresh install a working ML forecast immediately, without waiting for local retraining.

### What data does the model train on?

The Python training pipeline reads from the SQLite history store and builds hourly training rows from the raw telemetry history.

The training code pulls in:

- historical house power
- historical solar power
- stored or proxy solar forecast context
- price context
- cached weather features
- calendar structure in the configured timezone

Only sufficiently populated hours are treated as valid targets.

### What features are used?

The current feature contract contains 24 numeric features, including:

- local hour, weekday, week of year, month, season
- temperature, cloud cover, wind speed, precipitation
- forecast solar now, next 3h mean, next 6h mean
- price now, next 6h mean, next 24h percentile, top-quartile flag
- lagged load context
- same-hour previous day / previous week values and missing flags

The runtime checks that the artifact's feature schema and feature names match the live contract before it will serve that model.

### What target does the model learn?

The current model uses `baseline_ratio_v1` as its target mode.

That means the CatBoost model does not directly predict raw house power in watts. Instead, it learns a multiplier over a recency-weighted baseline forecast. At inference time, Chargecaster:

1. builds the baseline demand estimate
2. asks CatBoost for a ratio
3. applies that ratio to the baseline
4. clamps the result into a safe power range
5. applies light shape calibration across the forecast horizon

This tends to be more stable than asking the model to learn absolute load from scratch.

### How is the model trained?

The training pipeline in `backend/ml/load_forecast_lib.py` does the following:

1. Aggregate raw history into hourly rows.
2. Build a baseline forecast from recency-weighted hour/weekday/season averages.
3. Build the CatBoost feature matrix and weighted targets.
4. Evaluate with walk-forward folds.
   - Training starts only after at least 42 days of valid hourly history.
   - Each fold trains on history before a cutoff and evaluates on the following 24 hours.
5. Compare the model against:
   - a flat `2200 W` baseline
   - an hour-of-week baseline
   - the hybrid fallback forecaster
6. Train a final model on all valid rows.
7. Write a versioned artifact containing the model and metrics.

Training uses sample weights to care more about economically important periods, especially:

- higher-price hours
- low-solar hours where imports matter more
- common morning/evening decision windows

### Local setup for training

If you want to train or evaluate locally, create a Python environment and install the ML requirements:

```bash
python3 -m venv .venv-load-forecast
source .venv-load-forecast/bin/activate
python -m pip install -r backend/ml/requirements.txt
```

If you want Chargecaster's background retraining to use this environment, point `load_forecast.python_executable` in `config.local.yaml` at that interpreter.

### Manual training commands

Train a new candidate:

```bash
pnpm --filter chargecaster-backend load-forecast:train
```

Evaluate a model artifact explicitly:

```bash
pnpm --filter chargecaster-backend load-forecast:evaluate
```

Replay evaluation against historical windows:

```bash
pnpm --filter chargecaster-backend load-forecast:replay-evaluate
```

Promote a trained candidate into `current/`:

```bash
pnpm --filter chargecaster-backend load-forecast:promote -- 20260410T153206610Z
```

Bundle a trained candidate back into the repository seed artifact:

```bash
pnpm --filter chargecaster-backend load-forecast:bundle -- 20260410T153206610Z
```

### Automatic retraining and promotion

The runtime can also retrain in the background when enabled in config:

```yaml
load_forecast:
  self_training_enabled: true
  python_executable: "python3"
  min_history_days: 56
  min_new_history_days: 14
  retrain_window_start_hour: 1
  retrain_window_end_hour: 5
  auto_promote_mode: "strict"
```

In `strict` mode, a candidate is only auto-promoted if it clears multiple gates:

- at least 3% MAE improvement over the active model
- no regression on the tracked economic `p90` error against the active model
- no regression versus the hybrid fallback on the checked metrics
- replay cost delta is non-positive, meaning it does not make the optimizer more expensive on replayed windows

If `auto_promote_mode` is `manual`, the candidate is trained and evaluated but not switched into `current/` until you promote it yourself.

## Operational Notes

- `dry_run: true` is the safe default for development and tuning.
- The Fronius backend can translate optimizer output into concrete battery commands when dry-run is disabled and credentials are configured.
- The dashboard also exposes backtests so you can compare current strategy behavior against recent historical days.
- If the CatBoost runtime is unavailable, Chargecaster keeps working by falling back to the hybrid forecaster.

## Release and Deployment

The repository includes:

- `Dockerfile` for the monolith image
- `docker-compose.yml` for local container runs
- `.gitlab-ci.yml` for GitLab-based image builds
- `tag_and_push.sh` for tag-based release publishing

For a local release-style build, the container path above is the easiest way to test what will actually ship.
