import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.env.CERT_DOWNLOAD_SECRET ?? "certiflow-local-download-secret";

type DownloadClaim = { certNumber: string; exp: number };

function signature(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createDownloadToken(certNumber: string, ttlSeconds = 15 * 60): string {
  const claim: DownloadClaim = { certNumber, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function verifyDownloadToken(token: string | undefined, certNumber: string): boolean {
  if (!token) return false;
  const [payload, suppliedSignature] = token.split(".");
  if (!payload || !suppliedSignature) return false;
  const expected = Buffer.from(signature(payload));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DownloadClaim;
    return claim.certNumber === certNumber && claim.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

