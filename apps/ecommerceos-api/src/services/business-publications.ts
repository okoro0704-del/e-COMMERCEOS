import { z } from "zod";
import { prisma } from "../db.js";
import { httpError } from "../lib/crypto.js";
import { isPubliclyEligibleBusinessPublication, publicMediaHref } from "./lifeos-public-feed.js";
import { config } from "../config.js";

const CreateSchema = z.object({
  type: z.enum(["PHOTO", "VIDEO", "POST"]),
  title: z.string().max(200).optional(),
  caption: z.string().max(4000).optional(),
  mediaAssetIds: z.array(z.string().min(1)).min(1).max(8),
  relatedProductId: z.string().min(1).optional().nullable(),
  status: z.enum(["draft", "published"]).default("draft"),
  scheduledAt: z.string().datetime().optional().nullable(),
});

function launchUrl(slug: string, path: string): string {
  const base = config.storefrontLaunchUrlTemplate.replace("{subdomain}", slug).replace(/\/$/, "");
  return `${base}${path}`;
}

export async function listMerchantBusinessPublications(tenantId: string) {
  return prisma.businessPublication.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: "desc" }],
  });
}

export async function createBusinessPublication(tenantId: string, raw: unknown) {
  const input = CreateSchema.parse(raw);

  const assets = await prisma.mediaAsset.findMany({
    where: { tenantId, id: { in: input.mediaAssetIds } },
  });
  if (assets.length !== input.mediaAssetIds.length) {
    throw httpError(400, "invalid_media", "All media assets must belong to this store");
  }

  if (input.relatedProductId) {
    const product = await prisma.product.findFirst({
      where: { id: input.relatedProductId, tenantId },
    });
    if (!product) throw httpError(400, "invalid_product", "Related product must belong to this store");
  }

  const now = new Date();
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const publishing = input.status === "published";
  if (publishing && scheduledAt && scheduledAt.getTime() > Date.now()) {
    /* scheduled future — store as published with schedule gate */
  }

  return prisma.businessPublication.create({
    data: {
      tenantId,
      type: input.type,
      title: input.title?.trim() || "",
      caption: input.caption?.trim() || "",
      status: input.status,
      audience: "public",
      relatedProductId: input.relatedProductId ?? null,
      mediaAssetIds: input.mediaAssetIds,
      publishedAt: publishing ? now : null,
      scheduledAt,
    },
  });
}

export async function getPublicBusinessPublication(publicationId: string) {
  const row = await prisma.businessPublication.findUnique({
    where: { id: publicationId },
    include: { tenant: { include: { storeConfig: true } } },
  });
  if (!row?.tenant.storeConfig) return null;
  if (row.tenant.status !== "active") return null;
  if (!isPubliclyEligibleBusinessPublication(row)) return null;

  const slug = row.tenant.storeConfig.subdomain;
  const ids = Array.isArray(row.mediaAssetIds) ? row.mediaAssetIds.map(String) : [];
  const assets = await prisma.mediaAsset.findMany({ where: { tenantId: row.tenantId, id: { in: ids } } });

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    caption: row.caption,
    storeName: row.tenant.storeConfig.storeName,
    slug,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    relatedProductId: row.relatedProductId,
    media: assets.map((a) => ({
      assetId: a.id,
      href: publicMediaHref(a),
      contentType: a.contentType,
    })),
    canonicalSourceUrl: launchUrl(slug, `/p/${row.id}`),
    storeUrl: launchUrl(slug, "/"),
    productUrl: row.relatedProductId ? launchUrl(slug, `/product/${row.relatedProductId}`) : null,
  };
}
