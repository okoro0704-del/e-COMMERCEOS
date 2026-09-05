import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { loadCart, placeAndPay, updateCartItem } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Cart } from "../lib/types";

export function CartPage() {
  const navigate = useNavigate();
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    buyerName: "",
    buyerPhone: "",
    addressLine1: "",
    city: "Lagos",
    country: "NG",
  });

  useEffect(() => {
    loadCart().then((data) => setCart(data.cart));
  }, []);

  if (!cart) return <p className="empty">Loading cart…</p>;

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Cart</h1>
      {cart.items.length === 0 ? (
        <div className="empty">
          <p>Your cart is empty.</p>
          <Link to="/">Browse the catalog</Link>
        </div>
      ) : (
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
                    <button className="btn ghost" onClick={() => updateCartItem(item.id, item.quantity - 1).then(setCart)}>
                      −
                    </button>{" "}
                    {item.quantity}{" "}
                    <button className="btn ghost" onClick={() => updateCartItem(item.id, item.quantity + 1).then(setCart)}>
                      +
                    </button>
                  </td>
                  <td>{formatMoney(item.lineTotalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="price">Subtotal {formatMoney(cart.subtotalMinor)}</p>
          <form
            className="card stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const result = await placeAndPay(form);
                navigate(`/order/${result.orderId}?status=${result.status}`);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Checkout failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>Checkout</h2>
            <p className="muted small">Escrow is held on pay, then LogisticsOS is dispatched for delivery.</p>
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
            <button className="btn" disabled={busy}>{busy ? "Paying…" : "Pay and dispatch"}</button>
          </form>
        </>
      )}
    </div>
  );
}
