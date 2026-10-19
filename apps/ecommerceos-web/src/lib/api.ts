import { DEMO_ORDERS, DEMO_PRODUCTS, DEMO_STORE, emptyCart } from "./demo";
import { buyerToken, storeSubdomain } from "./money";
import type {
  Cart,
  MarketplaceCreatedStore,
  MarketplaceProductDetail,
  MarketplaceProjectedProduct,
  MarketplaceSearch,
  MarketplaceStore,
  MarketingPartner,
  MerchantSession,
  Order,
  PartnerCommissionRow,
  PlatformOverview,
  PlatformSession,
  PlatformStore,
  ActivationRecord,
  InventoryRow,
  StoreBranding,
  Product,
  StoreActivation,
  Storefront,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

/** Preview catalog for design reviews only. Never used as a fallback for a live store. */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export type ApiMode = "live" | "demo";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("x-store-subdomain", storeSubdomain());
  if (auth) headers.set("Authorization", `Bearer ${auth}`);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("Could not reach the store. Check your connection and try again.", 0, "network_error");
  }
  const data = (await res.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!res.ok) {
    throw new ApiError(data.message || data.error || `Request failed (${res.status})`, res.status, data.error ?? "request_failed");
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
  if (DEMO_MODE) {
    return { store: { ...DEMO_STORE, subdomain: storeSubdomain() }, products: DEMO_PRODUCTS, mode: "demo" };
  }
  const store = await request<Storefront>("/v1/storefront");
  // A store awaiting its verified setup payment has no public catalogue yet.
  if (store.activation?.open === false) return { store, products: [], mode: "live" };
  const products = await request<Product[]>("/v1/storefront/products");
  return { store, products, mode: "live" };
}

export async function loadCheckoutAvailability(): Promise<{ onlinePayment: boolean }> {
  if (DEMO_MODE) return { onlinePayment: false };
  const store = await request<Storefront>("/v1/storefront");
  return { onlinePayment: store.checkout?.onlinePayment === true };
}

export async function loadProduct(id: string): Promise<{ product: Product; mode: ApiMode }> {
  if (DEMO_MODE) {
    const product = DEMO_PRODUCTS.find((p) => p.id === id);
    if (!product) throw new Error("Product not found");
    return { product, mode: "demo" };
  }
  return { product: await request<Product>(`/v1/storefront/products/${id}`), mode: "live" };
}

function readDemoCart(): Cart {
  try {
    const raw = localStorage.getItem("eco_demo_cart");
    return raw ? (JSON.parse(raw) as Cart) : emptyCart();
  } catch {
    return emptyCart();
  }
}

export async function loadCart(): Promise<{ cart: Cart; mode: ApiMode }> {
  if (DEMO_MODE) return { cart: readDemoCart(), mode: "demo" };
  return { cart: await request<Cart>("/v1/cart", {}, buyerToken()), mode: "live" };
}

export async function loadOrder(id: string): Promise<Order> {
  return request<Order>(`/v1/orders/${encodeURIComponent(id)}`, {}, buyerToken());
}

function saveDemoCart(cart: Cart) {
  try {
    localStorage.setItem("eco_demo_cart", JSON.stringify(cart));
  } catch {
    /* preview only */
  }
  return cart;
}

export async function addToCart(variantId: string, product: Product): Promise<Cart> {
  if (!DEMO_MODE) {
    return request<Cart>(
      "/v1/cart/items",
      { method: "POST", body: JSON.stringify({ variantId, quantity: 1 }) },
      buyerToken(),
    );
  }
  const current = readDemoCart();
  const variant = product.variants.find((v) => v.id === variantId) ?? product.variants[0];
  if (!variant) return current;
  const existing = current.items.find((i) => i.variantId === variant.id);
  const items = existing
    ? current.items.map((i) =>
        i.variantId === variant.id
          ? { ...i, quantity: i.quantity + 1, lineTotalMinor: (i.quantity + 1) * i.unitPriceMinor }
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
  return saveDemoCart({ ...current, items, subtotalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0) });
}

