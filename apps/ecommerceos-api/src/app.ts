import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerLocalPrimitiveProvidersOrRemote } from "./services/register-primitives.js";
import { registerJobHandlers } from "./services/jobs.js";
import { assertProductionSafety } from "./lib/production-safety.js";
import { originAllowed } from "./lib/cors.js";

export async function buildApp() {
  const safetyWarnings = assertProductionSafety(config);
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

  // Keep the exact request bytes: signed service credentials bind the body hash to them. Parsing
  // is still Fastify's own JSON parser, with prototype-poisoning protection.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    parseJson(req, (body as Buffer).toString("utf8"), done);
  });

  await app.register(cors, {
    // Only the origins named in CORS_ORIGINS; no built-in hosting suffixes (see lib/cors.ts).
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return cb(null, originAllowed(origin, config.corsOrigins, config.env));
    },
    // The plugin's default is GET,HEAD,POST, which blocked the web app's cart, catalogue,
    // marketplace and DigiPedia updates from the browser.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
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
    // Unexpected failures stay generic; a deliberate "service unavailable" keeps its plain message.
    const deliberate = status === 503 && code !== "internal_error" && Boolean((err as { code?: string }).code);
    return reply.code(status).send({
      error: code,
      message: status >= 500 && !deliberate ? "Internal server error" : (err as Error).message,
      requestId,
    });
  });

  await registerRoutes(app);

  for (const warning of safetyWarnings) {
    app.log.warn({ safety: true }, warning);
  }

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}
