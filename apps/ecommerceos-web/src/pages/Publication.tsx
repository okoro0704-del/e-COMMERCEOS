import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { loadPublicPublication, type PublicBusinessPublication } from "../lib/api";

export function PublicationPage() {
  const { id } = useParams();
  const [row, setRow] = useState<PublicBusinessPublication | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) return;
    loadPublicPublication(id)
      .then(setRow)
      .catch(() => setMissing(true));
  }, [id]);

  if (missing) {
    return (
      <div className="not-found">
        <div>
          <p className="eyebrow">404</p>
          <h1>Publication not found</h1>
          <p className="muted">This photo or video is not public, or it was removed.</p>
          <p>
            <Link to="/">Back to storefront</Link>
          </p>
        </div>
      </div>
    );
  }

  if (!row) return <p className="empty">Loading…</p>;

  return (
    <article className="card stack" style={{ maxWidth: 720 }}>
      <p className="eyebrow">
        {row.type} · {row.storeName}
      </p>
      <h1>{row.title || "Update"}</h1>
      {row.caption ? <p className="muted">{row.caption}</p> : null}
      {row.publishedAt ? (
        <p className="small muted">{new Date(row.publishedAt).toLocaleString()}</p>
      ) : null}
      <div className="stack">
        {row.media.map((asset) => {
          const isVideo =
            (asset.contentType || "").startsWith("video/") || row.type === "VIDEO";
          if (isVideo) {
            return (
              <video key={asset.assetId} controls playsInline style={{ width: "100%", maxHeight: 480 }}>
                <source src={asset.href} type={asset.contentType || undefined} />
              </video>
            );
          }
          return (
            <img
              key={asset.assetId}
              src={asset.href}
              alt={row.title || row.caption || "Publication"}
              style={{ width: "100%", maxHeight: 560, objectFit: "contain" }}
            />
          );
        })}
      </div>
      <div className="row">
        <Link className="btn ghost" to="/">
          Keep browsing
        </Link>
        {row.relatedProductId ? (
          <Link className="btn" to={`/product/${row.relatedProductId}`}>
            View related product
          </Link>
        ) : null}
      </div>
    </article>
  );
}
