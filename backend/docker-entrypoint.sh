#!/bin/sh
set -eu

echo "Applying database migrations..."
npx prisma migrate deploy

echo "Seeding database..."
node dist/prisma/seed.js

echo "Starting API..."
exec node dist/src/server.js

