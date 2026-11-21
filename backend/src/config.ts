import "dotenv/config";

const port = Number(process.env.PORT ?? 4000);
const redisPort = Number(process.env.REDIS_PORT ?? 6379);

if (!Number.isInteger(port) || !Number.isInteger(redisPort)) {
  throw new Error("PORT and REDIS_PORT must be integers");
}

export const config = {
  port,
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: redisPort,
  },
};

