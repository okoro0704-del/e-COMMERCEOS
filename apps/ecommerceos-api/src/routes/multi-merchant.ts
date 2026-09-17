import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMerchant, requireTenant } from "../lib/auth.js";
import { addOccupant, addSeller, listOccupants, listSellers } from "../services/multi-merchant.js";

export async function registerMultiMerchantRoutes(app: FastifyInstance) {
  app.get("/v1/destination/occupants", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    return listOccupants(tenantId);
  });

  app.post("/v1/destination/occupants", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const body = z
      .object({
        unitCode: z.string().min(1),
        displayName: z.string().min(1),
        category: z.string().optional(),
        hours: z.string().optional(),
        referencedTenantId: z.string().optional(),
        referencedSubdomain: z.string().optional(),
      })
      .parse(req.body);
    return reply.code(201).send(await addOccupant(auth.tenantId, body));
  });

  app.get("/v1/marketplace/sellers", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    return listSellers(tenantId);
  });

  app.post("/v1/marketplace/sellers", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const body = z
      .object({
        displayName: z.string().min(1),
        status: z.enum(["invited", "active", "suspended"]).optional(),
        sellerTenantId: z.string().optional(),
      })
      .parse(req.body);
    return reply.code(201).send(await addSeller(auth.tenantId, body));
  });
}
