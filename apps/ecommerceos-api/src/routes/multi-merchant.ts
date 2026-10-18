import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMerchant, requireTenant, STORE_ADMIN_ROLES } from "../lib/auth.js";
import {
  addOccupant,
  addSeller,
  connectExistingOnlineStore,
  createSellerOnlineStore,
  enableOnlineMarketplace,
  listOccupants,
  listSellers,
  marketplaceAdminCatalog,
  marketplaceOverview,
  updateSellerStatus,
} from "../services/multi-merchant.js";

export async function registerMultiMerchantRoutes(app: FastifyInstance) {
  app.get("/v1/destination/occupants", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    return listOccupants(tenantId);
  });

  app.post("/v1/destination/occupants", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: [...STORE_ADMIN_ROLES, "manager"] });
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

  app.post("/v1/marketplace/enable", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    return enableOnlineMarketplace(auth.tenantId);
  });

  app.get("/v1/marketplace", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return marketplaceOverview(auth.tenantId);
  });

  app.get("/v1/marketplace/sellers", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return listSellers(auth.tenantId);
  });

  app.get("/v1/marketplace/catalog", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    return marketplaceAdminCatalog(auth.tenantId);
  });

  app.post("/v1/marketplace/sellers", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    const body = z
      .object({
        displayName: z.string().min(1),
        status: z.enum(["invited", "active", "suspended", "removed"]).default("invited"),
        sellerTenantId: z.string().optional(),
      })
      .parse(req.body);
    if (body.sellerTenantId) {
      const sellers = await connectExistingOnlineStore(auth.tenantId, {
        sellerTenantId: body.sellerTenantId,
        displayName: body.displayName,
      });
      return reply.code(201).send(sellers);
    }
    return reply.code(201).send(await addSeller(auth.tenantId, { displayName: body.displayName, status: body.status }));
  });

  app.post("/v1/marketplace/sellers/stores", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    const body = z
      .object({
        displayName: z.string().min(1),
        subdomain: z.string().min(1).optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        adminEmail: z.string().email().optional(),
        adminPassword: z.string().min(8).optional(),
      })
      .parse(req.body);
    return reply.code(201).send(await createSellerOnlineStore(auth.tenantId, body));
  });

  app.post("/v1/marketplace/sellers/connect", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    const body = z
      .object({
        sellerTenantId: z.string().min(1),
        displayName: z.string().min(1).optional(),
      })
      .parse(req.body);
    return reply.code(201).send(await connectExistingOnlineStore(auth.tenantId, body));
  });

  app.patch("/v1/marketplace/sellers/:id", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ status: z.enum(["invited", "active", "suspended", "removed"]) }).parse(req.body);
    return updateSellerStatus(auth.tenantId, id, body.status);
  });
}
