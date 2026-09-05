import { Link, useParams, useSearchParams } from "react-router-dom";

export function OrderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const status = params.get("status") ?? "DISPATCH_PENDING";

  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <p className="eyebrow">Order placed</p>
      <h1>Payment held in escrow</h1>
      <p className="muted">
        Order <strong>{id}</strong> is now <span className="status">{status}</span>. A rider job is created when the
        store API is live. Delivery releases the merchant, rider, and platform splits.
      </p>
      <Link className="btn" to="/">Return to storefront</Link>
    </div>
  );
}
