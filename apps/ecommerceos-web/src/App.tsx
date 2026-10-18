import { Link, Route, Routes } from "react-router-dom";
import { AdminPage } from "./pages/Admin";
import { CartPage } from "./pages/Cart";
import { MarketplaceProductPage } from "./pages/MarketplaceProduct";
import { NotFoundPage } from "./pages/NotFound";
import { OrderPage } from "./pages/Order";
import { PlatformPage } from "./pages/Platform";
import { ProductPage } from "./pages/Product";
import { PublicationPage } from "./pages/Publication";
import { StorefrontPage } from "./pages/Storefront";

export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" to="/">ECommerceOS</Link>
        <nav className="nav">
          <Link to="/">Shop</Link>
          <Link to="/cart">Cart</Link>
          <Link to="/admin">Admin</Link>
        </nav>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<StorefrontPage />} />
          <Route path="/storefront" element={<StorefrontPage />} />
          <Route path="/product/:id" element={<ProductPage />} />
          <Route path="/p/:id" element={<PublicationPage />} />
          <Route path="/m/:storeRef/product/:productId" element={<MarketplaceProductPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<CartPage />} />
          <Route path="/order/:id" element={<OrderPage />} />
          <Route path="/admin" element={<AdminPage />} />
          {/* Digiconomy staff console; deliberately not linked from the storefront navigation. */}
          <Route path="/platform" element={<PlatformPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
      <footer className="footer">EcommerceOS · Online Store · Online Marketplace</footer>
    </div>
  );
}
