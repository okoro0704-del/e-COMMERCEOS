import type { Cart, Order, Product, Storefront } from "./types";

export const DEMO_STORE: Storefront = {
  tenantId: "demo-tenant",
  storeName: "Market Lane",
  subdomain: "demo",
  defaultCurrency: "NGN",
  deliveryRadiusKm: 12,
  deliveryFeeMinor: 150_000,
  pickup: {
    addressLine1: "14 Broad Street",
    city: "Lagos",
    country: "NG",
  },
  primaryColor: "#0d7a6f",
};

export const DEMO_PRODUCTS: Product[] = [
  {
    id: "p-rice",
    tenantId: "demo-tenant",
    title: "Premium Ofada Rice 5kg",
    description: "Locally milled ofada rice. Vacuum packed for the pantry or weekly delivery.",
    status: "active",
    images: [],
    category: { id: "cat-grocery", code: "grocery", name: "Grocery" },
    variants: [
      {
        id: "v-rice",
        sku: "RICE-5KG",
        title: "5kg bag",
        priceMinor: 850_000,
        available: 42,
        status: "active",
        images: [],
      },
    ],
  },
  {
    id: "p-oil",
    tenantId: "demo-tenant",
    title: "Cold-pressed Palm Oil 1L",
    description: "Unrefined red palm oil from a verified farm cooperative.",
    status: "active",
    images: [],
    category: { id: "cat-grocery", code: "grocery", name: "Grocery" },
    variants: [
      {
        id: "v-oil",
        sku: "OIL-1L",
        title: "1 litre",
        priceMinor: 320_000,
        available: 28,
        status: "active",
        images: [],
      },
    ],
  },
  {
    id: "p-soap",
    tenantId: "demo-tenant",
    title: "Black Soap Bundle",
    description: "Three-bar household pack. Ships same-day inside the delivery radius.",
    status: "active",
    images: [],
    category: { id: "cat-home", code: "home", name: "Home" },
    variants: [
      {
        id: "v-soap",
        sku: "SOAP-3",
        title: "3-pack",
        priceMinor: 180_000,
        available: 60,
        status: "active",
        images: [],
      },
    ],
  },
  {
    id: "p-water",
    tenantId: "demo-tenant",
    title: "Spring Water Case 12×75cl",
    description: "Cased water for office and home restock. Rider pickup from Broad Street.",
    status: "active",
    images: [],
    category: { id: "cat-grocery", code: "grocery", name: "Grocery" },
    variants: [
      {
        id: "v-water",
        sku: "WTR-12",
        title: "Case of 12",
        priceMinor: 240_000,
        available: 18,
        status: "active",
        images: [],
      },
    ],
  },
];

export const DEMO_ORDERS: Order[] = [
  {
    id: "o-1",
    orderNumber: "ECO-8K2M1",
    status: "IN_TRANSIT",
    buyerName: "Adaeze Okonkwo",
    totalMinor: 1_190_000,
    currency: "NGN",
    createdAt: new Date().toISOString(),
    logisticsJobId: "job_demo_1",
  },
  {
    id: "o-2",
    orderNumber: "ECO-7P4Q9",
    status: "PAID_ESCROW",
    buyerName: "Chinedu Bello",
    totalMinor: 470_000,
    currency: "NGN",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
];

export function emptyCart(tenantId = DEMO_STORE.tenantId): Cart {
  return { id: "demo-cart", tenantId, items: [], subtotalMinor: 0 };
}
