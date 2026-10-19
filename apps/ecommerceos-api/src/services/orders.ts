import { splitSettlement, type OrderStatus } from "@ecommerceos/shared";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { httpError } from "../lib/crypto.js";
import { getOrCreateOpenCart, serializeCart } from "./cart.js";
import { reserveInventory, releaseReservation } from "./inventory.js";
import { getJobsProvider } from "./lifeos/container.js";
import { writeAudit } from "../lib/audit.js";
import { cancelConfirmedOrder, isMethodAccepted, type PaymentMethod } from "./offline-checkout.js";
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
  /** Offline payment chosen by the customer; omitted only by the disabled online checkout. */
  paymentMethod?: PaymentMethod;
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

  const method = input.paymentMethod;
  if (method && !isMethodAccepted(store, method)) {
    throw httpError(400, "payment_method_unavailable", "This store does not accept that payment method.");
  }
  // Pay on delivery needs no payment first; a bank transfer is held for the customer to pay.
  const holdMs = method === "bank_transfer" ? config.bankTransferWindowHours * 60 * 60 * 1000 : config.unpaidOrderTimeoutMs;
  const initialStatus = method === "pay_on_delivery" ? "CONFIRMED" : "PENDING_PAYMENT";
  const expiresAt = new Date(Date.now() + holdMs);
  const orderNumber = nextOrderNumber();

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        tenantId: input.tenantId,
        cartId: cart.id,
        orderNumber,
        status: initialStatus,
        paymentMethod: method ?? null,
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
            toStatus: initialStatus,
            source: "checkout",
            payload: { cartId: cart.id, ...(method ? { paymentMethod: method } : {}) },
          },
        },
        ...(method
          ? {
              payment: {
                create: {
                  tenantId: input.tenantId,
                  method,
                  status: method === "bank_transfer" ? "awaiting_transfer" : "due_on_delivery",
                  amountMinor: settlement.totalMinor,
                  currency: store.defaultCurrency,
                  ...(method === "bank_transfer"
                    ? { bankName: store.bankName, bankAccountName: store.bankAccountName, bankAccountNumber: store.bankAccountNumber }
                    : {}),
                },
              },
            }
          : {}),
      },
      include: { items: true, events: true, payment: true },
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

  if (initialStatus === "PENDING_PAYMENT") {
    await getJobsProvider().enqueue({
      queue: "ecommerceos",
      type: "cancel-unpaid-order",
      payload: { orderId: order.id, tenantId: input.tenantId },
      delayMs: holdMs,
    });
  }

  return order;
}

export async function getOrder(tenantId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: { items: true, events: { orderBy: { createdAt: "asc" } }, payment: true },
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
    include: { items: true, payment: true },
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

export async function cancelUnpaidOrder(orderId: string, reason = "unpaid_timeout", source = "platform-jobs") {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payment: true },
  });
  if (!order) return { skipped: true, reason: "not_found" };
  if (order.status !== "PENDING_PAYMENT") return { skipped: true, reason: "not_pending", status: order.status };
  if (reason === "unpaid_timeout" && order.paymentExpiresAt > new Date()) return { skipped: true, reason: "not_expired" };
  // A customer says they paid: the merchant must verify or reject that first; never auto-cancel it.
  if (order.payment?.status === "customer_reported") return { skipped: true, reason: "payment_reported" };

  // Conditional: of a concurrent sweep, merchant cancel or payment, one wins and stock is released once.
  const cancelled = await prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: "PENDING_PAYMENT" },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: reason,
      },
    });
    if (claimed.count !== 1) return false;
    if (order.payment) {
      const voided = await tx.orderPayment.updateMany({
        where: { orderId: order.id, status: { in: ["awaiting_transfer", "rejected"] } },
        data: { status: "void" },
      });
      // A report arrived meanwhile: undo the whole cancellation.
      if (voided.count !== 1) throw Object.assign(new Error("payment reported"), { paymentReported: true });
    }
    await appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: "PENDING_PAYMENT",
      toStatus: "CANCELLED",
      source,
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
    return true;
  }).catch((err: { paymentReported?: boolean }) => {
    if (err.paymentReported) return "payment_reported" as const;
    throw err;
  });
  if (cancelled === "payment_reported") return { skipped: true, reason: "payment_reported" };
  if (!cancelled) return { skipped: true, reason: "not_pending" };

  return { skipped: false, orderId: order.id, status: "CANCELLED" as const };
}

/**
 * A store admin cancels an order. Unpaid orders here; confirmed offline orders (pay on delivery,
 * or a verified transfer the owner has refunded) through cancelConfirmedOrder. A payment the
 * customer reported must be verified or rejected first.
 */
