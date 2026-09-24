#!/usr/bin/env bash
# Starts (or restarts) a local Postgres container for the mock backends.
# Always removes and recreates the container so it works after Codespace restarts.
# Data persists in ./.pgdata (gitignored). Tables/seed data are created by the app on start.
set -euo pipefail

NAME=po-backends-postgres
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$DIR/.pgdata"

echo "▶ Waiting for Docker..."
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "✖ Docker is not available"; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true

docker run -d --name "$NAME" \
  -e POSTGRES_USER=api_user \
  -e POSTGRES_PASSWORD=api_pass \
  -e POSTGRES_DB=po_backends_db \
  -p 5432:5432 \
  -v "$DIR/.pgdata:/var/lib/postgresql/data" \
  postgres:16-alpine >/dev/null

echo "▶ Waiting for Postgres to accept connections..."
for i in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U api_user -d po_backends_db >/dev/null 2>&1; then
    echo "✔ Postgres ready on localhost:5432 (db po_backends_db, user api_user)"
    exit 0
  fi
  sleep 1
done
echo "✖ Postgres did not become ready. Check: docker logs $NAME"
exit 1
