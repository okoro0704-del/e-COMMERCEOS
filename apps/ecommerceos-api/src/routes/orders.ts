import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireBuyer, requireMerchant, resolveMerchantAuth } from "../lib/auth.js";
import { getOrder, listOrders, placeOrder } from "../services/orders.js";
import { payOrder } from "../services/checkout.js";

const shippingSchema = z.object({
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().min(1),
  lat: z.number(),
  lng: z.number(),
});

export async function registerOrderRoutes(app: FastifyInstance) {
  app.post("/v1/orders", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    const body = z
      .object({
        buyerName: z.string().min(1),
        buyerPhone: z.string().optional(),
        buyerEmail: z.string().email().optional(),
        shipping: shippingSchema,
      })
      .parse(req.body);
    const order = await placeOrder({
      tenantId: auth.tenantId,
      buyerTrustId: auth.trustId,
      ...body,
    });
    return reply.code(201).send(order);
  });

  app.get("/v1/orders", async (req, reply) => {
    const merchant = await resolveMerchantAuth(req);
    if (merchant) {
      const query = z.object({ status: z.string().optional() }).parse(req.query);
      return listOrders({ tenantId: merchant.tenantId, status: query.status });
    }
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    const query = z.object({ status: z.string().optional() }).parse(req.query);
    return listOrders({ tenantId: buyer.tenantId, buyerTrustId: buyer.trustId, status: query.status });
  });

  app.get("/v1/orders/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const merchant = await resolveMerchantAuth(req);
    if (merchant) return getOrder(merchant.tenantId, id);
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    const order = await getOrder(buyer.tenantId, id);
    if (order.buyerTrustId !== buyer.trustId) {
      return reply.code(403).send({ error: "forbidden", message: "Order does not belong to this Trust ID" });
    }
    return order;
  });

  app.post("/v1/checkout/pay", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    const body = z.object({ orderId: z.string().min(1) }).parse(req.body);
    const result = await payOrder({
      tenantId: auth.tenantId,
      orderId: body.orderId,
      buyerTrustId: auth.trustId,
    });
    return reply.send(result);
  });
}
