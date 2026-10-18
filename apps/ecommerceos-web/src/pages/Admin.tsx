import { useEffect, useState } from "react";
import {
  addDestinationOccupant,
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
  merchantCatalog,
  merchantLogin,
  merchantOrders,
  previewDigiPedia,
  publishDigiPedia,
  saveDigiPediaDraft,
  updateMarketplaceSellerStatus,
  uploadMedia,
} from "../lib/api";
import { formatMoney } from "../lib/money";
import type { MarketplaceProjectedProduct, MerchantSession, Order, Product, Storefront } from "../lib/types";

const SESSION_KEY = "eco_merchant_session";

/** Never present an order as paid unless the API reports a verified payment. */
function paymentLabel(order: Order) {
  if (order.paymentVerified) return "Paid";
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

  useEffect(() => {
    void loadDigiPedia(token)
      .then((row) => {
        const next = row as DigiPediaManage;
        setData(next);
        setDraft(next.entry ? structuredClone(next.entry.draft) : null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load DigiPedia."));
  }, [token]);

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
