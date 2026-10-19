import { Fragment, useEffect, useState } from "react";
import {
  ApiError,
  addDestinationOccupant,
  adjustStock,
  advanceOrder,
  loadPaymentSettings,
  rejectOrderPayment,
  savePaymentSettings,
  verifyOrderPayment,
  cancelMerchantOrder,
  loadBranding,
  lowStock,
  merchantOrder,
  publicMediaUrl,
  saveBranding,
  changeMerchantPassword,
  exchangeAdminHandoff,
  merchantLogout,
  createBusinessPublication,
  createMarketplaceSellerStore,
  createProduct,
  demoOrders,
  demoProducts,
  enableOnlineMarketplace,
  initializeDigiPedia,
  loadDigiPedia,
  listDestinationOccupants,
  listMarketplaceSellers,
  loadMarketplaceAdminCatalog,
  loadStoreActivation,
  merchantCatalog,
  merchantLogin,
  merchantOrders,
  previewDigiPedia,
  publishDigiPedia,
  saveDigiPediaDraft,
  submitStoreActivation,
  updateMarketplaceSellerStatus,
  updateProduct,
  updateVariantPrice,
  uploadMedia,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type {
  InventoryRow,
  MarketplaceProjectedProduct,
  PaymentSettings,
  MerchantSession,
  Order,
  Product,
  StoreActivation,
  StoreBranding,
  Storefront,
} from "../lib/types";

const SESSION_KEY = "eco_merchant_session";

/** Never present an order as paid unless the API reports a verified payment. */
function paymentLabel(order: Order) {
  if (order.paymentVerified) return "Paid (confirmed by the store)";
  if (order.paymentStatus === "simulated_not_paid") return "Not paid (test payment)";
  if (order.paymentStatus === "provider_reported") return "Reported, not confirmed";
  if (order.paymentStatus === "unpaid") return "Not paid";
  return "—";
}

function readSession(): MerchantSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as MerchantSession) : null;
  } catch {
    return null;
  }
}

function saveSession(session: MerchantSession | null) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* session still lives in memory for this page */
  }
}

