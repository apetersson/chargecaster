# chargecaster

chargecaster plans charge/discharge schedules for a residential battery, persists the latest optimiser snapshot, and
serves a React dashboard for quick monitoring. The codebase is TypeScript end-to-end: a NestJS backend publishes a tRPC
API while a Vite bundle renders the UI.

---

## Features at a Glance

- End-to-end optimiser that ingests tariff forecasts, solar estimates, and live SOC and outputs a cost-aware plan (
  `current_mode`, SOC targets, projected spend).
- Shared TypeScript contracts between backend and frontend via direct source imports (`@backend/*` path aliases).
- SQLite (via `better-sqlite3`) snapshot/history store managed by the backend.
- Ready-to-run distroless Docker image; the backend can serve the built SPA when enabled.

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
├── Dockerfile  # Distroless runtime image (bundled backend; serves SPA when enabled)
├── docker-compose.yml  # Local orchestration helper
└── docker/entrypoint.sh
```

---

## Prerequisites

- **Node.js 20+** and **Yarn 1.22+** for development builds.
- **Docker 24+** (optional) for container workflows.
- Native build tools (`xcode-select --install` on macOS or `build-essential` + `python3` on Debian/Ubuntu) for
  `better-sqlite3`.

---

## Local Development

Quickstart (two terminals):

Terminal A – API/backend (API‑only)

```bash
cd backend
yarn install
# Dev mode with auto‑reload (tsx)
yarn backend:dev:api
# or single run without static files
yarn start:api
```

Notes:

- Binds to `http://localhost:4000`.
- Reads `config.local.yaml` by default, or `CHARGECASTER_CONFIG` if set.
- The backend uses TS path aliases to import the domain package from source (`../packages/domain/src`), so no pre‑build
  is required in dev.

Terminal B – Web/frontend (Vite)

```bash
cd ../frontend
yarn install
VITE_TRPC_URL=http://localhost:4000/trpc yarn dev
```

- Serves the dashboard at `http://localhost:5173`.
- Uses `VITE_TRPC_URL` to point to the backend tRPC endpoint (e.g. `http://localhost:4000/trpc`).

The dashboard batches tRPC calls such as `dashboard.summary`, `dashboard.history`, and `dashboard.oracle`. Snapshot data
is persisted to `data/db/backend.sqlite` so subsequent loads reuse the latest optimiser output.

### Lint / Typecheck / Build (all subprojects)

Option A — Workspaces (recommended):

```bash
yarn bootstrap
yarn lint:all
yarn typecheck:all
yarn build:all
```

Option B — Per project:

```bash
(cd packages/domain  && yarn install && yarn build)
(cd backend          && yarn install && yarn lint && yarn typecheck && yarn build)
(cd frontend         && yarn install && yarn lint && yarn typecheck && yarn build)
```

In dev mode the backend and frontend import the domain package via TS path aliases; for production builds, the domain
package should be built first so `dist/` is available (handled by `yarn build:all`).

---

## Configuration

- `config.local.yaml` is the canonical sample. Copy or symlink it to customise credentials, tariff providers, or solar
  forecasts.
- The backend reads `CHARGECASTER_CONFIG` if set; otherwise it falls back to `../config.local.yaml` relative to the
  backend working directory.
- `data/db/backend.sqlite` is created automatically; mount `data/` as a volume to persist history.

Key environment variables:

- `CHARGECASTER_CONFIG` – absolute path to the YAML config (default `/app/config.yaml` inside Docker).
- `PORT` / `HOST` – Fastify bind target (defaults `4000` / `0.0.0.0`).
- `NODE_ENV` – set to `production` in the container image.

Strict validation: The configuration parser rejects unknown top‑level keys. Valid sections are `dry_run`, `fronius`,
`battery`, `price`, `logic`, `evcc`, `market_data`, `solar`, and `logging`. Unknown keys will raise a validation error
at startup.

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

