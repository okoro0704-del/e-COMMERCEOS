import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadMarketplaceCatalog, loadMarketplaceStores, loadStorefront, publicMediaUrl, searchMarketplace } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { MarketplaceProjectedProduct, MarketplaceStore, Product, Storefront as Store } from "../lib/types";

export function StorefrontPage() {
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [mode, setMode] = useState<"live" | "demo">("demo");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"home" | "stores" | "catalogue">("home");
  const [stores, setStores] = useState<MarketplaceStore[]>([]);
  const [projected, setProjected] = useState<MarketplaceProjectedProduct[]>([]);
  const [categories, setCategories] = useState<Array<{ code: string; name: string }>>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    loadStorefront()
      .then(async (data) => {
        setStore(data.store);
        setProducts(data.products);
        setMode(data.mode);
        if (data.store.onlineMarketplace || data.store.operatingModel === "marketplace") {
          try {
            const [nextStores, catalog] = await Promise.all([loadMarketplaceStores(), loadMarketplaceCatalog()]);
            setStores(nextStores);
            setProjected(catalog.products);
            setCategories(catalog.categories);
          } catch {
            setStores([]);
            setProjected([]);
          }
        }
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const marketplace = Boolean(store?.onlineMarketplace || store?.operatingModel === "marketplace");
  const visibleStores = useMemo(
    () => stores.filter((row) => row.status === "active"),
    [stores],
  );

  if (error) return <p className="empty">This store is unavailable right now. {error}</p>;
  if (!store) return <p className="empty">Loading store…</p>;
  const brandStyle = store.primaryColor ? { background: `linear-gradient(135deg, ${store.primaryColor} 0%, #12343a 100%)` } : undefined;
  const logo = store.logoAssetId ? publicMediaUrl(store.logoAssetId) : store.logoUrl?.startsWith("https://") ? store.logoUrl : null;
  if (store.activation?.open === false) {
    return (
      <section className="hero" style={brandStyle}>
        {logo ? <img className="store-logo" src={logo} alt="" /> : null}
        <p className="badge">{store.subdomain}.getlifeos.app</p>
        <h1>{store.storeName}</h1>
        <p>This store is getting ready and will open soon.</p>
      </section>
    );
  }

  const model = store.operatingModel ?? "store";
  const occupants = store.destinationOccupants ?? [];

  async function onSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) {
      const catalog = await loadMarketplaceCatalog();
      setProjected(catalog.products);
      setCategories(catalog.categories);
      setStores(await loadMarketplaceStores());
      return;
    }
    setSearching(true);
    try {
      const result = await searchMarketplace(query.trim());
      setStores(result.stores);
      setProjected(result.products);
      setCategories(result.categories);
      setTab("catalogue");
    } finally {
      setSearching(false);
    }
  }

  return (
    <>
      {mode === "demo" ? (
        <div className="banner">
          Preview catalog only. This is not a real store and checkout is disabled.
        </div>
      ) : null}
      <section className="hero" style={brandStyle}>
        {logo ? <img className="store-logo" src={logo} alt="" /> : null}
        <p className="badge">
          {marketplace ? "Online Marketplace" : store.verticalId ?? "retail"} · {store.subdomain}.getlifeos.app
        </p>
        <h1>{store.storeName}</h1>
        {store.tagline ? <p className="tagline">{store.tagline}</p> : null}
        <p>
          {marketplace
            ? "Shop independent Online Stores. Each seller keeps their own catalogue — this marketplace only discovers it."
            : model === "destination"
              ? `Directory for this commercial destination in ${store.pickup.city}. Occupant businesses keep their own apps.`
              : model === "wholesale"
                ? `B2B catalog from ${store.pickup.city}. Minimum order ${store.wholesale?.minQuantityDefault ?? 6} units where set.`
                : store.hasPhysicalAddress === false
                  ? `Online storefront. Orders from ${store.pickup.city}.`
                  : `Physical shop and digital commerce from ${store.pickup.city}. Pickup at ${store.pickup.addressLine1}.`}
        </p>
        {marketplace ? (
          <form className="marketplace-search" onSubmit={onSearch}>
            <input
              type="search"
              placeholder="Search products, stores, categories"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search marketplace"
            />
            <button className="btn" type="submit" disabled={searching}>
              {searching ? "Searching…" : "Search"}
            </button>
          </form>
        ) : null}
      </section>

      {marketplace ? (
        <>
          <nav className="tabs" aria-label="Marketplace sections">
            <button className={tab === "home" ? "tab active" : "tab"} type="button" onClick={() => setTab("home")}>
              Home
            </button>
            <button className={tab === "stores" ? "tab active" : "tab"} type="button" onClick={() => setTab("stores")}>
              Stores
            </button>
            <button className={tab === "catalogue" ? "tab active" : "tab"} type="button" onClick={() => setTab("catalogue")}>
              Catalogue
            </button>
          </nav>

          {tab === "home" || tab === "stores" ? (
            <section className="stack">
              <h2>Stores</h2>
              {visibleStores.length ? (
                <div className="grid">
                  {visibleStores.map((seller) => (
                    <article key={seller.storeRef} className="card">
                      <p className="eyebrow">Online Store</p>
                      <h3>{seller.name}</h3>
                      <p className="muted small">{seller.subdomain}.getlifeos.app</p>
                      <a className="btn secondary" href={seller.publicUrl} target="_blank" rel="noreferrer">
                        Open store
                      </a>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty">No sellers are participating in this marketplace yet.</p>
              )}
            </section>
          ) : null}

          {tab === "home" || tab === "catalogue" ? (
            <section className="stack" style={{ marginTop: "1.5rem" }}>
              <h2>Catalogue</h2>
              {categories.length ? (
                <p className="muted small">Categories: {categories.map((c) => c.name).join(" · ")}</p>
              ) : null}
              {projected.length ? (
                <div className="grid">
                  {projected.map((item) => (
                    <Link
                      key={item.presentationId}
                      to={`/m/${item.storeRef}/product/${item.presentationId.split(":")[1]}`}
                      className="card"
                      style={{ color: "inherit", textDecoration: "none" }}
                    >
                      <p className="eyebrow">{item.category?.name ?? "Product"}</p>
                      <h3>{item.title}</h3>
                      <p className="muted small">{item.description}</p>
                      {item.priceMinor != null ? (
                        <p className="price">{formatMoney(item.priceMinor, item.currency)}</p>
                      ) : null}
                      <p className="small">Sold by {item.sellerName}</p>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="empty">
                  {visibleStores.length
                    ? "Participating stores have not published catalogue items yet."
                    : "No marketplace catalogue yet — invite a seller and add products in their Online Store."}
                </p>
              )}
            </section>
          ) : null}
        </>
      ) : model === "destination" ? (
        <div className="grid">
          {occupants.map((unit) => (
            <article key={unit.id} className="card">
              <p className="eyebrow">{unit.unitCode}</p>
              <h3>{unit.displayName}</h3>
              <p className="muted small">{unit.category ?? "Unit"} · {unit.hours ?? "Hours TBA"}</p>
              {unit.referencedSubdomain ? (
                <p className="small">Linked store: {unit.referencedSubdomain}.getlifeos.app</p>
              ) : (
                <p className="small muted">No linked store app yet — this centre does not copy their catalog.</p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="grid">
          {products.map((product) => {
            const variant = product.variants[0];
            return (
              <Link key={product.id} to={`/product/${product.id}`} className="card" style={{ color: "inherit", textDecoration: "none" }}>
                <p className="eyebrow">{product.category?.name ?? "Catalog"}</p>
                <h3>{product.title}</h3>
                <p className="muted small">{product.description}</p>
                {variant ? (
                  <p className="price">{formatMoney(variant.priceMinor, store.defaultCurrency)}</p>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
