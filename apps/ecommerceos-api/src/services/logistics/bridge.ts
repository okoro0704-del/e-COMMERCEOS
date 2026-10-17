import { assertTransition, orderStatusFromLogistics, type LogisticsStatus, type OrderStatus } from "@ecommerceos/shared";
import { prisma } from "../../db.js";
import { httpError } from "../../lib/crypto.js";
import { getLogisticsClient } from "./client.js";
import { appendOrderEvent } from "../orders.js";
import { consumeReservation } from "../inventory.js";
import { notifyOrderStatus } from "../notifications.js";

export async function dispatchPaidOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw httpError(404, "not_found", "Order not found");
  if (order.status !== "PAID_ESCROW") {
    throw httpError(409, "illegal_transition", `Cannot dispatch order in ${order.status}`);
  }

  const store = await prisma.storeConfig.findUnique({ where: { tenantId: order.tenantId } });
  if (!store) throw httpError(409, "store_not_configured", "Store has not been provisioned");

  const packageDims = order.items.reduce(
    (acc, item) => ({
      weightGrams: acc.weightGrams + item.weightGrams,
      lengthCm: Math.max(acc.lengthCm, item.lengthCm),
      widthCm: Math.max(acc.widthCm, item.widthCm),
      heightCm: acc.heightCm + item.heightCm,
    }),
    { weightGrams: 0, lengthCm: 0, widthCm: 0, heightCm: 0 },
  );

  const dispatched = await getLogisticsClient().dispatch({
    orderId: order.id,
    tenantId: order.tenantId,
    pickup: {
      lat: store.pickupLat,
      lng: store.pickupLng,
      addressLine1: store.pickupAddressLine1,
      addressLine2: store.pickupAddressLine2,
      city: store.pickupCity,
      region: store.pickupRegion,
      postalCode: store.pickupPostalCode,
      country: store.pickupCountry,
      contactName: store.storeName,
    },
    dropoff: {
      lat: order.shippingLat,
      lng: order.shippingLng,
      addressLine1: order.shippingAddressLine1,
      addressLine2: order.shippingAddressLine2,
      city: order.shippingCity,
      region: order.shippingRegion,
      postalCode: order.shippingPostalCode,
      country: order.shippingCountry,
      contactName: order.buyerName,
      contactPhone: order.buyerPhone,
    },
    package: packageDims,
    buyer: {
      trustId: order.buyerTrustId,
      name: order.buyerName,
      phone: order.buyerPhone,
      email: order.buyerEmail,
    },
  });

  const updated = await prisma.$transaction(async (tx) => {
    assertTransition("PAID_ESCROW", "DISPATCH_PENDING");
    const next = await tx.order.update({
      where: { id: order.id },
      data: {
        status: "DISPATCH_PENDING",
        logisticsJobId: dispatched.logisticsJobId,
        dispatchedAt: new Date(),
      },
      include: { items: true, events: true },
    });
    await appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: "PAID_ESCROW",
      toStatus: "DISPATCH_PENDING",
      source: "logistics.dispatch",
      payload: { logisticsJobId: dispatched.logisticsJobId },
    });
    return next;
  });

  await notifyOrderStatus({
    tenantId: order.tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    buyerTrustId: order.buyerTrustId,
    buyerPhone: order.buyerPhone,
    status: "DISPATCH_PENDING",
    message: "Your order {orderNumber} is paid and being prepared for dispatch.",
  });

  return updated;
}

export async function applyLogisticsWebhook(input: {
  logisticsJobId: string;
  orderId?: string;
  status: LogisticsStatus;
  occurredAt?: string;
}) {
  const order = await prisma.order.findFirst({
    where: input.orderId
      ? { id: input.orderId }
      : { logisticsJobId: input.logisticsJobId },
    include: { items: true },
  });
  if (!order) throw httpError(404, "not_found", "Order not found for logistics job");
  if (order.logisticsJobId && order.logisticsJobId !== input.logisticsJobId) {
    throw httpError(409, "job_mismatch", "logisticsJobId does not match order");
  }

  const mapped = orderStatusFromLogistics(input.status);
  if (order.status === mapped || order.status === "COMPLETED" || order.status === "CANCELLED") {
    return { order, skipped: true };
  }

  if (mapped === "IN_TRANSIT") {
    assertTransition(order.status as OrderStatus, "IN_TRANSIT");
    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.order.update({
        where: { id: order.id },
        data: { status: "IN_TRANSIT" },
        include: { items: true, events: true },
      });
      await appendOrderEvent(tx, {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "IN_TRANSIT",
        source: "logistics.webhook",
        payload: { logisticsStatus: input.status, logisticsJobId: input.logisticsJobId },
      });
      return next;
    });
    await notifyOrderStatus({
      tenantId: order.tenantId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      buyerTrustId: order.buyerTrustId,
      buyerPhone: order.buyerPhone,
      status: "IN_TRANSIT",
      message: "Your order {orderNumber} is on the way.",
    });
    return { order: updated, skipped: false };
  }

  return recordDelivery(order.id);
}

/**
 * Records delivery and consumes the reserved stock. It deliberately neither releases
 * funds nor completes the order: completion needs buyer acceptance and a
 * provider-confirmed settlement, and this build has neither.
 */
export async function recordDelivery(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw httpError(404, "not_found", "Order not found");
  if (order.status === "DELIVERED" || order.status === "COMPLETED") return { order, skipped: true };
  if (order.status !== "IN_TRANSIT" && order.status !== "DISPATCH_PENDING") {
    throw httpError(409, "illegal_transition", `Cannot record delivery from ${order.status}`);
  }
  assertTransition(order.status as OrderStatus, "DELIVERED");

  const delivered = await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      await consumeReservation(tx, {
        tenantId: order.tenantId,
        variantId: item.variantId,
        quantity: item.quantity,
        reference: order.id,
      });
    }
    const next = await tx.order.update({
      where: { id: order.id },
      data: { status: "DELIVERED", deliveredAt: new Date() },
      include: { items: true, events: true },
    });
    await appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: order.status,
      toStatus: "DELIVERED",
      source: "logistics.webhook",
      payload: { logisticsStatus: "DELIVERED", settlement: "not_released" },
    });
    return next;
  });

  await notifyOrderStatus({
    tenantId: order.tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    buyerTrustId: order.buyerTrustId,
    buyerPhone: order.buyerPhone,
    status: "DELIVERED",
    message: "Your order {orderNumber} has been delivered. Thank you for shopping with {storeName}.",
  });

  return { order: delivered, skipped: false };
}
