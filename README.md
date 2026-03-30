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
├── config.yaml.sample  # Sanitized runtime configuration template
├── config.local.yaml   # Local runtime configuration (gitignored)
├── data/               # Created at runtime; contains SQLite database
├── Dockerfile  # Distroless runtime image (bundled backend; serves SPA when enabled)
├── docker-compose.yml  # Local orchestration helper
└── docker/entrypoint.sh
```

---

## Prerequisites

- **Node.js 20+** and **pnpm 9+** for development builds (`npm install -g pnpm` or via [corepack](https://pnpm.io/installation#using-corepack)).
- **Docker 24+** (optional) for container workflows.
- Native build tools (`xcode-select --install` on macOS or `build-essential` + `python3` on Debian/Ubuntu) for
  `better-sqlite3`.

---

## Local Development

**One-command quickstart** (backend + frontend together):

```bash
pnpm install
pnpm dev
```

- Backend API at `http://localhost:4000`, frontend at `http://localhost:5173`.
- Uses `concurrently` to run both processes with colour-coded output.

Or two separate terminals if you prefer:

Terminal A – API/backend

```bash
cd backend
pnpm backend:dev:api
```

Terminal B – Web/frontend

```bash
cd frontend
VITE_TRPC_URL=http://localhost:4000/trpc pnpm dev
```

Notes:

- Backend binds to `http://localhost:4000`.
- Reads `config.local.yaml` by default, or `CHARGECASTER_CONFIG` if set.
- The backend and frontend import the shared domain package from source, so no pre-build is required in dev.

The dashboard batches tRPC calls such as `dashboard.summary`, `dashboard.history`, and `dashboard.oracle`. Snapshot data
is persisted to `data/db/backend.sqlite` so subsequent loads reuse the latest optimiser output.

### Lint / Typecheck / Build (all subprojects)

From the repo root (workspaces):

```bash
pnpm install
pnpm lint:all
pnpm typecheck:all
pnpm build:all
```

> **Note on `better-sqlite3`**: pnpm 10 requires explicit build-script approval. The root `package.json`
> already includes `pnpm.onlyBuiltDependencies` for `better-sqlite3`. If the native addon is missing
> after a fresh install, run `pnpm rebuild better-sqlite3`.

In both dev and production builds, the backend and frontend resolve the shared domain package from source instead of
depending on a prebuilt workspace output.

---

## Configuration

- Copy `config.yaml.sample` to `config.local.yaml` and customise credentials, tariff providers, and the site location
  used for weather-backed demand forecasting.
- The backend reads `CHARGECASTER_CONFIG` if set; otherwise it falls back to `../config.local.yaml` relative to the
  backend working directory.
- `data/db/backend.sqlite` is created automatically; mount `data/` as a volume to persist history.

Key environment variables:

- `CHARGECASTER_CONFIG` – absolute path to the YAML config (default `/app/config.yaml` inside Docker).
- `PORT` / `HOST` – Fastify bind target (defaults `4000` / `0.0.0.0`).
- `NODE_ENV` – set to `production` in the container image.

Strict validation: The configuration parser rejects unknown top‑level keys. Valid sections are `dry_run`, `fronius`,
`battery`, `price`, `logic`, `location`, `evcc`, `market_data`, and `logging`. Unknown keys will raise a validation
error at startup.

---

## Testing & Quality Gates

Backend:

```bash
cd backend
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

Frontend:

```bash
cd frontend
pnpm lint
pnpm build
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
cp config.yaml.sample config.local.yaml
CHARGECASTER_CONFIG_FILE=./config.local.yaml \
  docker compose up --build
```

---

## GitLab CI / Registry

The repository is also connected to GitLab at `gitlab.capacity.at` as `capacity-projects/chargecaster`.

- Remote: `gitlab` -> `ssh://git@gitlab.capacity.at:2222/capacity-projects/chargecaster.git`
- Registry: `registry.capacity.at/capacity-projects/chargecaster`
- Pipeline: `.gitlab-ci.yml` builds the existing `Dockerfile` with GitLab Runner via Kaniko
- Published tags:
  - pushes to `main` publish `:main`, `:latest`, and `:${CI_COMMIT_SHORT_SHA}`
  - git tags publish `:${CI_COMMIT_TAG}` and `:${CI_COMMIT_SHORT_SHA}`

This is the preferred container build path for Capacity-hosted releases.

---

## Release: Tag & Push

Use `./tag_and_push.sh` to bump the git tag, push the branch and tag to GitLab, and let GitLab CI publish the container image to the Capacity registry.

Usage:

```
./tag_and_push.sh [patch|minor|major|vX.Y.Z]
```

Defaults:
- Registry repo: `registry.capacity.at/capacity-projects/chargecaster` (override with `REGISTRY_REPO`)
- Remote: `gitlab` (override with `GIT_REMOTE`)

Examples:

```
# Patch bump from latest tag
./tag_and_push.sh

# Explicit version
./tag_and_push.sh v0.1.5
```

Resulting image tags:

- Tag push `vX.Y.Z` publishes `registry.capacity.at/capacity-projects/chargecaster:vX.Y.Z`
- The same tag pipeline also publishes `registry.capacity.at/capacity-projects/chargecaster:<short-sha>`
- Pushes to `main` publish `:main` and `:latest`

This is the intended path for staging: point the server at `registry.capacity.at/capacity-projects/chargecaster:vX.Y.Z` for pinned releases, or `:main` / `:latest` if you want a moving tag.

---

## Dev vs. Container: Static Files and Ports

- In dev, run the backend without static files and use Vite for the SPA:
  - Backend: `backend:dev:api` at `http://localhost:4000` (tRPC at `/trpc`).
  - Frontend: `VITE_TRPC_URL=http://localhost:4000/trpc pnpm --filter chargecaster-frontend dev` at `http://localhost:5173`.
- In containers, the backend serves the built SPA from `/public` when `SERVE_STATIC=true` (default in Dockerfiles).
  - Container listens on `8080` and Compose maps it to `6969`.

Environment flags:
- `SERVE_STATIC` — `true` to serve `/public` and SPA fallback (containers), `false` for API‑only mode (dev).
- `CHARGECASTER_CONFIG` — absolute path to YAML config (defaults to `/app/config.yaml` in containers).

---

## Operations & Troubleshooting

- **Resetting state**: stop the container and delete `data/db/backend.sqlite`; the backend will reseed from fixtures.
- **CORS errors**: ensure the frontend points to the same origin or update Fastify CORS rules in `backend/src/main.ts`.
- **better-sqlite3 build failures**: confirm build tooling is installed, then run `pnpm rebuild better-sqlite3`. The
  Docker build runs this automatically via `onlyBuiltDependencies`.
- **Updating dependencies**: run `pnpm update` from the repo root and rebuild the Docker image.

---

## License

No license granted. All rights reserved. A final license will be determined at a later date. Until then, you may not copy, distribute, or use this software except with explicit written permission from the author.
