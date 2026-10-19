import type { OrderStatus } from "@ecommerceos/shared";
import { prisma } from "../db.js";
import { httpError } from "../lib/crypto.js";
import { writeAudit } from "../lib/audit.js";
import { STORE_ADMIN_ROLES } from "../lib/auth.js";
import { appendOrderEvent, getOrder } from "./orders.js";
import { consumeReservation, releaseReservation } from "./inventory.js";

/**
 * Offline-assisted checkout. Customers pay the merchant directly, by bank transfer or on delivery.
 * No money passes through Digiconomy and nothing here talks to a payment provider.
 *
 * Payment states (OrderPayment.status):
 *   bank_transfer:   awaiting_transfer → customer_reported → verified        (merchant verifies)
 *                                        customer_reported → rejected → customer_reported
 *   pay_on_delivery: due_on_delivery → collected                            (merchant records cash)
 *   cancelled:       void (no money taken), or refunded_offline (verified, refunded by the merchant)
 *
 * A customer's notification only records what they report. Only a store owner or admin can
 * verify or collect, every transition is a conditional write (one winner under concurrency),
 * and each one is audited.
 */
export const PAYMENT_METHODS = ["pay_on_delivery", "bank_transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

type StorePaymentConfig = {
  payOnDeliveryEnabled: boolean;
  bankTransferEnabled: boolean;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankTransferNote: string | null;
};

class Conflict extends Error {}

export function acceptedPaymentMethods(store: StorePaymentConfig) {
  return {
    payOnDelivery: store.payOnDeliveryEnabled,
    bankTransfer: store.bankTransferEnabled && Boolean(store.bankName && store.bankAccountName && store.bankAccountNumber),
  };
}

export function isMethodAccepted(store: StorePaymentConfig, method: PaymentMethod) {
  const accepted = acceptedPaymentMethods(store);
  return method === "pay_on_delivery" ? accepted.payOnDelivery : accepted.bankTransfer;
}

const normalizeReference = (value: string) => value.trim().toUpperCase().replace(/\s+/g, "");
const last4 = (value: string | null) => (value ? value.slice(-4) : null);

// ---- Merchant settings -----------------------------------------------------------------------

function presentSettings(store: StorePaymentConfig) {
  return {
    payOnDeliveryEnabled: store.payOnDeliveryEnabled,
    bankTransferEnabled: store.bankTransferEnabled,
    bankName: store.bankName,
    bankAccountName: store.bankAccountName,
    bankAccountNumber: store.bankAccountNumber,
    bankTransferNote: store.bankTransferNote ?? "",
    accepted: acceptedPaymentMethods(store),
  };
}

export async function getPaymentSettings(tenantId: string) {
  const store = await prisma.storeConfig.findUnique({ where: { tenantId } });
  if (!store) throw httpError(404, "not_found", "Store not found");
  return presentSettings(store);
}

/** Owners only: these are the details customers send money to. */
export async function updatePaymentSettings(opts: {
  tenantId: string;
  staffId: string;
  patch: Partial<Omit<StorePaymentConfig, "bankTransferNote">> & { bankTransferNote?: string };
}) {
  const store = await prisma.storeConfig.findUnique({ where: { tenantId: opts.tenantId } });
  if (!store) throw httpError(404, "not_found", "Store not found");
  const next = { ...store, ...opts.patch };
  if (next.bankAccountNumber && !/^\d{6,20}$/.test(next.bankAccountNumber)) {
    throw httpError(400, "invalid_account_number", "Enter the account number as digits only.");
  }
  if (next.bankTransferEnabled && !(next.bankName && next.bankAccountName && next.bankAccountNumber)) {
    throw httpError(400, "bank_details_required", "Add the bank name, account name and account number to accept bank transfers.");
  }
  const updated = await prisma.storeConfig.update({
    where: { tenantId: opts.tenantId },
    data: {
      payOnDeliveryEnabled: next.payOnDeliveryEnabled,
      bankTransferEnabled: next.bankTransferEnabled,
      bankName: next.bankName?.trim() || null,
      bankAccountName: next.bankAccountName?.trim() || null,
      bankAccountNumber: next.bankAccountNumber?.trim() || null,
      bankTransferNote: next.bankTransferNote?.trim() || null,
    },
  });
  await writeAudit({
    tenantId: opts.tenantId,
    actorKind: "merchant",
    actorId: opts.staffId,
    action: "store.payment_settings_updated",
    resource: "store",
    resourceId: opts.tenantId,
    metadata: {
      payOnDeliveryEnabled: updated.payOnDeliveryEnabled,
      bankTransferEnabled: updated.bankTransferEnabled,
      bankAccountChanged: store.bankAccountNumber !== updated.bankAccountNumber || store.bankName !== updated.bankName,
      accountLast4: last4(updated.bankAccountNumber),
    },
  });
  return presentSettings(updated);
}

// ---- Customer -----------------------------------------------------------------------------

/** The customer says they sent the transfer. This records the report; it never marks the order paid. */
export async function reportTransfer(opts: {
  tenantId: string;
  buyerTrustId: string;
  orderId: string;
  reference: string;
  payerName: string;
}) {
  const order = await getOrder(opts.tenantId, opts.orderId);
  if (order.buyerTrustId !== opts.buyerTrustId) throw httpError(403, "forbidden", "Order does not belong to this Trust ID");
  if (order.paymentMethod !== "bank_transfer" || !order.payment) {
    throw httpError(409, "not_bank_transfer", "This order is not paid by bank transfer.");
  }
  const sameReport = () =>
    order.payment?.status === "customer_reported" &&
    normalizeReference(order.payment.customerReference ?? "") === normalizeReference(opts.reference);
  if (sameReport()) return getOrder(opts.tenantId, order.id); // a repeat of the same report
  if (order.status !== "PENDING_PAYMENT") throw httpError(409, "not_awaiting_payment", "This order is no longer awaiting payment.");
  if (order.payment.status === "customer_reported") {
    throw httpError(409, "already_reported", "A payment for this order is already being checked by the store.");
  }

  const claimed = await prisma.orderPayment.updateMany({
    where: { orderId: order.id, status: { in: ["awaiting_transfer", "rejected"] } },
    data: {
      status: "customer_reported",
      customerReference: opts.reference.trim(),
      customerPayerName: opts.payerName.trim(),
      customerReportedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    const current = await getOrder(opts.tenantId, order.id);
    if (current.payment?.status === "customer_reported" && normalizeReference(current.payment.customerReference ?? "") === normalizeReference(opts.reference)) {
      return current;
    }
    throw httpError(409, "already_reported", "A payment for this order is already being checked by the store.");
  }
  await prisma.$transaction(async (tx) =>
    appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: order.status as OrderStatus,
      toStatus: order.status as OrderStatus,
      source: "customer",
      payload: { payment: "customer_reported" },
    }),
  );
  await writeAudit({
    tenantId: opts.tenantId,
    actorKind: "buyer",
    action: "order.payment_reported",
    resource: "order",
    resourceId: order.id,
    metadata: { method: "bank_transfer" },
  });
  return getOrder(opts.tenantId, order.id);
}

// ---- Merchant: payment ----------------------------------------------------------------------

type Merchant = { tenantId: string; staffId: string; role: string };

function requireStoreAdmin(auth: Merchant) {
  if (!(STORE_ADMIN_ROLES as readonly string[]).includes(auth.role)) {
    throw httpError(403, "forbidden", "Only the store owner or an admin can record payments.");
  }
}

/** The merchant confirms the transfer reached their account. The order is confirmed exactly once. */
export async function verifyTransfer(auth: Merchant, orderId: string, opts: { amountReceivedMinor: number; merchantReference?: string }) {
  requireStoreAdmin(auth);
  const order = await getOrder(auth.tenantId, orderId);
  if (order.paymentMethod !== "bank_transfer" || !order.payment) {
    throw httpError(409, "not_bank_transfer", "This order is not paid by bank transfer.");
  }
  if (opts.amountReceivedMinor !== order.totalMinor) {
    throw httpError(400, "amount_mismatch", "The amount received does not match the order total.");
  }
  const reported = order.payment.status === "customer_reported";
  try {
    await prisma.$transaction(async (tx) => {
      const confirmed = await tx.order.updateMany({
        where: { id: order.id, tenantId: auth.tenantId, status: "PENDING_PAYMENT" },
        data: { status: "CONFIRMED" },
      });
      if (confirmed.count !== 1) throw new Conflict();
      const verified = await tx.orderPayment.updateMany({
        where: { orderId: order.id, status: { in: ["awaiting_transfer", "customer_reported"] } },
        data: {
          status: "verified",
          verifiedById: auth.staffId,
          verifiedAt: new Date(),
          verifiedAmountMinor: opts.amountReceivedMinor,
          merchantReference: opts.merchantReference?.trim() || null,
        },
      });
      if (verified.count !== 1) throw new Conflict();
      await appendOrderEvent(tx, {
        orderId: order.id,
        fromStatus: "PENDING_PAYMENT",
        toStatus: "CONFIRMED",
        source: "merchant",
        payload: { payment: "verified" },
      });
    });
  } catch (err) {
    if (err instanceof Conflict) throw httpError(409, "not_awaiting_payment", "This payment was already reviewed or the order changed.");
    throw err;
  }
  await writeAudit({
    tenantId: auth.tenantId,
    actorKind: "merchant",
    actorId: auth.staffId,
    action: "order.payment_verified",
    resource: "order",
    resourceId: order.id,
    metadata: { method: "bank_transfer", amountMinor: opts.amountReceivedMinor, afterCustomerReport: reported },
  });
  return getOrder(auth.tenantId, order.id);
}

/** The merchant did not find the reported transfer; the customer can report again. */
export async function rejectTransferReport(auth: Merchant, orderId: string, reason: string) {
  requireStoreAdmin(auth);
  const order = await getOrder(auth.tenantId, orderId);
  const rejected = await prisma.orderPayment.updateMany({
    where: { orderId: order.id, tenantId: auth.tenantId, status: "customer_reported" },
    data: { status: "rejected", rejectedById: auth.staffId, rejectedAt: new Date(), rejectedReason: reason.trim() },
  });
  if (rejected.count !== 1) throw httpError(409, "no_payment_report", "There is no customer payment report to reject.");
  await prisma.$transaction(async (tx) =>
    appendOrderEvent(tx, { orderId: order.id, fromStatus: order.status as OrderStatus, toStatus: order.status as OrderStatus, source: "merchant", payload: { payment: "rejected" } }),
  );
  await writeAudit({
    tenantId: auth.tenantId,
    actorKind: "merchant",
    actorId: auth.staffId,
    action: "order.payment_report_rejected",
    resource: "order",
    resourceId: order.id,
    metadata: { reason: reason.trim() },
  });
  return getOrder(auth.tenantId, order.id);
}

// ---- Merchant: fulfilment -------------------------------------------------------------------

export type FulfilmentAction = "dispatch" | "deliver" | "complete";

/**
 * Merchant-run fulfilment for offline orders. Any store staff can mark an order dispatched;
 * recording delivery (and, for pay on delivery, the cash collected) needs an owner or admin.
 */
export async function advanceFulfilment(auth: Merchant, orderId: string, action: FulfilmentAction, opts: { amountCollectedMinor?: number }) {
  const order = await getOrder(auth.tenantId, orderId);
  if (!order.paymentMethod || !order.payment) {
    throw httpError(409, "not_offline_order", "This order is not fulfilled by the store.");
  }
  const from: Record<FulfilmentAction, string[]> = {
    dispatch: ["CONFIRMED"],
    deliver: ["CONFIRMED", "IN_TRANSIT"],
    complete: ["DELIVERED"],
  };
  const to = { dispatch: "IN_TRANSIT", deliver: "DELIVERED", complete: "COMPLETED" }[action];
  if (action !== "dispatch") requireStoreAdmin(auth);
  if (!from[action].includes(order.status)) {
    throw httpError(409, "illegal_transition", `Cannot ${action} an order that is ${order.status}.`);
  }
  const cashOnDelivery = action === "deliver" && order.paymentMethod === "pay_on_delivery";
  if (cashOnDelivery && opts.amountCollectedMinor !== order.totalMinor) {
    throw httpError(400, "amount_mismatch", "Record the full order total collected on delivery.");
  }
  if (action === "deliver" && order.paymentMethod === "bank_transfer" && order.payment.status !== "verified") {
    throw httpError(409, "payment_not_verified", "Verify the bank transfer before delivering.");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      const moved = await tx.order.updateMany({
        where: { id: order.id, tenantId: auth.tenantId, status: order.status },
        data: {
          status: to,
          ...(action === "dispatch" ? { dispatchedAt: now } : {}),
          ...(action === "deliver" ? { deliveredAt: now } : {}),
          ...(action === "complete" ? { completedAt: now } : {}),
        },
      });
      if (moved.count !== 1) throw new Conflict();
      if (cashOnDelivery) {
        const collected = await tx.orderPayment.updateMany({
          where: { orderId: order.id, status: "due_on_delivery" },
          data: { status: "collected", verifiedById: auth.staffId, verifiedAt: now, verifiedAmountMinor: opts.amountCollectedMinor },
        });
        if (collected.count !== 1) throw new Conflict();
      }
      if (action === "deliver") {
        for (const item of order.items) {
          await consumeReservation(tx, { tenantId: order.tenantId, variantId: item.variantId, quantity: item.quantity, reference: order.id });
        }
      }
      await appendOrderEvent(tx, {
        orderId: order.id,
        fromStatus: order.status as OrderStatus,
        toStatus: to as OrderStatus,
        source: "merchant",
        payload: cashOnDelivery ? { payment: "collected" } : {},
      });
    });
  } catch (err) {
    if (err instanceof Conflict) throw httpError(409, "order_changed", "This order changed. Reload it and try again.");
    throw err;
  }
  await writeAudit({
    tenantId: auth.tenantId,
    actorKind: "merchant",
    actorId: auth.staffId,
    action: `order.${action === "dispatch" ? "dispatched" : action === "deliver" ? "delivered" : "completed"}`,
    resource: "order",
    resourceId: order.id,
    metadata: cashOnDelivery ? { payment: "collected", amountMinor: opts.amountCollectedMinor } : {},
  });
  return getOrder(auth.tenantId, order.id);
}

