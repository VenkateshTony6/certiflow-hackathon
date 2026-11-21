import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import {
  ApprovalDecision,
  ApprovalStage,
  BatchStatus,
  CertificateStatus,
  Prisma,
  PrismaClient,
  UserRole,
} from "@prisma/client";
import { allowRoles, authenticate } from "./middleware/auth";
import { validateCandidatesCsv } from "./helpers/candidatesCsv";
import { config } from "./config";
import { redis } from "./redis";
import { certificateQueue } from "./queue";
import { certificatesDirectory } from "./storage";
import { verifyDownloadToken } from "./helpers/pdfAccess";
import { correlationId } from "./middleware/correlation";

export const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());
app.use(correlationId);

app.get("/health", async (_request, response) => {
  await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
  response.json({ status: "ok" });
});

app.get("/api/verify/:certNumber", async (request, response) => {
  const key = `verify:${request.params.certNumber}`;
  const cached = await redis.get(key);
  if (cached) {
    response.json(JSON.parse(cached));
    return;
  }

  const certificate = await prisma.certificate.findUnique({
    where: { certNumber: request.params.certNumber },
    include: {
      candidate: true,
      batch: { include: { center: true } },
    },
  });
  const result = certificate
    ? {
        valid: certificate.status === CertificateStatus.ACTIVE,
        status: certificate.status,
        certNumber: certificate.certNumber,
        candidateName: certificate.candidate.fullName,
        courseName: certificate.batch.courseName,
        centerName: certificate.batch.center.name,
        issuedAt: certificate.issuedAt,
        revokedReason: certificate.revokedReason,
      }
    : {
        valid: false,
        status: "NOT_FOUND",
        certNumber: request.params.certNumber,
        candidateName: null,
        courseName: null,
        centerName: null,
        issuedAt: null,
        revokedReason: null,
      };

  await redis.set(key, JSON.stringify(result), "EX", 3600);
  response.json(result);
});

app.get("/api/users", async (_request, response) => {
  response.json(await prisma.user.findMany({ orderBy: { name: "asc" } }));
});

app.get("/api/certificates/:certNumber/download", async (request, response) => {
  const certNumber = String(request.params.certNumber);
  const token = typeof request.query.token === "string" ? request.query.token : undefined;
  const certificate = await prisma.certificate.findUnique({
    where: { certNumber },
    include: { batch: true },
  });
  if (!certificate?.pdfUrl) {
    response.status(404).json({ error: "Certificate PDF not found" });
    return;
  }

  let allowed = verifyDownloadToken(token, certNumber);
  if (!allowed) {
    const userId = request.header("x-user-id");
    const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    allowed = Boolean(user && (
      user.role === UserRole.STATE_OFFICE
      || user.role === UserRole.QUALITY_TEAM
      || (user.role === UserRole.DISTRICT_OFFICER && user.district === certificate.batch.district)
      || (user.role === UserRole.TRAINING_CENTER && user.id === certificate.batch.centerId)
    ));
  }
  if (!allowed) {
    response.status(token ? 403 : 401).json({ error: "Certificate download is not authorized" });
    return;
  }

  response.download(
    `${certificatesDirectory}/${certNumber}.pdf`,
    `${certNumber}.pdf`,
    (error) => {
      if (error && !response.headersSent) response.status(404).json({ error: "Certificate PDF not found" });
    },
  );
});

app.use("/api", authenticate(prisma));

function csvFile(request: Request): { buffer?: Buffer; error?: string } {
  const files = request.files as Express.Multer.File[] | undefined;
  const file = files?.find((candidate) => candidate.fieldname === "file");
  if (!file) return { error: "CSV file is required" };
  if (!file.originalname.toLowerCase().endsWith(".csv")) {
    return { error: "Only .csv files are supported. A PDF, spreadsheet, or document cannot be uploaded here." };
  }
  return { buffer: file.buffer };
}

app.post(
  "/api/batches",
  allowRoles(UserRole.TRAINING_CENTER),
  upload.any(),
  async (request, response) => {
    const uploadedCsv = csvFile(request);
    if (uploadedCsv.error) {
      response.status(400).json({ errors: [{ row: 1, message: uploadedCsv.error }] });
      return;
    }
    const validation = validateCandidatesCsv(uploadedCsv.buffer);
    if (validation.errors.length) {
      response.status(400).json({ errors: validation.errors });
      return;
    }
    const batchCode = String(request.body.batchCode ?? "").trim();
    const district = String(request.body.district ?? "").trim();
    const courseName = String(request.body.courseName ?? "").trim();
    const errors = [
      ...(!batchCode ? [{ row: 1, message: "batchCode is required" }] : []),
      ...(!district ? [{ row: 1, message: "district is required" }] : []),
      ...(!courseName ? [{ row: 1, message: "courseName is required" }] : []),
    ];
    if (errors.length) {
      response.status(400).json({ errors });
      return;
    }
    if (request.user!.district && request.user!.district !== district) {
      response.status(403).json({ error: "District mismatch" });
      return;
    }

    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.batch.create({
        data: {
          batchCode,
          centerId: request.user!.id,
          district,
          courseName,
          candidates: { create: validation.candidates },
        },
        include: { _count: { select: { candidates: true } } },
      });
      await tx.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: created.id,
          actorId: request.user!.id,
          action: "BATCH_SUBMITTED",
          metadata: { batchCode, candidateCount: validation.candidates.length, correlationId: request.correlationId },
        },
      });
      return created;
    });
    response.status(201).json(batch);
  },
);

