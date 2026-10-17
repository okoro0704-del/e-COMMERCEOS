import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckoutError,
  currentPendingOrder,
  loadCart,
  loadCheckoutAvailability,
  placeOrderAndPay,
  updateCartItem,
  type PendingOrder,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Cart } from "../lib/types";

export function CartPage() {
  const navigate = useNavigate();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onlinePayment, setOnlinePayment] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOrder | null>(currentPendingOrder);
  const [form, setForm] = useState({
    buyerName: "",
    buyerPhone: "",
    addressLine1: "",
    city: "Lagos",
    country: "NG",
  });

  useEffect(() => {
    loadCart()
      .then((data) => setCart(data.cart))
      .catch((err: Error) => setLoadError(err.message));
    loadCheckoutAvailability()
      .then((data) => setOnlinePayment(data.onlinePayment))
      .catch(() => setOnlinePayment(false));
  }, []);

  if (loadError) {
    return (
      <div className="empty">
        <p>We couldn't load your cart. {loadError}</p>
        <Link to="/">Back to the store</Link>
      </div>
    );
  }
  if (!cart) return <p className="empty">Loading cart…</p>;

  const changeQuantity = (itemId: string, quantity: number) =>
    updateCartItem(itemId, quantity)
      .then(setCart)
      .catch((err: Error) => setError(err.message));

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Cart</h1>
      {pending ? (
        <div className="banner" role="status">
          Order <strong>{pending.orderNumber}</strong> is reserved until{" "}
          {new Date(pending.paymentExpiresAt).toLocaleTimeString()} but has not been paid. No money has been taken.
        </div>
      ) : null}
      {cart.items.length === 0 && !pending ? (
        <div className="empty">
          <p>Your cart is empty.</p>
          <Link to="/">Browse the catalog</Link>
        </div>
      ) : (
        <>
          {cart.items.length ? (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.productTitle}
                        <div className="small muted">{item.sku}</div>
                      </td>
                      <td>
                        <button className="btn ghost" onClick={() => changeQuantity(item.id, item.quantity - 1)}>
                          −
                        </button>{" "}
                        {item.quantity}{" "}
                        <button className="btn ghost" onClick={() => changeQuantity(item.id, item.quantity + 1)}>
                          +
                        </button>
                      </td>
                      <td>{formatMoney(item.lineTotalMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="price">Subtotal {formatMoney(cart.subtotalMinor)}</p>
            </>
          ) : null}
          <form
            className="card stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const result = await placeOrderAndPay(form);
                setPending(null);
                navigate(`/order/${result.orderId}`);
              } catch (err) {
                if (err instanceof CheckoutError) {
                  setError(err.message);
                  setPending(err.pendingOrder);
                  if (err.pendingOrder) {
                    loadCart()
                      .then((data) => setCart(data.cart))
                      .catch(() => undefined);
                  }
                } else {
                  setError(err instanceof Error ? err.message : "Checkout failed");
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>Checkout</h2>
            {onlinePayment === false ? (
              <p className="small" role="status">
                Online payment is not available for this store yet, so orders can't be completed here. No payment will
                be taken. Please contact the seller directly to buy.
              </p>
            ) : null}
            <label>
              Full name
              <input required value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} />
            </label>
            <label>
              Phone
              <input required value={form.buyerPhone} onChange={(e) => setForm({ ...form, buyerPhone: e.target.value })} />
            </label>
            <label>
              Delivery address
              <input required value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} />
            </label>
            <div className="row">
              <label>
                City
                <input required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              </label>
              <label>
                Country
                <input required value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
              </label>
            </div>
            {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
            <button className="btn" disabled={busy || onlinePayment !== true}>
              {busy ? "Processing…" : pending ? "Retry payment" : "Place order and pay"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
