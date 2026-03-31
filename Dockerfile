FROM node:20-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

WORKDIR /app

# Install workspace dependencies using the root lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Copy shared domain sources before building dependents
COPY packages/domain/ packages/domain/

# Build frontend
COPY frontend/ frontend/
ARG FRONTEND_BUILD_VERSION=dev
ARG VITE_TRPC_URL=/trpc
ENV VITE_BUILD_VERSION=${FRONTEND_BUILD_VERSION}
ENV VITE_TRPC_URL=${VITE_TRPC_URL}
RUN pnpm --filter chargecaster-frontend build

# Bundle backend with esbuild against workspace sources (externalize native better-sqlite3)
COPY backend/ backend/
RUN pnpm --filter chargecaster-backend bundle \
  && pnpm store prune || true


FROM node:20-bookworm-slim AS native-deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

WORKDIR /app/backend

# Create a minimal package.json that includes only the native module we need at runtime
COPY backend/package.json package.json
RUN node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const deps={'better-sqlite3': pkg.dependencies['better-sqlite3']};if(pkg.dependencies['catboost']) deps['catboost']=pkg.dependencies['catboost'];fs.writeFileSync('package.json', JSON.stringify({name: pkg.name+'-runtime', private:true, version: pkg.version, type:'commonjs', dependencies:deps, pnpm:{onlyBuiltDependencies:['better-sqlite3','catboost']}}, null, 2));"
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --shamefully-hoist


FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG BACKEND_BUILD_VERSION=dev
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CHARGECASTER_CONFIG=/app/config.yaml \
    CHARGECASTER_BUILD_VERSION=${BACKEND_BUILD_VERSION} \
    VITE_TRPC_URL=/trpc \
    SERVE_STATIC=true

COPY --from=builder /app/backend/dist-bundle/index.js /app/backend/dist-bundle/index.js
COPY --from=builder /app/backend/assets/load-forecast /app/backend/assets/load-forecast
COPY --from=builder /app/backend/ml /app/backend/ml
COPY --from=builder /app/frontend/dist /public
COPY --from=native-deps /app/backend/node_modules /app/backend/node_modules
COPY config.yaml.sample /app/config.yaml.sample

RUN find /app/backend/node_modules -name libcatboostmodel.so -exec cp {} /usr/local/lib/libcatboostmodel.so \; \
  && ldconfig \
  && python3 -m pip install --no-cache-dir --break-system-packages -r /app/backend/ml/requirements.txt

EXPOSE 8080

CMD ["node", "/app/backend/dist-bundle/index.js"]
