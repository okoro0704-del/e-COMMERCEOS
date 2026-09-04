import { availableInventory } from "@ecommerceos/shared";
import { prisma } from "../db.js";
import { httpError } from "../lib/crypto.js";

export async function getOrCreateOpenCart(tenantId: string, buyerTrustId: string) {
  const existing = await prisma.cart.findFirst({
    where: { tenantId, buyerTrustId, status: "open" },
    include: { items: { include: { variant: { include: { product: true } } } } },
  });
  if (existing) return existing;
  return prisma.cart.create({
    data: { tenantId, buyerTrustId, status: "open" },
    include: { items: { include: { variant: { include: { product: true } } } } },
  });
}

export async function getCart(tenantId: string, buyerTrustId: string) {
  const cart = await getOrCreateOpenCart(tenantId, buyerTrustId);
  return serializeCart(cart);
}

export async function addCartItem(opts: {
  tenantId: string;
  buyerTrustId: string;
  variantId: string;
  quantity: number;
}) {
  if (opts.quantity < 1) throw httpError(400, "invalid_quantity", "Quantity must be at least 1");
  const variant = await prisma.productVariant.findFirst({
    where: { id: opts.variantId, tenantId: opts.tenantId, status: "active" },
  });
  if (!variant) throw httpError(404, "not_found", "Variant not found");

  const cart = await getOrCreateOpenCart(opts.tenantId, opts.buyerTrustId);
  const existing = cart.items.find((i) => i.variantId === opts.variantId);
  const nextQty = (existing?.quantity ?? 0) + opts.quantity;
  const available = availableInventory(variant.inventoryCount, variant.reservedCount);
  if (nextQty > available) {
    throw httpError(409, "insufficient_stock", `Only ${available} available for ${variant.sku}`);
  }

  if (existing) {
    await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity: nextQty } });
  } else {
    await prisma.cartItem.create({
      data: { cartId: cart.id, variantId: opts.variantId, quantity: opts.quantity },
    });
  }
  return getCart(opts.tenantId, opts.buyerTrustId);
}

export async function updateCartItem(opts: {
  tenantId: string;
  buyerTrustId: string;
  itemId: string;
  quantity: number;
}) {
  const cart = await getOrCreateOpenCart(opts.tenantId, opts.buyerTrustId);
  const item = cart.items.find((i) => i.id === opts.itemId);
  if (!item) throw httpError(404, "not_found", "Cart item not found");
  if (opts.quantity < 1) {
    await prisma.cartItem.delete({ where: { id: item.id } });
    return getCart(opts.tenantId, opts.buyerTrustId);
  }
  const available = availableInventory(item.variant.inventoryCount, item.variant.reservedCount);
  if (opts.quantity > available) {
    throw httpError(409, "insufficient_stock", `Only ${available} available for ${item.variant.sku}`);
  }
  await prisma.cartItem.update({ where: { id: item.id }, data: { quantity: opts.quantity } });
  return getCart(opts.tenantId, opts.buyerTrustId);
}

export async function removeCartItem(opts: { tenantId: string; buyerTrustId: string; itemId: string }) {
  const cart = await getOrCreateOpenCart(opts.tenantId, opts.buyerTrustId);
  const item = cart.items.find((i) => i.id === opts.itemId);
  if (!item) throw httpError(404, "not_found", "Cart item not found");
  await prisma.cartItem.delete({ where: { id: item.id } });
  return getCart(opts.tenantId, opts.buyerTrustId);
}

export function serializeCart(cart: {
  id: string;
  tenantId: string;
  buyerTrustId: string;
  status: string;
  items: Array<{
    id: string;
    quantity: number;
    variant: {
      id: string;
      sku: string;
      title: string;
      priceMinor: number;
      inventoryCount: number;
      reservedCount: number;
      weightGrams: number;
      lengthCm: number;
      widthCm: number;
      heightCm: number;
      product: { id: string; title: string };
    };
  }>;
}) {
  const items = cart.items.map((item) => ({
    id: item.id,
    variantId: item.variant.id,
    productId: item.variant.product.id,
    productTitle: item.variant.product.title,
    sku: item.variant.sku,
    title: item.variant.title,
    quantity: item.quantity,
    unitPriceMinor: item.variant.priceMinor,
    lineTotalMinor: item.variant.priceMinor * item.quantity,
    available: availableInventory(item.variant.inventoryCount, item.variant.reservedCount),
    weightGrams: item.variant.weightGrams,
    dimensions: {
      lengthCm: item.variant.lengthCm,
      widthCm: item.variant.widthCm,
      heightCm: item.variant.heightCm,
    },
  }));
  const subtotalMinor = items.reduce((s, i) => s + i.lineTotalMinor, 0);
  return {
    id: cart.id,
    tenantId: cart.tenantId,
    buyerTrustId: cart.buyerTrustId,
    status: cart.status,
    items,
    subtotalMinor,
  };
}
