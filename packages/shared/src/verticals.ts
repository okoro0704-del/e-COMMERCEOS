/**
 * Canonical EcommerceOS operating models.
 * Vertical IDs `retail` and `delivery` are stable (Physical Store / Online Store).
 */

export const ECOMMERCE_OPERATING_MODELS = [
  "store",
  "supermarket",
  "destination",
  "wholesale",
  "marketplace",
] as const;

export type EcommerceOperatingModel = (typeof ECOMMERCE_OPERATING_MODELS)[number];

export const ECOMMERCEOS_VERTICAL_IDS = [
  "retail",
  "delivery",
  "supermarket",
  "shopping_centre",
  "wholesaler",
  "shopping_mall",
  "marketplace",
] as const;

export type EcommerceOsVerticalId = (typeof ECOMMERCEOS_VERTICAL_IDS)[number];

export const ECOMMERCE_VERTICAL_ID_ALIASES: Record<string, EcommerceOsVerticalId> = {
  physical_store: "retail",
  online_store: "delivery",
};

export function canonicalEcommerceVerticalId(id: string): EcommerceOsVerticalId | string {
  return ECOMMERCE_VERTICAL_ID_ALIASES[id] ?? id;
}

export type DestinationOccupant = {
  id: string;
  unitCode: string;
  displayName: string;
  category?: string;
  hours?: string;
  /** Reference to another canonical tenant — never a copied product catalog. */
  referencedTenantId?: string | null;
  referencedSubdomain?: string | null;
};

export type MarketplaceSeller = {
  id: string;
  displayName: string;
  status: "invited" | "active" | "suspended";
  /** Reference to the seller's own application/tenant — not a copied catalog. */
  sellerTenantId?: string | null;
};

export type EcommerceVerticalPreset = {
  id: EcommerceOsVerticalId;
  displayName: string;
  description: string;
  operatingModel: EcommerceOperatingModel;
  hasPhysicalAddress: boolean;
  modules: string[];
  seedCategories: Array<{ code: string; name: string; sortOrder: number }>;
  seedOccupants?: Array<Omit<DestinationOccupant, "id">>;
  wholesale?: { minQuantityDefault: number };
};

