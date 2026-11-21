import cors from "cors";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { config } from "./config";
import { redis } from "./redis";

const prisma = new PrismaClient();

export const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.get("/health", async (_request, response) => {
  try {
    await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping()]);
    response.json({ status: "ok", services: { postgres: "up", redis: "up" } });
  } catch (error) {
    response.status(503).json({ status: "unavailable" });
  }
});

app.get("/api", (_request, response) => {
  response.json({ name: "CertiFlow API", version: "0.1.0" });
});

