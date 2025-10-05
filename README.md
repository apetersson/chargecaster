# chargecaster

chargecaster plans charge/discharge schedules for a residential battery, persists the latest optimiser snapshot, and serves a React dashboard for quick monitoring. The codebase is TypeScript end-to-end: a NestJS backend publishes a tRPC API while a Vite bundle renders the UI.

---

## Features at a Glance
- End-to-end optimiser that ingests tariff forecasts, solar estimates, and live SOC and outputs a cost-aware plan (`current_mode`, SOC targets, projected spend).
- Shared TypeScript contracts between backend and frontend via direct source imports (`@backend/*` path aliases).
- SQLite (via `better-sqlite3`) snapshot/history store managed by the backend.
- Ready-to-run Docker image that serves the SPA through nginx and reverse-proxies API calls.

---

## Project Layout
```
.
├── backend/            # NestJS + Fastify + tRPC API and optimiser
│   ├── fixtures/       # Sample data used for seeding demos
│   ├── src/            # Application code
│   └── package.json
├── frontend/           # React + Vite dashboard
│   ├── src/            # Components, hooks, API client
│   └── package.json
├── config.local.yaml   # Example runtime configuration
├── data/               # Created at runtime; contains SQLite database
├── Dockerfile          # Multi-stage image (frontend + backend + nginx)
├── docker-compose.yml  # Local orchestration helper
├── docker/entrypoint.sh
└── nginx-default.conf
```

---

## Prerequisites
- **Node.js 20+** and **Yarn 1.22+** for development builds.
- **Docker 24+** (optional) for container workflows.
- Native build tools (`xcode-select --install` on macOS or `build-essential` + `python3` on Debian/Ubuntu) for `better-sqlite3`.

---

## Local Development
1. Install backend dependencies:
   ```bash
   cd backend
   yarn install
   ```
2. Install frontend dependencies:
   ```bash
   cd ../frontend
   yarn install
   ```
3. Start the backend in one terminal:
   ```bash
   cd backend
   yarn start
   ```
   - Listens on `http://localhost:4000`.
   - Loads optimisation inputs from `config.local.yaml` by default.
4. Start the frontend in another terminal:
   ```bash
   cd frontend
   yarn dev
   ```
   - Serves the dashboard at `http://localhost:5173`.
   - Uses `VITE_TRPC_URL` (defaults to `http://localhost:4000/trpc`).

The dashboard batches tRPC calls such as `dashboard.summary`, `dashboard.history`, and `dashboard.oracle`. Snapshot data is persisted to `data/db/backend.sqlite` so subsequent loads reuse the latest optimiser output.

---

## Configuration
- `config.local.yaml` is the canonical sample. Copy or symlink it to customise credentials, tariff providers, or solar forecasts.
- The backend reads `CHARGECASTER_CONFIG` if set; otherwise it falls back to `../config.local.yaml` relative to the backend working directory.
- `data/db/backend.sqlite` is created automatically; mount `data/` as a volume to persist history.

Key environment variables:
- `CHARGECASTER_CONFIG` – absolute path to the YAML config (default `/app/config.yaml` inside Docker).
- `PORT` / `HOST` – Fastify bind target (defaults `4000` / `0.0.0.0`).
- `NODE_ENV` – set to `production` in the container image.

---

## Testing & Quality Gates
Backend:
```bash
cd backend
yarn lint
yarn typecheck
yarn test
yarn test:e2e
```

Frontend:
```bash
cd frontend
yarn lint
yarn test        # if suites exist
yarn build
```

---

## Docker Image
The root `Dockerfile` produces a single image with three stages:
1. Build the Vite frontend into `/public`.
2. Install backend dependencies (including the native SQLite binding).
3. Serve the app via nginx while running the NestJS API with `tsx`.

Build and run manually:
```bash
docker build -t chargecaster:local .
docker run \
  -p 6969:80 \
  -v $(pwd)/data:/data \
  -v $(pwd)/config.local.yaml:/app/config.yaml:ro \
  -e CHARGECASTER_CONFIG=/app/config.yaml \
  --name chargecaster \
  chargecaster:local
```

- Visit `http://localhost:6969` for the UI.
- `/data` persists `db/backend.sqlite` and any future runtime assets.
- Logs from nginx and the backend are emitted to the container stdout/stderr streams.

---

## Docker Compose (local convenience)
A helper compose file (`docker-compose.yml`) builds the image locally and wires the expected mounts:
```bash
docker compose up --build
```
Configuration highlights:
- Binds host port `6969` to container port `80`.
- Mounts the repository `data/` directory into `/data`.
- Mounts `config.local.yaml` into `/app/config.yaml` (read-only) via the `CHARGECASTER_CONFIG_FILE` variable (defaults to `./config.local.yaml`).
- Restarts the container unless stopped manually.

Update `docker-compose.yml` if your config file lives elsewhere or if you prefer a pre-built registry image.

Example with an absolute config path:
```bash
CHARGECASTER_CONFIG_FILE=/Users/andreas/Documents/code/scripts/qnd/chargecaster/config.local.yaml \
  docker compose up --build
```

---

## Operations & Troubleshooting
- **Resetting state**: stop the container and delete `data/db/backend.sqlite`; the backend will reseed from fixtures.
- **CORS errors**: ensure the frontend points to the same origin or update Fastify CORS rules in `backend/src/main.ts`.
- **better-sqlite3 build failures**: confirm build tooling is installed before running `yarn install` or building the Docker image.
- **Updating dependencies**: run `yarn upgrade` in each project and rebuild the Docker image.

---

## License
Provided as-is without warranty. Adapt configuration and deployment to suit your installation.
