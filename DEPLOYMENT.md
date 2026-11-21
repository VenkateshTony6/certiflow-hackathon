# Production Deployment Plan

## Capacity Target

- 100,000 registered users and approximately 10,000 daily active users
- Peak ingestion: 500 batches/hour
- Peak asynchronous load: up to 30,000 PDFs and 30,000 WhatsApp messages/hour
- Bursty, read-heavy public certificate verification

## Architecture

```text
                         +--------------------+
 Internet -------------->| CloudFront + WAF   |
                         +---------+----------+
                                   |
              +--------------------+--------------------+
              |                                         |
      React static assets                     Application Load Balancer
          (S3 origin)                                  |
                                             +---------+---------+
                                             | ECS Fargate API   |
                                             | tasks (multi-AZ)  |
                                             +----+----------+---+
                                                  |          |
                           +----------------------+          +------------------+
                           |                                                    |
                 +---------v----------+                              +----------v---------+
                 | RDS PostgreSQL     |                              | ElastiCache Redis  |
                 | Multi-AZ primary   |<----- BullMQ state/cache --->| Multi-AZ           |
                 +---------+----------+                              +----------+---------+
                           |                                                    |
                 +---------v----------+                              +----------v---------+
                 | Read replica       |                              | ECS Fargate workers|
                 | verification/read |                              | PDF + WhatsApp     |
                 +--------------------+                              +----+-----------+---+
                                                                           |           |
                                                                  +--------v--+   +----v---------+
                                                                  | Private S3|   | WhatsApp API |
                                                                  | PDFs      |   | provider     |
                                                                  +-----+-----+   +--------------+
                                                                        |
                                                                 CloudFront signed URL
```

## Hosting Choices

### ECS Fargate

Run separate API, PDF-worker, and WhatsApp-worker services without managing hosts. Independent services allow CPU-heavy PDF rendering to scale without overprovisioning the API or increasing WhatsApp concurrency beyond provider limits. Spread tasks across at least two Availability Zones.

### RDS PostgreSQL

Use a Multi-AZ primary for transactional writes, row locks, and integrity constraints. Route public verification misses and reporting queries to a read replica where consistency requirements permit. Use RDS Proxy to protect the database from connection spikes during task scaling.

### ElastiCache Redis

Use a Multi-AZ replication group with automatic failover for BullMQ state, rate-control data, and verification caching. Redis removes most burst traffic from PostgreSQL; the database remains authoritative when cache entries are absent.

### S3 and CloudFront

Store PDFs durably in private S3 rather than container filesystems. CloudFront serves authorized downloads efficiently and absorbs geographically distributed traffic. Lifecycle policies move older certificates to lower-cost storage classes.

## Horizontal Scaling and Backlog Control

- Scale API tasks on request count, latency, CPU, and target-response time.
- Scale PDF workers primarily on certificate queue depth and oldest-job age, with CPU as a guardrail.
- Scale WhatsApp workers on queue depth but cap concurrency to the provider's messages-per-second allowance.
- Reserve queue-specific worker services; a WhatsApp outage must not block certificate generation.
- At 30,000 items/hour, sustained processing must exceed 8.4 PDFs/second and 8.4 messages/second. Provision for at least 2× peak recovery capacity so a one-hour backlog can clear in roughly one additional hour.
- Apply per-tenant admission control and batch-size limits to prevent one training center from monopolizing workers.

The primary bottlenecks are PDF rendering CPU/memory and external WhatsApp rate limits. Preload fonts, keep PDF templates small, use bounded worker concurrency, and negotiate provider throughput before adding workers. Autoscaling cannot overcome a provider-side quota.

## Failure Handling

| Failure | Response |
|---|---|
| Worker crash | BullMQ lock expiry returns unfinished jobs to the queue. Idempotent certificate upserts and stable job IDs prevent duplicate certificates. ECS replaces unhealthy tasks. |
| Redis restart/failover | ElastiCache promotes a replica; workers reconnect with jitter. API verification falls back to PostgreSQL. Alert on failover and queue stagnation. |
| WhatsApp outage | Exponential retries handle brief failures. Exhausted jobs enter a dead-letter workflow for controlled replay; provider concurrency is reduced during recovery. Certificate issuance continues. |
| Slow database | RDS Proxy limits connection pressure. Shed nonessential reporting, use statement timeouts, inspect lock/query metrics, and shift eligible reads to the replica. Do not retry locked writes without bounded backoff. |
| API task/AZ loss | ALB routes to healthy tasks in another AZ. Deployments retain minimum healthy capacity and roll back on health-check or error-rate regression. |
| S3 write failure | Keep the BullMQ job retryable and do not enqueue delivery until upload succeeds. Orphan detection reconciles DB rows and objects. |

## Storage and Privacy

- Block all public access on the certificate bucket and enable SSE-KMS encryption, versioning, access logs, and narrowly scoped task roles.
- Store only S3 object keys in PostgreSQL. Generate short-lived presigned URLs—or CloudFront signed URLs—after an authorized request.
- The public verification endpoint returns only the minimum verification fields. It must never expose phone numbers, enrollment records, internal audit metadata, raw object keys, or unrestricted PDF URLs.
- Separate public verification DTOs and database queries from authenticated administrative DTOs to prevent accidental PII expansion.
- Protect verification with WAF rate limits, bot controls, normalized certificate identifiers, and audit sampling.
- Encrypt RDS and Redis in transit and at rest; rotate secrets through AWS Secrets Manager.

## Monitoring and Alerting

Use CloudWatch metrics/logs plus OpenTelemetry traces. Generate a correlation ID at the edge, propagate it through API requests and BullMQ job data, and include it in structured logs.

Alert on:

- API 5xx rate, p95/p99 latency, unhealthy tasks, and authorization-denial anomalies
- Queue depth, oldest-job age, retry rate, failed-job count, and dead-letter growth per queue
- PDF render duration, S3 upload failures, WhatsApp latency/rate-limit responses, and delivery success rate
- PostgreSQL CPU, connections, free storage, replica lag, slow queries, and lock-wait duration
- Redis memory, evictions, connection failures, replication lag, and failovers
- Verification cache hit ratio and sudden invalid-certificate traffic spikes

Page on sustained user impact or growing backlogs; use tickets for capacity trends and isolated retryable failures.

## Indicative Monthly Cost

An optimized non-enterprise baseline is approximately **$220/month**:

| Component | Approximate monthly cost |
|---|---:|
| Fargate API and baseline workers | $55 |
| RDS PostgreSQL primary + small read replica | $90 |
| ElastiCache Redis | $20 |
| ALB, CloudWatch, Secrets Manager, and KMS | $25 |
| S3, CloudFront, backups, and ordinary transfer | $30 |
| **Estimated baseline** | **$220** |

This is a planning estimate, not a quote. It assumes small always-on capacity with burst scaling and moderate stored-PDF/download volume. Multi-AZ production sizing, NAT Gateway traffic, long log retention, large PDF egress, sustained peak workers, and WhatsApp provider fees can materially increase cost. Removing the read replica or using Graviton tasks lowers cost but reduces read isolation or compatibility; larger reserved RDS capacity improves predictable performance but raises the baseline. Validate with load tests and the AWS Pricing Calculator before launch.
