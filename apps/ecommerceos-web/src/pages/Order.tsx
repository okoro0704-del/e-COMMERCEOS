import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadOrder, reportTransfer } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Order } from "../lib/types";

/** Plain-language status built only from what the API reports. */
function describeOrder(order: Order): { heading: string; detail: string } {
  if (order.status === "CANCELLED") {
    return order.paymentStatus === "refunded_offline"
      ? { heading: "Order cancelled", detail: "The store cancelled this order and refunded your payment." }
      : { heading: "Order cancelled", detail: "This order was cancelled. No payment is being held for it." };
  }
  switch (order.paymentStatus) {
    case "awaiting_transfer":
      return { heading: "Awaiting your transfer", detail: "Send the total to the store's account below, then tell the store." };
    case "customer_reported":
      return { heading: "Checking your payment", detail: "The store is checking that your transfer arrived. Your order is not confirmed yet." };
    case "rejected":
      return { heading: "Payment not found yet", detail: "The store could not find your transfer. Check the details and tell the store again." };
    case "verified":
      return { heading: "Payment confirmed", detail: "The store confirmed your transfer." };
    case "due_on_delivery":
      return { heading: "Order confirmed", detail: "Pay the store when your order arrives." };
    case "collected":
      return { heading: "Paid on delivery", detail: "The store recorded your payment on delivery." };
    case "simulated_not_paid":
      return { heading: "Not paid", detail: "This order was marked paid by a test payment system. No money was taken." };
    default:
      return { heading: "Awaiting payment", detail: "No payment has been taken for this order." };
  }
}

const FULFILMENT_TEXT: Record<string, string> = {
  not_started: "Not started",
  awaiting_dispatch: "Being prepared",
  in_transit: "On its way",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function OrderPage() {
  const { id } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ reference: "", payerName: "" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
  const payment = order.payment;
  const canReport = payment?.method === "bank_transfer" && ["awaiting_transfer", "rejected"].includes(payment.status) && order.status !== "CANCELLED";

  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <p className="eyebrow">Order {order.orderNumber}</p>
      <h1>{status.heading}</h1>
      <p className="muted">{status.detail}</p>
      <p>
        Total <strong>{formatMoney(order.totalMinor, order.currency)}</strong>
        {order.fulfilmentStatus ? <span className="muted small"> · {FULFILMENT_TEXT[order.fulfilmentStatus] ?? order.fulfilmentStatus}</span> : null}
      </p>

      {payment?.method === "bank_transfer" && payment.bankAccountNumber ? (
        <div className="order-detail stack">
          <p className="eyebrow">Pay to the store</p>
          <p className="small">
            {payment.bankName}
            <br />
            Account name: <strong>{payment.bankAccountName}</strong>
            <br />
            Account number: <strong>{payment.bankAccountNumber}</strong>
            <br />
            Amount: <strong>{formatMoney(payment.amountMinor, payment.currency)}</strong>
            <br />
            Use <strong>{order.orderNumber}</strong> as the transfer narration.
          </p>
          {order.paymentExpiresAt ? (
            <p className="muted small">Please pay by {new Date(order.paymentExpiresAt).toLocaleString()}, or the order is released.</p>
          ) : null}
        </div>
      ) : null}

      {payment?.status === "rejected" && payment.rejectedReason ? (
        <p className="banner small">The store said: {payment.rejectedReason}</p>
      ) : null}

      {canReport ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setFormError(null);
            try {
              setOrder(await reportTransfer(order.id, form));
            } catch (err) {
              setFormError(err instanceof Error ? err.message : "Could not send your payment details.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>I've sent the transfer</h2>
          <label>
            Transfer reference (from your bank)
            <input required minLength={3} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </label>
          <label>
            Name on the paying account
            <input required value={form.payerName} onChange={(e) => setForm({ ...form, payerName: e.target.value })} />
          </label>
          {formError ? <p className="small" style={{ color: "var(--eco-danger)" }}>{formError}</p> : null}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Tell the store"}
          </button>
          <p className="muted small">The store confirms your order once they see the money in their account.</p>
        </form>
      ) : null}

      {payment?.status === "customer_reported" ? (
        <p className="muted small" role="status">
          You reported reference {payment.customerReference}. We'll update this page when the store confirms it.
        </p>
      ) : null}
      <Link className="btn secondary" to="/">Return to storefront</Link>
    </div>
  );
}
