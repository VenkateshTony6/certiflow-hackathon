import { Worker } from "bullmq";
import { config } from "./config";

const worker = new Worker(
  "certificate-issuance",
  async (job) => {
    console.log(`Processing certificate job ${job.id}`);
    return { processedAt: new Date().toISOString() };
  },
  { connection: config.redis },
);

worker.on("ready", () => console.log("Certificate worker is ready."));
worker.on("failed", (job, error) => console.error(`Job ${job?.id} failed`, error));

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received; shutting down worker.`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