app.put(
  "/api/batches/:id/resubmit",
  allowRoles(UserRole.TRAINING_CENTER),
  upload.any(),
  async (request, response) => {
    const batchId = String(request.params.id);
    const uploadedCsv = csvFile(request);
    if (uploadedCsv.error) {
      response.status(400).json({ errors: [{ row: 1, message: uploadedCsv.error }] });
      return;
    }
    const validation = validateCandidatesCsv(uploadedCsv.buffer);
    if (validation.errors.length) {
      response.status(400).json({ errors: validation.errors });
      return;
    }

    const batch = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
      const existing = await tx.batch.findUnique({ where: { id: batchId } });
      if (!existing) return null;
      if (existing.centerId !== request.user!.id) return "FORBIDDEN" as const;
      if (existing.status !== BatchStatus.SENT_BACK) return "INVALID_STATUS" as const;

      await tx.candidate.deleteMany({ where: { batchId: existing.id } });
      await tx.batchApproval.deleteMany({ where: { batchId: existing.id } });
      const updated = await tx.batch.update({
        where: { id: existing.id },
        data: {
          status: BatchStatus.SUBMITTED,
          reviewNote: null,
          candidates: { create: validation.candidates },
        },
        include: { _count: { select: { candidates: true } } },
      });
      await tx.auditLog.create({
        data: {
          entityType: "Batch",
          entityId: existing.id,
          actorId: request.user!.id,
          action: "BATCH_RESUBMITTED",
          metadata: { candidateCount: validation.candidates.length, correlationId: request.correlationId },
        },
      });
      return updated;
    });

    if (!batch) response.status(404).json({ error: "Batch not found" });
    else if (batch === "FORBIDDEN") response.status(403).json({ error: "Forbidden" });
    else if (batch === "INVALID_STATUS") response.status(409).json({ error: "Batch is not sent back" });
    else response.json(batch);
  },
);

type DecisionBody = { decision?: ApprovalDecision; comment?: string };