export async function cancelOrderByMerchant(opts: {
  tenantId: string;
  staffId: string;
  role: string;
  orderId: string;
  reason: string;
  refundReference?: string;
}) {
  const order = await getOrder(opts.tenantId, opts.orderId);
  if (order.status === "CONFIRMED" || order.status === "IN_TRANSIT") {
    return cancelConfirmedOrder({ tenantId: opts.tenantId, staffId: opts.staffId, role: opts.role }, order.id, opts);
  }
  if (order.status !== "PENDING_PAYMENT") {
    throw httpError(409, "not_cancellable", "This order can no longer be cancelled.");
  }
  if (order.payment?.status === "customer_reported") {
    throw httpError(409, "payment_report_pending", "The customer reported a payment. Verify or reject it first.");
  }
  const result = await cancelUnpaidOrder(order.id, `merchant: ${opts.reason}`, "merchant");
  if (result.skipped) throw httpError(409, "not_cancellable", "This order changed before it could be cancelled.");
  await writeAudit({
    tenantId: opts.tenantId,
    actorKind: "merchant",
    actorId: opts.staffId,
    action: "order.cancelled",
    resource: "order",
    resourceId: order.id,
    metadata: { reason: opts.reason },
  });
  return getOrder(opts.tenantId, order.id);
}

export async function sweepUnpaidOrders(now = new Date()) {
  const expired = await prisma.order.findMany({
    where: {
      status: "PENDING_PAYMENT",
      paymentExpiresAt: { lte: now },
      NOT: { payment: { is: { status: "customer_reported" } } },
    },
    select: { id: true },
  });
  const results = [];
  for (const row of expired) {
    results.push(await cancelUnpaidOrder(row.id, "unpaid_timeout"));
  }
  return { scanned: expired.length, results };
}

export type OrderPaymentStatus =
  | "unpaid"
  | "simulated_not_paid"
  | "provider_reported"
  | "awaiting_transfer"
  | "customer_reported"
  | "verified"
  | "rejected"
  | "due_on_delivery"
  | "collected"
  | "void"
  | "refunded_offline";
export type OrderFulfilmentStatus =
  | "not_started"
  | "awaiting_dispatch"
  | "in_transit"
  | "delivered"
  | "completed"
  | "cancelled";

const FULFILMENT_BY_STATUS: Record<string, OrderFulfilmentStatus> = {
  PENDING_PAYMENT: "not_started",
  PAID_ESCROW: "not_started",
  CONFIRMED: "awaiting_dispatch",
  DISPATCH_PENDING: "awaiting_dispatch",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

/**
 * Payment and fulfilment read separately from the single stored status, so a
 * dispatched order is never mistaken for a paid one. Orders "paid" through the
 * old local stub carry a `local_` payment id and are reported as not paid.
 */
type PresentablePayment = {
  method: string;
  status: string;
  amountMinor: number;
  currency: string;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  customerReference: string | null;
  customerReportedAt: Date | null;
  verifiedAt: Date | null;
  rejectedReason: string | null;
  refundReference: string | null;
  merchantReference?: string | null;
};

/** What the customer is shown about their payment; bank details only while they still need to pay. */
function presentPayment(payment: PresentablePayment, forMerchant: boolean) {
  const stillToPay = ["awaiting_transfer", "rejected", "customer_reported"].includes(payment.status);
  return {
    method: payment.method,
    status: payment.status,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    ...(payment.method === "bank_transfer" && (stillToPay || forMerchant)
      ? { bankName: payment.bankName, bankAccountName: payment.bankAccountName, bankAccountNumber: payment.bankAccountNumber }
      : {}),
    customerReference: payment.customerReference,
    customerReportedAt: payment.customerReportedAt,
    verifiedAt: payment.verifiedAt,
    rejectedReason: payment.rejectedReason,
    ...(forMerchant ? { merchantReference: payment.merchantReference ?? null, refundReference: payment.refundReference } : {}),
  };
}

export function presentOrder<
  T extends { status: string; escrowPaymentId: string | null; buyerTrustId: string; payment?: PresentablePayment | null },
>(order: T, opts: { forMerchant?: boolean } = {}) {
  const { buyerTrustId, payment, ...rest } = order;
  // Offline payments are verified only by the merchant's explicit action, never by the customer.
  const paymentStatus: OrderPaymentStatus = payment
    ? (payment.status as OrderPaymentStatus)
    : !order.escrowPaymentId
      ? "unpaid"
      : order.escrowPaymentId.startsWith("local_")
        ? "simulated_not_paid"
        : "provider_reported";
  // Older rows hold the buyer's bearer token as buyerTrustId; merchants never see it.
  return {
    ...rest,
    ...(opts.forMerchant ? {} : { buyerTrustId }),
    paymentStatus,
    // The disabled online checkout has no verified provider, so only merchant-verified offline payments count.
    paymentVerified: payment ? payment.status === "verified" || payment.status === "collected" : false,
    ...(payment ? { payment: presentPayment(payment, Boolean(opts.forMerchant)) } : {}),
    fulfilmentStatus: FULFILMENT_BY_STATUS[order.status] ?? "not_started",
  };
}
