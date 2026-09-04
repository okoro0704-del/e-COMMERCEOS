/**
 * E2E: order placement → FundzMan escrow → LogisticsOS dispatch → delivery settlement.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const testDbPath = path.join(apiRoot, "prisma", `order-lifecycle-${process.pid}.db`);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./order-lifecycle-${process.pid}.db`;
process.env.INTERNAL_PROVISION_TOKEN = "portal-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";

const BUYER_TOKEN = "TD-BUYER-1";
const MERCHANT_PASSWORD = "Password123!";

let app: FastifyInstance;
let prisma: PrismaClient;
let tenantId: string;
let merchantToken: string;
let variantId: string;
let logistics: { jobs: Array<{ logisticsJobId: string; orderId: string }> };
let fundzman: { releases: Array<{ paymentId: string; splits: Array<{ role: string; amount: number }> }> };
let elfcom: { sent: Array<{ threadId: string; body: string; channel?: string }> };

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // Windows may keep a handle from a previous run; prisma db push will reuse/reset.
    }
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:./order-lifecycle-${process.pid}.db`, NODE_ENV: "test" },
    stdio: "pipe",
  });

  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  app = await buildApp();
  await app.ready();
  prisma = new PrismaClient();

  const { getLocalLogistics, getLocalFundzMan, getLocalElfCom } = await import(
    "../../apps/ecommerceos-api/src/services/register-primitives.ts"
  );
  logistics = getLocalLogistics()!;
  fundzman = getLocalFundzMan()!;
  elfcom = getLocalElfCom()!;
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
});

function buyerHeaders() {
  return {
    authorization: `Bearer ${BUYER_TOKEN}`,
    "x-tenant-id": tenantId,
  };
}

async function provisionAndStock() {
  const subdomain = `market-${Date.now().toString(36)}`;
  const provision = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      tenantId: `tid_${subdomain}`,
      subdomain,
      displayName: "Harbor Market",
      seed: "default",
      adminStaff: {
        email: `owner@${subdomain}.example`,
        displayName: "Owner",
        role: "owner",
        password: MERCHANT_PASSWORD,
      },
    },
  });
  assert.equal(provision.statusCode, 201, provision.body);
  tenantId = provision.json().tenantId as string;

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/login",
    payload: { email: `owner@${subdomain}.example`, password: MERCHANT_PASSWORD, tenantSlug: subdomain },
  });
  assert.equal(login.statusCode, 200, login.body);
  merchantToken = login.json().token as string;

  const categories = await app.inject({
    method: "GET",
    url: "/v1/categories",
    headers: { authorization: `Bearer ${merchantToken}` },
  });
  const grocery = (categories.json() as Array<{ id: string; code: string }>).find((c) => c.code === "GROCERY");
  assert.ok(grocery);

  const created = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: { authorization: `Bearer ${merchantToken}` },
    payload: {
      title: "Rice 5kg",
      categoryId: grocery.id,
      images: ["drive://demo/rice.jpg"],
      variants: [
        {
          sku: "RICE-5KG",
          barcode: "6151100123456",
          priceMinor: 8_500_00,
          inventoryCount: 10,
          weightGrams: 5000,
          lengthCm: 40,
          widthCm: 28,
          heightCm: 10,
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  variantId = created.json().variants[0].id as string;
}

test("order placement, FundzMan escrow, auto-dispatch, and delivery settlement", async () => {
  await provisionAndStock();

  const cart = await app.inject({
    method: "POST",
    url: "/v1/cart/items",
    headers: buyerHeaders(),
    payload: { variantId, quantity: 2 },
  });
  assert.equal(cart.statusCode, 201, cart.body);
  assert.equal(cart.json().subtotalMinor, 17_000_00);

  const placed = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyerHeaders(),
    payload: {
      buyerName: "Ada Buyer",
      buyerPhone: "+2348011111111",
      buyerEmail: "ada@example.com",
      shipping: {
        addressLine1: "12 Marina",
        city: "Lagos",
        country: "NG",
        lat: 6.4541,
        lng: 3.3947,
      },
    },
  });
  assert.equal(placed.statusCode, 201, placed.body);
  const order = placed.json() as {
    id: string;
    status: string;
    totalMinor: number;
    merchantShareMinor: number;
    riderFeeMinor: number;
    platformCommissionMinor: number;
  };
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(order.totalMinor, 17_000_00 + 150_000);
  assert.equal(order.platformCommissionMinor, Math.round((17_000_00 * 250) / 10_000));
  assert.equal(order.merchantShareMinor, 17_000_00 - order.platformCommissionMinor);
  assert.equal(order.riderFeeMinor, 150_000);

  const reserved = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert.equal(reserved!.reservedCount, 2);
  assert.equal(reserved!.inventoryCount, 10);

  const paid = await app.inject({
    method: "POST",
    url: "/v1/checkout/pay",
    headers: buyerHeaders(),
    payload: { orderId: order.id },
  });
  assert.equal(paid.statusCode, 200, paid.body);
  const paidBody = paid.json() as {
    order: { status: string; escrowPaymentId: string; logisticsJobId: string; invoiceDriveUrl: string };
    payment: { status: string; paymentId: string };
  };
  assert.equal(paidBody.payment.status, "escrow_held");
  assert.equal(paidBody.order.status, "DISPATCH_PENDING");
  assert.ok(paidBody.order.escrowPaymentId);
  assert.ok(paidBody.order.logisticsJobId);
  assert.ok(paidBody.order.invoiceDriveUrl.startsWith("drive://"));

  assert.equal(logistics.jobs.length, 1);
  assert.equal(logistics.jobs[0]!.orderId, order.id);
  assert.equal(logistics.jobs[0]!.logisticsJobId, paidBody.order.logisticsJobId);

  const picked = await app.inject({
    method: "POST",
    url: "/internal/ecommerce/webhooks/logistics-update",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      logisticsJobId: paidBody.order.logisticsJobId,
      orderId: order.id,
      status: "PICKED_UP",
    },
  });
  assert.equal(picked.statusCode, 200, picked.body);
  assert.equal(picked.json().status, "IN_TRANSIT");

  const delivered = await app.inject({
    method: "POST",
    url: "/internal/ecommerce/webhooks/logistics-update",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      logisticsJobId: paidBody.order.logisticsJobId,
      orderId: order.id,
      status: "DELIVERED",
    },
  });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.equal(delivered.json().status, "COMPLETED");

  assert.equal(fundzman.releases.length, 1);
  const splits = fundzman.releases[0]!.splits;
  assert.equal(splits.find((s) => s.role === "merchant")?.amount, order.merchantShareMinor);
  assert.equal(splits.find((s) => s.role === "rider")?.amount, order.riderFeeMinor);
  assert.equal(splits.find((s) => s.role === "platform")?.amount, order.platformCommissionMinor);
  const splitSum = splits.reduce((s, x) => s + x.amount, 0);
  assert.equal(splitSum, order.totalMinor);

  assert.ok(elfcom.sent.some((m) => m.threadId === `order:${order.id}`));
  assert.ok(elfcom.sent.some((m) => m.channel === "sms" && m.body.includes("delivered")));

  const stock = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert.equal(stock!.reservedCount, 0);
  assert.equal(stock!.inventoryCount, 8);

  const final = await prisma.order.findUnique({ where: { id: order.id } });
  assert.equal(final!.status, "COMPLETED");
  assert.ok(final!.completedAt);
});

test("unpaid orders are cancelled after timeout and reserved inventory is released", async () => {
  await provisionAndStock();

  const cart = await app.inject({
    method: "POST",
    url: "/v1/cart/items",
    headers: buyerHeaders(),
    payload: { variantId, quantity: 1 },
  });
  assert.equal(cart.statusCode, 201, cart.body);

  const placed = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyerHeaders(),
    payload: {
      buyerName: "Late Buyer",
      shipping: {
        addressLine1: "1 Broad Street",
        city: "Lagos",
        country: "NG",
        lat: 6.45,
        lng: 3.39,
      },
    },
  });
  assert.equal(placed.statusCode, 201, placed.body);
  const orderId = placed.json().id as string;

  const reserved = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert.equal(reserved!.reservedCount, 1);

  await prisma.order.update({
    where: { id: orderId },
    data: { paymentExpiresAt: new Date(Date.now() - 1000) },
  });

  const sweep = await app.inject({
    method: "POST",
    url: "/internal/jobs/sweep-unpaid-orders",
    headers: { authorization: "Bearer portal-e2e-token" },
  });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.equal(sweep.json().scanned, 1);

  const cancelled = await prisma.order.findUnique({ where: { id: orderId } });
  assert.equal(cancelled!.status, "CANCELLED");
  assert.equal(cancelled!.cancelReason, "unpaid_timeout");

  const released = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert.equal(released!.reservedCount, 0);
  assert.equal(released!.inventoryCount, 10);
});
