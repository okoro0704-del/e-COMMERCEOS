import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadOrder } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Order } from "../lib/types";

/** Plain-language status built only from what the API reports. */
function describeOrder(order: Order): { heading: string; detail: string } {
  if (order.status === "CANCELLED") {
    return { heading: "Order cancelled", detail: "This order was cancelled. No payment is being held for it." };
  }
  if (order.paymentStatus === "simulated_not_paid") {
    return {
      heading: "Not paid",
      detail: "This order was marked paid by a test payment system. No money was taken.",
    };
  }
  if (order.paymentStatus === "unpaid" || order.status === "PENDING_PAYMENT") {
    return { heading: "Awaiting payment", detail: "No payment has been taken for this order." };
  }
  return {
    heading: "Payment reported, not yet confirmed",
    detail: "The payment provider reported this payment. It has not been independently confirmed.",
  };
}

export function OrderPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    loadOrder(id)
      .then(setOrder)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  if (error) {
    return (
      <div className="card stack" style={{ maxWidth: 560 }}>
        <h1>We couldn't load this order</h1>
        <p className="muted">{error}</p>
        <Link className="btn" to="/">Return to storefront</Link>
      </div>
    );
  }
  if (!order) return <p className="empty">Loading order…</p>;

  const status = describeOrder(order);
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <p className="eyebrow">Order {order.orderNumber}</p>
      <h1>{status.heading}</h1>
      <p className="muted">{status.detail}</p>
      <p>
        Total <strong>{formatMoney(order.totalMinor, order.currency)}</strong>
      </p>
      <Link className="btn" to="/">Return to storefront</Link>
    </div>
  );
}
