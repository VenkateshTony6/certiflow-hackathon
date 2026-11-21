import { randomUUID } from "node:crypto";
import { PrismaClient, UserRole } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { app, prisma as appPrisma } from "../src/index";
import { certificateQueue, escalationQueue, whatsappQueue } from "../src/queue";
import { redis } from "../src/redis";
import { escalateStaleBatches, startWorkers, stopWorkers } from "../src/worker";

const prisma = new PrismaClient();

type Personas = Awaited<ReturnType<typeof seedPersonas>>;
let users: Personas;

async function seedPersonas() {
  const create = (name: string, role: UserRole, district: string | null = null) =>
    prisma.user.create({
      data: { name, role, district, email: `${name.toLowerCase()}-${randomUUID()}@test.local` },
    });
  const [anika, dev, meera, kabir, neha, farah] = await Promise.all([
    create("Anika", UserRole.TRAINING_CENTER, "Pune"),
    create("Dev", UserRole.DISTRICT_OFFICER, "Pune"),
    create("Meera", UserRole.DISTRICT_OFFICER, "Pune"),
    create("Kabir", UserRole.DISTRICT_OFFICER, "Mumbai"),
    create("Neha", UserRole.QUALITY_TEAM),
    create("Farah", UserRole.STATE_OFFICE),
  ]);
  return { anika, dev, meera, kabir, neha, farah };
}

async function resetDatabase() {
  await prisma.auditLog.deleteMany();
  await prisma.certificate.deleteMany();
  await prisma.batchApproval.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.user.deleteMany();
}

