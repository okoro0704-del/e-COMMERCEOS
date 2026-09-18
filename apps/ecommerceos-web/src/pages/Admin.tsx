import { useState } from "react";
import {
  addDestinationOccupant,
  createMarketplaceSellerStore,
  createProduct,
  demoOrders,
  demoProducts,
  enableOnlineMarketplace,
  listDestinationOccupants,
  listMarketplaceSellers,
  loadMarketplaceAdminCatalog,
  merchantCatalog,
  merchantLogin,
  merchantOrders,
  updateMarketplaceSellerStatus,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type { MarketplaceProjectedProduct, MerchantSession, Order, Product, Storefront } from "../lib/types";

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
  const [occupants, setOccupants] = useState<NonNullable<Storefront["destinationOccupants"]>>([]);
  const [sellers, setSellers] = useState<NonNullable<Storefront["marketplaceSellers"]>>([]);
  const [unitForm, setUnitForm] = useState({
    unitCode: "",
    displayName: "",
    category: "",
    hours: "09:00–21:00",
    referencedSubdomain: "",
  });
  const [sellerForm, setSellerForm] = useState({ displayName: "", subdomain: "", city: "Lagos" });
  const [form, setForm] = useState({ title: "", description: "", sku: "", priceNaira: 25, stock: 10 });
  const [operator, setOperator] = useState(false);
  const [projected, setProjected] = useState<MarketplaceProjectedProduct[]>([]);
  const [createdNote, setCreatedNote] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<"overview" | "stores" | "catalogue">("overview");

  async function refresh(token: string) {
    const [nextProducts, nextOrders, nextOccupants, nextSellers] = await Promise.all([
      merchantCatalog(token).catch(() => []),
      merchantOrders(token).catch(() => []),
      listDestinationOccupants(token).catch(() => []),
      listMarketplaceSellers(token).catch(() => []),
    ]);
    setProducts(nextProducts);
    setOrders(nextOrders);
    setOccupants(nextOccupants ?? []);
    setSellers(nextSellers ?? []);
    try {
      const catalog = await loadMarketplaceAdminCatalog(token);
      setProjected(catalog.products);
      setOperator(true);
    } catch {
      setOperator(false);
      setProjected([]);
    }
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

      {session && !operator ? (
        <section className="card stack">
          <h2>Online Marketplace</h2>
          <p className="muted small">
            Enable operator mode on this application. Marketplace is a capability, not a separately purchased vertical.
          </p>
          <button
            className="btn secondary"
            type="button"
            onClick={async () => {
              await enableOnlineMarketplace(session.token);
              await refresh(session.token);
            }}
          >
            Enable Online Marketplace
          </button>
        </section>
      ) : null}

      {operator ? (
        <section className="card stack">
          <h2>Online Marketplace admin</h2>
          <nav className="tabs" aria-label="Operator sections">
            <button className={adminTab === "overview" ? "tab active" : "tab"} type="button" onClick={() => setAdminTab("overview")}>
              Overview
            </button>
            <button className={adminTab === "stores" ? "tab active" : "tab"} type="button" onClick={() => setAdminTab("stores")}>
              Stores
            </button>
            <button className={adminTab === "catalogue" ? "tab active" : "tab"} type="button" onClick={() => setAdminTab("catalogue")}>
              Catalogue
            </button>
          </nav>
          {adminTab === "overview" ? (
            <p className="muted small">
              {sellers.filter((s) => s.status === "active").length} participating stores. Seller catalogues stay on each
              Online Store. Connect existing store is same-organization only.
            </p>
          ) : null}
        </section>
      ) : null}

      {!operator ? (
      <>
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

      <section className="card stack">
        <h2>Destination directory</h2>
        <p className="muted small">
          Centres and malls reference occupant businesses. They do not copy another store’s catalog.
        </p>
        {session ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const next = await addDestinationOccupant(session.token, {
                unitCode: unitForm.unitCode,
                displayName: unitForm.displayName,
                category: unitForm.category || undefined,
                hours: unitForm.hours || undefined,
                referencedSubdomain: unitForm.referencedSubdomain || undefined,
              });
              setOccupants(next);
              setUnitForm({
                unitCode: "",
                displayName: "",
                category: "",
                hours: "09:00–21:00",
                referencedSubdomain: "",
              });
            }}
          >
            <div className="row">
              <label>
                Unit
                <input
                  required
                  value={unitForm.unitCode}
                  onChange={(e) => setUnitForm({ ...unitForm, unitCode: e.target.value })}
                />
              </label>
              <label>
                Occupant name
                <input
                  required
                  value={unitForm.displayName}
                  onChange={(e) => setUnitForm({ ...unitForm, displayName: e.target.value })}
                />
              </label>
            </div>
            <label>
              Linked store subdomain (optional)
              <input
                value={unitForm.referencedSubdomain}
                onChange={(e) => setUnitForm({ ...unitForm, referencedSubdomain: e.target.value })}
                placeholder="harbor-market"
              />
            </label>
            <button className="btn secondary" type="submit">Add occupant</button>
          </form>
        ) : (
          <p className="muted small">Sign in to add occupants.</p>
        )}
        <ul>
          {occupants.map((unit) => (
            <li key={unit.id}>
              {unit.unitCode} — {unit.displayName}
              {unit.referencedSubdomain ? ` → ${unit.referencedSubdomain}` : " (no linked app)"}
            </li>
          ))}
        </ul>
      </section>
      </>
      ) : null}

      {operator && session && (adminTab === "stores" || adminTab === "overview") ? (
        <section className="card stack">
          <h2>Add seller / Create Online Store</h2>
          <p className="muted small">
            Provisions a real Online Store through the existing distributor path. The seller keeps that application.
          </p>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const created = await createMarketplaceSellerStore(session.token, {
                displayName: sellerForm.displayName,
                subdomain: sellerForm.subdomain || undefined,
                city: sellerForm.city || undefined,
              });
              setSellers(await listMarketplaceSellers(session.token) ?? []);
              setCreatedNote(
                `${created.store.applicationId} ready. Public: ${created.store.publicUrl}. Manage with ${created.adminEmail}`,
              );
              setSellerForm({ displayName: "", subdomain: "", city: "Lagos" });
              const catalog = await loadMarketplaceAdminCatalog(session.token);
              setProjected(catalog.products);
            }}
          >
            <label>
              Business / store name
              <input
                required
                value={sellerForm.displayName}
                onChange={(e) => setSellerForm({ ...sellerForm, displayName: e.target.value })}
              />
            </label>
            <div className="row">
              <label>
                Subdomain (optional)
                <input
                  value={sellerForm.subdomain}
                  onChange={(e) => setSellerForm({ ...sellerForm, subdomain: e.target.value })}
                  placeholder="ade-fashion"
                />
              </label>
              <label>
                City
                <input
                  value={sellerForm.city}
                  onChange={(e) => setSellerForm({ ...sellerForm, city: e.target.value })}
                />
              </label>
            </div>
            <button className="btn" type="submit">Create Online Store</button>
          </form>
          {createdNote ? <p className="small">{createdNote}</p> : null}
          <p className="muted small">
            Connect existing store: same organization only. Cross-organization attach is not implemented.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Status</th>
                  <th>Relationship</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((seller) => (
                  <tr key={seller.id}>
                    <td>
                      <strong>{seller.displayName}</strong>
                      <div className="muted small">{seller.sellerSubdomain ?? "invited"}</div>
                    </td>
                    <td className="status">{seller.status}</td>
                    <td>
                      <div className="row">
                        {seller.publicUrl ? (
                          <a className="btn ghost" href={seller.publicUrl} target="_blank" rel="noreferrer">
                            View Store
                          </a>
                        ) : null}
                        {seller.createdByMarketplace && seller.adminUrl ? (
                          <a className="btn ghost" href={seller.adminUrl} target="_blank" rel="noreferrer">
                            Manage Store
                          </a>
                        ) : null}
                        {seller.status === "active" ? (
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={async () => {
                              await updateMarketplaceSellerStatus(session.token, seller.id, "suspended");
                              setSellers(await listMarketplaceSellers(session.token) ?? []);
                            }}
                          >
                            Suspend
                          </button>
                        ) : seller.status === "suspended" ? (
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={async () => {
                              await updateMarketplaceSellerStatus(session.token, seller.id, "active");
                              setSellers(await listMarketplaceSellers(session.token) ?? []);
                            }}
                          >
                            Reactivate
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {operator && adminTab === "catalogue" ? (
        <section className="card stack">
          <h2>Marketplace catalogue projection</h2>
          <p className="muted small">Live view of participating Online Store catalogues. No marketplace product copies.</p>
          {projected.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Seller</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody>
                  {projected.map((item) => (
                    <tr key={item.presentationId}>
                      <td>{item.title}</td>
                      <td>{item.sellerName}</td>
                      <td>{item.priceMinor != null ? formatMoney(item.priceMinor, item.currency) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No participating catalogue items yet.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
