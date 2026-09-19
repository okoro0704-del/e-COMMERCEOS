import { prisma } from "../db.js";
import {
  isPubliclyEligibleBusinessPublication,
  publicMediaHref,
} from "./lifeos-public-feed.js";

function asImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((href) => href.startsWith("https://"));
}

export type PublicStorePublication = {
  publicationId: string;
  publisherEntityId: string;
  subjectEntityIds: string[];
  publishedAt: string;
  status: "published";
  audience: "public";
  type: string;
  title: string | null;
  summary: string | null;
  contentReference: { ownerVertical: "ecommerceos"; kind: string; nativeId: string };
  mediaReferences: Array<{ href: string; kind: "image" | "video"; alt: string | null }>;
  provenance: {
    sourceId: string;
    sourceType: "canonical_publication";
    publisherEntityId: string;
    canonicalUrl: string;
    publicationId: string;
    title?: string;
    publishedAt: string;
    available: boolean;
  };
  canonicalUrl: string;
};

function mediaKindForPublication(
  type: string,
  contentType: string | null | undefined,
): "image" | "video" {
  if ((contentType || "").startsWith("video/") || type === "VIDEO") return "video";
  return "image";
}

export async function listPublicPublications(tenantId: string): Promise<PublicStorePublication[]> {
  const store = await prisma.storeConfig.findUnique({ where: { tenantId } });
  if (!store) return [];
  const slug = store.subdomain;

  const [products, publications] = await Promise.all([
    prisma.product.findMany({
      where: { tenantId, status: "active" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.businessPublication.findMany({
      where: {
        tenantId,
        status: "published",
        audience: "public",
        type: { in: ["PHOTO", "VIDEO", "POST"] },
        publishedAt: { not: null },
      },
      orderBy: { publishedAt: "desc" },
    }),
  ]);

  const productRows: PublicStorePublication[] = products.map((product) => ({
    publicationId: `ecommerceos:product:${product.id}`,
    publisherEntityId: slug,
    subjectEntityIds: [slug],
    publishedAt: product.createdAt.toISOString(),
    status: "published" as const,
    audience: "public" as const,
    type: "update",
    title: product.title || null,
    summary: product.description.replace(/\s+/g, " ").trim().slice(0, 280) || null,
    contentReference: { ownerVertical: "ecommerceos" as const, kind: "product", nativeId: product.id },
    mediaReferences: asImages(product.images).map((href) => ({
      href,
      kind: "image" as const,
      alt: product.title || null,
    })),
    provenance: {
      sourceId: `publication:ecommerceos:product:${product.id}`,
      sourceType: "canonical_publication" as const,
      publisherEntityId: slug,
      canonicalUrl: `https://${slug}.getlifeos.app/product/${product.id}`,
      publicationId: `ecommerceos:product:${product.id}`,
      title: product.title || undefined,
      publishedAt: product.createdAt.toISOString(),
      available: true,
    },
    canonicalUrl: `https://${slug}.getlifeos.app/product/${product.id}`,
  }));

  const publicationRows: PublicStorePublication[] = [];
  for (const row of publications) {
    if (!isPubliclyEligibleBusinessPublication(row)) continue;

    const ids = Array.isArray(row.mediaAssetIds) ? row.mediaAssetIds.map(String) : [];
    const assets = ids.length
      ? await prisma.mediaAsset.findMany({ where: { tenantId, id: { in: ids } } })
      : [];

    const mediaReferences = assets
      .map((asset) => {
        const href = publicMediaHref(asset);
        if (!href.startsWith("https://") && !href.includes("/v1/public/media/")) return null;
        return {
          href,
          kind: mediaKindForPublication(row.type, asset.contentType),
          alt: row.title || row.caption || null,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m != null);

    const publishedAt = row.publishedAt!.toISOString();
    const canonicalUrl = `/p/${row.id}`;
    publicationRows.push({
      publicationId: `ecommerceos:publication:${row.id}`,
      publisherEntityId: slug,
      subjectEntityIds: [slug],
      publishedAt,
      status: "published",
      audience: "public",
      type: row.type.toLowerCase(),
      title: row.title || null,
      summary: row.caption?.replace(/\s+/g, " ").trim().slice(0, 280) || null,
      contentReference: {
        ownerVertical: "ecommerceos",
        kind: "publication",
        nativeId: row.id,
      },
      mediaReferences,
      provenance: {
        sourceId: `publication:ecommerceos:publication:${row.id}`,
        sourceType: "canonical_publication",
        publisherEntityId: slug,
        canonicalUrl,
        publicationId: `ecommerceos:publication:${row.id}`,
        title: row.title || undefined,
        publishedAt,
        available: true,
      },
      canonicalUrl,
    });
  }

  return [...publicationRows, ...productRows].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
}
