import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { BatchStatus, DeliveryStatus, PrismaClient, UserRole } from "@prisma/client";
import { Worker } from "bullmq";
import { config } from "./config";
import { certificateQueue, escalationQueue, queueNames, whatsappQueue } from "./queue";
import { redis } from "./redis";
import { createDownloadToken } from "./helpers/pdfAccess";
import { certificatesDirectory } from "./storage";

const prisma = new PrismaClient();
const connection = { host: config.redis.host, port: config.redis.port };
type IssuanceJob = { batchId: string; actorId: string; correlationId?: string };
type WhatsappJob = { certificateId: string; actorId: string; correlationId?: string };

let workers: Worker[] = [];
let started = false;

async function nextCertificateNumber(): Promise<string> {
  await prisma.$executeRawUnsafe(
    'CREATE SEQUENCE IF NOT EXISTS "Certificate_number_seq" START WITH 1 INCREMENT BY 1',
  );
  const [result] = await prisma.$queryRawUnsafe<{ sequence: bigint }[]>(
    `SELECT nextval('"Certificate_number_seq"') AS sequence`,
  );
  return `PSM-2026-${result.sequence.toString().padStart(6, "0")}`;
}

async function generateCertificatePdf(input: {
  certNumber: string;
  candidateName: string;
  courseName: string;
  centerName: string;
  issuedAt: Date;
}): Promise<string> {
  await fs.promises.mkdir(certificatesDirectory, { recursive: true });
  const filename = `${input.certNumber}.pdf`;
  const outputPath = path.join(certificatesDirectory, filename);

  await new Promise<void>((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", layout: "landscape", margin: 56 });
    const output = fs.createWriteStream(outputPath);
    output.on("finish", resolve);
    output.on("error", reject);
    document.on("error", reject);
    document.pipe(output);
    document
      .fontSize(30)
      .text("Certificate of Completion", { align: "center" })
      .moveDown(1.5)
      .fontSize(16)
      .text("This certificate is awarded to", { align: "center" })
      .moveDown(0.6)
      .fontSize(28)
      .text(input.candidateName, { align: "center" })
      .moveDown(0.8)
      .fontSize(16)
      .text(`for successfully completing ${input.courseName}`, { align: "center" })
      .moveDown(0.8)
      .text(`Training center: ${input.centerName}`, { align: "center" })
      .moveDown(2)
      .fontSize(11)
      .text(`Certificate: ${input.certNumber}`, { align: "center" })
      .text(`Issued: ${input.issuedAt.toISOString().slice(0, 10)}`, { align: "center" });
    document.end();
  });
  return `/api/certificates/${input.certNumber}/download`;
}

async function issueBatchCertificates({ batchId, actorId, correlationId }: IssuanceJob): Promise<void> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { candidates: true, center: true },
  });
  if (!batch || batch.status !== BatchStatus.STATE_APPROVED) throw new Error("Approved batch not found");

  for (const candidate of batch.candidates) {
    const existing = await prisma.certificate.findUnique({
      where: { batchId_candidateId: { batchId, candidateId: candidate.id } },
    });
    const certNumber = existing?.certNumber ?? await nextCertificateNumber();
    const certificate = await prisma.certificate.upsert({
      where: { batchId_candidateId: { batchId, candidateId: candidate.id } },
      update: {},
      create: { batchId, candidateId: candidate.id, certNumber },
    });
    const pdfUrl = await generateCertificatePdf({
      certNumber: certificate.certNumber,
      candidateName: candidate.fullName,
      courseName: batch.courseName,
      centerName: batch.center.name,
      issuedAt: certificate.issuedAt,
    });
    await prisma.certificate.update({ where: { id: certificate.id }, data: { pdfUrl } });
    await whatsappQueue.add(
      "send-whatsapp",
      { certificateId: certificate.id, actorId, correlationId } satisfies WhatsappJob,
      { jobId: `wa-${certificate.id}` },
    );
  }
}

async function sendWhatsapp(
  { certificateId, actorId, correlationId }: WhatsappJob,
  attemptsMade: number,
): Promise<void> {
  const forcedFailures = process.env.WHATSAPP_TEST_FAILURE_ATTEMPTS;
  await new Promise((resolve) => setTimeout(resolve, forcedFailures === undefined ? 200 + Math.random() * 800 : 10));
  if (forcedFailures !== undefined ? attemptsMade < Number(forcedFailures) : Math.random() < 0.3) {
    throw new Error(Math.random() < 0.5 ? "WhatsApp API timeout" : "WhatsApp API error");
  }
  await prisma.$transaction(async (tx) => {
    const certificate = await tx.certificate.update({
      where: { id: certificateId },
      data: { deliveryStatus: DeliveryStatus.SENT },
    });
    const token = createDownloadToken(certificate.certNumber);
    const baseUrl = process.env.API_PUBLIC_URL ?? "http://localhost:4000";
    const downloadUrl = `${baseUrl}/api/certificates/${encodeURIComponent(certificate.certNumber)}/download?token=${encodeURIComponent(token)}`;
    await tx.auditLog.create({
      data: {
        entityType: "Certificate",
        entityId: certificate.id,
        actorId,
        action: "WHATSAPP_SENT",
        metadata: { certNumber: certificate.certNumber, downloadUrl, correlationId: correlationId ?? certificate.id },
      },
    });
  });
}

export async function escalateStaleBatches(): Promise<void> {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000);
  const stale = await prisma.batch.findMany({
    where: {
      status: { in: [BatchStatus.SUBMITTED, BatchStatus.DISTRICT_APPROVED, BatchStatus.QUALITY_APPROVED] },
      escalated: false,
      updatedAt: { lt: cutoff },
    },
    select: { id: true, centerId: true, status: true },
  });
  const stateOfficer = await prisma.user.findFirst({ where: { role: UserRole.STATE_OFFICE } });

  for (const batch of stale) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.batch.updateMany({
        where: { id: batch.id, escalated: false },
        data: { escalated: true },
      });
      if (!claimed.count) return;
      await tx.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: batch.id,
          actorId: stateOfficer?.id ?? batch.centerId,
          action: "ESCALATED",
          metadata: { status: batch.status, thresholdMinutes: 3, correlationId: batch.id },
        },
      });
    });
  }
}

export async function startWorkers(): Promise<void> {
  if (started) return;
  started = true;
  workers = [
    new Worker<IssuanceJob>(
      queueNames.certificates,
      async (job) => {
        if (job.name === "issue-batch-certificates") await issueBatchCertificates(job.data);
      },
      { connection, concurrency: 2 },
    ),
    new Worker<WhatsappJob>(
      queueNames.whatsapp,
      async (job) => sendWhatsapp(job.data, job.attemptsMade),
      { connection, concurrency: 5 },
    ),
    new Worker(queueNames.escalation, async () => escalateStaleBatches(), { connection }),
  ];
  await escalationQueue.add(
    "scan-stale-batches",
    {},
    { jobId: "escalation-scan", repeat: { every: 60_000 } },
  );
  console.log("Certificate, WhatsApp, and escalation workers started.");
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  workers = [];
  started = false;
  await prisma.$disconnect();
}

let shuttingDown = false;
async function shutdownWorkerProcess(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopWorkers();
  await Promise.all([certificateQueue.close(), whatsappQueue.close(), escalationQueue.close()]);
  await redis.quit();
}

if (require.main === module) {
  void startWorkers();
  process.on("SIGTERM", () => void shutdownWorkerProcess().finally(() => process.exit(0)));
  process.on("SIGINT", () => void shutdownWorkerProcess().finally(() => process.exit(0)));
}
