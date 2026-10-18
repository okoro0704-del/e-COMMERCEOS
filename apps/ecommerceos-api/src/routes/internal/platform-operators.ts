import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createOperator, PLATFORM_ROLES, platformAdminTokenMatches } from "../../services/platform-auth.js";

/**
 * Creates Digiconomy platform operators. Guarded by ECO_PLATFORM_ADMIN_TOKEN, which LifeOS
 * Portal does not hold; with it unset the route refuses every call.
 * POST /internal/platform/operators
 */
export async function registerPlatformOperatorRoutes(app: FastifyInstance) {
  app.post("/internal/platform/operators", async (req, reply) => {
    if (!platformAdminTokenMatches(req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized", message: "Valid platform admin token required" });
    }
    const body = z
      .object({
        email: z.string().email(),
        displayName: z.string().trim().min(1).max(120),
        role: z.enum(PLATFORM_ROLES).default("verifier"),
        password: z.string().min(1).max(1024),
      })
      .parse(req.body);
    return reply.code(201).send(await createOperator(body));
  });
}
