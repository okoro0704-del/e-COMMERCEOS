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
};

export type MerchantSession = {
  token: string;
  staff: {
    id: string;
    displayName: string;
    email: string;
    role: string;
    tenantId: string;
    tenantSlug: string;
  };
};
