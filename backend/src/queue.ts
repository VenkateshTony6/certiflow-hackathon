import { Queue } from "bullmq";
import { redis } from "./redis";

export const certificateQueue = new Queue("certificate-issuance", {
  connection: redis,
});