async function drainQueues() {
  await Promise.all([
    certificateQueue.drain(true),
    whatsappQueue.drain(true),
    escalationQueue.drain(true),
  ]);
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

async function createBatch(candidateCount: number) {
  return prisma.batch.create({
    data: {
      batchCode: `PUNE-${randomUUID()}`,
      centerId: users.anika.id,
      district: "Pune",
      courseName: "Advanced Digital Skills",
      candidates: {
        create: Array.from({ length: candidateCount }, (_, index) => ({
          fullName: `Candidate ${index + 1}`,
          phone: `${9000000000 + index}`,
          enrollmentNo: `ENR-${randomUUID()}`,
        })),
      },
    },
  });
}

async function decide(userId: string, batchId: string, decision = "APPROVED") {
  return request(app)
    .post(`/api/batches/${batchId}/decision`)
    .set("x-user-id", userId)
    .send({ decision, comment: "Integration test decision" });
}

describe.sequential("CertiFlow integration", () => {
  beforeEach(async () => {
    delete process.env.WHATSAPP_TEST_FAILURE_ATTEMPTS;
    await stopWorkers();
    await drainQueues();
    await resetDatabase();
    users = await seedPersonas();
  });

  afterAll(async () => {
    await stopWorkers();
    await drainQueues();
    await resetDatabase();
    await Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]);
    await Promise.all([certificateQueue.close(), whatsappQueue.close(), escalationQueue.close()]);
    await redis.quit();
  });

  test("rejects every bad CSV row and inserts no candidates", async () => {
    const csv = [
      "fullName,phone,enrollmentNo",
      ",9876543210,ENR-001",
      "Bad Phone,123,ENR-002",
    ].join("\n");
    const response = await request(app)
      .post("/api/batches")
      .set("x-user-id", users.anika.id)
      .field("batchCode", "PUNE-BAD-001")
      .field("courseName", "Digital Skills")
      .field("district", "Pune")
      .attach("file", Buffer.from(csv), "candidates.csv");

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 2 }),
      expect.objectContaining({ row: 3 }),
    ]));
    expect(await prisma.candidate.count()).toBe(0);
    expect(await prisma.batch.count({ where: { batchCode: "PUNE-BAD-001" } })).toBe(0);
  });

  test("serializes concurrent district approvals and advances exactly once", async () => {
    const batch = await createBatch(2);
    const responses = await Promise.all([
      decide(users.dev.id, batch.id),
      decide(users.meera.id, batch.id),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const updated = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(updated.status).toBe("DISTRICT_APPROVED");
    expect(await prisma.batchApproval.count({ where: { batchId: batch.id } })).toBe(2);
    expect(await prisma.auditLog.count({
      where: { entityId: batch.id, action: "BATCH_APPROVED" },
    })).toBe(2);
  });

  test("escalates an untouched batch and records the event", async () => {
    const batch = await createBatch(2);
    const staleAt = new Date(Date.now() - 5 * 60 * 1000);
    await prisma.batch.update({
      where: { id: batch.id },
      data: { createdAt: staleAt, updatedAt: staleAt },
    });

    await escalateStaleBatches();

    const escalated = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(escalated.escalated).toBe(true);
    expect(await prisma.auditLog.count({
      where: { entityType: "Batch", entityId: batch.id, action: "ESCALATED" },
    })).toBe(1);
  });

  test("clears approvals on sent-back resubmission but preserves audit history", async () => {
    const batch = await createBatch(2);
    expect((await decide(users.dev.id, batch.id)).status).toBe(200);
    const sentBack = await decide(users.meera.id, batch.id, "SENT_BACK");
    expect(sentBack.status).toBe(200);
    expect(sentBack.body.status).toBe("SENT_BACK");

    const correctedCsv = [
      "fullName,phone,enrollmentNo",
      "Corrected One,9876543210,FIX-001",
      "Corrected Two,9123456780,FIX-002",
    ].join("\n");
    const resubmitted = await request(app)
      .put(`/api/batches/${batch.id}/resubmit`)
      .set("x-user-id", users.anika.id)
      .attach("file", Buffer.from(correctedCsv), "corrected.csv");

    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body.status).toBe("SUBMITTED");
    expect(await prisma.batchApproval.count({ where: { batchId: batch.id } })).toBe(0);
    const decisionHistory = await prisma.auditLog.findMany({
      where: { entityType: "Batch", entityId: batch.id, action: { in: ["BATCH_APPROVED", "BATCH_SENT_BACK"] } },
    });
    expect(decisionHistory).toHaveLength(2);
    expect(await prisma.auditLog.count({
      where: { entityType: "Batch", entityId: batch.id, action: "BATCH_RESUBMITTED" },
    })).toBe(1);
  });

  test("requires quality approval and issues 60 unique certificates idempotently", async () => {
    process.env.WHATSAPP_TEST_FAILURE_ATTEMPTS = "1";
    const batch = await createBatch(60);
    await Promise.all([decide(users.dev.id, batch.id), decide(users.meera.id, batch.id)]);

    const prematureState = await decide(users.farah.id, batch.id);
    expect(prematureState.status).toBe(409);
    const quality = await decide(users.neha.id, batch.id);
    expect(quality.status).toBe(200);
    expect(quality.body.status).toBe("QUALITY_APPROVED");

    await startWorkers();
    const state = await decide(users.farah.id, batch.id);
    expect(state.status).toBe(200);
    expect(state.body.status).toBe("STATE_APPROVED");

    await waitFor(
      () => prisma.certificate.count({ where: { batchId: batch.id } }),
      (count) => count === 60,
      30_000,
    );
    await certificateQueue.add(
      "issue-batch-certificates",
      { batchId: batch.id, actorId: users.farah.id },
      { jobId: `test-rerun-${randomUUID()}` },
    );
    await waitFor(
      async () => (await certificateQueue.getJobCounts("active", "waiting", "delayed")),
      (counts) => counts.active === 0 && counts.waiting === 0 && counts.delayed === 0,
      30_000,
    );

    const certificates = await prisma.certificate.findMany({ where: { batchId: batch.id } });
    expect(certificates).toHaveLength(60);
    expect(new Set(certificates.map((certificate) => certificate.certNumber)).size).toBe(60);
    expect(certificates.every((certificate) => /^PSM-2026-\d{6}$/.test(certificate.certNumber))).toBe(true);
    await waitFor(
      () => prisma.certificate.count({ where: { batchId: batch.id, deliveryStatus: "SENT" } }),
      (count) => count === 60,
      70_000,
    );
    expect(await prisma.auditLog.count({
      where: { entityType: "Certificate", action: "WHATSAPP_SENT" },
    })).toBe(60);
    await stopWorkers();
    delete process.env.WHATSAPP_TEST_FAILURE_ATTEMPTS;
  }, 110_000);

  test("revocation evicts verification cache immediately", async () => {
    const batch = await createBatch(1);
    const candidate = await prisma.candidate.findFirstOrThrow({ where: { batchId: batch.id } });
    const certificate = await prisma.certificate.create({
      data: { batchId: batch.id, candidateId: candidate.id, certNumber: "PSM-2026-999999" },
    });

    const initial = await request(app).get(`/api/verify/${certificate.certNumber}`);
    expect(initial.body.valid).toBe(true);
    expect(await redis.get(`verify:${certificate.certNumber}`)).not.toBeNull();

    const revoked = await request(app)
      .post(`/api/certificates/${certificate.certNumber}/revoke`)
      .set("x-user-id", users.farah.id)
      .send({ reason: "Certificate issued in error" });
    expect(revoked.status).toBe(200);
    expect(await redis.get(`verify:${certificate.certNumber}`)).toBeNull();

    const verified = await request(app).get(`/api/verify/${certificate.certNumber}`);
    expect(verified.body).toMatchObject({ valid: false, status: "REVOKED" });
  });

  test("blocks a training center from review decisions", async () => {
    const batch = await createBatch(2);
    const response = await decide(users.anika.id, batch.id);
    expect(response.status).toBe(403);
    expect(await prisma.batchApproval.count({ where: { batchId: batch.id } })).toBe(0);
  });

  test("blocks an unauthenticated certificate PDF download", async () => {
    const batch = await createBatch(1);
    const candidate = await prisma.candidate.findFirstOrThrow({ where: { batchId: batch.id } });
    const certificate = await prisma.certificate.create({
      data: {
        batchId: batch.id,
        candidateId: candidate.id,
        certNumber: "PSM-2026-888888",
        pdfUrl: "/api/certificates/PSM-2026-888888/download",
      },
    });

    const response = await request(app).get(`/api/certificates/${certificate.certNumber}/download`);
    expect([401, 403]).toContain(response.status);
  });
});
