import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireBuyer, requireMerchant, resolveMerchantAuth, STORE_ADMIN_ROLES } from "../lib/auth.js";
import { cancelOrderByMerchant, getOrder, listOrders, placeOrder, presentOrder } from "../services/orders.js";
import { payOrder } from "../services/checkout.js";
import { assertStoreOpen } from "../services/activation.js";
import {
  advanceFulfilment,
  PAYMENT_METHODS,
  rejectTransferReport,
  reportTransfer,
  verifyTransfer,
} from "../services/offline-checkout.js";

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
    await assertStoreOpen(auth.tenantId);
    const body = z
      .object({
        buyerName: z.string().min(1),
        buyerPhone: z.string().optional(),
        buyerEmail: z.string().email().optional(),
        shipping: shippingSchema,
        paymentMethod: z.enum(PAYMENT_METHODS).optional(),
      })
      .parse(req.body);
    const order = await placeOrder({
      tenantId: auth.tenantId,
      buyerTrustId: auth.trustId,
      ...body,
    });
    return reply.code(201).send(presentOrder(order));
  });

  app.get("/v1/orders", async (req, reply) => {
    const merchant = await resolveMerchantAuth(req);
    if (merchant?.mustChangePassword) {
      return reply.code(403).send({ error: "password_change_required", message: "Set a new password to continue." });
    }
    if (merchant) {
      const query = z.object({ status: z.string().optional() }).parse(req.query);
      return (await listOrders({ tenantId: merchant.tenantId, status: query.status })).map((o) =>
        presentOrder(o, { forMerchant: true }),
      );
    }
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    const query = z.object({ status: z.string().optional() }).parse(req.query);
    return (await listOrders({ tenantId: buyer.tenantId, buyerTrustId: buyer.trustId, status: query.status })).map(
      (o) => presentOrder(o),
    );
  });

  app.get("/v1/orders/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const merchant = await resolveMerchantAuth(req);
    if (merchant?.mustChangePassword) {
      return reply.code(403).send({ error: "password_change_required", message: "Set a new password to continue." });
    }
    if (merchant) return presentOrder(await getOrder(merchant.tenantId, id), { forMerchant: true });
    const buyer = await requireBuyer(req, reply);
    if (!buyer) return;
    const order = await getOrder(buyer.tenantId, id);
    if (order.buyerTrustId !== buyer.trustId) {
      return reply.code(403).send({ error: "forbidden", message: "Order does not belong to this Trust ID" });
    }
    return presentOrder(order);
  });

  // Customer: "I have sent the transfer". Recorded for the merchant to check; never marks the order paid.
  app.post("/v1/orders/:id/payment-notification", async (req, reply) => {
    const auth = await requireBuyer(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ reference: z.string().trim().min(3).max(80), payerName: z.string().trim().min(1).max(120) }).parse(req.body);
    const order = await reportTransfer({ tenantId: auth.tenantId, buyerTrustId: auth.trustId, orderId: id, ...body });
    return presentOrder(order);
  });

  app.post("/v1/orders/:id/payment/verify", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ amountReceivedMinor: z.number().int().nonnegative(), merchantReference: z.string().trim().max(80).optional() })
      .parse(req.body);
    return presentOrder(await verifyTransfer(auth, id, body), { forMerchant: true });
  });

  app.post("/v1/orders/:id/payment/reject", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    return presentOrder(await rejectTransferReport(auth, id, body.reason), { forMerchant: true });
  });

  app.post("/v1/orders/:id/fulfilment", async (req, reply) => {
    const auth = await requireMerchant(req, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ action: z.enum(["dispatch", "deliver", "complete"]), amountCollectedMinor: z.number().int().nonnegative().optional() })
      .parse(req.body);
    return presentOrder(await advanceFulfilment(auth, id, body.action, body), { forMerchant: true });
  });

  app.post("/v1/orders/:id/cancel", async (req, reply) => {
    const auth = await requireMerchant(req, reply, { roles: STORE_ADMIN_ROLES });
    if (!auth) return;
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ reason: z.string().trim().min(3).max(300), refundReference: z.string().trim().max(80).optional() })
      .parse(req.body);
    const order = await cancelOrderByMerchant({
      tenantId: auth.tenantId,
      staffId: auth.staffId,
      role: auth.role,
      orderId: id,
      reason: body.reason,
      refundReference: body.refundReference,
    });
    return presentOrder(order, { forMerchant: true });
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
    return reply.send({ ...result, order: presentOrder(result.order) });
  });
}
