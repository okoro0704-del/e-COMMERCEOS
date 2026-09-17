import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { loadStorefront } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Product, Storefront as Store } from "../lib/types";

export function StorefrontPage() {
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [mode, setMode] = useState<"live" | "demo">("demo");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStorefront()
      .then((data) => {
        setStore(data.store);
        setProducts(data.products);
        setMode(data.mode);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="empty">{error}</p>;
  if (!store) return <p className="empty">Loading store…</p>;

  const model = store.operatingModel ?? "store";
  const occupants = store.destinationOccupants ?? [];
  const sellers = store.marketplaceSellers ?? [];

  return (
    <>
      {mode === "demo" ? (
        <div className="banner">
          Showing the Market Lane catalog. Connect <code>VITE_API_URL</code> to a live ECommerceOS API to load a provisioned store.
        </div>
      ) : null}
      <section className="hero">
        <p className="badge">{store.verticalId ?? "retail"} · {store.subdomain}.lifeos.app</p>
        <h1>{store.storeName}</h1>
        <p>
          {model === "destination"
            ? `Directory for this commercial destination in ${store.pickup.city}. Occupant businesses keep their own apps.`
            : model === "marketplace"
              ? "Independent sellers participate here. Catalogs stay on each seller’s own application."
              : model === "wholesale"
                ? `B2B catalog from ${store.pickup.city}. Minimum order ${store.wholesale?.minQuantityDefault ?? 6} units where set.`
                : store.hasPhysicalAddress === false
                  ? `Online storefront. Orders from ${store.pickup.city}.`
                  : `Physical shop and digital commerce from ${store.pickup.city}. Pickup at ${store.pickup.addressLine1}.`}
        </p>
      </section>

      {model === "destination" ? (
        <div className="grid">
          {occupants.map((unit) => (
            <article key={unit.id} className="card">
              <p className="eyebrow">{unit.unitCode}</p>
              <h3>{unit.displayName}</h3>
              <p className="muted small">{unit.category ?? "Unit"} · {unit.hours ?? "Hours TBA"}</p>
              {unit.referencedSubdomain ? (
                <p className="small">Linked store: {unit.referencedSubdomain}.lifeos.app</p>
              ) : (
                <p className="small muted">No linked store app yet — this centre does not copy their catalog.</p>
              )}
            </article>
          ))}
        </div>
      ) : model === "marketplace" ? (
        <div className="grid">
          {sellers.length ? (
            sellers.map((seller) => (
              <article key={seller.id} className="card">
                <p className="eyebrow">{seller.status}</p>
                <h3>{seller.displayName}</h3>
                <p className="muted small">
                  {seller.sellerTenantId
                    ? `Seller app ${seller.sellerTenantId}`
                    : "Invited seller — catalog stays on their own application."}
                </p>
              </article>
            ))
          ) : (
            <p className="empty">No sellers have joined this marketplace yet.</p>
          )}
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
