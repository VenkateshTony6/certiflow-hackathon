export type UserRole = "TRAINING_CENTER" | "DISTRICT_OFFICER" | "QUALITY_TEAM" | "STATE_OFFICE";

export type DemoUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  district: string | null;
};

export type Approval = {
  id: string;
  stage: "DISTRICT" | "QUALITY" | "STATE";
  decision: "APPROVED" | "REJECTED" | "SENT_BACK";
  comment: string | null;
  officer: Pick<DemoUser, "id" | "name" | "role">;
};

export type Certificate = {
  id: string;
  certNumber: string;
  status: "ACTIVE" | "REVOKED";
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  pdfUrl: string | null;
  revokedReason: string | null;
};

export type AuditLog = {
  id: string;
  action: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type Batch = {
  id: string;
  batchCode: string;
  district: string;
  courseName: string;
  status: string;
  reviewNote: string | null;
  escalated: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { candidates: number };
  approvals: Approval[];
  certificates: Certificate[];
  auditLogs: AuditLog[];
};

export type VerifyResult = {
  valid: boolean;
  status: string;
  certNumber: string;
  candidateName: string | null;
  courseName: string | null;
  centerName: string | null;
  issuedAt: string | null;
  revokedReason: string | null;
};