export async function updateCartItem(itemId: string, quantity: number): Promise<Cart> {
  if (!DEMO_MODE) {
    return request<Cart>(
      `/v1/cart/items/${itemId}`,
      { method: "PATCH", body: JSON.stringify({ quantity }) },
      buyerToken(),
    );
  }
  const current = readDemoCart();
  const items =
    quantity < 1
      ? current.items.filter((i) => i.id !== itemId)
      : current.items.map((i) => (i.id === itemId ? { ...i, quantity, lineTotalMinor: quantity * i.unitPriceMinor } : i));
  return saveDemoCart({ ...current, items, subtotalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0) });
}

export type PendingOrder = { id: string; orderNumber: string; paymentExpiresAt: string };

/** Raised when checkout does not complete. Carries the reserved, unpaid order (if any) for retry. */
export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly pendingOrder: PendingOrder | null,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

const pendingOrderKey = () => `eco_pending_order:${storeSubdomain()}`;

function readPendingOrder(): PendingOrder | null {
  try {
    const raw = sessionStorage.getItem(pendingOrderKey());
    if (!raw) return null;
    const row = JSON.parse(raw) as PendingOrder;
    return new Date(row.paymentExpiresAt).getTime() > Date.now() ? row : null;
  } catch {
    return null;
  }
}

function writePendingOrder(row: PendingOrder | null) {
  try {
    if (row) sessionStorage.setItem(pendingOrderKey(), JSON.stringify(row));
    else sessionStorage.removeItem(pendingOrderKey());
  } catch {
    /* retry still works within this page */
  }
}

export function currentPendingOrder() {
  return readPendingOrder();
}

/** Errors after which the reserved order can no longer be paid, so it should not be retried. */
const TERMINAL_PAYMENT_ERRORS = new Set(["payment_expired", "illegal_transition", "not_found", "forbidden"]);

