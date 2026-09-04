import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireBuyer, requireTenant } from "../lib/auth.js";
import { listCategories, getProduct, listProducts } from "../services/catalog.js";
import { addCartItem, getCart, removeCartItem, updateCartItem } from "../services/cart.js";
import { prisma } from "../db.js";

export async function registerStorefrontRoutes(app: FastifyInstance) {
  app.get("/v1/storefront", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    const store = await prisma.storeConfig.findUnique({ where: { tenantId } });
    if (!store) return reply.code(404).send({ error: "not_found", message: "Store not found" });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    return {
      tenantId,
      storeName: store.storeName,
      subdomain: store.subdomain,
      defaultCurrency: store.defaultCurrency,
      deliveryRadiusKm: store.deliveryRadiusKm,
      deliveryFeeMinor: store.deliveryFeeMinor,
      pickup: {
        addressLine1: store.pickupAddressLine1,
        city: store.pickupCity,
        region: store.pickupRegion,
        country: store.pickupCountry,
        lat: store.pickupLat,
        lng: store.pickupLng,
      },
      primaryColor: tenant?.primaryColor,
    };
  });

  app.get("/v1/storefront/categories", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    return listCategories(tenantId);
  });

  app.get("/v1/storefront/products", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    return listProducts(tenantId, { status: "active" });
  });

  app.get("/v1/storefront/products/:id", async (req, reply) => {
    const tenantId = await requireTenant(req, reply);
    if (!tenantId) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return getProduct(tenantId, id);
  });

  app.get("/v1/cart", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    return getCart(auth.tenantId, auth.trustId);
  });

  app.post("/v1/cart/items", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    const body = z
      .object({
        variantId: z.string().min(1),
        quantity: z.number().int().positive().default(1),
      })
      .parse(req.body);
    const cart = await addCartItem({
      tenantId: auth.tenantId,
      buyerTrustId: auth.trustId,
      variantId: body.variantId,
      quantity: body.quantity,
    });
    return reply.code(201).send(cart);
  });

  app.patch("/v1/cart/items/:id", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ quantity: z.number().int() }).parse(req.body);
    return updateCartItem({
      tenantId: auth.tenantId,
      buyerTrustId: auth.trustId,
      itemId: id,
      quantity: body.quantity,
    });
  });

  app.delete("/v1/cart/items/:id", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return removeCartItem({ tenantId: auth.tenantId, buyerTrustId: auth.trustId, itemId: id });
  });
}
