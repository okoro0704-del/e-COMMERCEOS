import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { addToCart, loadProduct } from "../lib/api";
import { formatMoney } from "../lib/money";
import type { Product } from "../lib/types";

export function ProductPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState<Product | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    loadProduct(id)
      .then((data) => setProduct(data.product))
      .catch(() => setMissing(true));
  }, [id]);

  if (missing) {
    return (
      <div className="not-found">
        <div>
          <p className="eyebrow">404</p>
          <h1>Product not found</h1>
          <p className="muted">That item is not in this catalog.</p>
          <p><Link to="/">Back to storefront</Link></p>
        </div>
      </div>
    );
  }

  if (!product) return <p className="empty">Loading…</p>;
  const variant = product.variants[0];

  return (
    <article className="card stack" style={{ maxWidth: 640 }}>
      <p className="eyebrow">{product.category?.name ?? "Product"}</p>
      <h1>{product.title}</h1>
      <p className="muted">{product.description}</p>
      {variant ? (
        <>
          <p className="price">{formatMoney(variant.priceMinor)}</p>
          <p className="small muted">{variant.available} in stock · SKU {variant.sku}</p>
        </>
      ) : null}
      {error ? <p className="small" style={{ color: "var(--eco-danger)" }}>{error}</p> : null}
      <div className="row">
        <button
          className="btn"
          disabled={!variant || busy}
          onClick={async () => {
            if (!variant) return;
            setBusy(true);
            setError(null);
            try {
              await addToCart(variant.id, product);
              navigate("/cart");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not add to cart");
            } finally {
              setBusy(false);
            }
          }}
        >
          Add to cart
        </button>
        <Link className="btn ghost" to="/">Keep browsing</Link>
      </div>
    </article>
  );
}
