export type Storefront = {
  tenantId: string;
  storeName: string;
  subdomain: string;
  defaultCurrency: string;
  deliveryRadiusKm: number;
  deliveryFeeMinor: number;
  pickup: {
    addressLine1: string;
    city: string;
    region?: string | null;
    country: string;
  };
  primaryColor?: string | null;
  verticalId?: string;
  operatingModel?: string;
  hasPhysicalAddress?: boolean;
  onlineMarketplace?: boolean;
  destinationOccupants?: Array<{
    id: string;
    unitCode: string;
    displayName: string;
    category?: string;
    hours?: string;
    referencedSubdomain?: string | null;
  }>;
  marketplaceSellers?: Array<{
    id: string;
    displayName: string;
    status: string;
    sellerTenantId?: string | null;
    sellerApplicationId?: string | null;
    sellerSubdomain?: string | null;
    publicUrl?: string | null;
    adminUrl?: string | null;
    createdByMarketplace?: boolean;
  }>;
  wholesale?: { minQuantityDefault?: number } | null;
  checkout?: { onlinePayment: boolean };
  /** Closed while the store awaits its verified setup payment. */
  activation?: { open: boolean };
};

export type Product = {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  status: string;
  images: string[];
  category: { id: string; code: string; name: string } | null;
  variants: Array<{
    id: string;
    sku: string;
    title: string;
    priceMinor: number;
    available: number;
    status: string;
    images: string[];
  }>;
};

export type MarketplaceStore = {
  storeRef: string;
  name: string;
  subdomain: string;
  publicUrl: string;
  status: string;
};

export type MarketplaceProjectedProduct = {
  presentationId: string;
  storeRef: string;
  sellerName: string;
  sellerPublicUrl: string | null;
  title: string;
  description: string;
  images: string[];
  category: { code: string; name: string } | null;
  priceMinor: number | null;
  currency: string;
  available: number | null;
};

export type MarketplaceProductDetail = {
  presentationId: string;
  storeRef: string;
  title: string;
  description: string;
  images: string[];
  category: { name: string } | null;
  priceMinor: number | null;
  currency: string;
  available: number | null;
  seller: {
    name: string;
    publicUrl: string | null;
    subdomain: string | null;
  };
};

export type MarketplaceSearch = {
  query: string;
  stores: MarketplaceStore[];
  products: MarketplaceProjectedProduct[];
  categories: Array<{ code: string; name: string }>;
};

export type MarketplaceCreatedStore = {
  membership: NonNullable<Storefront["marketplaceSellers"]>[number];
  store: {
    applicationId: string;
    tenantId: string;
    slug: string;
    verticalId: string;
    publicUrl: string;
    adminUrl: string;
  };
  temporaryAdminPassword?: string;
  adminEmail?: string;
};

export type Cart = {
  id: string;
  tenantId: string;
  items: Array<{
    id: string;
    variantId: string;
    productId: string;
    productTitle: string;
    sku: string;
    title: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
};

export type Order = {
  id: string;
  orderNumber: string;
  status: string;
  buyerName: string;
  totalMinor: number;
  currency: string;
  createdAt: string;
  logisticsJobId?: string | null;
  paymentExpiresAt?: string;
  paymentStatus?: "unpaid" | "simulated_not_paid" | "provider_reported";
  paymentVerified?: boolean;
  fulfilmentStatus?: string;
};

export type MerchantSession = {
  token: string;
  passwordSet?: boolean;
  mustChangePassword?: boolean;
  staff: {
    id: string;
    displayName: string;
    email: string;
    role: string;
    tenantId: string;
    tenantSlug: string;
  };
};

export type ActivationOffer = {
  plan: "standard" | "early_adopter";
  amountMinor: number;
  currency: string;
  available: boolean;
  reason?: string;
};

export type ActivationRecord = {
  id: string;
  plan: string;
  amountMinor: number;
  currency: string;
  status: "payment_submitted" | "verified" | "rejected" | "reversed";
  paymentReference: string;
  payerName: string;
  paidAt: string | null;
  submittedAt: string;
  verifiedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  reversedAt: string | null;
  reversedReason: string | null;
  partner: { code: string; name: string } | null;
  commission: { amountMinor: number; currency: string; rateBps: number; status: string } | null;
  store?: { tenantId: string; slug: string; name: string };
};

export type StoreActivation = {
  required: boolean;
  status: "legacy" | "pending" | "active";
  storeOpen: boolean;
  offers: ActivationOffer[];
  paymentInstructions: string;
  submissions: ActivationRecord[];
};

export type PlatformOperator = { id?: string; operatorId?: string; email: string; displayName: string; role: "verifier" | "admin" };
export type PlatformSession = { token: string; expiresAt: string; operator: PlatformOperator };

export type MarketingPartner = {
  id: string;
  code: string;
  name: string;
  email: string;
  status: "active" | "suspended";
  createdAt: string;
  referrals: number;
  verifiedReferrals: number;
  commissionAccruedMinor: Record<string, number>;
  commissionReversedMinor: Record<string, number>;
};

export type PartnerCommissionRow = {
  id: string;
  partner: { id: string; code: string; name: string };
  activationId: string;
  store: { slug: string; name: string };
  rateBps: number;
  amountMinor: number;
  currency: string;
  status: "accrued" | "reversed";
  createdAt: string;
  reversedAt: string | null;
};

export type PlatformOverview = {
  activationRequired: boolean;
  stores: Record<string, number>;
  activations: Record<string, number>;
  partners: Record<string, number>;
  verifiedSetupFeesMinor: Record<string, number>;
  commissionsMinor: Array<{ status: string; currency: string; amountMinor: number }>;
};

export type PlatformStore = {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  activationStatus: string;
  currency: string | null;
  createdAt: string;
};
