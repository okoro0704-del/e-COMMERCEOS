import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadMarketplaceProduct } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { MarketplaceProductDetail } from "../lib/types";

export function MarketplaceProductPage() {
  const { storeRef, productId } = useParams();
  const [item, setItem] = useState<MarketplaceProductDetail | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!storeRef || !productId) return;
    loadMarketplaceProduct(storeRef, productId)
      .then(setItem)
      .catch(() => setMissing(true));
  }, [storeRef, productId]);

  if (missing) {
    return (
      <div className="not-found">
        <div>
          <p className="eyebrow">Unavailable</p>
          <h1>Product not in this marketplace</h1>
          <p className="muted">That item is not projected from a participating Online Store.</p>
          <p><Link to="/">Back to marketplace</Link></p>
        </div>
      </div>
    );
  }

  if (!item) return <p className="empty">Loading…</p>;

  return (
    <article className="card stack" style={{ maxWidth: 640 }}>
      <p className="eyebrow">{item.category?.name ?? "Product"}</p>
      <h1>{item.title}</h1>
      <p className="muted">{item.description}</p>
      {item.priceMinor != null ? <p className="price">{formatMoney(item.priceMinor, item.currency)}</p> : null}
      {item.available != null ? <p className="small muted">{item.available} available from the seller</p> : null}
      <section className="card" style={{ boxShadow: "none" }}>
        <p className="eyebrow">Seller</p>
        <h2>{item.seller.name}</h2>
        <p className="muted small">This product belongs to the seller’s Online Store. The marketplace does not own it.</p>
        {item.seller.publicUrl ? (
          <a className="btn" href={item.seller.publicUrl} target="_blank" rel="noreferrer">
            Open seller store
          </a>
        ) : null}
      </section>
      <Link className="btn ghost" to="/">Back to marketplace</Link>
    </article>
  );
}
