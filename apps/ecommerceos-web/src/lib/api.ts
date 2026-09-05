import { DEMO_ORDERS, DEMO_PRODUCTS, DEMO_STORE, emptyCart } from "./demo";
import { buyerToken, storeSubdomain } from "./money";
import type { Cart, MerchantSession, Order, Product, Storefront } from "./types";

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
