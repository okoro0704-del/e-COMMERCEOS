import { splitSettlement, type OrderStatus } from "@ecommerceos/shared";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { httpError } from "../lib/crypto.js";
import { getOrCreateOpenCart, serializeCart } from "./cart.js";
import { reserveInventory, releaseReservation } from "./inventory.js";
import { getJobsProvider } from "./lifeos/container.js";
import type { Prisma } from "@prisma/client";

export type PlaceOrderInput = {
  tenantId: string;
  buyerTrustId: string;
  buyerName: string;
  buyerPhone?: string;
  buyerEmail?: string;
  shipping: {
    addressLine1: string;
    addressLine2?: string;
    city: string;
    region?: string;
    postalCode?: string;
    country: string;
    lat: number;
    lng: number;
  };
};

function nextOrderNumber() {
  const n = Date.now().toString(36).toUpperCase();
  return `ECO-${n}`;
}

export async function placeOrder(input: PlaceOrderInput) {
  const store = await prisma.storeConfig.findUnique({ where: { tenantId: input.tenantId } });
  if (!store) throw httpError(409, "store_not_configured", "Store has not been provisioned");

  const cart = await getOrCreateOpenCart(input.tenantId, input.buyerTrustId);
  const serialized = serializeCart(cart);
  if (!serialized.items.length) throw httpError(400, "empty_cart", "Cart is empty");

  const settlement = splitSettlement({
    merchandiseMinor: serialized.subtotalMinor,
    deliveryFeeMinor: store.deliveryFeeMinor,
    platformCommissionBps: store.platformCommissionBps,
  });

  const expiresAt = new Date(Date.now() + config.unpaidOrderTimeoutMs);
  const orderNumber = nextOrderNumber();

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        tenantId: input.tenantId,
        cartId: cart.id,
        orderNumber,
        status: "PENDING_PAYMENT",
        buyerTrustId: input.buyerTrustId,
        buyerName: input.buyerName,
        buyerPhone: input.buyerPhone,
        buyerEmail: input.buyerEmail,
        shippingAddressLine1: input.shipping.addressLine1,
        shippingAddressLine2: input.shipping.addressLine2,
        shippingCity: input.shipping.city,
        shippingRegion: input.shipping.region,
        shippingPostalCode: input.shipping.postalCode,
        shippingCountry: input.shipping.country,
        shippingLat: input.shipping.lat,
        shippingLng: input.shipping.lng,
        currency: store.defaultCurrency,
        merchandiseMinor: settlement.merchandiseMinor,
        deliveryFeeMinor: settlement.deliveryFeeMinor,
        platformCommissionMinor: settlement.platformCommissionMinor,
        merchantShareMinor: settlement.merchantShareMinor,
        riderFeeMinor: settlement.riderFeeMinor,
        totalMinor: settlement.totalMinor,
        paymentExpiresAt: expiresAt,
        items: {
          create: serialized.items.map((item) => ({
            variantId: item.variantId,
            sku: item.sku,
            title: item.title,
            quantity: item.quantity,
            unitPriceMinor: item.unitPriceMinor,
            weightGrams: item.weightGrams * item.quantity,
            lengthCm: item.dimensions.lengthCm,
            widthCm: item.dimensions.widthCm,
            heightCm: item.dimensions.heightCm,
          })),
        },
        events: {
          create: {
            fromStatus: null,
            toStatus: "PENDING_PAYMENT",
            source: "checkout",
            payload: { cartId: cart.id },
          },
        },
      },
      include: { items: true, events: true },
    });

    for (const item of serialized.items) {
      await reserveInventory(tx, {
        tenantId: input.tenantId,
        variantId: item.variantId,
        quantity: item.quantity,
        reference: created.id,
      });
    }

    await tx.cart.update({ where: { id: cart.id }, data: { status: "converted" } });
    return created;
  });

  await getJobsProvider().enqueue({
    queue: "ecommerceos",
    type: "cancel-unpaid-order",
    payload: { orderId: order.id, tenantId: input.tenantId },
    delayMs: config.unpaidOrderTimeoutMs,
  });

  return order;
}

export async function getOrder(tenantId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: { items: true, events: { orderBy: { createdAt: "asc" } } },
  });
  if (!order) throw httpError(404, "not_found", "Order not found");
  return order;
}

export async function listOrders(opts: {
  tenantId: string;
  buyerTrustId?: string;
  status?: string;
}) {
  return prisma.order.findMany({
    where: {
      tenantId: opts.tenantId,
      buyerTrustId: opts.buyerTrustId,
      status: opts.status,
    },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function appendOrderEvent(
  tx: Prisma.TransactionClient,
  opts: {
    orderId: string;
    fromStatus: string | null;
    toStatus: OrderStatus;
    source: string;
    payload?: Record<string, unknown>;
  },
) {
  await tx.orderEvent.create({
    data: {
      orderId: opts.orderId,
      fromStatus: opts.fromStatus,
      toStatus: opts.toStatus,
      source: opts.source,
      payload: (opts.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function cancelUnpaidOrder(orderId: string, reason = "unpaid_timeout") {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) return { skipped: true, reason: "not_found" };
  if (order.status !== "PENDING_PAYMENT") return { skipped: true, reason: "not_pending", status: order.status };

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason,
      },
    });
    await appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: "PENDING_PAYMENT",
      toStatus: "CANCELLED",
      source: "platform-jobs",
      payload: { reason },
    });
    for (const item of order.items) {
      await releaseReservation(tx, {
        tenantId: order.tenantId,
        variantId: item.variantId,
        quantity: item.quantity,
        reference: order.id,
      });
    }
  });

  return { skipped: false, orderId: order.id, status: "CANCELLED" as const };
}

export async function sweepUnpaidOrders(now = new Date()) {
  const expired = await prisma.order.findMany({
    where: { status: "PENDING_PAYMENT", paymentExpiresAt: { lte: now } },
    select: { id: true },
  });
  const results = [];
  for (const row of expired) {
    results.push(await cancelUnpaidOrder(row.id, "unpaid_timeout"));
  }
  return { scanned: expired.length, results };
}