export const ECOMMERCEOS_VERTICAL_PRESETS: Record<EcommerceOsVerticalId, EcommerceVerticalPreset> = {
  retail: {
    id: "retail",
    displayName: "Physical Store",
    description: "Run your physical shop and digital commerce together.",
    operatingModel: "store",
    hasPhysicalAddress: true,
    modules: ["catalog", "inventory", "storefront", "cart", "orders", "checkout", "billing", "logistics_bridge", "staff_management"],
    seedCategories: [
      { code: "GROCERY", name: "Groceries", sortOrder: 1 },
      { code: "ELECTRONICS", name: "Electronics", sortOrder: 2 },
      { code: "FASHION", name: "Fashion", sortOrder: 3 },
      { code: "HOME", name: "Home & Living", sortOrder: 4 },
      { code: "HEALTH", name: "Health & Beauty", sortOrder: 5 },
    ],
  },
  delivery: {
    id: "delivery",
    displayName: "Online Store",
    description: "Sell online without needing a customer-facing physical shop.",
    operatingModel: "store",
    hasPhysicalAddress: false,
    modules: ["catalog", "inventory", "storefront", "cart", "orders", "checkout", "billing", "logistics_bridge", "staff_management"],
    seedCategories: [
      { code: "GROCERY", name: "Groceries", sortOrder: 1 },
      { code: "ELECTRONICS", name: "Electronics", sortOrder: 2 },
      { code: "FASHION", name: "Fashion", sortOrder: 3 },
      { code: "HOME", name: "Home & Living", sortOrder: 4 },
      { code: "HEALTH", name: "Health & Beauty", sortOrder: 5 },
    ],
  },
  supermarket: {
    id: "supermarket",
    displayName: "Supermarket",
    description: "Operate high-volume, multi-category retail.",
    operatingModel: "supermarket",
    hasPhysicalAddress: true,
    modules: [
      "catalog",
      "inventory",
      "storefront",
      "cart",
      "orders",
      "checkout",
      "billing",
      "logistics_bridge",
      "departments",
      "promotions",
      "staff_management",
    ],
    seedCategories: [
      { code: "PRODUCE", name: "Produce", sortOrder: 1 },
      { code: "BAKERY", name: "Bakery", sortOrder: 2 },
      { code: "DAIRY", name: "Dairy", sortOrder: 3 },
      { code: "MEAT", name: "Meat & Fish", sortOrder: 4 },
      { code: "GROCERY", name: "Grocery aisles", sortOrder: 5 },
      { code: "HOUSEHOLD", name: "Household", sortOrder: 6 },
    ],
  },
  shopping_centre: {
    id: "shopping_centre",
    displayName: "Shopping Centre",
    description: "Bring the businesses in your commercial centre together digitally.",
    operatingModel: "destination",
    hasPhysicalAddress: true,
    modules: ["directory", "units", "hours", "events", "offers", "storefront", "staff_management"],
    seedCategories: [
      { code: "FOOD", name: "Food court", sortOrder: 1 },
      { code: "RETAIL", name: "Retail units", sortOrder: 2 },
      { code: "SERVICES", name: "Services", sortOrder: 3 },
    ],
    seedOccupants: [
      { unitCode: "A-01", displayName: "Unit A-01", category: "Retail units", hours: "09:00–21:00" },
      { unitCode: "FC-02", displayName: "Food court 02", category: "Food court", hours: "08:00–22:00" },
    ],
  },
  wholesaler: {
    id: "wholesaler",
    displayName: "Wholesaler",
    description: "Run bulk and business-to-business commerce.",
    operatingModel: "wholesale",
    hasPhysicalAddress: true,
    modules: ["catalog", "inventory", "storefront", "orders", "checkout", "billing", "bulk_orders", "wholesale_pricing", "staff_management"],
    seedCategories: [
      { code: "CARTON", name: "Carton goods", sortOrder: 1 },
      { code: "PALLET", name: "Pallet lots", sortOrder: 2 },
      { code: "INGREDIENTS", name: "Ingredients", sortOrder: 3 },
    ],
    wholesale: { minQuantityDefault: 6 },
  },
  shopping_mall: {
    id: "shopping_mall",
    displayName: "Shopping Mall",
    description: "Operate a multi-store shopping destination.",
    operatingModel: "destination",
    hasPhysicalAddress: true,
    modules: ["directory", "units", "hours", "events", "offers", "facilities", "storefront", "staff_management"],
    seedCategories: [
      { code: "ANCHOR", name: "Anchor stores", sortOrder: 1 },
      { code: "FASHION", name: "Fashion", sortOrder: 2 },
      { code: "DINING", name: "Dining", sortOrder: 3 },
      { code: "LEISURE", name: "Leisure & cinema", sortOrder: 4 },
    ],
    seedOccupants: [
      { unitCode: "L1-10", displayName: "Level 1 — Unit 10", category: "Fashion", hours: "10:00–22:00" },
      { unitCode: "L0-FOOD", displayName: "Food hall", category: "Dining", hours: "09:00–22:00" },
      { unitCode: "FAC-PARK", displayName: "Parking & facilities", category: "Leisure & cinema", hours: "06:00–00:00" },
    ],
  },
  marketplace: {
    id: "marketplace",
    displayName: "Marketplace",
    description: "Operate a commerce platform for independent sellers.",
    operatingModel: "marketplace",
    hasPhysicalAddress: false,
    modules: ["directory", "seller_participation", "catalog", "storefront", "orders", "staff_management"],
    seedCategories: [
      { code: "SELLERS", name: "Sellers", sortOrder: 1 },
      { code: "OFFERS", name: "Marketplace offers", sortOrder: 2 },
    ],
  },
};

export function ecommerceVerticalPreset(verticalId?: string | null): EcommerceVerticalPreset {
  const id = canonicalEcommerceVerticalId(verticalId ?? "retail");
  if (id in ECOMMERCEOS_VERTICAL_PRESETS) {
    return ECOMMERCEOS_VERTICAL_PRESETS[id as EcommerceOsVerticalId];
  }
  return ECOMMERCEOS_VERTICAL_PRESETS.retail;
}
