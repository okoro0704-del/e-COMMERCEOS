import { prisma } from "../db.js";

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
  mediaReferences: Array<{ href: string; kind: "image"; alt: string | null }>;
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

export async function listPublicPublications(tenantId: string): Promise<PublicStorePublication[]> {
  const store = await prisma.storeConfig.findUnique({ where: { tenantId } });
  if (!store) return [];
  const slug = store.subdomain;
  const products = await prisma.product.findMany({
    where: { tenantId, status: "active" },
    orderBy: { createdAt: "desc" },
  });
  return products.map((product) => ({
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
}
