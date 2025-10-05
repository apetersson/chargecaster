FROM node:20-bookworm-slim AS domain-builder

RUN corepack enable

WORKDIR /app/packages/domain

COPY packages/domain/package.json packages/domain/tsconfig.json packages/domain/tsconfig.build.json packages/domain/tsconfig.build.cjs.json ./
COPY packages/domain/src ./src

RUN if [ -f yarn.lock ]; then \
      yarn install --frozen-lockfile --check-files; \
    else \
      yarn install --check-files; \
    fi \
    && yarn build


FROM node:20-bookworm-slim AS frontend-builder

RUN corepack enable

WORKDIR /app/frontend

COPY --from=domain-builder /app/packages/domain /app/packages/domain
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile --check-files

COPY frontend/ ./

ARG VITE_TRPC_URL=/trpc
ENV VITE_TRPC_URL=${VITE_TRPC_URL}

RUN yarn build


FROM node:20-bookworm-slim AS backend-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app/backend

COPY --from=domain-builder /app/packages/domain /app/packages/domain
COPY backend/package.json backend/yarn.lock ./
RUN yarn install --frozen-lockfile --check-files

COPY backend/ ./

RUN yarn run tsc -p tsconfig.build.json

RUN rm -rf node_modules \
  && yarn install --frozen-lockfile --production --check-files \
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

COPY --from=backend-builder /app/backend/node_modules /app/backend/node_modules
COPY --from=backend-builder /app/backend/dist /app/backend/dist
COPY --from=backend-builder /app/backend/package.json /app/backend/package.json
COPY --from=backend-builder /app/backend/yarn.lock /app/backend/yarn.lock
COPY --from=frontend-builder /app/frontend/dist /public
COPY --from=domain-builder /app/packages/domain /app/packages/domain

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
