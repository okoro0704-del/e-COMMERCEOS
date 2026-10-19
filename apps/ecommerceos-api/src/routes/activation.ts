import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMerchant } from "../lib/auth.js";
import { getStoreActivation, submitActivation } from "../services/activation.js";

/** Store owner side of the paid brand setup: see the fee, submit a manual payment for review. */
export async function registerActivationRoutes(app: FastifyInstance) {
  app.get("/v1/activation", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return getStoreActivation(auth.tenantId);
  });

  app.post("/v1/activation/submit", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: ["owner"] });
    if (!auth) return;
    const body = z
      .object({
        plan: z.enum(["standard", "early_adopter"]).default("standard"),
        paymentReference: z.string().min(1).max(80),
        payerName: z.string().min(1).max(120),
        paidAt: z.string().datetime().optional(),
        partnerCode: z.string().max(32).optional(),
      })
      .parse(req.body);
    const activation = await submitActivation({ tenantId: auth.tenantId, staffId: auth.staffId, ...body });
    return reply.code(201).send(activation);
  });
}
