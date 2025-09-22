FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

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
    VITE_TRPC_URL=/trpc

COPY --from=backend-builder /app/backend /app/backend
COPY --from=frontend-builder /app/frontend/dist /public

COPY nginx-default.conf /etc/nginx/conf.d/default.conf
COPY config.yaml.sample /app/config.yaml.sample
COPY config.yaml /app/config.yaml.dist

COPY docker/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
  && rm -f /etc/nginx/sites-enabled/default \
  && ln -s /data /app/data

VOLUME ["/data"]

EXPOSE 80

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
