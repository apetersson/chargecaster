FROM python:3.12-alpine

RUN adduser -D -H app && \
    mkdir -p /app /data && chown -R app:app /app /data

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY controller.py core.py evaluate_once.py config.yaml ./
RUN chmod +x /app/controller.py

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD pgrep -f controller.py >/dev/null || exit 1

USER app
CMD ["python", "-u", "/app/controller.py"]
