import { prisma } from "../db.js";
import { config } from "../config.js";
import { getLifeOsStorageProvider } from "./lifeos/container.js";
import { buyerVisibleTenantWhere } from "./activation.js";

function launchUrl(slug: string, path = ""): string {
  const base = config.storefrontLaunchUrlTemplate.replace("{subdomain}", slug).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : path ? `/${path}` : ""}`;
}

function publicApiBase(): string {
  return (process.env.ECOMMERCEOS_PUBLIC_API_URL ?? process.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");
}

/** Prefer https URL; otherwise expose public media proxy for Drive-backed assets. */
export function publicMediaHref(asset: { id: string; url: string }): string {
  if (asset.url.startsWith("https://")) return asset.url;
  const base = publicApiBase();
  if (base) return `${base}/v1/public/media/${encodeURIComponent(asset.id)}`;
  return `/v1/public/media/${encodeURIComponent(asset.id)}`;
}

export function isPubliclyEligibleProduct(status: string): boolean {
  return status === "active";
}

export function isPubliclyEligibleBusinessPublication(row: {
  status: string;
  audience: string;
  publishedAt: Date | null;
  scheduledAt: Date | null;
}): boolean {
  if (row.status !== "published") return false;
  if (row.audience !== "public") return false;
  if (!row.publishedAt) return false;
  if (row.scheduledAt && row.scheduledAt.getTime() > Date.now()) return false;
  return true;
}

export type LifeOsFeedItem = {
  projectionVersion: 1;
  family: "catalogue" | "publication";
  applicationId: "ecommerceos";
  engine: "ecommerceos";
  verticalId: string | null;
  tenant: {
    canonicalEntityId: string;
    slug: string;
    kind: "BUSINESS";
    displayName: string;
  };
  itemType: string;
  canonicalItemId: string;
  title: string;
  summary: string | null;
  assetReferences: Array<{
    assetId: string;
    ownerEntityId: string;
    href: string;
    kind: "image" | "video" | "file";
    alt: string | null;
  }>;
  availability: "available" | "unavailable" | "unknown";
  price: { amount: string; currency: string } | null;
  catalogueMetadata: Record<string, unknown> | null;
  presentationHints: { kind: string; immersiveEligible: boolean };
  canonicalSourceUrl: string;
  sourceSurface: "storefront";
  publishedAt: string | null;
  updatedAt: string | null;
  provenance: {
    sourceApplicationId: "ecommerceos";
    sourceTenantSlug: string;
    sourceItemId: string;
    sourceContract: string;
  };
  relatedItem?: { kind: "product"; id: string; canonicalSourceUrl: string } | null;
};

type CursorPayload = { k: "product" | "publication"; t: string; id: string };

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw?: string | null): CursorPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorPayload;
    if ((parsed.k === "product" || parsed.k === "publication") && parsed.t && parsed.id) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

async function projectProductRow(row: {
  id: string;
  title: string;
  description: string;
  status: string;
  images: unknown;
  createdAt: Date;
  updatedAt: Date;
  tenant: { status: string; name: string; businessType: string; storeConfig: { subdomain: string; storeName: string; defaultCurrency: string } | null };
  variants: Array<{ priceMinor: number; status: string }>;
}): Promise<LifeOsFeedItem | null> {
  const store = row.tenant.storeConfig;
  if (!store) return null;
  if (row.tenant.status !== "active") return null;
  if (!isPubliclyEligibleProduct(row.status)) return null;

  const slug = store.subdomain;
  const images = Array.isArray(row.images) ? row.images.map(String) : [];
  const httpsImages = images.filter((u) => u.startsWith("https://"));
  const assetRefs = httpsImages.map((href, i) => ({
    assetId: `${row.id}:img:${i}`,
    ownerEntityId: slug,
    href,
    kind: "image" as const,
    alt: row.title,
  }));

  const activeVariant = row.variants.find((v) => v.status === "active") ?? row.variants[0];
  const price =
    activeVariant != null
      ? {
          amount: (activeVariant.priceMinor / 100).toFixed(2),
          currency: store.defaultCurrency || "NGN",
        }
      : null;

  return {
    projectionVersion: 1,
    family: "catalogue",
    applicationId: "ecommerceos",
    engine: "ecommerceos",
    verticalId: row.tenant.businessType || "retail",
    tenant: {
      canonicalEntityId: slug,
      slug,
      kind: "BUSINESS",
      displayName: store.storeName || row.tenant.name,
    },
    itemType: "PRODUCT",
    canonicalItemId: row.id,
    title: row.title,
    summary: row.description?.replace(/\s+/g, " ").trim().slice(0, 280) || null,
    assetReferences: assetRefs,
    availability: "available",
    price,
    catalogueMetadata: { domainModel: "retail_commerce" },
    presentationHints: { kind: "product", immersiveEligible: true },
    canonicalSourceUrl: launchUrl(slug, `/product/${row.id}`),
    sourceSurface: "storefront",
    publishedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    provenance: {
      sourceApplicationId: "ecommerceos",
      sourceTenantSlug: slug,
      sourceItemId: row.id,
      sourceContract: "ecommerceos.public_lifeos_feed_v1",
    },
  };
}

async function projectBusinessPublicationRow(row: {
  id: string;
  tenantId: string;
  type: string;
  title: string;
  caption: string;
  status: string;
  audience: string;
  relatedProductId: string | null;
  mediaAssetIds: unknown;
  publishedAt: Date | null;
  scheduledAt: Date | null;
  updatedAt: Date;
  tenant: { status: string; name: string; storeConfig: { subdomain: string; storeName: string } | null };
}): Promise<LifeOsFeedItem | null> {
  const store = row.tenant.storeConfig;
  if (!store) return null;
  if (row.tenant.status !== "active") return null;
  if (!isPubliclyEligibleBusinessPublication(row)) return null;

  const slug = store.subdomain;
  const ids = Array.isArray(row.mediaAssetIds) ? row.mediaAssetIds.map(String) : [];
  const tenantAssets = ids.length
    ? await prisma.mediaAsset.findMany({ where: { id: { in: ids }, tenantId: row.tenantId } })
    : [];

  const assetReferences = tenantAssets.map((a) => {
    const kind: "image" | "video" | "file" =
      (a.contentType || "").startsWith("video/") || row.type === "VIDEO"
        ? "video"
        : (a.contentType || "").startsWith("image/") || row.type === "PHOTO"
          ? "image"
          : "file";
    return {
      assetId: a.id,
      ownerEntityId: slug,
      href: publicMediaHref(a),
      kind,
      alt: row.title || row.caption || null,
    };
  });

  const related =
    row.relatedProductId != null
      ? {
          kind: "product" as const,
          id: row.relatedProductId,
          canonicalSourceUrl: launchUrl(slug, `/product/${row.relatedProductId}`),
        }
      : null;

  return {
    projectionVersion: 1,
    family: "publication",
    applicationId: "ecommerceos",
    engine: "ecommerceos",
    verticalId: null,
    tenant: {
      canonicalEntityId: slug,
      slug,
      kind: "BUSINESS",
      displayName: store.storeName || row.tenant.name,
    },
    itemType: row.type === "VIDEO" ? "VIDEO" : row.type === "PHOTO" ? "PHOTO" : "POST",
    canonicalItemId: row.id,
    title: row.title || row.caption || "Update",
    summary: row.caption || null,
    assetReferences,
    availability: "available",
    price: null,
    catalogueMetadata: related ? { relatedProductId: related.id } : null,
    presentationHints: {
      kind: row.type.toLowerCase(),
      immersiveEligible: true,
    },
    canonicalSourceUrl: launchUrl(slug, `/p/${row.id}`),
    sourceSurface: "storefront",
    publishedAt: row.publishedAt!.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    provenance: {
      sourceApplicationId: "ecommerceos",
      sourceTenantSlug: slug,
      sourceItemId: row.id,
      sourceContract: "ecommerceos.public_lifeos_feed_v1",
    },
    relatedItem: related,
  };
}

/**
 * Cross-tenant public LifeOS discovery feed (no management credentials).
 * Only active tenants + public eligible products/publications.
 */
export async function listLifeOsPublicFeed(opts?: {
  cursor?: string | null;
  limit?: number;
  kind?: "product" | "publication" | "all";
}): Promise<{ items: LifeOsFeedItem[]; nextCursor: string | null; count: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 24, 1), 50);
  const kind = opts?.kind ?? "all";
  const cursor = decodeCursor(opts?.cursor);

  const productWhere: Record<string, unknown> = {
    status: "active",
    tenant: { status: "active", storeConfig: { isNot: null }, ...buyerVisibleTenantWhere() },
  };
  const pubWhere: Record<string, unknown> = {
    status: "published",
    audience: "public",
    publishedAt: { not: null, lte: new Date() },
    OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
    tenant: { status: "active", storeConfig: { isNot: null }, ...buyerVisibleTenantWhere() },
  };

  if (cursor?.k === "product" && (kind === "all" || kind === "product")) {
    productWhere.OR = [
      { createdAt: { lt: new Date(cursor.t) } },
      { createdAt: new Date(cursor.t), id: { lt: cursor.id } },
    ];
  }
  if (cursor?.k === "publication" && (kind === "all" || kind === "publication")) {
    pubWhere.OR = [
      { publishedAt: { lt: new Date(cursor.t) } },
      { publishedAt: new Date(cursor.t), id: { lt: cursor.id } },
    ];
  }

  const take = limit + 1;
  const [products, publications] = await Promise.all([
    kind === "publication"
      ? Promise.resolve([])
      : prisma.product.findMany({
          where: productWhere as never,
          include: {
            tenant: { include: { storeConfig: true } },
            variants: { where: { status: "active" }, take: 1 },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
        }),
    kind === "product"
      ? Promise.resolve([])
      : prisma.businessPublication.findMany({
          where: pubWhere as never,
          include: { tenant: { include: { storeConfig: true } } },
          orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
          take,
        }),
  ]);

  const projected: Array<{ item: LifeOsFeedItem; sortAt: number; kind: "product" | "publication"; id: string }> =
    [];

  for (const p of products) {
    const item = await projectProductRow(p);
    if (item) projected.push({ item, sortAt: p.createdAt.getTime(), kind: "product", id: p.id });
  }
  for (const pub of publications) {
    const item = await projectBusinessPublicationRow(pub);
    if (item && pub.publishedAt) {
      projected.push({ item, sortAt: pub.publishedAt.getTime(), kind: "publication", id: pub.id });
    }
  }

  projected.sort((a, b) => {
    if (b.sortAt !== a.sortAt) return b.sortAt - a.sortAt;
    return b.id.localeCompare(a.id);
  });

  const page = projected.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    projected.length > limit && last
      ? encodeCursor({
          k: last.kind,
          t: new Date(last.sortAt).toISOString(),
          id: last.id,
        })
      : null;

  return { items: page.map((p) => p.item), nextCursor, count: page.length };
}

export async function streamPublicMediaAsset(assetId: string): Promise<{
  body: Uint8Array;
  contentType: string;
} | null> {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    include: { tenant: true },
  });
  if (!asset || asset.tenant.status !== "active") return null;

  if (asset.url.startsWith("https://")) {
    const res = await fetch(asset.url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return { body: buf, contentType: asset.contentType || res.headers.get("content-type") || "application/octet-stream" };
  }

  const storage = getLifeOsStorageProvider();
  const got = await storage.get({ namespace: asset.namespace, key: asset.driveKey });
  if (!got) return null;
  return { body: got.body, contentType: got.contentType || asset.contentType || "application/octet-stream" };
}
