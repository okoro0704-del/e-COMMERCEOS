import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bootstrapFirstAdmin, platformAdminTokenMatches } from "../../services/platform-auth.js";

/**
 * Creates the first Digiconomy platform admin, once. Guarded by ECO_PLATFORM_ADMIN_TOKEN, which
 * LifeOS Portal does not hold; with it unset the route refuses every call, and once an active
 * admin exists it refuses too. Later operators are invited from the console.
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
        password: z.string().min(1).max(1024),
      })
      .parse(req.body);
    return reply.code(201).send(await bootstrapFirstAdmin(body));
  });
}
