import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerLocalPrimitiveProvidersOrRemote } from "./services/register-primitives.js";
import { registerJobHandlers } from "./services/jobs.js";

export async function buildApp() {
  registerLocalPrimitiveProvidersOrRemote();
  registerJobHandlers();

  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      if (typeof incoming === "string" && incoming.trim()) return incoming.trim();
      return randomUUID();
    },
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    const corr = req.headers["x-correlation-id"];
    if (typeof corr === "string" && corr.trim()) {
      reply.header("x-correlation-id", corr.trim());
    } else {
      reply.header("x-correlation-id", req.id);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Request validation failed",
        details: err.flatten(),
        requestId,
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    let code = (err as { code?: string }).code ?? "internal_error";
    if (typeof code === "string" && (code.startsWith("P") || code.includes("Prisma"))) {
      code = "internal_error";
    }
    if (status >= 500) {
      app.log.error({ err, requestId }, "request failed");
    }
    return reply.code(status).send({
      error: code,
      message: status >= 500 ? "Internal server error" : (err as Error).message,
      requestId,
    });
  });

  await registerRoutes(app);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}
