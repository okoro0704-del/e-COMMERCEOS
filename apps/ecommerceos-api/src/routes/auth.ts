import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { merchantLogin } from "../services/staff-auth.js";
import { requireMerchant } from "../lib/auth.js";

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/v1/auth/merchant/login", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
        tenantSlug: z.string().optional(),
      })
      .parse(req.body);
    const result = await merchantLogin(body);
    return reply.send(result);
  });

  app.get("/v1/auth/merchant/me", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return reply.send({ staff: auth });
  });
}
