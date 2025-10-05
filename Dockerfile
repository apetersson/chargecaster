FROM node:20-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Install workspace dependencies using the root lockfile
COPY package.json yarn.lock ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN yarn install --frozen-lockfile --check-files

# Build domain first so dependents can rely on dist outputs
COPY packages/domain/ packages/domain/
RUN yarn workspace @chargecaster/domain build

# Build frontend
COPY frontend/ frontend/
ARG VITE_TRPC_URL=/trpc
ENV VITE_TRPC_URL=${VITE_TRPC_URL}
RUN yarn workspace chargecaster-frontend build

# Bundle backend with esbuild (externalize native better-sqlite3)
COPY backend/ backend/
RUN yarn workspace chargecaster-backend bundle \
  && yarn cache clean --force || true


FROM node:20-bookworm-slim AS native-deps

RUN corepack enable

WORKDIR /app/backend

# Create a minimal package.json that includes only the native module we need at runtime
COPY backend/package.json package.json
RUN node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const v=pkg.dependencies['better-sqlite3'];fs.writeFileSync('package.json', JSON.stringify({name: pkg.name+'-runtime', private:true, version: pkg.version, type:'commonjs', dependencies:{'better-sqlite3': v}}, null, 2));"
RUN yarn install --production --check-files \
  && yarn cache clean --force || true


FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    CHARGECASTER_CONFIG=/app/config.yaml \
    VITE_TRPC_URL=/trpc \
    SERVE_STATIC=true

COPY --from=builder /app/backend/dist-bundle/index.js /app/backend/dist-bundle/index.js
COPY --from=builder /app/frontend/dist /public
COPY --from=native-deps /app/backend/node_modules /app/backend/node_modules
COPY config.yaml.sample /app/config.yaml.sample

EXPOSE 8080

# Use absolute path to node in distroless
ENTRYPOINT ["/nodejs/bin/node"]

CMD ["/app/backend/dist-bundle/index.js"]
