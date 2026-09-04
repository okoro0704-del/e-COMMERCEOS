import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireInternalToken } from "./provision.js";
import { applyLogisticsWebhook } from "../../services/logistics/bridge.js";

/**
 * LogisticsOS → ECommerceOS status fan-in.
 * POST /internal/ecommerce/webhooks/logistics-update
 */
export async function registerLogisticsWebhookRoutes(app: FastifyInstance) {
  app.post("/internal/ecommerce/webhooks/logistics-update", async (req, reply) => {
    if (!requireInternalToken(req.headers.authorization)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Valid service bearer token required",
      });
    }

    const body = z
      .object({
        logisticsJobId: z.string().min(1),
        orderId: z.string().min(1).optional(),
        status: z.enum(["PICKED_UP", "IN_TRANSIT", "DELIVERED"]),
        occurredAt: z.string().optional(),
      })
      .parse(req.body);

    const result = await applyLogisticsWebhook(body);
    return reply.code(200).send({
      ok: true,
      skipped: result.skipped,
      orderId: result.order.id,
      status: result.order.status,
      logisticsJobId: result.order.logisticsJobId,
    });
  });
}
