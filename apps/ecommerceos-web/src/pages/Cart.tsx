import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckoutError,
  currentPendingOrder,
  loadCart,
  loadCheckoutAvailability,
  placeOfflineOrder,
  placeOrderAndPay,
  updateCartItem,
  type PendingOrder,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Cart } from "../lib/types";

type Method = "pay_on_delivery" | "bank_transfer";

const METHOD_TEXT: Record<Method, { title: string; detail: string }> = {
  bank_transfer: {
    title: "Bank transfer to the store",
    detail: "After you place the order you'll see the store's bank details. The store confirms when your transfer arrives.",
  },
  pay_on_delivery: {
    title: "Pay on delivery",
    detail: "Pay the store when your order arrives.",
  },
};

export function CartPage() {
  const navigate = useNavigate();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onlinePayment, setOnlinePayment] = useState<boolean | null>(null);
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
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
      .then((data) => {
        setOnlinePayment(data.onlinePayment);
        const accepted: Method[] = [];
        if (data.methods.bankTransfer) accepted.push("bank_transfer");
        if (data.methods.payOnDelivery) accepted.push("pay_on_delivery");
        setMethods(accepted);
        setMethod(accepted[0] ?? null);
      })
      .catch(() => {
        setOnlinePayment(false);
        setMethods([]);
      });
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

  const offline = Boolean(methods && methods.length);
  const canOrder = offline ? Boolean(method) : onlinePayment === true;

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Cart</h1>
      {pending && !offline ? (
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
              <div className="table-wrap">
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
                          <button className="btn ghost" type="button" aria-label="One fewer" onClick={() => changeQuantity(item.id, item.quantity - 1)}>
                            −
                          </button>{" "}
                          {item.quantity}{" "}
                          <button className="btn ghost" type="button" aria-label="One more" onClick={() => changeQuantity(item.id, item.quantity + 1)}>
                            +
                          </button>
                        </td>
                        <td>{formatMoney(item.lineTotalMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                if (offline && method) {
                  const order = await placeOfflineOrder({ ...form, paymentMethod: method });
                  navigate(`/order/${order.id}`);
                  return;
                }
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
            {offline ? (
              <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="small" style={{ fontWeight: 650, marginBottom: "0.4rem" }}>
                  How would you like to pay?
                </legend>
                {methods!.map((m) => (
                  <label key={m} className="card" style={{ flexDirection: "row", alignItems: "flex-start", gap: "0.6rem", padding: "0.8rem" }}>
                    <input type="radio" name="paymentMethod" value={m} checked={method === m} onChange={() => setMethod(m)} />
                    <span>
                      <strong>{METHOD_TEXT[m].title}</strong>
                      <span className="muted small" style={{ display: "block", fontWeight: 400 }}>
                        {METHOD_TEXT[m].detail}
                      </span>
                    </span>
                  </label>
                ))}
                <p className="muted small">You pay the store directly. Nothing is charged on this website.</p>
              </fieldset>
            ) : methods !== null && onlinePayment === false ? (
              <p className="small" role="status">
                This store isn't taking orders online yet, so orders can't be completed here. No payment will be taken.
                Please contact the seller directly to buy.
              </p>
            ) : null}
            <label>
              Full name
              <input required value={form.buyerName} onChange={(e) => setForm({ ...form, buyerName: e.target.value })} />
            </label>
            <label>
              Phone
              <input required type="tel" value={form.buyerPhone} onChange={(e) => setForm({ ...form, buyerPhone: e.target.value })} />
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
            <button className="btn" disabled={busy || !canOrder}>
              {busy ? "Placing order…" : offline ? "Place order" : pending ? "Retry payment" : "Place order and pay"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
