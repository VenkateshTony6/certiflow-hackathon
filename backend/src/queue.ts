import { Queue } from "bullmq";
import { redis } from "./redis";

const suffix = process.env.VITEST ? "-test" : "";
export const queueNames = {
  certificates: `certificate-issuance${suffix}`,
  whatsapp: `whatsapp-delivery${suffix}`,
  escalation: `batch-escalation${suffix}`,
};

export const certificateQueue = new Queue(queueNames.certificates, {
  connection: redis,
});

export const whatsappQueue = new Queue(queueNames.whatsapp, {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  },
});

export const escalationQueue = new Queue(queueNames.escalation, {
  connection: redis,
});

