#!/bin/sh
set -eu

echo "Applying database migrations..."
npx prisma migrate deploy

echo "Seeding database..."
node dist/prisma/seed.js

echo "Starting API and queue worker..."
node dist/src/server.js &
api_pid=$!
node dist/src/worker.js &
worker_pid=$!

shutdown() {
  kill "$api_pid" "$worker_pid" 2>/dev/null || true
  wait "$api_pid" "$worker_pid" 2>/dev/null || true
}

trap shutdown INT TERM EXIT
wait -n "$api_pid" "$worker_pid"

