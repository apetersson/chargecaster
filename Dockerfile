FROM node:20-bookworm-slim AS domain-builder

WORKDIR /app/packages/domain

COPY packages/domain/package.json packages/domain/tsconfig.json packages/domain/tsconfig.build.json ./
COPY packages/domain/src ./src

RUN yarn install && yarn build


FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

COPY --from=domain-builder /app/packages/domain /app/packages/domain
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY frontend/ ./

ARG VITE_TRPC_URL=/trpc
ENV VITE_TRPC_URL=${VITE_TRPC_URL}

RUN yarn build


FROM node:20-bookworm-slim AS backend-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY --from=domain-builder /app/packages/domain /app/packages/domain
COPY backend/package.json backend/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY backend/ ./

RUN yarn cache clean --force || true


FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    BATTERYCTL_CONFIG=/app/config.yaml \
    VITE_TRPC_URL=/trpc \
    NGINX_PORT=8080

COPY --from=backend-builder /app/backend /app/backend
COPY --from=frontend-builder /app/frontend/dist /public

COPY nginx.conf /etc/nginx/nginx.conf
COPY nginx-default.conf /etc/nginx/conf.d/default.conf
COPY config.yaml.sample /app/config.yaml.sample
COPY config.yaml /app/config.yaml.dist

COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && rm -f /etc/nginx/sites-enabled/default \
  && mkdir -p /data /var/run/nginx \
  && ln -s /data /app/data \
  && chown -R node:node /app /data /var/cache/nginx /var/lib/nginx /var/run/nginx

VOLUME ["/data"]

EXPOSE 8080

USER node

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
