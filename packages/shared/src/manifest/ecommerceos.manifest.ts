/**
 * ECommerceOS app manifest for Master Distributor / LifeOS Portal.
 * Consumed when a client clicks "Install ECommerceOS".
 */

export type RequiredLifeOsPrimitive =
  | "identity"
  | "messaging"
  | "storage"
  | "jobs"
  | "distributor"
  | "billing";

export const MODULE_IDS = [
  "catalog",
  "inventory",
  "cart",
  "orders",
  "checkout",
  "storefront",
  "logistics_bridge",
  "billing",
  "staff_management",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export type ProductCategorySeed = {
  code: string;
  name: string;
  sortOrder: number;
};

export type ECommerceOsDefaultSeed = {
  roles: Array<{ role: string; label: string }>;
  categories: ProductCategorySeed[];
  store: {
    defaultCurrency: string;
    deliveryRadiusKm: number;
    platformCommissionBps: number;
    deliveryFeeMinor: number;
    pickupAddressLine1: string;
    pickupCity: string;
    pickupCountry: string;
    pickupLat: number;
    pickupLng: number;
  };
  notificationTemplates: Array<{
    key: string;
    channel: "chat" | "sms";
    subject: string;
    body: string;
  }>;
};

export const ECOMMERCEOS_DEFAULT_MODULES: ModuleId[] = [...MODULE_IDS];

export const ECOMMERCEOS_DEFAULT_SEED: ECommerceOsDefaultSeed = {
  roles: [
    { role: "owner", label: "Owner" },
    { role: "admin", label: "Administrator" },
    { role: "manager", label: "Store manager" },
    { role: "clerk", label: "Inventory clerk" },
  ],
  categories: [
    { code: "GROCERY", name: "Groceries", sortOrder: 1 },
    { code: "ELECTRONICS", name: "Electronics", sortOrder: 2 },
    { code: "FASHION", name: "Fashion", sortOrder: 3 },
    { code: "HOME", name: "Home & Living", sortOrder: 4 },
    { code: "HEALTH", name: "Health & Beauty", sortOrder: 5 },
  ],
  store: {
    defaultCurrency: "NGN",
    deliveryRadiusKm: 15,
    platformCommissionBps: 250,
    deliveryFeeMinor: 150_000,
    pickupAddressLine1: "1 LifeOS Plaza",
    pickupCity: "Lagos",
    pickupCountry: "NG",
    pickupLat: 6.5244,
    pickupLng: 3.3792,
  },
  notificationTemplates: [
    {
      key: "ORDER_PAID",
      channel: "chat",
      subject: "Payment received",
      body: "Your order {orderNumber} is paid and being prepared for dispatch.",
    },
    {
      key: "ORDER_IN_TRANSIT",
      channel: "sms",
      subject: "Out for delivery",
      body: "Your order {orderNumber} is on the way.",
    },
    {
      key: "ORDER_DELIVERED",
      channel: "sms",
      subject: "Delivered",
      body: "Your order {orderNumber} has been delivered. Thank you for shopping with {storeName}.",
    },
  ],
};

export type ECommerceOSManifest = {
  appId: "ecommerceos";
  displayName: string;
  version: string;
  description: string;
  distributorPrimitives: Array<"commerce" | "identity" | "billing" | "messaging">;
  requiredPrimitives: RequiredLifeOsPrimitive[];
  defaultModules: ModuleId[];
  defaultSeed: ECommerceOsDefaultSeed;
  brandDefaults: { primaryColor: string; businessType: "retail" };
  install: {
    bootstrapPath: "/v1/distributor/tenants/bootstrap";
    hosProvisionPath: "/internal/distributor/provision";
    oauthDestinations: string[];
  };
};

export const ECOMMERCEOS_MANIFEST: ECommerceOSManifest = {
  appId: "ecommerceos",
  displayName: "ECommerceOS",
  version: "0.1.0",
  description:
    "Physical retail and e-commerce engine — products, inventory, carts, escrow checkout, and LogisticsOS dispatch.",
  distributorPrimitives: ["commerce", "identity", "billing", "messaging"],
  requiredPrimitives: ["identity", "messaging", "storage", "jobs", "distributor", "billing"],
  defaultModules: ECOMMERCEOS_DEFAULT_MODULES,
  defaultSeed: ECOMMERCEOS_DEFAULT_SEED,
  brandDefaults: {
    primaryColor: "#1D4ED8",
    businessType: "retail",
  },
  install: {
    bootstrapPath: "/v1/distributor/tenants/bootstrap",
    hosProvisionPath: "/internal/distributor/provision",
    oauthDestinations: [
      "https://{subdomain}.lifeos.app",
      "https://{subdomain}.lifeos.app/admin",
    ],
  },
};
