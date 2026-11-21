# CertiFlow — Pragati Skills Mission

CertiFlow is a certificate-issuance workflow for training centers and government review teams. It validates candidate CSVs atomically, enforces staged approvals, creates certificates asynchronously, simulates WhatsApp delivery, and provides public certificate verification.

## Requirements & Ambiguity Decisions

- **District quorum:** a batch advances only after approvals from two distinct district officers assigned to the same district.
- **Quality gate:** batches with more than 50 candidates require Quality Team approval. Batches with 50 or fewer candidates proceed from district approval directly to the State Office.
- **Resubmission:** `SENT_BACK` batches may be resubmitted only by their owning training center. Candidates are replaced and prior `BatchApproval` records are cleared; immutable `AuditLog` history is retained.
- **Escalation clock:** the demo flags an untouched active batch after three minutes. This represents the production requirement of 48 hours.

## Architecture & Key Decisions

```text
React/Vite UI
     |
Express API ---- Redis cache / BullMQ ---- Separate worker container
     |                                      |-- PDF generation
PostgreSQL                                 |-- WhatsApp retry delivery
                                            `-- SLA escalation scan
     |
RBAC/HMAC certificate download endpoint ---- shared cert_storage volume
```

### PostgreSQL

PostgreSQL is the system of record. Approval decisions use `SELECT ... FOR UPDATE` inside transactions so concurrent district approvals serialize cleanly. Unique constraints enforce batch codes, enrollment numbers within a batch, one approval per officer and stage, one certificate per candidate and batch, and globally unique certificate numbers.

### Redis

Redis backs BullMQ and caches public verification responses for one hour. Revocation deletes `verify:<certNumber>` immediately, preventing a stale certificate from continuing to appear genuine.

### BullMQ

Certificate generation and WhatsApp delivery run in a separate worker container rather than inside the API process. Certificate upserts and stable job identifiers make retries idempotent. Simulated WhatsApp failures retry five times with exponential backoff, absorbing short provider outages without blocking the API. Test runs use isolated queue names so the Compose worker cannot consume integration-test jobs.

### Certificate access

PDFs are not exposed through a public static directory. `GET /api/certificates/:certNumber/download` permits the State Office, Quality Team, the matching district officers, the owning training center, or a candidate holding a short-lived HMAC-signed WhatsApp link. The API and worker share the `cert_storage` Docker volume.

## Local Setup & Tests

Requirements: Docker Desktop or Docker Engine with Compose v2. Ports `4000`, `5173`, `5432`, and `6379` should be available; host ports can be overridden in `.env` using `.env.example`.

From a fresh clone:

```bash
docker compose up --build
```

In a second terminal, run the real PostgreSQL/Redis integration suite:

```bash
docker compose exec backend npm test
```

Open:

- UI: <http://localhost:5173>
- API health: <http://localhost:4000/health>
- Public verification: use **Public Verify** in the top navigation

The backend container applies Prisma migrations, runs the idempotent seed, and starts the API. Compose starts the independently scalable `worker` service after the API is healthy. PostgreSQL, Redis, and generated certificates use named volumes.

## Main Workflow

1. Select a seeded demo persona.
2. Anika submits a batch and candidate CSV.
3. Dev and Meera approve the Pune batch concurrently or in either order.
4. Neha reviews batches containing more than 50 candidates.
5. Farah grants final approval.
6. Workers generate PDFs and retry simulated WhatsApp delivery.
7. The public verifier reports certificates as genuine, revoked, or invalid.

## AI Tools Used & Verification

Codex was used module-by-module for infrastructure, Prisma models, API routes, workers, UI, and test scaffolding. Human verification focused on schema constraints, transactional `FOR UPDATE` behavior, role and district boundaries, idempotency, and the real Postgres/Redis integration-test cases. AI output was treated as implementation assistance, not as proof of correctness.

## Known Limitations & Next Steps

- The `x-user-id` persona switch is intentionally implemented for the brief's one-click demo requirement. It is not production authentication; production replaces it with OAuth2/OIDC-issued JWTs and server-side authorization claims as described in `DEPLOYMENT.md`.
- Local Docker uses a persistent named volume and RBAC/HMAC-signed certificate downloads. Production should move private PDFs to S3 and issue short-lived presigned or CloudFront-signed URLs.
- Certificate sequencing is fixed to the 2026 demo prefix; introduce configurable, partitioned yearly sequences.
- WhatsApp delivery is simulated; integrate an approved provider, webhook receipts, rate limiting, and dead-letter replay.
- Queue-to-database consistency should use an outbox pattern so final approval and job publication are atomic.
- Add malware scanning, CSV size/row limits, pagination, accessibility testing, and operational administration tools.
- Replace the three-minute escalation threshold with a configurable 48-hour business-time SLA in production.
- Docker Desktop was unavailable on the implementation machine, so Compose execution still needs final verification on a Docker-enabled host even though Dockerfiles, paths, health checks, migrations, seed startup, shared storage, and service dependencies were audited.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the production scaling and security plan.

