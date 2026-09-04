import { prisma } from "../db.js";
import { driveUrl, httpError } from "../lib/crypto.js";
import { writeAudit } from "../lib/audit.js";
import { getLifeOsStorageProvider } from "./lifeos/container.js";
import type { Prisma } from "@prisma/client";

function asImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}

export async function listCategories(tenantId: string) {
  return prisma.productCategory.findMany({
    where: { tenantId, status: "active" },
    orderBy: { sortOrder: "asc" },
  });
}

export async function createProduct(opts: {
  tenantId: string;
  actorId?: string;
  title: string;
  description?: string;
  categoryId?: string;
  images?: string[];
  variants?: Array<{
    sku: string;
    title?: string;
    barcode?: string;
    priceMinor: number;
    inventoryCount?: number;
    weightGrams?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    images?: string[];
  }>;
}) {
  if (opts.categoryId) {
    const cat = await prisma.productCategory.findFirst({
      where: { id: opts.categoryId, tenantId: opts.tenantId },
    });
    if (!cat) throw httpError(404, "not_found", "Category not found");
  }

  const product = await prisma.product.create({
    data: {
      tenantId: opts.tenantId,
      categoryId: opts.categoryId,
      title: opts.title,
      description: opts.description ?? "",
      status: "active",
      images: (opts.images ?? []) as Prisma.InputJsonValue,
      variants: opts.variants?.length
        ? {
            create: opts.variants.map((v) => ({
              tenantId: opts.tenantId,
              sku: v.sku,
              title: v.title ?? opts.title,
              barcode: v.barcode,
              priceMinor: v.priceMinor,
              inventoryCount: v.inventoryCount ?? 0,
              reservedCount: 0,
              weightGrams: v.weightGrams ?? 0,
              lengthCm: v.lengthCm ?? 0,
              widthCm: v.widthCm ?? 0,
              heightCm: v.heightCm ?? 0,
              images: (v.images ?? []) as Prisma.InputJsonValue,
              status: "active",
            })),
          }
        : undefined,
    },
    include: { variants: true, category: true },
  });

  await writeAudit({
    tenantId: opts.tenantId,
    actorKind: "merchant",
    actorId: opts.actorId,
    action: "product.create",
    resource: "product",
    resourceId: product.id,
  });

  return serializeProduct(product);
}

export async function listProducts(tenantId: string, opts?: { status?: string; categoryId?: string }) {
  const products = await prisma.product.findMany({
    where: {
      tenantId,
      status: opts?.status,
      categoryId: opts?.categoryId,
    },
    include: { variants: true, category: true },
    orderBy: { createdAt: "desc" },
  });
  return products.map(serializeProduct);
}

export async function getProduct(tenantId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId },
    include: { variants: true, category: true },
  });
  if (!product) throw httpError(404, "not_found", "Product not found");
  return serializeProduct(product);
}

export async function updateProduct(
  tenantId: string,
  productId: string,
  patch: { title?: string; description?: string; categoryId?: string | null; status?: string; images?: string[] },
) {
  await getProduct(tenantId, productId);
  const product = await prisma.product.update({
    where: { id: productId },
    data: {
      title: patch.title,
      description: patch.description,
      categoryId: patch.categoryId,
      status: patch.status,
      images: patch.images as Prisma.InputJsonValue | undefined,
    },
    include: { variants: true, category: true },
  });
  return serializeProduct(product);
}

export async function createVariant(
  tenantId: string,
  productId: string,
  input: {
    sku: string;
    title?: string;
    barcode?: string;
    priceMinor: number;
    inventoryCount?: number;
    weightGrams?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    images?: string[];
  },
) {
  const product = await prisma.product.findFirst({ where: { id: productId, tenantId } });
  if (!product) throw httpError(404, "not_found", "Product not found");

  const existing = await prisma.productVariant.findUnique({
    where: { tenantId_sku: { tenantId, sku: input.sku } },
  });
  if (existing) throw httpError(409, "conflict", `SKU already exists: ${input.sku}`);

  return prisma.productVariant.create({
    data: {
      tenantId,
      productId,
      sku: input.sku,
      title: input.title ?? product.title,
      barcode: input.barcode,
      priceMinor: input.priceMinor,
      inventoryCount: input.inventoryCount ?? 0,
      reservedCount: 0,
      weightGrams: input.weightGrams ?? 0,
      lengthCm: input.lengthCm ?? 0,
      widthCm: input.widthCm ?? 0,
      heightCm: input.heightCm ?? 0,
      images: (input.images ?? []) as Prisma.InputJsonValue,
      status: "active",
    },
  });
}

export async function updateVariant(
  tenantId: string,
  variantId: string,
  patch: {
    title?: string;
    barcode?: string | null;
    priceMinor?: number;
    weightGrams?: number;
    lengthCm?: number;
    widthCm?: number;
    heightCm?: number;
    status?: string;
    images?: string[];
  },
) {
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, tenantId } });
  if (!variant) throw httpError(404, "not_found", "Variant not found");
  return prisma.productVariant.update({
    where: { id: variantId },
    data: {
      title: patch.title,
      barcode: patch.barcode,
      priceMinor: patch.priceMinor,
      weightGrams: patch.weightGrams,
      lengthCm: patch.lengthCm,
      widthCm: patch.widthCm,
      heightCm: patch.heightCm,
      status: patch.status,
      images: patch.images as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function uploadProductImage(opts: {
  tenantId: string;
  productId?: string;
  filename: string;
  body: Uint8Array | string;
  contentType?: string;
}) {
  const storage = getLifeOsStorageProvider();
  const key = `products/${opts.productId ?? "unassigned"}/${Date.now()}-${opts.filename}`;
  const ref = await storage.put({
    namespace: opts.tenantId,
    key,
    body: opts.body,
    contentType: opts.contentType ?? "image/jpeg",
  });
  const url = ref.url ?? driveUrl(ref.namespace, ref.key);
  await prisma.mediaAsset.create({
    data: {
      tenantId: opts.tenantId,
      namespace: ref.namespace,
      driveKey: ref.key,
      contentType: ref.contentType,
      sizeBytes: ref.sizeBytes ?? null,
      url,
    },
  });
  return { url, key: ref.key, namespace: ref.namespace };
}

function serializeProduct(product: {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  status: string;
  images: unknown;
  category: { id: string; code: string; name: string } | null;
  variants: Array<{
    id: string;
    sku: string;
    title: string;
    barcode: string | null;
    priceMinor: number;
    inventoryCount: number;
    reservedCount: number;
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    images: unknown;
    status: string;
  }>;
}) {
  return {
    id: product.id,
    tenantId: product.tenantId,
    title: product.title,
    description: product.description,
    status: product.status,
    images: asImages(product.images),
    category: product.category,
    variants: product.variants.map((v) => ({
      ...v,
      images: asImages(v.images),
      available: v.inventoryCount - v.reservedCount,
    })),
  };
}
