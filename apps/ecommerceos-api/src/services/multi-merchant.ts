import { randomBytes, randomUUID } from "node:crypto";
import {
  isOnlineMarketplaceOperator,
  type DestinationOccupant,
  type MarketplaceMembershipStatus,
  type MarketplaceSeller,
} from "@ecommerceos/shared";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { httpError } from "../lib/crypto.js";
import { listCategories, listProducts, getProduct } from "./catalog.js";
import { provisionEcommerceTenant } from "./distributor/provision-tenant.js";

type TenantSettings = Record<string, unknown>;

async function readTenant(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { organization: true, storeConfig: true },
  });
  if (!tenant) throw httpError(404, "not_found", "Tenant not found");
  return tenant;
}

function asSettings(raw: unknown): TenantSettings {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as TenantSettings) } : {};
}

async function readSettings(tenantId: string): Promise<TenantSettings> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  return asSettings(tenant?.settings);
}

async function writeSettings(tenantId: string, settings: TenantSettings) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: settings as object } });
  return settings;
}

function normalizeSeller(row: MarketplaceSeller): MarketplaceSeller {
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status ?? "invited",
    sellerTenantId: row.sellerTenantId ?? null,
    sellerApplicationId: row.sellerApplicationId ?? null,
    sellerSubdomain: row.sellerSubdomain ?? null,
    publicUrl: row.publicUrl ?? null,
    adminUrl: row.adminUrl ?? null,
    createdByMarketplace: row.createdByMarketplace ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listOccupants(tenantId: string): Promise<DestinationOccupant[]> {
  const settings = await readSettings(tenantId);
  return Array.isArray(settings.destinationOccupants)
    ? (settings.destinationOccupants as DestinationOccupant[])
    : [];
}

export async function addOccupant(
  tenantId: string,
  input: Omit<DestinationOccupant, "id">,
): Promise<DestinationOccupant[]> {
  const settings = await readSettings(tenantId);
  const occupants = Array.isArray(settings.destinationOccupants)
    ? [...(settings.destinationOccupants as DestinationOccupant[])]
    : [];
  occupants.push({
    id: `occ_${randomUUID().slice(0, 8)}`,
    unitCode: input.unitCode,
    displayName: input.displayName,
    category: input.category,
    hours: input.hours,
    referencedTenantId: input.referencedTenantId ?? null,
    referencedSubdomain: input.referencedSubdomain ?? null,
  });
  settings.destinationOccupants = occupants;
  await writeSettings(tenantId, settings);
  return occupants;
}

export async function listSellers(tenantId: string): Promise<MarketplaceSeller[]> {
  const settings = await readSettings(tenantId);
  return Array.isArray(settings.marketplaceSellers)
    ? (settings.marketplaceSellers as MarketplaceSeller[]).map(normalizeSeller)
    : [];
}

export async function requireMarketplaceOperator(tenantId: string) {
  const tenant = await readTenant(tenantId);
  const settings = asSettings(tenant.settings);
  if (!isOnlineMarketplaceOperator(settings)) {
    throw httpError(403, "forbidden", "Online Marketplace operator mode is not enabled for this application");
  }
  return { tenant, settings };
}

export async function enableOnlineMarketplace(tenantId: string) {
  const tenant = await readTenant(tenantId);
  const settings = asSettings(tenant.settings);
  settings.onlineMarketplace = true;
  if (!Array.isArray(settings.marketplaceSellers)) settings.marketplaceSellers = [];
  await writeSettings(tenantId, settings);
  return marketplaceOverview(tenantId);
}

export async function marketplaceOverview(tenantId: string) {
  const { tenant, settings } = await requireMarketplaceOperator(tenantId);
  const sellers = await listSellers(tenantId);
  const participating = sellers.filter((s) => s.status === "active");
  return {
    operator: {
      tenantId: tenant.id,
      applicationId: tenant.lifeosBusinessId ?? tenant.id,
      name: tenant.storeConfig?.storeName ?? tenant.name,
      slug: tenant.slug,
      verticalId: typeof settings.verticalId === "string" ? settings.verticalId : tenant.businessType,
      operatingModel: settings.operatingModel ?? "marketplace",
      onlineMarketplace: true,
      publicUrl: launchUrl(config.storefrontLaunchUrlTemplate, tenant.slug),
      adminUrl: launchUrl(config.adminLaunchUrlTemplate, tenant.slug),
    },
    stores: sellers,
    participatingCount: participating.length,
    connectExistingStore: "same_organization_only",
    connectArbitraryStore: "NOT IMPLEMENTED — AUTHORIZATION CONTRACT REQUIRED",
    orderRouting: "NOT IMPLEMENTED",
  };
}

function launchUrl(template: string, subdomain: string): string {
  return template.replaceAll("{subdomain}", subdomain);
}

async function registerSellerWithPortal(input: {
  applicationId: string;
  tenantId: string;
  subdomain: string;
  displayName: string;
  marketplaceSubdomain: string;
  organizationId?: string;
}) {
  if (!config.portalApiUrl) return;
  try {
    const res = await fetch(`${config.portalApiUrl}/internal/ecommerceos/seller-install`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.portalInternalToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      console.warn(`portal seller-install ${res.status}`);
    }
  } catch (err) {
    console.warn("portal seller-install failed", err);
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return slug || "store";
}

async function uniqueSubdomain(preferred: string): Promise<string> {
  const base = slugify(preferred);
  for (let i = 0; i < 8; i += 1) {
    const candidate = i === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const existing = await prisma.tenant.findUnique({ where: { slug: candidate } });
    const store = await prisma.storeConfig.findUnique({ where: { subdomain: candidate } });
    if (!existing && !store) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

async function writeSellers(tenantId: string, sellers: MarketplaceSeller[]) {
  const settings = await readSettings(tenantId);
  settings.marketplaceSellers = sellers;
  await writeSettings(tenantId, settings);
  return sellers.map(normalizeSeller);
}

export async function addSeller(
  tenantId: string,
  input: Omit<MarketplaceSeller, "id">,
): Promise<MarketplaceSeller[]> {
  await requireMarketplaceOperator(tenantId);
  const sellers = await listSellers(tenantId);
  const now = new Date().toISOString();
  sellers.push(
    normalizeSeller({
      id: `sel_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      displayName: input.displayName,
      status: input.status ?? "invited",
      sellerTenantId: input.sellerTenantId ?? null,
      sellerApplicationId: input.sellerApplicationId ?? null,
      sellerSubdomain: input.sellerSubdomain ?? null,
      publicUrl: input.publicUrl ?? null,
      adminUrl: input.adminUrl ?? null,
      createdByMarketplace: input.createdByMarketplace ?? false,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return writeSellers(tenantId, sellers);
}

export async function createSellerOnlineStore(
  marketplaceTenantId: string,
  input: {
    displayName: string;
    subdomain?: string;
    city?: string;
    country?: string;
    adminEmail?: string;
    adminPassword?: string;
  },
) {
  const { tenant: marketplace } = await requireMarketplaceOperator(marketplaceTenantId);
  const subdomain = input.subdomain ? await uniqueSubdomain(input.subdomain) : await uniqueSubdomain(input.displayName);
  const applicationId = `ins_${randomUUID().replace(/-/g, "")}`;
  const organization = marketplace.organization;
  const adminPassword = input.adminPassword ?? `Tmp-${randomBytes(6).toString("hex")}!`;
  const adminEmail = input.adminEmail ?? `owner@${subdomain}.commerce.local`;

  const provisioned = await provisionEcommerceTenant({
    distributorTenantId: applicationId,
    subdomain,
    displayName: input.displayName,
    seed: "default",
    verticalId: "delivery",
    hasPhysicalAddress: false,
    organization: organization
      ? { slug: organization.slug, name: organization.name }
      : { slug: `${marketplace.slug}-group`, name: `${marketplace.name} Group` },
    adminStaff: {
      email: adminEmail,
      displayName: input.displayName,
      role: "owner",
      password: adminPassword,
    },
    pickup: {
      city: input.city,
      country: input.country,
    },
  });

  const sellers = await listSellers(marketplaceTenantId);
  const now = new Date().toISOString();
  const membership: MarketplaceSeller = {
    id: `sel_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    displayName: input.displayName,
    status: "active",
    sellerTenantId: provisioned.tenantId,
    sellerApplicationId: applicationId,
    sellerSubdomain: provisioned.slug,
    publicUrl: provisioned.storefrontUrl,
    adminUrl: provisioned.adminConsoleUrl,
    createdByMarketplace: true,
    createdAt: now,
    updatedAt: now,
  };
  sellers.push(membership);
  await writeSellers(marketplaceTenantId, sellers);
  await registerSellerWithPortal({
    applicationId,
    tenantId: provisioned.tenantId,
    subdomain: provisioned.slug,
    displayName: input.displayName,
    marketplaceSubdomain: marketplace.slug,
    organizationId: organization?.id,
  });

  return {
    membership,
    store: {
      applicationId,
      tenantId: provisioned.tenantId,
      slug: provisioned.slug,
      verticalId: provisioned.verticalId,
      publicUrl: provisioned.storefrontUrl,
      adminUrl: provisioned.adminConsoleUrl,
    },
    temporaryAdminPassword: adminPassword,
    adminEmail,
  };
}

export async function connectExistingOnlineStore(
  marketplaceTenantId: string,
  input: { sellerTenantId: string; displayName?: string },
) {
  const { tenant: marketplace } = await requireMarketplaceOperator(marketplaceTenantId);
  const seller = await prisma.tenant.findUnique({
    where: { id: input.sellerTenantId },
    include: { storeConfig: true },
  });
  if (!seller) throw httpError(404, "not_found", "Online Store not found");

  if (!marketplace.organizationId || seller.organizationId !== marketplace.organizationId) {
    throw httpError(
      403,
      "forbidden",
      "CONNECT EXISTING STORE: NOT IMPLEMENTED — AUTHORIZATION CONTRACT REQUIRED",
    );
  }

  const sellerSettings = asSettings(seller.settings);
  const verticalId = typeof sellerSettings.verticalId === "string" ? sellerSettings.verticalId : seller.businessType;
  if (verticalId !== "delivery") {
    throw httpError(400, "invalid_store", "Only a canonical Online Store can be connected");
  }

  const existing = await listSellers(marketplaceTenantId);
  if (existing.some((row) => row.sellerTenantId === seller.id && row.status !== "removed")) {
    throw httpError(409, "conflict", "Store is already participating in this marketplace");
  }

  const subdomain = seller.storeConfig?.subdomain ?? seller.slug;
  return addSeller(marketplaceTenantId, {
    displayName: input.displayName ?? seller.storeConfig?.storeName ?? seller.name,
    status: "active",
    sellerTenantId: seller.id,
    sellerApplicationId: seller.lifeosBusinessId ?? seller.id,
    sellerSubdomain: subdomain,
    publicUrl: launchUrl(config.storefrontLaunchUrlTemplate, subdomain),
    adminUrl: launchUrl(config.adminLaunchUrlTemplate, subdomain),
    createdByMarketplace: false,
  });
}

export async function updateSellerStatus(
  marketplaceTenantId: string,
  sellerId: string,
  status: MarketplaceMembershipStatus,
) {
  await requireMarketplaceOperator(marketplaceTenantId);
  const sellers = await listSellers(marketplaceTenantId);
  const index = sellers.findIndex((row) => row.id === sellerId);
  if (index < 0) throw httpError(404, "not_found", "Marketplace membership not found");
  const current = sellers[index]!;
  sellers[index] = {
    ...current,
    status,
    updatedAt: new Date().toISOString(),
  };
  await writeSellers(marketplaceTenantId, sellers);
  const membership = sellers[index]!;
  let storeStillExists = false;
  let catalogueCount = 0;
  if (membership.sellerTenantId) {
    const store = await prisma.tenant.findUnique({ where: { id: membership.sellerTenantId } });
    storeStillExists = Boolean(store);
    if (store) {
      catalogueCount = await prisma.product.count({ where: { tenantId: store.id } });
    }
  }
  return {
    membership,
    storeDeleted: false,
    storeStillExists,
    catalogueCount,
  };
}

export function participatingSellers(sellers: MarketplaceSeller[]): MarketplaceSeller[] {
  return sellers.filter((row) => row.status === "active" && row.sellerTenantId);
}

export async function projectMarketplaceStores(marketplaceTenantId: string) {
  const sellers = participatingSellers(await listSellers(marketplaceTenantId));
  const stores = [];
  for (const seller of sellers) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: seller.sellerTenantId! },
      include: { storeConfig: true },
    });
    if (!tenant || tenant.status !== "active") continue;
    stores.push({
      storeRef: seller.id,
      name: seller.displayName,
      subdomain: seller.sellerSubdomain ?? tenant.storeConfig?.subdomain ?? tenant.slug,
      publicUrl: seller.publicUrl ?? launchUrl(config.storefrontLaunchUrlTemplate, tenant.slug),
      status: seller.status,
    });
  }
  return stores;
}

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

async function projectSellerProducts(seller: MarketplaceSeller): Promise<MarketplaceProjectedProduct[]> {
  if (!seller.sellerTenantId) return [];
  const tenant = await prisma.tenant.findUnique({
    where: { id: seller.sellerTenantId },
    include: { storeConfig: true },
  });
  if (!tenant || tenant.status !== "active") return [];
  const products = await listProducts(tenant.id, { status: "active" });
  const currency = tenant.storeConfig?.defaultCurrency ?? "NGN";
  const publicUrl = seller.publicUrl ?? launchUrl(config.storefrontLaunchUrlTemplate, tenant.slug);
  return products.map((product) => {
    const variant = product.variants[0];
    return {
      presentationId: `${seller.id}:${product.id}`,
      storeRef: seller.id,
      sellerName: seller.displayName,
      sellerPublicUrl: publicUrl,
      title: product.title,
      description: product.description,
      images: product.images,
      category: product.category ? { code: product.category.code, name: product.category.name } : null,
      priceMinor: variant?.priceMinor ?? null,
      currency,
      available: variant?.available ?? null,
    };
  });
}

export async function projectMarketplaceCatalog(marketplaceTenantId: string, query?: string) {
  const sellers = participatingSellers(await listSellers(marketplaceTenantId));
  const products: MarketplaceProjectedProduct[] = [];
  const categories = new Map<string, string>();
  for (const seller of sellers) {
    const rows = await projectSellerProducts(seller);
    for (const row of rows) {
      if (row.category) categories.set(row.category.code, row.category.name);
      products.push(row);
    }
  }
  const q = query?.trim().toLowerCase();
  const filtered = q
    ? products.filter((row) =>
        [row.title, row.description, row.sellerName, row.category?.name ?? ""].join(" ").toLowerCase().includes(q),
      )
    : products;
  return {
    products: filtered,
    categories: [...categories.entries()].map(([code, name]) => ({ code, name })),
  };
}

export async function projectMarketplaceSearch(marketplaceTenantId: string, query: string) {
  const q = query.trim().toLowerCase();
  const stores = (await projectMarketplaceStores(marketplaceTenantId)).filter((store) =>
    q ? store.name.toLowerCase().includes(q) || store.subdomain.toLowerCase().includes(q) : true,
  );
  const catalog = await projectMarketplaceCatalog(marketplaceTenantId, query);
  return {
    query,
    stores,
    products: catalog.products,
    categories: catalog.categories.filter((row) => (q ? row.name.toLowerCase().includes(q) || row.code.toLowerCase().includes(q) : true)),
  };
}

export async function projectMarketplaceProduct(marketplaceTenantId: string, storeRef: string, productId: string) {
  const sellers = participatingSellers(await listSellers(marketplaceTenantId));
  const seller = sellers.find((row) => row.id === storeRef || row.sellerSubdomain === storeRef);
  if (!seller?.sellerTenantId) throw httpError(404, "not_found", "Store is not participating in this marketplace");
  const product = await getProduct(seller.sellerTenantId, productId);
  const tenant = await prisma.tenant.findUnique({
    where: { id: seller.sellerTenantId },
    include: { storeConfig: true },
  });
  const currency = tenant?.storeConfig?.defaultCurrency ?? "NGN";
  const variant = product.variants[0];
  return {
    presentationId: `${seller.id}:${product.id}`,
    storeRef: seller.id,
    title: product.title,
    description: product.description,
    images: product.images,
    category: product.category ? { name: product.category.name } : null,
    priceMinor: variant?.priceMinor ?? null,
    currency,
    available: variant?.available ?? null,
    seller: {
      name: seller.displayName,
      publicUrl: seller.publicUrl ?? (tenant ? launchUrl(config.storefrontLaunchUrlTemplate, tenant.slug) : null),
      subdomain: seller.sellerSubdomain ?? tenant?.slug ?? null,
    },
  };
}

export async function marketplaceAdminCatalog(marketplaceTenantId: string) {
  await requireMarketplaceOperator(marketplaceTenantId);
  const stores = await projectMarketplaceStores(marketplaceTenantId);
  const catalog = await projectMarketplaceCatalog(marketplaceTenantId);
  return { stores, ...catalog };
}

export async function sellerStoreCategories(sellerTenantId: string) {
  return listCategories(sellerTenantId);
}
