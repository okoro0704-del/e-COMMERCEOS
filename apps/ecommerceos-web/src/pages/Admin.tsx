import { useState } from "react";
import {
  createProduct,
  demoOrders,
  demoProducts,
  merchantCatalog,
  merchantLogin,
  merchantOrders,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type { MerchantSession, Order, Product } from "../lib/types";

const SESSION_KEY = "eco_merchant_session";

function readSession(): MerchantSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as MerchantSession) : null;
}

export function AdminPage() {
  const [session, setSession] = useState<MerchantSession | null>(readSession);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(!session);
  const [products, setProducts] = useState<Product[]>(demoProducts());
  const [orders, setOrders] = useState<Order[]>(demoOrders());
  const [form, setForm] = useState({ title: "", description: "", sku: "", priceNaira: 25, stock: 10 });

  async function refresh(token: string) {
    const [nextProducts, nextOrders] = await Promise.all([merchantCatalog(token), merchantOrders(token)]);
    setProducts(nextProducts);
    setOrders(nextOrders);
    setDemo(false);
  }

  return (
    <div className="stack">
      <h1>Merchant console</h1>
      {!session ? (
        <form
          className="card stack"
          style={{ maxWidth: 420 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const next = await merchantLogin(email, password);
              localStorage.setItem(SESSION_KEY, JSON.stringify(next));
              setSession(next);
              await refresh(next.token);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Login failed");
              setDemo(true);
            }
          }}
        >
          <p className="muted small">Sign in with a provisioned staff account. Without an API this console stays in preview mode.</p>
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
          <button className="btn">Sign in</button>
        </form>
      ) : (
        <div className="row">
          <p className="muted small">Signed in as {session.staff.displayName}</p>
          <button
            className="btn ghost"
            onClick={() => {
              localStorage.removeItem(SESSION_KEY);
              setSession(null);
              setDemo(true);
              setProducts(demoProducts());
              setOrders(demoOrders());
            }}
          >
            Sign out
          </button>
        </div>
      )}

      {demo ? (
        <div className="banner">Preview catalog and orders. Live data appears after a successful merchant login.</div>
      ) : null}

      <section className="card stack">
        <h2>Add product</h2>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!session) {
              setError("Sign in against a live API to create products.");
              return;
            }
            const created = await createProduct(session.token, form);
            setProducts((current) => [created, ...current]);
            setForm({ title: "", description: "", sku: "", priceNaira: 25, stock: 10 });
          }}
        >
          <label>
            Title
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </label>
          <label>
            Description
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <div className="row">
            <label>
              SKU
              <input required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </label>
            <label>
              Price (NGN)
              <input
                type="number"
                min={0}
                required
                value={form.priceNaira}
                onChange={(e) => setForm({ ...form, priceNaira: Number(e.target.value) })}
              />
            </label>
            <label>
              Stock
              <input
                type="number"
                min={0}
                required
                value={form.stock}
                onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
              />
            </label>
          </div>
          <button className="btn secondary" type="submit">Save product</button>
        </form>
      </section>

      <section className="card">
        <h2>Catalog</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>SKU</th>
              <th>Price</th>
              <th>Stock</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const variant = product.variants[0];
              return (
                <tr key={product.id}>
                  <td>{product.title}</td>
                  <td>{variant?.sku ?? "—"}</td>
                  <td>{variant ? formatMoney(variant.priceMinor) : "—"}</td>
                  <td>{variant?.available ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Orders</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Buyer</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.orderNumber}</td>
                <td>{order.buyerName}</td>
                <td className="status">{order.status}</td>
                <td>{formatMoney(order.totalMinor, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