Distroless build: `Dockerfile`
- Bundles the backend with esbuild to `/app/backend/dist-bundle/index.js`.
- Installs only native runtime deps (e.g. `better-sqlite3`).
- Uses `gcr.io/distroless/nodejs20-debian12:nonroot` as the runtime.
- The backend serves the built SPA from `/public` when `SERVE_STATIC=true`.

Build and run manually:

```bash
docker build -f Dockerfile -t chargecaster:local .
docker run \
  -p 6969:8080 \
  -v "$(pwd)/data:/data" \
  -v "$(pwd)/config.local.yaml:/app/config.yaml:ro" \
  -e CHARGECASTER_CONFIG=/app/config.yaml \
  -e SERVE_STATIC=true \
  --name chargecaster \
  chargecaster:local
```

- Visit `http://localhost:6969` for the UI.
- `/data` persists `db/backend.sqlite` and any future runtime assets.
- Logs from nginx and the backend are emitted to the container stdout/stderr streams.

---

## Docker Compose (local convenience)

A helper compose file (`docker-compose.yml`) builds the distroless image locally and wires the expected mounts:

```bash
docker compose up --build
```

Configuration highlights:

- Binds host port `6969` to container port `8080`.
- Mounts the repository `data/` directory into `/data`.
- Mounts `config.local.yaml` into `/app/config.yaml` (read-only) via the `CHARGECASTER_CONFIG_FILE` variable (defaults
  to `./config.local.yaml`).
- Restarts the container unless stopped manually.

Update `docker-compose.yml` if your config file lives elsewhere or if you prefer a pre-built registry image.

Example with an absolute config path:

```bash
CHARGECASTER_CONFIG_FILE=./config.local.yaml \
  docker compose up --build
```

---

## Release: Tag & Push

Use `./tag_and_push.sh` to bump the git tag, build multi‑arch Docker images, push to Docker Hub, and push git refs (including the new tag).

Usage:

```
./tag_and_push.sh [patch|minor|major|vX.Y.Z]
```

Defaults:
- Repo: `apetersson/chargecaster` (override with `DOCKER_REPO`)
- Platforms: `linux/amd64,linux/arm64` (override with `PLATFORMS`)
- Remote: `origin` (override with `GIT_REMOTE`)

Examples:

```
# Patch bump from latest tag
./tag_and_push.sh

# Explicit version
./tag_and_push.sh v0.1.5
```

Prereqs: logged in to Docker (`docker login`) and Docker Buildx available.

---

## Dev vs. Container: Static Files and Ports

- In dev, run the backend without static files and use Vite for the SPA:
  - Backend: `backend:dev:api` at `http://localhost:4000` (tRPC at `/trpc`).
  - Frontend: `yarn dev` at `http://localhost:5173` with `VITE_TRPC_URL=http://localhost:4000/trpc`.
- In containers, the backend serves the built SPA from `/public` when `SERVE_STATIC=true` (default in Dockerfiles).
  - Container listens on `8080` and Compose maps it to `6969`.

Environment flags:
- `SERVE_STATIC` — `true` to serve `/public` and SPA fallback (containers), `false` for API‑only mode (dev).
- `CHARGECASTER_CONFIG` — absolute path to YAML config (defaults to `/app/config.yaml` in containers).

---

## Operations & Troubleshooting

- **Resetting state**: stop the container and delete `data/db/backend.sqlite`; the backend will reseed from fixtures.
- **CORS errors**: ensure the frontend points to the same origin or update Fastify CORS rules in `backend/src/main.ts`.
- **better-sqlite3 build failures**: confirm build tooling is installed before running `yarn install` or building the
  Docker image.
- **Updating dependencies**: run `yarn upgrade` in each project and rebuild the Docker image.

---

## License

No license granted. All rights reserved. A final license will be determined at a later date. Until then, you may not copy, distribute, or use this software except with explicit written permission from the author.
