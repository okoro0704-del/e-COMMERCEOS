import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="not-found">
      <div>
        <p className="eyebrow">404</p>
        <h1>Page not found</h1>
        <p className="muted">This path is not part of the ECommerceOS storefront or merchant console.</p>
        <p><Link to="/">Go to the storefront</Link> · <Link to="/admin">Open admin</Link></p>
      </div>
    </div>
  );
}
