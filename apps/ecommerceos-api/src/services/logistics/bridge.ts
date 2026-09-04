import { assertTransition, orderStatusFromLogistics, type LogisticsStatus, type OrderStatus } from "@ecommerceos/shared";
import { prisma } from "../../db.js";
import { httpError } from "../../lib/crypto.js";
import { getLogisticsClient } from "./client.js";
import { appendOrderEvent } from "../orders.js";
import { consumeReservation } from "../inventory.js";
import { getFundzManWalletProvider } from "../lifeos/container.js";
import { notifyOrderStatus } from "../notifications.js";
import { storeInvoicePdf } from "../invoices.js";

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

  return settleDeliveredOrder(order.id);
}

export async function settleDeliveredOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw httpError(404, "not_found", "Order not found");
  if (order.status === "COMPLETED") return { order, skipped: true };
  if (order.status !== "IN_TRANSIT" && order.status !== "DISPATCH_PENDING" && order.status !== "DELIVERED") {
    throw httpError(409, "illegal_transition", `Cannot settle delivery from ${order.status}`);
  }
  if (order.status === "DISPATCH_PENDING") {
    assertTransition("DISPATCH_PENDING", "DELIVERED");
  } else if (order.status === "IN_TRANSIT") {
    assertTransition("IN_TRANSIT", "DELIVERED");
  }
  if (!order.escrowPaymentId) {
    throw httpError(409, "missing_escrow", "Order has no FundzMan escrow payment");
  }

  const store = await prisma.storeConfig.findUnique({ where: { tenantId: order.tenantId } });
  if (!store) throw httpError(409, "store_not_configured", "Store has not been provisioned");

  if (order.status !== "DELIVERED") {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "DELIVERED", deliveredAt: new Date() },
      });
      await appendOrderEvent(tx, {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "DELIVERED",
        source: "logistics.webhook",
        payload: { logisticsStatus: "DELIVERED" },
      });
    });
  }

  const release = await getFundzManWalletProvider().releaseEscrow({
    paymentId: order.escrowPaymentId,
    currency: order.currency,
    reference: order.id,
    splits: [
      { payeeId: order.tenantId, role: "merchant", amount: order.merchantShareMinor },
      { payeeId: store.riderPayeeId, role: "rider", amount: order.riderFeeMinor },
      { payeeId: store.platformPayeeId, role: "platform", amount: order.platformCommissionMinor },
    ],
    metadata: { orderId: order.id, orderNumber: order.orderNumber },
  });

  const invoice = await storeInvoicePdf({
    tenantId: order.tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    buyerName: order.buyerName,
    currency: order.currency,
    totalMinor: order.totalMinor,
    status: "COMPLETED",
  });

  const completed = await prisma.$transaction(async (tx) => {
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
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        invoiceDriveKey: invoice.key,
        invoiceDriveUrl: invoice.url,
      },
      include: { items: true, events: true },
    });
    await appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: "DELIVERED",
      toStatus: "COMPLETED",
      source: "fundzman.escrow_release",
      payload: { releaseId: release.releaseId, splits: release.splits },
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

  return { order: completed, skipped: false, release, invoice };
}
