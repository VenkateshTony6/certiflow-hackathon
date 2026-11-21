-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('TRAINING_CENTER', 'DISTRICT_OFFICER', 'QUALITY_TEAM', 'STATE_OFFICE');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('SUBMITTED', 'DISTRICT_APPROVED', 'QUALITY_APPROVED', 'STATE_APPROVED', 'REJECTED', 'SENT_BACK');

-- CreateEnum
CREATE TYPE "ApprovalStage" AS ENUM ('DISTRICT', 'QUALITY', 'STATE');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'SENT_BACK');

-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "district" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "courseName" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewNote" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "enrollmentNo" TEXT NOT NULL,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchApproval" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "officerId" TEXT NOT NULL,
    "stage" "ApprovalStage" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "comment" TEXT,

    CONSTRAINT "BatchApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "certNumber" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "CertificateStatus" NOT NULL DEFAULT 'ACTIVE',
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "pdfUrl" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_batchCode_key" ON "Batch"("batchCode");

-- CreateIndex
CREATE INDEX "Batch_centerId_idx" ON "Batch"("centerId");

-- CreateIndex
CREATE INDEX "Batch_district_status_idx" ON "Batch"("district", "status");

-- CreateIndex
CREATE INDEX "Candidate_batchId_idx" ON "Candidate"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_batchId_enrollmentNo_key" ON "Candidate"("batchId", "enrollmentNo");

-- CreateIndex
CREATE INDEX "BatchApproval_batchId_idx" ON "BatchApproval"("batchId");

-- CreateIndex
CREATE INDEX "BatchApproval_officerId_idx" ON "BatchApproval"("officerId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchApproval_batchId_officerId_stage_key" ON "BatchApproval"("batchId", "officerId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_certNumber_key" ON "Certificate"("certNumber");

-- CreateIndex
CREATE INDEX "Certificate_batchId_idx" ON "Certificate"("batchId");

-- CreateIndex
CREATE INDEX "Certificate_candidateId_idx" ON "Certificate"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_batchId_candidateId_key" ON "Certificate"("batchId", "candidateId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchApproval" ADD CONSTRAINT "BatchApproval_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchApproval" ADD CONSTRAINT "BatchApproval_officerId_fkey" FOREIGN KEY ("officerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