export async function placeOrderAndPay(input: {
  buyerName: string;
  buyerPhone: string;
  addressLine1: string;
  city: string;
  country: string;
}): Promise<{ orderId: string; status: string }> {
  if (DEMO_MODE) {
    throw new CheckoutError("This is a preview store. Checkout is disabled.", "demo_mode", null);
  }

  let pending = readPendingOrder();
  if (!pending) {
    try {
      const order = await request<{ id: string; orderNumber: string; paymentExpiresAt: string }>(
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
      pending = { id: order.id, orderNumber: order.orderNumber, paymentExpiresAt: order.paymentExpiresAt };
      writePendingOrder(pending);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("Could not place the order.", 0, "request_failed");
      throw new CheckoutError(e.message, e.code, null);
    }
  }

  try {
    const paid = await request<{ order: { id: string; status: string } }>(
      "/v1/checkout/pay",
      { method: "POST", body: JSON.stringify({ orderId: pending.id }) },
      buyerToken(),
    );
    writePendingOrder(null);
    return { orderId: paid.order.id, status: paid.order.status };
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError("Payment did not complete.", 0, "request_failed");
    const stillPayable = !TERMINAL_PAYMENT_ERRORS.has(e.code);
    if (!stillPayable) writePendingOrder(null);
    throw new CheckoutError(e.message, e.code, stillPayable ? pending : null);
  }
}

/** The store handle comes from this admin address (x-store-subdomain), so accounts are store-scoped. */
export async function merchantLogin(email: string, password: string): Promise<MerchantSession> {
  return request<MerchantSession>("/v1/auth/merchant/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function exchangeAdminHandoff(code: string): Promise<MerchantSession & { resetGrant: string }> {
  return request("/v1/auth/merchant/handoff/exchange", { method: "POST", body: JSON.stringify({ code }) });
}

export async function merchantLogout(token: string): Promise<void> {
  await request("/v1/auth/merchant/logout", { method: "POST" }, token).catch(() => undefined);
}

export async function changeMerchantPassword(
  token: string,
  input: { newPassword: string; currentPassword?: string; resetGrant?: string },
): Promise<{ ok: true; passwordSet: boolean; mustChangePassword: boolean }> {
  return request("/v1/auth/merchant/password", { method: "POST", body: JSON.stringify(input) }, token);
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

export async function updateProduct(token: string, id: string, input: { title?: string; status?: string }) {
  return request<Product>(`/v1/products/${id}`, { method: "PATCH", body: JSON.stringify(input) }, token);
}

export async function updateVariantPrice(token: string, variantId: string, priceMinor: number) {
  return request(`/v1/variants/${variantId}`, { method: "PATCH", body: JSON.stringify({ priceMinor }) }, token);
}

export async function adjustStock(token: string, variantId: string, delta: number, reason: string) {
  return request(`/v1/inventory/variants/${variantId}`, { method: "PATCH", body: JSON.stringify({ delta, reason }) }, token);
}

/** Public URL of an uploaded store image (served by the API). */
export function publicMediaUrl(assetId: string) {
  return `${API_BASE}/v1/public/media/${encodeURIComponent(assetId)}`;
}

export async function loadBranding(token: string) {
  return request<StoreBranding>("/v1/store/branding", {}, token);
}

export async function saveBranding(
  token: string,
  input: { storeName?: string; tagline?: string; primaryColor?: string; logoAssetId?: string | null },
) {
  return request<StoreBranding>("/v1/store/branding", { method: "PATCH", body: JSON.stringify(input) }, token);
}

export async function merchantOrder(token: string, id: string) {
  return request<Order>(`/v1/orders/${encodeURIComponent(id)}`, {}, token);
}

export async function cancelMerchantOrder(token: string, id: string, reason: string) {
  return request<Order>(`/v1/orders/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }, token);
}

export async function lowStock(token: string, threshold = 5) {
  return request<InventoryRow[]>(`/v1/inventory?lowStock=true&threshold=${threshold}`, {}, token);
}

export async function loadStoreActivation(token: string) {
  return request<StoreActivation>("/v1/activation", {}, token);
}

export async function submitStoreActivation(
  token: string,
  input: { plan: string; paymentReference: string; payerName: string; paidAt?: string; partnerCode?: string },
) {
  return request<ActivationRecord>("/v1/activation/submit", { method: "POST", body: JSON.stringify(input) }, token);
}

// Digiconomy platform console. Operator sessions are separate from store sessions.

export async function platformLogin(email: string, password: string) {
  return request<PlatformSession>("/v1/platform/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function platformLogout(token: string) {
  await request("/v1/platform/logout", { method: "POST" }, token).catch(() => undefined);
}

export async function platformOverview(token: string) {
  return request<PlatformOverview>("/v1/platform/overview", {}, token);
}

export async function platformStores(token: string) {
  return request<{ stores: PlatformStore[] }>("/v1/platform/stores", {}, token);
}

export async function platformActivations(token: string, status?: string) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<{ activations: ActivationRecord[] }>(`/v1/platform/activations${suffix}`, {}, token);
}

export async function reviewActivation(
  token: string,
  id: string,
  action: "verify" | "reject" | "reverse",
  body: { amountReceivedMinor?: number; currency?: string; reason?: string },
) {
  return request<ActivationRecord>(`/v1/platform/activations/${id}/${action}`, { method: "POST", body: JSON.stringify(body) }, token);
}

export async function platformPartners(token: string) {
  return request<{ partners: MarketingPartner[] }>("/v1/platform/partners", {}, token);
}

export async function createPartner(token: string, input: { code: string; name: string; email: string }) {
  return request<MarketingPartner>("/v1/platform/partners", { method: "POST", body: JSON.stringify(input) }, token);
}

export async function setPartnerStatus(token: string, id: string, action: "suspend" | "reactivate") {
  return request<MarketingPartner>(`/v1/platform/partners/${id}/${action}`, { method: "POST" }, token);
}

export async function platformCommissions(token: string) {
  return request<{ commissions: PartnerCommissionRow[] }>("/v1/platform/commissions", {}, token);
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
