/**
 * E2E: order placement, payment safety, LogisticsOS delivery recording, unpaid timeout.
 * No order may become paid without verified payment evidence, and delivery never releases funds.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prismaSchemaArgs, testDatabaseUrl } from "./test-database.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const testDbPath = path.join(apiRoot, "prisma", `order-lifecycle-${process.pid}.db`);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl(`file:./order-lifecycle-${process.pid}.db`);
process.env.INTERNAL_PROVISION_TOKEN = "portal-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";

const BUYER_TOKEN = "TD-BUYER-1";
const MERCHANT_PASSWORD = "E2e-Store-Passw0rd-2026!";

let app: FastifyInstance;
let prisma: PrismaClient;
let tenantId: string;
let merchantToken: string;
let variantId: string;
let logistics: { jobs: Array<{ logisticsJobId: string; orderId: string }> };
let fundzman: { attempts: unknown[]; releases: unknown[] };
let elfcom: { sent: Array<{ threadId: string; body: string; channel?: string }> };

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // Windows may keep a handle from a previous run; prisma db push will reuse/reset.
    }
  }
  execSync(`npx prisma db push --skip-generate${prismaSchemaArgs()}`, {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "test" },
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

async function placePendingOrder(quantity = 2) {
  const cart = await app.inject({
    method: "POST",
    url: "/v1/cart/items",
    headers: buyerHeaders(),
    payload: { variantId, quantity },
  });
  assert.equal(cart.statusCode, 201, cart.body);
  const placed = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyerHeaders(),
    payload: {
      buyerName: "Ada Buyer",
      buyerPhone: "+2348011111111",
      buyerEmail: "ada@example.com",
      shipping: { addressLine1: "12 Marina", city: "Lagos", country: "NG", lat: 6.4541, lng: 3.3947 },
    },
  });
  assert.equal(placed.statusCode, 201, placed.body);
  return placed.json() as {
    id: string;
    status: string;
    totalMinor: number;
    paymentStatus: string;
    paymentVerified: boolean;
    fulfilmentStatus: string;
  };
}

async function assertStillUnpaid(orderId: string) {
  const stored = await prisma.order.findUnique({ where: { id: orderId } });
  assert.equal(stored!.status, "PENDING_PAYMENT");
  assert.equal(stored!.paidAt, null);
  assert.equal(stored!.escrowPaymentId, null);
  assert.equal(stored!.logisticsJobId, null);
}

test("checkout cannot mark an order paid while online payment is unavailable", async () => {
  await provisionAndStock();
  const order = await placePendingOrder();
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(order.totalMinor, 17_000_00 + 150_000);
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(order.paymentVerified, false);
  assert.equal(order.fulfilmentStatus, "not_started");

  const reserved = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert.equal(reserved!.reservedCount, 2);

  const attemptsBefore = fundzman.attempts.length;
  const jobsBefore = logistics.jobs.length;
  const paid = await app.inject({
    method: "POST",
    url: "/v1/checkout/pay",
    headers: buyerHeaders(),
    payload: { orderId: order.id },
  });
  assert.equal(paid.statusCode, 503, paid.body);
  assert.equal(paid.json().error, "payments_unavailable");
  assert.equal(fundzman.attempts.length, attemptsBefore, "no payment provider call");
  assert.equal(logistics.jobs.length, jobsBefore, "no dispatch");
  await assertStillUnpaid(order.id);

  const storefront = await app.inject({ method: "GET", url: "/v1/storefront", headers: { "x-tenant-id": tenantId } });
  assert.equal(storefront.json().checkout.onlinePayment, false);
});

test("local payment adapter never reports success and never releases funds", async () => {
  const { LocalFundzManAdapter } = await import("../../apps/ecommerceos-api/src/services/lifeos/local-adapters.ts");
  const adapter = new LocalFundzManAdapter();
  const result = await adapter.initiatePayment({
    payerTrustId: "TD-ANY",
    payeeId: "tenant",
    amount: 100_00,
    currency: "NGN",
    escrow: true,
  });
  assert.equal(result.status, "failed");
  const bill = await adapter.billPassThrough({
    payerTrustId: "TD-ANY",
    billId: "bill",
    amount: 100_00,
    currency: "NGN",
    passThrough: {},
  });
  assert.equal(bill.status, "failed");
  await assert.rejects(
    adapter.releaseEscrow({ paymentId: result.paymentId, currency: "NGN", splits: [] }),
    (err: { code?: string }) => err.code === "escrow_unavailable",
  );
});

test("enabling checkout does not let the local adapter or an unconfirmed provider result pay an order", async () => {
  const { config } = await import("../../apps/ecommerceos-api/src/config.ts");
  const container = await import("../../apps/ecommerceos-api/src/services/lifeos/container.ts");
  const original = container.getLifeOsPrimitives();
  await provisionAndStock();
  const order = await placePendingOrder(1);
  config.protectedCheckoutEnabled = true;
  try {
    const withLocal = await app.inject({
      method: "POST",
      url: "/v1/checkout/pay",
      headers: buyerHeaders(),
      payload: { orderId: order.id },
    });
    assert.equal(withLocal.statusCode, 503, withLocal.body);
    assert.equal(withLocal.json().error, "payments_unavailable");

    // A provider that only says "authorized" (no funds held) must not move the order forward.
    const wallet = original.wallet;
    container.setLifeOsPrimitives({
      ...original,
      wallet: {
        primitiveId: "fundzman",
        bound: true,
        health: async () => ({ ok: true }),
        initiatePayment: async (payload) => ({
          paymentId: "prov_auth_only",
          status: "authorized",
          amount: payload.amount,
          currency: payload.currency,
        }),
        billPassThrough: (payload) => wallet.billPassThrough(payload),
        getWalletSummary: (userId) => wallet.getWalletSummary(userId),
        releaseEscrow: (payload) => wallet.releaseEscrow(payload),
      },
    });
    const authorizedOnly = await app.inject({
      method: "POST",
      url: "/v1/checkout/pay",
      headers: buyerHeaders(),
      payload: { orderId: order.id },
    });
    assert.equal(authorizedOnly.statusCode, 402, authorizedOnly.body);
    assert.equal(authorizedOnly.json().error, "payment_failed");
  } finally {
    config.protectedCheckoutEnabled = false;
    container.setLifeOsPrimitives(original);
  }
  await assertStillUnpaid(order.id);
});

test("a logistics DELIVERED webhook records delivery but never releases funds or completes the order", async () => {
  await provisionAndStock();
  const order = await placePendingOrder(2);
  // Production holds orders that the old local stub moved past payment; reproduce one.
  const jobId = `log_job_legacy_${order.id}`;
  await prisma.order.update({
    where: { id: order.id },
    data: { status: "DISPATCH_PENDING", escrowPaymentId: "local_pay_legacy", logisticsJobId: jobId, paidAt: new Date() },
  });

  const merchantView = await app.inject({
    method: "GET",
    url: `/v1/orders/${order.id}`,
    headers: { authorization: `Bearer ${merchantToken}` },
  });
  assert.equal(merchantView.statusCode, 200, merchantView.body);
  assert.equal(merchantView.json().paymentStatus, "simulated_not_paid");
  assert.equal(merchantView.json().paymentVerified, false);

  const picked = await app.inject({
    method: "POST",
    url: "/internal/ecommerce/webhooks/logistics-update",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: { logisticsJobId: jobId, orderId: order.id, status: "PICKED_UP" },
  });
  assert.equal(picked.statusCode, 200, picked.body);
  assert.equal(picked.json().status, "IN_TRANSIT");

  const releasesBefore = fundzman.releases.length;
  const delivered = await app.inject({
    method: "POST",
    url: "/internal/ecommerce/webhooks/logistics-update",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: { logisticsJobId: jobId, orderId: order.id, status: "DELIVERED" },
  });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.equal(delivered.json().status, "DELIVERED");
  assert.equal(fundzman.releases.length, releasesBefore, "no settlement release");

  const final = await prisma.order.findUnique({ where: { id: order.id }, include: { events: true } });
  assert.equal(final!.status, "DELIVERED");
  assert.equal(final!.completedAt, null);
  assert.equal(final!.events.some((e) => e.toStatus === "COMPLETED"), false);

  const stock = await prisma.productVariant.findUnique({ where: { id: variantId } });
  assert.equal(stock!.reservedCount, 0);
  assert.equal(stock!.inventoryCount, 8);
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
