# Demand Hunter service — runs on a dedicated server, NOT on Netlify.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DH_DATA_DIR=/data \
    MOCK_MODE=true \
    DH_SIMULATED=true

RUN groupadd --system dh && useradd --system --gid dh --home /app dh
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY buyerml ./buyerml
COPY tests ./tests
RUN mkdir -p /data && chown -R dh:dh /data

USER dh
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
# One worker: replay protection (nonces) and the hunt threads live in this process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--proxy-headers", "--no-server-header"]
