import type { NextFunction, Request, Response } from "express";
import type { User } from "@prisma/client";
import { PrismaClient, UserRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function authenticate(prisma: PrismaClient) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const userId = request.header("x-user-id");
    if (!userId) {
      response.status(401).json({ error: "x-user-id is required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      response.status(401).json({ error: "Unknown user" });
      return;
    }

    request.user = user;
    next();
  };
}

export function allowRoles(...roles: UserRole[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!request.user || !roles.includes(request.user.role)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

