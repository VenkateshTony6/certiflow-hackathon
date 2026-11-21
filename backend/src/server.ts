import { app } from "./app";
import { config } from "./config";
import { redis } from "./redis";

const server = app.listen(config.port, () => {
  console.log(`CertiFlow API listening on port ${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received; shutting down API.`);
  server.close(() => {
    void redis.quit().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

