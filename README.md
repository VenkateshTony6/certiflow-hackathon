# CertiFlow

CertiFlow is a TypeScript monorepo with an Express/BullMQ backend and a React/Vite frontend.

## Start the complete stack

1. Copy `.env.example` to `.env` if you need to override any host ports.
2. Run:

   ```bash
   docker compose up --build
   ```

The frontend is available at http://localhost:5173 and the API health endpoint at http://localhost:4000/health. The backend container waits for PostgreSQL and Redis, applies Prisma migrations, runs the idempotent seed, and then starts both the API and BullMQ worker.

If ports 5432 or 6379 are already occupied, set `POSTGRES_PORT` or `REDIS_PORT` in `.env`; container-to-container ports remain unchanged.