/** A Portal handoff arrives as #handoff=<code>; take it once and remove it from the address bar. */
function takeHandoffCode(): string | null {
  const match = window.location.hash.match(/[#&]handoff=([^&]+)/);
  if (!match) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(match[1]!);
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
  const [pubForm, setPubForm] = useState<{
    type: "PHOTO" | "VIDEO";
    title: string;
    caption: string;
    relatedProductId: string;
    file: File | null;
  }>({ type: "PHOTO", title: "", caption: "", relatedProductId: "", file: null });
  const [pubBusy, setPubBusy] = useState(false);
  const [pubNote, setPubNote] = useState<string | null>(null);
  const [operator, setOperator] = useState(false);
  const [projected, setProjected] = useState<MarketplaceProjectedProduct[]>([]);
  const [createdNote, setCreatedNote] = useState<string | null>(null);
  const [adminTab, setAdminTab] = useState<"overview" | "stores" | "catalogue">("overview");
  const [resetGrant, setResetGrant] = useState<string | null>(null);
  const [pwForm, setPwForm] = useState({ current: "", next: "" });
  const [pwNote, setPwNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    const code = takeHandoffCode();
    if (code) {
      exchangeAdminHandoff(code)
        .then(async (next) => {
          const { resetGrant: grant, ...rest } = next;
          saveSession(rest);
          setSession(rest);
          setResetGrant(grant);
          await refresh(rest.token);
        })
        .catch((err: Error) => setError(err.message));
      return;
    }
    const existing = readSession();
    if (existing && !existing.mustChangePassword) void refresh(existing.token);
  }, []);

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
              saveSession(next);
              setSession(next);
              if (!next.mustChangePassword) await refresh(next.token);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Login failed");
              setDemo(true);
            }
          }}
        >
          <p className="muted small">
            Sign in to this store with your staff email and password, or open the admin from LifeOS Portal.
          </p>
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
            onClick={async () => {
              await merchantLogout(session.token);
              saveSession(null);
              setSession(null);
              setResetGrant(null);
              setDemo(true);
              setProducts(demoProducts());
              setOrders(demoOrders());
            }}
          >
            Sign out
          </button>
        </div>
      )}

      {session ? (
        <section className="card stack" style={{ maxWidth: 480 }}>
          <h2>
            {resetGrant || session.mustChangePassword || session.passwordSet === false
              ? "Set a new password"
              : "Change password"}
          </h2>
          {session.mustChangePassword ? (
            <p className="small" role="status">
              This password was set for you by someone else. Choose your own to continue.
            </p>
          ) : null}
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setPwNote(null);
              setError(null);
              try {
                const result = await changeMerchantPassword(session.token, {
                  newPassword: pwForm.next,
                  currentPassword: resetGrant || session.passwordSet === false ? undefined : pwForm.current,
                  resetGrant: resetGrant ?? undefined,
                });
                const next = { ...session, passwordSet: result.passwordSet, mustChangePassword: result.mustChangePassword };
                saveSession(next);
                setSession(next);
                setResetGrant(null);
                setPwForm({ current: "", next: "" });
                setPwNote("Password saved. Other signed-in devices were signed out.");
                await refresh(next.token);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not save the password");
              }
            }}
          >
            {resetGrant || session.passwordSet === false ? null : (
              <label>
                Current password
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={pwForm.current}
                  onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
                />
              </label>
            )}
            <label>
              New password (at least 12 characters)
              <input
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={pwForm.next}
                onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
              />
            </label>
            {pwNote ? <p className="muted small" role="status">{pwNote}</p> : null}
            <button className="btn secondary" type="submit">Save password</button>
          </form>
        </section>
      ) : null}

      {demo ? (
        <div className="banner">Preview catalog and orders. Live data appears after a successful merchant login.</div>
      ) : null}

      {session && !demo ? <ActivationAdmin token={session.token} isOwner={session.staff.role === "owner"} /> : null}

      {session && !demo && ["owner", "admin"].includes(session.staff.role) ? <BrandingAdmin token={session.token} /> : null}

      {session && !demo && ["owner", "admin"].includes(session.staff.role) ? (
        <PaymentSettingsAdmin token={session.token} isOwner={session.staff.role === "owner"} />
      ) : null}

      {session && !demo ? <DigiPediaAdmin token={session.token} /> : null}

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

      <section className="card stack">
        <h2>Publish photo / video</h2>
        <p className="muted small">Share store media on your public catalogue and LifeOS feed.</p>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!session) {
              setError("Sign in against a live API to publish media.");
              return;
            }
            if (!pubForm.file) {
              setError("Choose a photo or video file to upload.");
              return;
            }
            setPubBusy(true);
            setError(null);
            setPubNote(null);
            try {
              const buffer = await pubForm.file.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              let binary = "";
              for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
              const bodyBase64 = btoa(binary);
              const contentType =
                pubForm.file.type ||
                (pubForm.type === "VIDEO" ? "video/mp4" : "image/jpeg");
              const uploaded = await uploadMedia(session.token, {
                filename: pubForm.file.name || `${pubForm.type.toLowerCase()}-${Date.now()}`,
                contentType,
                bodyBase64,
                productId: pubForm.relatedProductId || undefined,
              });
              const created = await createBusinessPublication(session.token, {
                type: pubForm.type,
                title: pubForm.title || undefined,
                caption: pubForm.caption || undefined,
                mediaAssetIds: [uploaded.id],
                relatedProductId: pubForm.relatedProductId || null,
                status: "published",
              });
              setPubNote(`Published · /p/${String(created.id ?? "")}`);
              setPubForm({ type: "PHOTO", title: "", caption: "", relatedProductId: "", file: null });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not publish media");
            } finally {
              setPubBusy(false);
            }
          }}
        >
          <label>
            Type
            <select
              value={pubForm.type}
              onChange={(e) =>
                setPubForm({ ...pubForm, type: e.target.value === "VIDEO" ? "VIDEO" : "PHOTO" })
              }
            >
              <option value="PHOTO">PHOTO</option>
              <option value="VIDEO">VIDEO</option>
            </select>
          </label>
          <label>
            Title
            <input value={pubForm.title} onChange={(e) => setPubForm({ ...pubForm, title: e.target.value })} />
          </label>
          <label>
            Caption
            <textarea
              value={pubForm.caption}
              onChange={(e) => setPubForm({ ...pubForm, caption: e.target.value })}
            />
          </label>
          <label>
            Related product (optional)
            <select
              value={pubForm.relatedProductId}
              onChange={(e) => setPubForm({ ...pubForm, relatedProductId: e.target.value })}
            >
              <option value="">None</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            File
            <input
              type="file"
              accept={pubForm.type === "VIDEO" ? "video/*" : "image/*"}
              required
              onChange={(e) => setPubForm({ ...pubForm, file: e.target.files?.[0] ?? null })}
            />
          </label>
          {pubNote ? <p className="muted small" role="status">{pubNote}</p> : null}
          <button className="btn" type="submit" disabled={pubBusy}>
            {pubBusy ? "Publishing…" : "Publish"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Catalog</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const variant = product.variants[0];
                return (
                  <Fragment key={product.id}>
                    <tr>
                      <td>{product.title}</td>
                      <td>{variant?.sku ?? "—"}</td>
                      <td>{variant ? formatMoney(variant.priceMinor) : "—"}</td>
                      <td>{variant?.available ?? 0}</td>
                      <td className="status">{product.status}</td>
                      <td>
                        {session && !demo ? (
                          <button
                            className="btn ghost"
                            type="button"
                            onClick={() => setEditing(editing === product.id ? null : product.id)}
                          >
                            {editing === product.id ? "Close" : "Edit"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {session && editing === product.id ? (
                      <tr>
                        <td colSpan={6}>
                          <ProductEditor
                            token={session.token}
                            product={product}
                            onSaved={async () => {
                              setEditing(null);
                              setProducts(await merchantCatalog(session.token));
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {session && !demo ? (
        <OrdersAdmin
          token={session.token}
          orders={orders}
          role={session.staff.role}
          onChanged={async () => setOrders(await merchantOrders(session.token))}
        />
      ) : (
        <section className="card">
          <h2>Orders</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Buyer</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>{order.orderNumber}</td>
                    <td>{order.buyerName}</td>
                    <td className="status">{order.status}</td>
                    <td>{paymentLabel(order)}</td>
                    <td>{formatMoney(order.totalMinor, order.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {session && !demo ? <LowStockAdmin token={session.token} products={products} /> : null}

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
                `${created.store.applicationId} ready. Public: ${created.store.publicUrl}. Manage with ${created.adminEmail}${created.temporaryAdminPassword ? ` / ${created.temporaryAdminPassword}` : ""}`,
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

type DigiPediaDraft = {
  title: string;
  summary: string;
  sections: Array<{ sectionId: string; heading: string; body: string; sourceReferences: unknown[] }>;
  sourceReferences: unknown[];
  relatedEntityReferences: unknown[];
};

type DigiPediaManage = {
  intro: string;
  status: string;
  published: boolean;
  hasDraftChanges?: boolean;
  draftVersion: number;
  entity: { displayName: string; kind: string };
  entry: { draft: DigiPediaDraft; publishedRevisionId: string | null } | null;
  revisions?: Array<{ id: string; revisionNumber: number; publishedAt: string }>;
};

function DigiPediaAdmin({ token }: { token: string }) {
  const [data, setData] = useState<DigiPediaManage | null>(null);
  const [draft, setDraft] = useState<DigiPediaDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    void loadDigiPedia(token)
      .then((row) => {
        const next = row as DigiPediaManage;
        setData(next);
        setDraft(next.entry ? structuredClone(next.entry.draft) : null);
      })
      .catch((err) => {
        // A separate service being down is not something the merchant did: show a calm notice.
        if (err instanceof ApiError && (err.status === 503 || err.status === 0)) {
          setUnavailable(err.status === 0 ? "DigiPedia is temporarily unavailable. Please try again later." : err.message);
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load DigiPedia.");
      });
  }, [token]);

  if (unavailable) {
    return (
      <section className="card stack">
        <h2>DigiPedia</h2>
        <p className="muted small" role="status">
          {unavailable}
        </p>
      </section>
    );
  }

  async function run(action: string, work: () => Promise<void>) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update DigiPedia.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="card stack">
      <h2>DigiPedia</h2>
      {data ? <p className="muted small">{data.intro}</p> : null}
      {data ? (
        <p className="muted small">
          {data.entity.displayName} ·{" "}
          {data.status === "none"
            ? "No entry yet"
            : data.hasDraftChanges
              ? "Published · Draft changes"
              : data.published
                ? "Published"
                : "Draft"}
        </p>
      ) : null}
      {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
      {notice ? <p className="muted small" role="status">{notice}</p> : null}
      {data && !data.entry ? (
        <button
          className="btn"
          type="button"
          disabled={Boolean(busy)}
          onClick={() =>
            void run("initialize", async () => {
              const next = (await initializeDigiPedia(token)) as DigiPediaManage;
              setData(next);
              setDraft(next.entry ? structuredClone(next.entry.draft) : null);
            })
          }
        >
          Start DigiPedia
        </button>
      ) : null}
      {draft && data?.entry ? (
        <>
          <label>
            Title
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            Summary
            <textarea rows={3} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
          </label>
          {draft.sections.map((section, index) => (
            <div className="stack" key={section.sectionId}>
              <label>
                {section.heading || "Section"}
                <input
                  value={section.heading}
                  onChange={(e) => {
                    const sections = [...draft.sections];
                    sections[index] = { ...section, heading: e.target.value };
                    setDraft({ ...draft, sections });
                  }}
                />
              </label>
              <label>
                Body
                <textarea
                  rows={5}
                  value={section.body}
                  onChange={(e) => {
                    const sections = [...draft.sections];
                    sections[index] = { ...section, body: e.target.value };
                    setDraft({ ...draft, sections });
                  }}
                />
              </label>
              <button
                className="btn ghost"
                type="button"
                onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, i) => i !== index) })}
              >
                Remove section
              </button>
            </div>
          ))}
          <button
            className="btn ghost"
            type="button"
            onClick={() =>
              setDraft({
                ...draft,
                sections: [
                  ...draft.sections,
                  { sectionId: `section-${draft.sections.length + 1}`, heading: "About", body: "", sourceReferences: [] },
                ],
              })
            }
          >
            Add section
          </button>
          <div className="row">
            <button
              className="btn"
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("save", async () => {
                  const next = (await saveDigiPediaDraft(token, data.draftVersion, draft)) as DigiPediaManage;
                  setData(next);
                  setDraft(next.entry ? structuredClone(next.entry.draft) : draft);
                  setNotice("Draft saved. The public page is unchanged.");
                })
              }
            >
              Save draft
            </button>
            <button
              className="btn"
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("preview", async () => {
                  setPreviewHtml(await previewDigiPedia(token));
                })
              }
            >
              Preview
            </button>
            <button
              className="btn secondary"
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("publish", async () => {
                  const next = (await publishDigiPedia(token, data.draftVersion, draft)) as DigiPediaManage;
                  setData(next);
                  setDraft(next.entry ? structuredClone(next.entry.draft) : draft);
                  setNotice("Published. The public DigiPedia now shows this revision.");
                })
              }
            >
              Publish
            </button>
          </div>
          {data.revisions?.length ? (
            <div>
              <h3>Revision history</h3>
              {data.revisions.map((rev) => (
                <p className="muted small" key={rev.id}>
                  Revision {rev.revisionNumber} · {new Date(rev.publishedAt).toLocaleString()} · Published
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {previewHtml ? (
        <div role="dialog" aria-labelledby="eco-digipedia-preview">
          <div className="row">
            <h3 id="eco-digipedia-preview">Preview</h3>
            <button className="btn ghost" type="button" onClick={() => setPreviewHtml(null)}>
              Close
            </button>
          </div>
          <iframe title="DigiPedia draft preview" srcDoc={previewHtml} style={{ width: "100%", minHeight: "60vh", border: 0 }} />
        </div>
      ) : null}
    </section>
  );
}

const ACTIVATION_STATUS_TEXT: Record<string, string> = {
  payment_submitted: "Awaiting verification",
  verified: "Verified",
  rejected: "Not verified",
  reversed: "Reversed",
};

const PLAN_LABEL: Record<string, string> = { standard: "Standard brand setup", early_adopter: "Early-adopter setup" };

/** Paid brand setup: the owner pays outside the app, then submits the transfer for Digiconomy to verify. */
function ActivationAdmin({ token, isOwner }: { token: string; isOwner: boolean }) {
  const [data, setData] = useState<StoreActivation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ plan: "standard", paymentReference: "", payerName: "", paidAt: "", partnerCode: "" });

  const load = () =>
    loadStoreActivation(token)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load the setup status."));

  useEffect(() => {
    void load();
  }, [token]);

  if (!data) {
    return error ? (
      <section className="card stack">
        <h2>Store activation</h2>
        <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p>
      </section>
    ) : null;
  }

  const awaiting = data.submissions.find((s) => s.status === "payment_submitted");
  const offers = data.offers.filter((o) => o.available);
  const chosen = offers.find((o) => o.plan === form.plan) ?? offers[0];
  const canSubmit = isOwner && data.status !== "active" && !awaiting && (data.required || data.status === "pending");

  return (
    <section className="card stack">
      <h2>Store activation</h2>
      <p className="small" role="status">
        {data.status === "active"
          ? "Your setup payment is verified. Your store is open to customers."
          : data.status === "pending"
            ? "Your store is closed to customers until Digiconomy verifies your brand setup payment. You can add products meanwhile."
            : "This store was created before paid setup and stays open. No setup payment is due."}
      </p>
      {awaiting ? (
        <p className="banner small">
          Payment reference {awaiting.paymentReference} submitted on {new Date(awaiting.submittedAt).toLocaleDateString()}.
          Digiconomy will verify it and open your store.
        </p>
      ) : null}

      {canSubmit && chosen ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            setNotice(null);
            try {
              await submitStoreActivation(token, {
                plan: chosen.plan,
                paymentReference: form.paymentReference,
                payerName: form.payerName,
                paidAt: form.paidAt ? new Date(form.paidAt).toISOString() : undefined,
                partnerCode: form.partnerCode.trim() || undefined,
              });
              setForm({ plan: "standard", paymentReference: "", payerName: "", paidAt: "", partnerCode: "" });
              setNotice("Submitted. Digiconomy will verify your payment.");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not submit the payment.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="price">
            {PLAN_LABEL[chosen.plan]}: {formatMoney(chosen.amountMinor, chosen.currency)} one-time
          </p>
          <p className="muted small">
            {data.paymentInstructions ||
              "Pay the setup fee by bank transfer using the details Digiconomy gave you, then enter the transfer reference below. No card payment is taken in this app."}
          </p>
          {offers.length > 1 ? (
            <label>
              Setup price
              <select value={chosen.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                {offers.map((o) => (
                  <option key={o.plan} value={o.plan}>
                    {PLAN_LABEL[o.plan]} — {formatMoney(o.amountMinor, o.currency)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="row">
            <label>
              Transfer reference
              <input required value={form.paymentReference} onChange={(e) => setForm({ ...form, paymentReference: e.target.value })} />
            </label>
            <label>
              Paid by (name on the transfer)
              <input required value={form.payerName} onChange={(e) => setForm({ ...form, payerName: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <label>
              Date paid
              <input type="date" value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} />
            </label>
            <label>
              Referral code (optional)
              <input value={form.partnerCode} onChange={(e) => setForm({ ...form, partnerCode: e.target.value })} />
            </label>
          </div>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Submitting…" : "Submit payment for verification"}
          </button>
        </form>
      ) : null}
      {!isOwner && data.status !== "active" ? (
        <p className="muted small">Only the store owner can submit the setup payment.</p>
      ) : null}
      {notice ? <p className="muted small" role="status">{notice}</p> : null}
      {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}

      {data.submissions.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Setup</th>
                <th>Reference</th>
                <th>Referral</th>
                <th>Draft documents</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.submissions.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.submittedAt).toLocaleDateString()}</td>
                  <td>{formatMoney(s.amountMinor, s.currency)}</td>
                  <td>{s.paymentReference}</td>
                  <td>{s.partner?.code ?? "—"}</td>
                  <td>
                    {(s.documents ?? []).map((d) => (
                      <div key={d.number} className="muted small">
                        {d.kind === "invoice" ? "Invoice" : "Receipt"} {d.number}
                        {d.status === "void" ? " (void)" : ""}
                      </div>
                    ))}
                  </td>
                  <td>
                    <span className="status">{ACTIVATION_STATUS_TEXT[s.status] ?? s.status}</span>
                    {s.rejectedReason || s.reversedReason ? (
                      <div className="muted small">{s.rejectedReason ?? s.reversedReason}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/** Edit a product's title, visibility, price and stock with the existing catalogue endpoints. */
function ProductEditor({ token, product, onSaved }: { token: string; product: Product; onSaved: () => Promise<void> }) {
  const variant = product.variants[0];
  const [form, setForm] = useState({
    title: product.title,
    status: product.status,
    priceNaira: variant ? variant.priceMinor / 100 : 0,
    stockDelta: 0,
    reason: "restock",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          if (form.title !== product.title || form.status !== product.status) {
            await updateProduct(token, product.id, { title: form.title, status: form.status });
          }
          const priceMinor = Math.round(form.priceNaira * 100);
          if (variant && priceMinor !== variant.priceMinor) await updateVariantPrice(token, variant.id, priceMinor);
          if (variant && form.stockDelta !== 0) await adjustStock(token, variant.id, form.stockDelta, form.reason);
          await onSaved();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not save the product.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row">
        <label>
          Title
          <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label>
          Visibility
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="active">Active (on the storefront)</option>
            <option value="draft">Draft (hidden)</option>
          </select>
        </label>
      </div>
      {variant ? (
        <div className="row">
          <label>
            Price (NGN)
            <input
              type="number"
              min={0}
              step="0.01"
              required
              value={form.priceNaira}
              onChange={(e) => setForm({ ...form, priceNaira: Number(e.target.value) })}
            />
          </label>
          <label>
            Stock change (now {variant.available})
            <input type="number" value={form.stockDelta} onChange={(e) => setForm({ ...form, stockDelta: Number(e.target.value) })} />
          </label>
          <label>
            Reason
            <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
              <option value="restock">Restock</option>
              <option value="correction">Stock count correction</option>
              <option value="damaged">Damaged or lost</option>
            </select>
          </label>
        </div>
      ) : null}
      {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
      <div className="row">
        <button className="btn secondary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/** Storefront branding: name, tagline, colour and logo (owners and admins). */
function BrandingAdmin({ token }: { token: string }) {
  const [branding, setBranding] = useState<StoreBranding | null>(null);
  const [form, setForm] = useState({ storeName: "", tagline: "", primaryColor: "#1D4ED8" });
  const [logoAssetId, setLogoAssetId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadBranding(token)
      .then((b) => {
        setBranding(b);
        setForm({ storeName: b.storeName, tagline: b.tagline, primaryColor: b.primaryColor });
        setLogoAssetId(b.logoAssetId);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load branding."));
  }, [token]);

  if (!branding) return error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null;

  return (
    <section className="card stack">
      <h2>Store branding</h2>
      <div className="hero" style={{ background: `linear-gradient(135deg, ${form.primaryColor} 0%, #12343a 100%)`, marginBottom: 0 }}>
        {logoAssetId ? <img className="store-logo" src={publicMediaUrl(logoAssetId)} alt="" /> : null}
        <h3>{form.storeName || "Your store"}</h3>
        {form.tagline ? <p className="tagline">{form.tagline}</p> : null}
      </div>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setNote(null);
          try {
            const saved = await saveBranding(token, { ...form, logoAssetId });
            setBranding(saved);
            setNote("Branding saved. Your storefront shows it now.");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save branding.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row">
          <label>
            Store name
            <input required maxLength={80} value={form.storeName} onChange={(e) => setForm({ ...form, storeName: e.target.value })} />
          </label>
          <label>
            Brand colour
            <input className="swatch" type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} />
          </label>
        </div>
        <label>
          Tagline
          <input maxLength={160} value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} />
        </label>
        <label>
          Logo (square image)
          <input
            type="file"
            accept="image/*"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setError(null);
              try {
                const bodyBase64 = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
                  reader.onerror = () => reject(new Error("Could not read the image."));
                  reader.readAsDataURL(file);
                });
                const uploaded = await uploadMedia(token, { filename: file.name, contentType: file.type || "image/png", bodyBase64 });
                setLogoAssetId(uploaded.id);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not upload the logo.");
              }
            }}
          />
        </label>
        {note ? <p className="muted small" role="status">{note}</p> : null}
        {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
        <button className="btn secondary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save branding"}
        </button>
      </form>
    </section>
  );
}

const ORDER_FILTERS: Array<[string, string]> = [
  ["", "All"],
  ["PENDING_PAYMENT", "Awaiting payment"],
  ["CONFIRMED", "To prepare"],
  ["IN_TRANSIT", "On the way"],
  ["DELIVERED", "Delivered"],
  ["CANCELLED", "Cancelled"],
];

const PAYMENT_TEXT: Record<string, string> = {
  awaiting_transfer: "Awaiting transfer",
  customer_reported: "Customer says paid: check your account",
  verified: "Transfer verified",
  rejected: "Report rejected",
  due_on_delivery: "Pay on delivery",
  collected: "Cash collected",
  void: "No payment",
  refunded_offline: "Refunded",
};

/**
 * Orders: filter by status, open an order, and act on it. Recording money (verifying a transfer,
 * cash collected on delivery) is for owners and admins; any staff can mark an order dispatched.
 */
function OrdersAdmin({
  token,
  orders,
  role,
  onChanged,
}: {
  token: string;
  orders: Order[];
  role: string;
  onChanged: () => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Order | null>(null);
  const [input, setInput] = useState({ reason: "", amount: "", reference: "", refund: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The order being worked on stays in view after an action moves it to another status.
  const visible = filter ? orders.filter((o) => o.status === filter || o.id === open?.id) : orders;
  const canRecordMoney = role === "owner" || role === "admin";

  async function act(work: () => Promise<Order>) {
    setBusy(true);
    setError(null);
    try {
      setOpen(await work());
      setInput({ reason: "", amount: "", reference: "", refund: "" });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const minor = (naira: string) => Math.round(Number(naira) * 100);

  return (
    <section className="card stack">
      <h2>Orders</h2>
      <nav className="tabs" aria-label="Order status">
        {ORDER_FILTERS.map(([value, label]) => (
          <button key={value || "all"} type="button" className={filter === value ? "tab active" : "tab"} onClick={() => setFilter(value)}>
            {label} ({value ? orders.filter((o) => o.status === value).length : orders.length})
          </button>
        ))}
      </nav>
      {visible.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Buyer</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((order) => (
                <Fragment key={order.id}>
                  <tr>
                    <td>{order.orderNumber}</td>
                    <td>{order.buyerName}</td>
                    <td className="status">{order.status}</td>
                    <td>{order.payment ? PAYMENT_TEXT[order.payment.status] ?? order.payment.status : paymentLabel(order)}</td>
                    <td>{formatMoney(order.totalMinor, order.currency)}</td>
                    <td>
                      <button
                        className="btn ghost"
                        type="button"
                        onClick={async () => {
                          setError(null);
                          setInput({ reason: "", amount: "", reference: "", refund: "" });
                          if (open?.id === order.id) return setOpen(null);
                          try {
                            setOpen(await merchantOrder(token, order.id));
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "Could not open the order.");
                          }
                        }}
                      >
                        {open?.id === order.id ? "Close" : "View"}
                      </button>
                    </td>
                  </tr>
                  {open?.id === order.id ? (
                    <tr>
                      <td colSpan={6}>
                        <OrderDetail
                          order={open}
                          busy={busy}
                          canRecordMoney={canRecordMoney}
                          isOwner={role === "owner"}
                          input={input}
                          setInput={setInput}
                          verify={() => act(() => verifyOrderPayment(token, open.id, minor(input.amount), input.reference || undefined))}
                          reject={() => act(() => rejectOrderPayment(token, open.id, input.reason))}
                          advance={(action, collected) => act(() => advanceOrder(token, open.id, action, collected))}
                          cancel={() => act(() => cancelMerchantOrder(token, open.id, input.reason, input.refund || undefined))}
                          minor={minor}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No orders in this view.</p>
      )}
      {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
    </section>
  );
}

type DetailInput = { reason: string; amount: string; reference: string; refund: string };

function OrderDetail({
  order,
  busy,
  canRecordMoney,
  isOwner,
  input,
  setInput,
  verify,
  reject,
  advance,
  cancel,
  minor,
}: {
  order: Order;
  busy: boolean;
  canRecordMoney: boolean;
  isOwner: boolean;
  input: DetailInput;
  setInput: (next: DetailInput) => void;
  verify: () => void;
  reject: () => void;
  advance: (action: "dispatch" | "deliver" | "complete", collected?: number) => void;
  cancel: () => void;
  minor: (naira: string) => number;
}) {
  const payment = order.payment;
  const transfer = payment?.method === "bank_transfer";
  const awaitingTransfer = transfer && order.status === "PENDING_PAYMENT" && ["awaiting_transfer", "customer_reported"].includes(payment!.status);
  const cashOnDelivery = payment?.method === "pay_on_delivery";
  const paid = payment?.status === "verified";
  const cancellable =
    (order.status === "PENDING_PAYMENT" && payment?.status !== "customer_reported") ||
    (Boolean(payment) && ["CONFIRMED", "IN_TRANSIT"].includes(order.status) && (!paid || isOwner));

  return (
    <div className="order-detail stack">
      <p className="small">
        Deliver to {order.shippingCity ?? "—"} · placed {new Date(order.createdAt).toLocaleString()}
        {payment ? ` · ${payment.method === "bank_transfer" ? "Bank transfer" : "Pay on delivery"}` : ""}
      </p>
      <ul className="small">
        {(order.items ?? []).map((item) => (
          <li key={item.id}>
            {item.quantity} × {item.title} ({item.sku}) — {formatMoney(item.unitPriceMinor * item.quantity, order.currency)}
          </li>
        ))}
      </ul>
      {payment?.customerReference ? (
        <p className="small">
          Customer reported transfer reference <strong>{payment.customerReference}</strong>
          {payment.customerReportedAt ? ` on ${new Date(payment.customerReportedAt).toLocaleString()}` : ""}.
        </p>
      ) : null}
      <p className="muted small">
        History: {(order.events ?? []).map((ev) => ev.toStatus).join(" → ") || "—"}
        {order.cancelReason ? ` · ${order.cancelReason}` : ""}
      </p>

      {awaitingTransfer && canRecordMoney ? (
        <div className="stack">
          <p className="small">
            Check your bank account for {formatMoney(order.totalMinor, order.currency)}, then record it. A customer's message is not proof of
            payment.
          </p>
          <div className="row">
            <label>
              Amount received (NGN)
              <input type="number" min={0} step="0.01" value={input.amount} onChange={(e) => setInput({ ...input, amount: e.target.value })} />
            </label>
            <label>
              Your bank statement reference (optional)
              <input value={input.reference} onChange={(e) => setInput({ ...input, reference: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <button className="btn" type="button" disabled={busy || !input.amount} onClick={verify}>
              Verify transfer received
            </button>
            {payment?.status === "customer_reported" ? (
              <button className="btn ghost" type="button" disabled={busy || input.reason.trim().length < 3} onClick={reject}>
                Not received: reject report
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {order.status === "CONFIRMED" ? (
        <button className="btn secondary" type="button" disabled={busy} onClick={() => advance("dispatch")}>
          Mark dispatched
        </button>
      ) : null}

      {canRecordMoney && ["CONFIRMED", "IN_TRANSIT"].includes(order.status) && payment ? (
        cashOnDelivery ? (
          <div className="row">
            <label>
              Cash collected on delivery (NGN)
              <input type="number" min={0} step="0.01" value={input.amount} onChange={(e) => setInput({ ...input, amount: e.target.value })} />
            </label>
            <button className="btn" type="button" disabled={busy || !input.amount} onClick={() => advance("deliver", minor(input.amount))}>
              Delivered and paid
            </button>
          </div>
        ) : (
          <button className="btn" type="button" disabled={busy} onClick={() => advance("deliver")}>
            Mark delivered
          </button>
        )
      ) : null}

      {canRecordMoney && order.status === "DELIVERED" && payment ? (
        <button className="btn secondary" type="button" disabled={busy} onClick={() => advance("complete")}>
          Complete order
        </button>
      ) : null}

      {canRecordMoney && cancellable ? (
        <div className="row">
          <label>
            Reason {payment?.status === "customer_reported" ? "to reject or cancel" : "to cancel"}
            <input value={input.reason} onChange={(e) => setInput({ ...input, reason: e.target.value })} />
          </label>
          {paid ? (
            <label>
              Refund transfer reference
              <input value={input.refund} onChange={(e) => setInput({ ...input, refund: e.target.value })} />
            </label>
          ) : null}
          <button className="btn ghost" type="button" disabled={busy || input.reason.trim().length < 3 || (paid && input.refund.trim().length < 3)} onClick={cancel}>
            {paid ? "Cancel (refunded)" : order.status === "PENDING_PAYMENT" ? "Cancel unpaid order" : "Cancel order"}
          </button>
        </div>
      ) : null}
      {paid && !isOwner && ["CONFIRMED", "IN_TRANSIT"].includes(order.status) ? (
        <p className="muted small">Only the store owner can cancel an order that was paid.</p>
      ) : null}
    </div>
  );
}

/** Where customers pay: pay on delivery and the store's own bank account (owners edit). */
function PaymentSettingsAdmin({ token, isOwner }: { token: string; isOwner: boolean }) {
  const [settings, setSettings] = useState<PaymentSettings | null>(null);
  const [form, setForm] = useState({ payOnDeliveryEnabled: false, bankTransferEnabled: false, bankName: "", bankAccountName: "", bankAccountNumber: "", bankTransferNote: "" });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadPaymentSettings(token)
      .then((s) => {
        setSettings(s);
        setForm({
          payOnDeliveryEnabled: s.payOnDeliveryEnabled,
          bankTransferEnabled: s.bankTransferEnabled,
          bankName: s.bankName ?? "",
          bankAccountName: s.bankAccountName ?? "",
          bankAccountNumber: s.bankAccountNumber ?? "",
          bankTransferNote: s.bankTransferNote ?? "",
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load payment settings."));
  }, [token]);

  if (!settings) return error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null;

  return (
    <section className="card stack">
      <h2>How customers pay</h2>
      <p className="muted small">
        Customers pay you directly. Digiconomy never holds the money. You confirm each bank transfer yourself before preparing the order.
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setNote(null);
          try {
            const saved = await savePaymentSettings(token, form);
            setSettings(saved);
            setNote("Saved. Your checkout shows these options now.");
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save payment settings.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" disabled={!isOwner} checked={form.payOnDeliveryEnabled} onChange={(e) => setForm({ ...form, payOnDeliveryEnabled: e.target.checked })} />
          Accept pay on delivery
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" disabled={!isOwner} checked={form.bankTransferEnabled} onChange={(e) => setForm({ ...form, bankTransferEnabled: e.target.checked })} />
          Accept bank transfer to my account
        </label>
        <div className="row">
          <label>
            Bank name
            <input disabled={!isOwner} value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
          </label>
          <label>
            Account name
            <input disabled={!isOwner} value={form.bankAccountName} onChange={(e) => setForm({ ...form, bankAccountName: e.target.value })} />
          </label>
          <label>
            Account number
            <input disabled={!isOwner} inputMode="numeric" value={form.bankAccountNumber} onChange={(e) => setForm({ ...form, bankAccountNumber: e.target.value })} />
          </label>
        </div>
        {note ? <p className="muted small" role="status">{note}</p> : null}
        {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
        {isOwner ? (
          <button className="btn secondary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save payment settings"}
          </button>
        ) : (
          <p className="muted small">Only the store owner can change where customers pay.</p>
        )}
      </form>
    </section>
  );
}

/** Variants running low (5 or fewer available), refreshed when the catalogue changes. */
function LowStockAdmin({ token, products }: { token: string; products: Product[] }) {
  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  useEffect(() => {
    lowStock(token)
      .then(setRows)
      .catch(() => setRows([]));
  }, [token, products]);
  if (!rows) return null;
  return (
    <section className="card stack">
      <h2>Low stock</h2>
      {rows.length ? (
        <ul className="small">
          {rows.map((r) => (
            <li key={r.variantId}>
              <strong>{r.productTitle}</strong> ({r.sku}): {r.available} available
              {r.reservedCount ? `, ${r.reservedCount} reserved for unpaid orders` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Every product has more than 5 in stock.</p>
      )}
    </section>
  );
}
