import { DEMO_ORDERS, DEMO_PRODUCTS, DEMO_STORE, emptyCart } from "./demo";
import { buyerToken, storeSubdomain } from "./money";
import type {
  Cart,
  MarketplaceCreatedStore,
  MarketplaceProductDetail,
  MarketplaceProjectedProduct,
  MarketplaceSearch,
  MarketplaceStore,
  MerchantSession,
  Order,
  Product,
  Storefront,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export type ApiMode = "live" | "demo";

async function request<T>(path: string, init: RequestInit = {}, auth?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("x-store-subdomain", storeSubdomain());
  if (auth) headers.set("Authorization", `Bearer ${auth}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

/** Public LifeOS/catalogue endpoints — no store subdomain header. */
async function fetchPublic<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

export type PublicBusinessPublication = {
  id: string;
  type: string;
  title: string;
  caption: string;
  storeName: string;
  slug: string;
  publishedAt: string | null;
  relatedProductId: string | null;
  media: Array<{ assetId: string; href: string; contentType: string | null }>;
  canonicalSourceUrl: string;
  storeUrl: string;
  productUrl: string | null;
};

export async function loadPublicPublication(id: string): Promise<PublicBusinessPublication> {
  return fetchPublic<PublicBusinessPublication>(`/v1/public/publications/${encodeURIComponent(id)}`);
}

export async function uploadMedia(
  token: string,
  input: { filename: string; contentType: string; bodyBase64: string; productId?: string },
): Promise<{ id: string; url: string; key: string; namespace: string; contentType?: string | null }> {
  return request(
    "/v1/media/upload",
    {
      method: "POST",
      body: JSON.stringify({
        filename: input.filename,
        contentType: input.contentType,
        body: input.bodyBase64,
        encoding: "base64",
        productId: input.productId,
      }),
    },
    token,
  );
}

export async function createBusinessPublication(
  token: string,
  input: {
    type: "PHOTO" | "VIDEO" | "POST";
    title?: string;
    caption?: string;
    mediaAssetIds: string[];
    relatedProductId?: string | null;
    status?: "draft" | "published";
  },
) {
  return request<Record<string, unknown>>(
    "/v1/publications",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export async function loadStorefront(): Promise<{ store: Storefront; products: Product[]; mode: ApiMode }> {
  try {
    const [store, products] = await Promise.all([
      request<Storefront>("/v1/storefront"),
      request<Product[]>("/v1/storefront/products"),
    ]);
    return { store, products, mode: "live" };
  } catch {
    return { store: { ...DEMO_STORE, subdomain: storeSubdomain() }, products: DEMO_PRODUCTS, mode: "demo" };
  }
}

export async function loadProduct(id: string): Promise<{ product: Product; mode: ApiMode }> {
  try {
    return { product: await request<Product>(`/v1/storefront/products/${id}`), mode: "live" };
  } catch {
    const product = DEMO_PRODUCTS.find((p) => p.id === id);
    if (!product) throw new Error("Product not found");
    return { product, mode: "demo" };
  }
}

export async function loadCart(): Promise<{ cart: Cart; mode: ApiMode }> {
  try {
    return { cart: await request<Cart>("/v1/cart", {}, buyerToken()), mode: "live" };
  } catch {
    const raw = localStorage.getItem("eco_demo_cart");
    return { cart: raw ? (JSON.parse(raw) as Cart) : emptyCart(), mode: "demo" };
  }
}

function saveDemoCart(cart: Cart) {
  localStorage.setItem("eco_demo_cart", JSON.stringify(cart));
  return cart;
}

export async function addToCart(variantId: string, product: Product): Promise<Cart> {
  try {
    return await request<Cart>(
      "/v1/cart/items",
      { method: "POST", body: JSON.stringify({ variantId, quantity: 1 }) },
      buyerToken(),
    );
  } catch {
    const current = (await loadCart()).cart;
    const variant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];
    if (!variant) return current;
    const existing = current.items.find((i) => i.variantId === variant.id);
    const items = existing
      ? current.items.map((i) =>
          i.variantId === variant.id
            ? {
                ...i,
                quantity: i.quantity + 1,
                lineTotalMinor: (i.quantity + 1) * i.unitPriceMinor,
              }
            : i,
        )
      : [
          ...current.items,
          {
            id: `ci-${variant.id}`,
            variantId: variant.id,
            productId: product.id,
            productTitle: product.title,
            sku: variant.sku,
            title: variant.title,
            quantity: 1,
            unitPriceMinor: variant.priceMinor,
            lineTotalMinor: variant.priceMinor,
          },
        ];
    return saveDemoCart({
      ...current,
      items,
      subtotalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0),
    });
  }
}

export async function updateCartItem(itemId: string, quantity: number): Promise<Cart> {
  try {
    return await request<Cart>(
      `/v1/cart/items/${itemId}`,
      { method: "PATCH", body: JSON.stringify({ quantity }) },
      buyerToken(),
    );
  } catch {
    const current = (await loadCart()).cart;
    const items =
      quantity < 1
        ? current.items.filter((i) => i.id !== itemId)
        : current.items.map((i) =>
            i.id === itemId
              ? { ...i, quantity, lineTotalMinor: quantity * i.unitPriceMinor }
              : i,
          );
    return saveDemoCart({
      ...current,
      items,
      subtotalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0),
    });
  }
}

export async function placeAndPay(input: {
  buyerName: string;
  buyerPhone: string;
  addressLine1: string;
  city: string;
  country: string;
}): Promise<{ orderId: string; status: string; mode: ApiMode }> {
  try {
    const order = await request<{ id: string; status: string }>(
      "/v1/orders",
      {
        method: "POST",
        body: JSON.stringify({
          buyerName: input.buyerName,
          buyerPhone: input.buyerPhone,
          shipping: {
            addressLine1: input.addressLine1,
            city: input.city,
            country: input.country,
            lat: 6.5244,
            lng: 3.3792,
          },
        }),
      },
      buyerToken(),
    );
    const paid = await request<{ order: { id: string; status: string } }>(
      "/v1/checkout/pay",
      { method: "POST", body: JSON.stringify({ orderId: order.id }) },
      buyerToken(),
    );
    return { orderId: paid.order.id, status: paid.order.status, mode: "live" };
  } catch {
    saveDemoCart(emptyCart());
    return { orderId: `demo-${Date.now()}`, status: "DISPATCH_PENDING", mode: "demo" };
  }
}

export async function merchantLogin(email: string, password: string): Promise<MerchantSession> {
  return request<MerchantSession>("/v1/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function merchantCatalog(token: string): Promise<Product[]> {
  return request<Product[]>("/v1/products", {}, token);
}

export async function merchantOrders(token: string): Promise<Order[]> {
  return request<Order[]>("/v1/orders", {}, token);
}

export async function createProduct(
  token: string,
  input: { title: string; description: string; sku: string; priceNaira: number; stock: number },
): Promise<Product> {
  return request<Product>(
    "/v1/products",
    {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        variants: [
          {
            sku: input.sku,
            title: input.title,
            priceMinor: Math.round(input.priceNaira * 100),
            inventoryCount: input.stock,
          },
        ],
      }),
    },
    token,
  );
}

export function demoOrders() {
  return DEMO_ORDERS;
}

export function demoProducts() {
  return DEMO_PRODUCTS;
}

export async function listDestinationOccupants(token?: string) {
  return request<Storefront["destinationOccupants"]>("/v1/destination/occupants", {}, token);
}

export async function addDestinationOccupant(
  token: string,
  input: {
    unitCode: string;
    displayName: string;
    category?: string;
    hours?: string;
    referencedSubdomain?: string;
  },
) {
  return request<NonNullable<Storefront["destinationOccupants"]>>(
    "/v1/destination/occupants",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export async function listMarketplaceSellers(token?: string) {
  return request<Storefront["marketplaceSellers"]>("/v1/marketplace/sellers", {}, token);
}

export async function addMarketplaceSeller(
  token: string,
  input: { displayName: string; status?: "invited" | "active" | "suspended" | "removed"; sellerTenantId?: string },
) {
  return request<NonNullable<Storefront["marketplaceSellers"]>>(
    "/v1/marketplace/sellers",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export async function enableOnlineMarketplace(token: string) {
  return request("/v1/marketplace/enable", { method: "POST" }, token);
}

export async function createMarketplaceSellerStore(
  token: string,
  input: { displayName: string; subdomain?: string; city?: string; country?: string },
) {
  return request<MarketplaceCreatedStore>(
    "/v1/marketplace/sellers/stores",
    { method: "POST", body: JSON.stringify(input) },
    token,
  );
}

export async function updateMarketplaceSellerStatus(
  token: string,
  sellerId: string,
  status: "invited" | "active" | "suspended" | "removed",
) {
  return request<{
    membership: NonNullable<Storefront["marketplaceSellers"]>[number];
    storeDeleted: boolean;
    storeStillExists: boolean;
    catalogueCount: number;
  }>(`/v1/marketplace/sellers/${sellerId}`, { method: "PATCH", body: JSON.stringify({ status }) }, token);
}

export async function loadMarketplaceStores() {
  return request<MarketplaceStore[]>("/v1/storefront/marketplace/stores");
}

export async function loadMarketplaceCatalog(q?: string) {
  const suffix = q ? `?q=${encodeURIComponent(q)}` : "";
  return request<{ products: MarketplaceProjectedProduct[]; categories: Array<{ code: string; name: string }> }>(
    `/v1/storefront/marketplace/products${suffix}`,
  );
}

export async function searchMarketplace(q: string) {
  return request<MarketplaceSearch>(`/v1/storefront/marketplace/search?q=${encodeURIComponent(q)}`);
}

export async function loadMarketplaceProduct(storeRef: string, productId: string) {
  return request<MarketplaceProductDetail>(`/v1/storefront/marketplace/products/${storeRef}/${productId}`);
}

export async function loadMarketplaceAdminCatalog(token: string) {
  return request<{
    stores: MarketplaceStore[];
    products: MarketplaceProjectedProduct[];
    categories: Array<{ code: string; name: string }>;
  }>("/v1/marketplace/catalog", {}, token);
}

export async function loadDigiPedia(token: string) {
  return request<Record<string, unknown>>("/v1/admin/digipedia", {}, token);
}

export async function initializeDigiPedia(token: string) {
  return request<Record<string, unknown>>("/v1/admin/digipedia/initialize", { method: "POST" }, token);
}

export async function saveDigiPediaDraft(token: string, expectedVersion: number, draft: unknown) {
  return request<Record<string, unknown>>(
    "/v1/admin/digipedia/draft",
    { method: "PUT", body: JSON.stringify({ expectedVersion, draft }) },
    token,
  );
}

export async function publishDigiPedia(token: string, expectedVersion: number, draft: unknown) {
  return request<Record<string, unknown>>(
    "/v1/admin/digipedia/publish",
    { method: "POST", body: JSON.stringify({ expectedVersion, draft }) },
    token,
  );
}

export async function previewDigiPedia(token: string) {
  const headers = new Headers();
  headers.set("Accept", "text/html");
  headers.set("x-store-subdomain", storeSubdomain());
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/v1/admin/digipedia/preview`, { headers });
  if (!res.ok) throw new Error("Could not preview DigiPedia.");
  return res.text();
}