/**
 * Cancel a confirmed offline order before delivery. Pay on delivery: no money was taken. A
 * verified bank transfer: only the owner can cancel, after refunding the customer directly, and
 * records the refund reference. Reserved stock is released.
 */
export async function cancelConfirmedOrder(auth: Merchant, orderId: string, opts: { reason: string; refundReference?: string }) {
  const order = await getOrder(auth.tenantId, orderId);
  if (!order.paymentMethod || !order.payment || !["CONFIRMED", "IN_TRANSIT"].includes(order.status)) {
    throw httpError(409, "not_cancellable", "This order cannot be cancelled here.");
  }
  const paid = order.payment.status === "verified";
  if (paid && auth.role !== "owner") {
    throw httpError(403, "forbidden", "Only the store owner can cancel an order that was paid.");
  }
  if (paid && !(opts.refundReference && opts.refundReference.trim().length >= 3)) {
    throw httpError(400, "refund_reference_required", "Refund the customer, then enter the refund transfer reference.");
  }
  try {
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.order.updateMany({
        where: { id: order.id, tenantId: auth.tenantId, status: order.status },
        data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: `merchant: ${opts.reason}` },
      });
      if (cancelled.count !== 1) throw new Conflict();
      const payment = await tx.orderPayment.updateMany({
        where: { orderId: order.id, status: paid ? "verified" : "due_on_delivery" },
        data: paid ? { status: "refunded_offline", refundReference: opts.refundReference!.trim() } : { status: "void" },
      });
      if (payment.count !== 1) throw new Conflict();
      for (const item of order.items) {
        await releaseReservation(tx, { tenantId: order.tenantId, variantId: item.variantId, quantity: item.quantity, reference: order.id });
      }
      await appendOrderEvent(tx, {
        orderId: order.id,
        fromStatus: order.status as OrderStatus,
        toStatus: "CANCELLED",
        source: "merchant",
        payload: { reason: opts.reason, payment: paid ? "refunded_offline" : "void" },
      });
    });
  } catch (err) {
    if (err instanceof Conflict) throw httpError(409, "not_cancellable", "This order changed before it could be cancelled.");
    throw err;
  }
  await writeAudit({
    tenantId: auth.tenantId,
    actorKind: "merchant",
    actorId: auth.staffId,
    action: "order.cancelled",
    resource: "order",
    resourceId: order.id,
    metadata: { reason: opts.reason, payment: paid ? "refunded_offline" : "void" },
  });
  return getOrder(auth.tenantId, order.id);
}
