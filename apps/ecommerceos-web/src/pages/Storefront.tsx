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

  return (
    <>
      {mode === "demo" ? (
        <div className="banner">
          Showing the Market Lane catalog. Connect <code>VITE_API_URL</code> to a live ECommerceOS API to load a provisioned store.
        </div>
      ) : null}
      <section className="hero">
        <p className="badge">{store.subdomain}.lifeos.app</p>
        <h1>{store.storeName}</h1>
        <p>
          Physical retail and same-day delivery from {store.pickup.city}. Pickup at {store.pickup.addressLine1}.
          Delivery within {store.deliveryRadiusKm} km — {formatMoney(store.deliveryFeeMinor, store.defaultCurrency)}.
        </p>
      </section>
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
    </>
  );
}
