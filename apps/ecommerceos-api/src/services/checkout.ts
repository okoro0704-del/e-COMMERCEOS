import { assertTransition } from "@ecommerceos/shared";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { httpError } from "../lib/crypto.js";
import { appendOrderEvent, getOrder } from "./orders.js";
import { dispatchPaidOrder } from "./logistics/bridge.js";
import { getFundzManWalletProvider } from "./lifeos/container.js";
import { LocalFundzManAdapter } from "./lifeos/local-adapters.js";
import { storeInvoicePdf } from "./invoices.js";
import { notifyOrderStatus } from "./notifications.js";

export type OnlinePaymentAvailability =
  | { available: true }
  | { available: false; reason: "disabled" | "no_payment_provider" };

/**
 * Online payment is only offered when explicitly enabled and backed by a real provider.
 * The local adapter can never take money, so it never makes payment available.
 */
export function onlinePaymentAvailability(): OnlinePaymentAvailability {
  if (!config.protectedCheckoutEnabled) return { available: false, reason: "disabled" };
  if (getFundzManWalletProvider() instanceof LocalFundzManAdapter) {
    return { available: false, reason: "no_payment_provider" };
  }
  return { available: true };
}

export async function payOrder(opts: {
  tenantId: string;
  orderId: string;
  buyerTrustId: string;
}) {
  const order = await getOrder(opts.tenantId, opts.orderId);
  if (order.buyerTrustId !== opts.buyerTrustId) {
    throw httpError(403, "forbidden", "Order does not belong to this Trust ID");
  }
  if (order.status === "PAID_ESCROW" || order.status === "DISPATCH_PENDING") {
    return { order, replayed: true };
  }
  if (order.status !== "PENDING_PAYMENT") {
    throw httpError(409, "illegal_transition", `Cannot pay order in ${order.status}`);
  }
  if (order.paymentExpiresAt < new Date()) {
    throw httpError(409, "payment_expired", "Unpaid order window has expired");
  }
  if (!onlinePaymentAvailability().available) {
    throw httpError(
      503,
      "payments_unavailable",
      "Online payment is not available for this store yet. No payment has been taken.",
    );
  }

  const payment = await getFundzManWalletProvider().initiatePayment({
    payerTrustId: opts.buyerTrustId,
    payeeId: opts.tenantId,
    amount: order.totalMinor,
    currency: order.currency,
    reference: order.id,
    escrow: true,
    metadata: { orderId: order.id, orderNumber: order.orderNumber },
  });

  // Only a provider-reported hold with a payment reference moves the order forward.
  if (payment.status !== "escrow_held" || !payment.paymentId) {
    throw httpError(402, "payment_failed", payment.message ?? "Payment was not completed. No funds are held.");
  }

  assertTransition("PENDING_PAYMENT", "PAID_ESCROW");

  const invoice = await storeInvoicePdf({
    tenantId: order.tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    buyerName: order.buyerName,
    currency: order.currency,
    totalMinor: order.totalMinor,
    status: "PAID_ESCROW",
  });

  const paid = await prisma.$transaction(async (tx) => {
    const next = await tx.order.update({
      where: { id: order.id },
      data: {
        status: "PAID_ESCROW",
        escrowPaymentId: payment.paymentId,
        paidAt: new Date(),
        invoiceDriveKey: invoice.key,
        invoiceDriveUrl: invoice.url,
      },
      include: { items: true, events: true },
    });
    await appendOrderEvent(tx, {
      orderId: order.id,
      fromStatus: "PENDING_PAYMENT",
      toStatus: "PAID_ESCROW",
      source: "fundzman.pay",
      payload: { paymentId: payment.paymentId, status: payment.status },
    });
    return next;
  });

  await notifyOrderStatus({
    tenantId: order.tenantId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    buyerTrustId: order.buyerTrustId,
    buyerPhone: order.buyerPhone,
    status: "PAID_ESCROW",
    message: "Your order {orderNumber} is paid and being prepared for dispatch.",
  });

  const dispatched = await dispatchPaidOrder(paid.id);
  return { order: dispatched, payment, replayed: false };
}
