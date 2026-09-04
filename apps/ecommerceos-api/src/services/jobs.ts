import { getLocalJobDispatcher } from "./register-primitives.js";
import { cancelUnpaidOrder, sweepUnpaidOrders } from "./orders.js";

export function registerJobHandlers() {
  const jobs = getLocalJobDispatcher();
  jobs?.registerHandler("cancel-unpaid-order", async (payload) => {
    const orderId = String(payload.orderId ?? "");
    if (!orderId) return;
    await cancelUnpaidOrder(orderId, "unpaid_timeout");
  });
  jobs?.registerHandler("sweep-unpaid-orders", async () => {
    await sweepUnpaidOrders();
  });
}
