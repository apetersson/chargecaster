# batteryctl

Batteryctl optimises residential battery charge/discharge schedules against day-ahead tariffs and exposes the results over a lightweight web dashboard. The project now ships a full TypeScript stack:

- **Backend** – NestJS + Fastify + tRPC (`backend/`)
- **Frontend** – React + Vite + TanStack Query (`frontend/`)
- **Storage** – better-sqlite3 for local persistence, JSON snapshots for the UI

Both apps run with hot-reload in development and share a common type layer so the dashboard speaks to the API without manual schema glue.

## Highlights

- Fetches live state from EVCC (or bundled fixtures) and optional market data feeds.
- Dynamic programming optimiser calculates cost-minimising trajectories while respecting battery constraints.
- Exposes snapshot, history, and trajectory endpoints over tRPC; the frontend consumes them via auto-generated TypeScript types.
- Ships with fixtures for rapid local demos—no hardware connection required.
- Supports Docker/Compose packaging for one-command deployments (API + UI + SQLite volume).

## Repository Layout

```
.
├── backend/                # NestJS Fastify API + optimiser and storage layers
│   ├── src/
│   │   ├── simulation/     # Optimiser implementation + helpers
│   │   ├── storage/        # better-sqlite3 persistence layer
│   │   └── trpc/           # Router definitions exposed to the frontend
│   ├── fixtures/           # Sample EVCC dumps used for seeding demo state
│   ├── dev-server.mjs      # Build/watch helper used by `yarn start:dev`
│   └── package.json
├── frontend/               # React dashboard
│   ├── src/
│   │   ├── api/            # tRPC client bootstrap
│   │   ├── components/     # UI widgets (summary cards, tables, charts)
│   └── package.json
├── data/                   # Created at runtime; holds the SQLite database
├── config.local.yaml       # Sample controller config (if running Python tools)
└── README.md
```

> Legacy Python utilities (`controller.py`, `core.py`, etc.) remain in the repo for reference, but the actively maintained runtime is the TypeScript backend/frontend pair described here.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **Yarn 1.22+** (`npm install -g yarn` if you do not have it yet)
- **SQLite** runtime libraries (bundled on macOS/Linux; required by `better-sqlite3`)
- **Docker 24+** (optional) for containerised deployments

## Backend: NestJS + Fastify

```bash
cd backend
yarn install
# hot reload with TypeScript compilation + auto restart
yarn start:dev
```

The dev server runs on `http://localhost:4000`. It compiles TypeScript (`tsc --watch`) to `dist/` and restarts Fastify whenever the build succeeds. Key scripts:

- `yarn test` – unit tests (Vitest)
- `yarn test:e2e` – end-to-end tRPC smoke tests
- `yarn build` – production compile to `dist/`
- `yarn lint` / `yarn typecheck` – static analysis

Environment tweaks:

- `PORT`/`HOST` override the Fastify listener (defaults `4000`, `0.0.0.0`).
- `NODE_ENV=test` suppresses logging and prevents the bootstrap auto-start (tests call `bootstrap()` manually).
- `fixtures/sample_data.json` seeds the SQLite store when no history exists; replace this file with a dump from your own system for realistic demos.

### Data storage

The API writes to `../data/db/backend.sqlite` (relative to `backend/`). Delete the `data/` folder to reset the demo database, or mount the directory as a volume in Docker for persistence.

## Frontend: React + Vite

```bash
cd frontend
yarn install
# dev server with fast refresh
yarn dev
```

The dashboard is available at `http://localhost:5173` and proxies API calls directly to the backend:

- By default it targets `http://localhost:4000/trpc`.
- Override the target by exporting `VITE_TRPC_URL` before running `yarn dev`.

Helpful scripts:

- `yarn lint` – ESLint with TypeScript support
- `yarn test` – Vitest component tests (if present)
- `yarn build` – Production bundle (outputs to `dist/`)

## Coordinated dev workflow

1. Start the backend (`yarn start:dev` in `backend/`).
2. Start the frontend (`yarn dev` in `frontend/`).
3. Visit `http://localhost:5173` – the dashboard issues batched GET requests such as
   `GET /trpc/dashboard.summary,dashboard.history,dashboard.trajectory?batch=1`.
   Fastify’s `maxParamLength` is configured to allow these long URLs.
4. Edit code in either project; both dev servers hot-reload automatically.

If you change backend TypeScript that affects generated JavaScript, remember to run `yarn build` before building Docker images so `dist/` reflects the latest changes.

## Testing checklist

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
yarn test   # if suites are defined
yarn build
```

## Docker & deployment

A container image can bundle both the API and the static frontend. The current workflow is:

```bash
# build the API
cd backend
yarn build

# build the frontend bundle
cd ../frontend
yarn build

# back at repo root, build the image (Dockerfile assumes prebuilt artifacts)
docker build -t batteryctl:local .
```

The Dockerfile (not shown here) serves the compiled frontend via nginx and launches the backend API with Node.js. Mount `./data` into `/app/data` to persist SQLite state between restarts.

## Snapshot payload reference

The backend exposes tRPC procedures; the most commonly consumed responses include:

- `dashboard.summary` – single snapshot with `current_soc_percent`, `next_step_soc_percent`, price metrics, warnings/errors.
- `dashboard.history` – chronological list of past optimiser runs (`entries` array with SOC, price, grid energy).
- `dashboard.trajectory` – optimiser forecast with per-slot SOC + energy recommendations.

## Troubleshooting

- **404 on long tRPC URLs** – Ensure the backend was rebuilt after updating adapter settings (`yarn build`). Fastify must be initialised with `maxParamLength: 4096` (already configured in `src/main.ts`).
- **better-sqlite3 install issues** – Make sure native build tooling is available (`xcode-select --install` on macOS, `build-essential` on Debian/Ubuntu).
- **CORS errors in the browser** – The backend enables permissive CORS in development. If you customise origins, update both the Fastify CORS options and the frontend `VITE_TRPC_URL`.
- **Stale fixtures** – Delete `data/db/backend.sqlite` to force reseeding from `fixtures/sample_data.json`.

## License

Provided as-is, with no warranty. Adapt the stack to match your hardware, tariffs, and deployment constraints.
