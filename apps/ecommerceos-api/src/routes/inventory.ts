import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMerchant } from "../lib/auth.js";
import { adjustInventory, listInventory } from "../services/inventory.js";

export async function registerInventoryRoutes(app: FastifyInstance) {
  app.get("/v1/inventory", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const query = z
      .object({
        lowStock: z.enum(["true", "false"]).optional(),
        threshold: z.coerce.number().int().optional(),
      })
      .parse(req.query);
    return listInventory(auth.tenantId, {
      lowStock: query.lowStock === "true",
      threshold: query.threshold,
    });
  });

  app.patch("/v1/inventory/variants/:id", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        delta: z.number().int(),
        reason: z.string().min(1),
        reference: z.string().optional(),
      })
      .parse(req.body);
    return adjustInventory({
      tenantId: auth.tenantId,
      variantId: id,
      delta: body.delta,
      reason: body.reason,
      reference: body.reference,
      actorId: auth.staffId,
    });
  });
}
