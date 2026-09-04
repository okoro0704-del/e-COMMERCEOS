import { availableInventory } from "@ecommerceos/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { httpError } from "../lib/crypto.js";
import { writeAudit } from "../lib/audit.js";

export async function listInventory(tenantId: string, opts?: { lowStock?: boolean; threshold?: number }) {
  const variants = await prisma.productVariant.findMany({
    where: { tenantId, status: "active" },
    include: { product: { select: { id: true, title: true } } },
    orderBy: { sku: "asc" },
  });
  const rows = variants.map((v) => ({
    variantId: v.id,
    productId: v.productId,
    productTitle: v.product.title,
    sku: v.sku,
    barcode: v.barcode,
    inventoryCount: v.inventoryCount,
    reservedCount: v.reservedCount,
    available: availableInventory(v.inventoryCount, v.reservedCount),
    weightGrams: v.weightGrams,
    dimensions: { lengthCm: v.lengthCm, widthCm: v.widthCm, heightCm: v.heightCm },
  }));
  if (opts?.lowStock) {
    const threshold = opts.threshold ?? 5;
    return rows.filter((r) => r.available <= threshold);
  }
  return rows;
}

export async function adjustInventory(opts: {
  tenantId: string;
  variantId: string;
  delta: number;
  reason: string;
  reference?: string;
  actorId?: string;
}) {
  if (opts.delta === 0) throw httpError(400, "invalid_delta", "Inventory delta cannot be zero");

  const variant = await prisma.productVariant.findFirst({
    where: { id: opts.variantId, tenantId: opts.tenantId },
  });
  if (!variant) throw httpError(404, "not_found", "Variant not found");

  const nextCount = variant.inventoryCount + opts.delta;
  if (nextCount < variant.reservedCount) {
    throw httpError(409, "insufficient_stock", "Cannot reduce on-hand below reserved quantity");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.productVariant.update({
      where: { id: opts.variantId },
      data: { inventoryCount: nextCount },
    });
    await tx.inventoryMovement.create({
      data: {
        tenantId: opts.tenantId,
        variantId: opts.variantId,
        delta: opts.delta,
        reason: opts.reason,
        reference: opts.reference,
      },
    });
    return row;
  });

  await writeAudit({
    tenantId: opts.tenantId,
    actorKind: "merchant",
    actorId: opts.actorId,
    action: "inventory.adjust",
    resource: "variant",
    resourceId: opts.variantId,
    metadata: { delta: opts.delta, reason: opts.reason },
  });

  return {
    variantId: updated.id,
    sku: updated.sku,
    inventoryCount: updated.inventoryCount,
    reservedCount: updated.reservedCount,
    available: availableInventory(updated.inventoryCount, updated.reservedCount),
  };
}

export async function reserveInventory(
  tx: Prisma.TransactionClient,
  opts: { tenantId: string; variantId: string; quantity: number; reference: string },
) {
  const variant = await tx.productVariant.findFirst({
    where: { id: opts.variantId, tenantId: opts.tenantId },
  });
  if (!variant) throw httpError(404, "not_found", "Variant not found");
  const available = availableInventory(variant.inventoryCount, variant.reservedCount);
  if (available < opts.quantity) {
    throw httpError(409, "insufficient_stock", `SKU ${variant.sku} has only ${available} available`);
  }
  await tx.productVariant.update({
    where: { id: opts.variantId },
    data: { reservedCount: variant.reservedCount + opts.quantity },
  });
  await tx.inventoryMovement.create({
    data: {
      tenantId: opts.tenantId,
      variantId: opts.variantId,
      delta: 0,
      reason: "reserve",
      reference: opts.reference,
    },
  });
}

export async function releaseReservation(
  tx: Prisma.TransactionClient,
  opts: { tenantId: string; variantId: string; quantity: number; reference: string },
) {
  const variant = await tx.productVariant.findFirst({
    where: { id: opts.variantId, tenantId: opts.tenantId },
  });
  if (!variant) return;
  const nextReserved = Math.max(0, variant.reservedCount - opts.quantity);
  await tx.productVariant.update({
    where: { id: opts.variantId },
    data: { reservedCount: nextReserved },
  });
  await tx.inventoryMovement.create({
    data: {
      tenantId: opts.tenantId,
      variantId: opts.variantId,
      delta: 0,
      reason: "release_reservation",
      reference: opts.reference,
    },
  });
}

export async function consumeReservation(
  tx: Prisma.TransactionClient,
  opts: { tenantId: string; variantId: string; quantity: number; reference: string },
) {
  const variant = await tx.productVariant.findFirst({
    where: { id: opts.variantId, tenantId: opts.tenantId },
  });
  if (!variant) return;
  await tx.productVariant.update({
    where: { id: opts.variantId },
    data: {
      reservedCount: Math.max(0, variant.reservedCount - opts.quantity),
      inventoryCount: Math.max(0, variant.inventoryCount - opts.quantity),
    },
  });
  await tx.inventoryMovement.create({
    data: {
      tenantId: opts.tenantId,
      variantId: opts.variantId,
      delta: -opts.quantity,
      reason: "fulfilled",
      reference: opts.reference,
    },
  });
}