app.post("/api/batches/:id/decision", async (request: Request, response: Response) => {
  const batchId = String(request.params.id);
  const { decision, comment } = request.body as DecisionBody;
  if (!decision || !Object.values(ApprovalDecision).includes(decision)) {
    response.status(400).json({ error: "Invalid decision" });
    return;
  }
  const actor = request.user!;
  const decisionRoles: UserRole[] = [
    UserRole.DISTRICT_OFFICER,
    UserRole.QUALITY_TEAM,
    UserRole.STATE_OFFICE,
  ];
  if (!decisionRoles.includes(actor.role)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  let enqueue = false;
  const outcome = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Batch" WHERE id = ${batchId} FOR UPDATE
    `;
    if (!locked.length) return { error: "NOT_FOUND" as const };
    const batch = await tx.batch.findUnique({
      where: { id: batchId },
      include: { _count: { select: { candidates: true } } },
    });
    if (!batch) return { error: "NOT_FOUND" as const };

    let stage: ApprovalStage;
    let nextStatus = batch.status;
    if (actor.role === UserRole.DISTRICT_OFFICER) {
      if (!actor.district || actor.district !== batch.district) return { error: "DISTRICT" as const };
      if (batch.status !== BatchStatus.SUBMITTED) return { error: "STATUS" as const };
      stage = ApprovalStage.DISTRICT;
    } else if (actor.role === UserRole.QUALITY_TEAM) {
      if (batch._count.candidates <= 50 || batch.status !== BatchStatus.DISTRICT_APPROVED) {
        return { error: "STATUS" as const };
      }
      stage = ApprovalStage.QUALITY;
    } else {
      const expected = batch._count.candidates > 50
        ? BatchStatus.QUALITY_APPROVED
        : BatchStatus.DISTRICT_APPROVED;
      if (batch.status !== expected) return { error: "STATUS" as const };
      stage = ApprovalStage.STATE;
    }

    await tx.batchApproval.upsert({
      where: {
        batchId_officerId_stage: { batchId: batch.id, officerId: actor.id, stage },
      },
      update: { decision, comment },
      create: { batchId: batch.id, officerId: actor.id, stage, decision, comment },
    });

    if (decision === ApprovalDecision.REJECTED) nextStatus = BatchStatus.REJECTED;
    else if (decision === ApprovalDecision.SENT_BACK) nextStatus = BatchStatus.SENT_BACK;
    else if (stage === ApprovalStage.DISTRICT) {
      const approvals = await tx.batchApproval.count({
        where: { batchId: batch.id, stage, decision: ApprovalDecision.APPROVED },
      });
      if (approvals >= 2) nextStatus = BatchStatus.DISTRICT_APPROVED;
    } else if (stage === ApprovalStage.QUALITY) nextStatus = BatchStatus.QUALITY_APPROVED;
    else {
      nextStatus = BatchStatus.STATE_APPROVED;
      enqueue = true;
    }

    const updated = await tx.batch.update({
      where: { id: batch.id },
      data: {
        status: nextStatus,
        reviewNote: decision === ApprovalDecision.APPROVED ? null : comment,
      },
    });
    await tx.auditLog.create({
      data: {
        entityType: "Batch",
        entityId: batch.id,
        actorId: actor.id,
        action: `BATCH_${decision}`,
        metadata: { stage, comment: comment ?? null, correlationId: request.correlationId },
      },
    });
    return { batch: updated };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

  if ("error" in outcome) {
    const status = outcome.error === "NOT_FOUND" ? 404 : outcome.error === "DISTRICT" ? 403 : 409;
    response.status(status).json({ error: outcome.error === "STATUS" ? "Invalid workflow status" : outcome.error });
    return;
  }
  if (enqueue) {
    await certificateQueue.add("issue-batch-certificates", {
      batchId,
      actorId: actor.id,
      correlationId: request.correlationId,
    }, {
      jobId: `issue-batch-certificates-${batchId}`,
    });
  }
  response.json(outcome.batch);
});

function batchWhere(request: Request): Prisma.BatchWhereInput {
  const user = request.user!;
  if (user.role === UserRole.TRAINING_CENTER) return { centerId: user.id };
  if (user.role === UserRole.DISTRICT_OFFICER) return { district: user.district ?? "__none__" };
  return {};
}

const batchInclude = {
  center: { select: { id: true, name: true, district: true } },
  _count: { select: { candidates: true } },
  approvals: { include: { officer: { select: { id: true, name: true, role: true } } } },
  certificates: true,
} satisfies Prisma.BatchInclude;

async function attachAuditLogs<T extends { id: string }>(batches: T[]) {
  const logs = await prisma.auditLog.findMany({
    where: { entityType: "Batch", entityId: { in: batches.map((batch) => batch.id) } },
    orderBy: { createdAt: "asc" },
  });
  return batches.map((batch) => ({
    ...batch,
    auditLogs: logs.filter((log) => log.entityId === batch.id),
  }));
}

app.get("/api/batches", async (request, response) => {
  const batches = await prisma.batch.findMany({
    where: batchWhere(request),
    include: batchInclude,
    orderBy: { createdAt: "desc" },
  });
  response.json(await attachAuditLogs(batches));
});

app.get("/api/batches/:id", async (request, response) => {
  const batch = await prisma.batch.findFirst({
    where: { AND: [{ id: request.params.id }, batchWhere(request)] },
    include: { ...batchInclude, candidates: true },
  });
  if (!batch) {
    response.status(404).json({ error: "Batch not found" });
    return;
  }
  response.json((await attachAuditLogs([batch]))[0]);
});

app.post(
  "/api/certificates/:certNumber/revoke",
  allowRoles(UserRole.STATE_OFFICE),
  async (request, response) => {
    const certNumber = String(request.params.certNumber);
    const reason = String(request.body.reason ?? "").trim();
    if (!reason) {
      response.status(400).json({ error: "reason is required" });
      return;
    }
    const certificate = await prisma.$transaction(async (tx) => {
      const existing = await tx.certificate.findUnique({ where: { certNumber } });
      if (!existing) return null;
      const updated = await tx.certificate.update({
        where: { certNumber },
        data: {
          status: CertificateStatus.REVOKED,
          revokedAt: new Date(),
          revokedReason: reason,
        },
      });
      await tx.auditLog.create({
        data: {
          entityType: "Certificate",
          entityId: existing.id,
          actorId: request.user!.id,
          action: "CERTIFICATE_REVOKED",
          metadata: { certNumber: existing.certNumber, reason, correlationId: request.correlationId },
        },
      });
      return updated;
    });
    if (!certificate) {
      response.status(404).json({ error: "Certificate not found" });
      return;
    }
    await redis.del(`verify:${certNumber}`);
    response.json(certificate);
  },
);

app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`CertiFlow API listening on port ${config.port}`));
}

