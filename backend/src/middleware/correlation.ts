import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export function correlationId(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header("x-correlation-id")?.trim();
  request.correlationId = incoming || randomUUID();
  response.setHeader("x-correlation-id", request.correlationId);
  next();
}

