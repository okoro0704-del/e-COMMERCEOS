import { Link, Route, Routes } from "react-router-dom";
import { AdminPage } from "./pages/Admin";
import { CartPage } from "./pages/Cart";
import { NotFoundPage } from "./pages/NotFound";
import { OrderPage } from "./pages/Order";
import { ProductPage } from "./pages/Product";
import { StorefrontPage } from "./pages/Storefront";

export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" to="/">ECommerceOS</Link>
        <nav className="nav">
          <Link to="/">Storefront</Link>
          <Link to="/cart">Cart</Link>
          <Link to="/admin">Admin</Link>
        </nav>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<StorefrontPage />} />
          <Route path="/storefront" element={<StorefrontPage />} />
          <Route path="/product/:id" element={<ProductPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CartPage />} />
          <Route path="/order/:id" element={<OrderPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="footer">LifeOS Business · Physical retail · LogisticsOS dispatch</footer>
    </div>
  );
}
