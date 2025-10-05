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

# Build backend
COPY backend/ backend/
RUN yarn workspace chargecaster-backend build \
  && yarn cache clean --force || true


FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx tini curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    CHARGECASTER_CONFIG=/app/config.yaml \
    VITE_TRPC_URL=/trpc \
    NGINX_PORT=8080

# Copy production artifacts and the workspace node_modules from builder
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/backend/dist /app/backend/dist
COPY --from=builder /app/backend/package.json /app/backend/package.json
COPY --from=builder /app/frontend/dist /public
COPY --from=builder /app/packages/domain/package.json /app/packages/domain/package.json
COPY --from=builder /app/packages/domain/dist /app/packages/domain/dist
COPY --from=builder /app/packages/domain/dist-cjs /app/packages/domain/dist-cjs

COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx-default.conf /etc/nginx/conf.d/default.conf
COPY config.yaml.sample /app/config.yaml.sample

COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && rm -f /etc/nginx/sites-enabled/default \
  && mkdir -p /var/run/nginx /var/cache/nginx /var/lib/nginx \
  && ln -s /data /app/data \
  && node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('/app/backend/package.json','utf8'));pkg.type='commonjs';fs.writeFileSync('/app/backend/package.json',JSON.stringify(pkg,null,2));" \
  && chown -R node:node /app /var/cache/nginx /var/lib/nginx /var/run/nginx

VOLUME ["/data"]

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["curl", "-fsS", "http://127.0.0.1:8080/"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

