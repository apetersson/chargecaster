# Build frontend bundle with Vite
FROM node:20-alpine AS frontend-build
WORKDIR /frontend

COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY frontend/vite.config.ts ./vite.config.ts
COPY frontend/tsconfig.json ./tsconfig.json
COPY frontend/tsconfig.node.json ./tsconfig.node.json
COPY frontend/index.html ./index.html
COPY frontend/public ./public
COPY frontend/src ./src

RUN yarn build

# Runtime image: Python controller + nginx serving static bundle
FROM python:3.12-alpine

RUN apk add --no-cache nginx bash && \
    adduser -D -H app && \
    mkdir -p /app /data /public && \
    chown -R app:app /app /data /public

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY controller.py core.py evaluate_once.py config.yaml ./
COPY nginx-default.conf /etc/nginx/http.d/default.conf
COPY start.sh /start.sh
COPY --from=frontend-build /frontend/dist /public
RUN mkdir -p /public/data
COPY snapshots/latest.json /public/data/latest.json
RUN chown -R app:app /public && \
    chmod +x /app/controller.py /start.sh

EXPOSE 80

VOLUME ["/data", "/public/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD pgrep -f controller.py >/dev/null || exit 1

CMD ["/start.sh"]
