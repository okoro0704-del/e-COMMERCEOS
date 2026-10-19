/**
 * E2E: offline-assisted checkout. Customers pay the merchant directly (bank transfer or on
 * delivery). A customer's notification never marks an order paid; only a store owner or admin
 * verifies, each transition happens once under concurrency, and stock follows the order.
 * Synthetic bank details only.
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
const dbName = `offline-checkout-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);
const SERVICE_TOKEN = "offline-checkout-e2e-service";
const PASSWORD = "Harbor-Lantern-Passw0rd-26";
const SYNTHETIC_ACCOUNT = "0000012345";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl(`file:./${dbName}`);
process.env.INTERNAL_PROVISION_TOKEN = SERVICE_TOKEN;
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
delete process.env.ECO_ACTIVATION_REQUIRED;

let app: FastifyInstance;
let prisma: PrismaClient;
type Store = { subdomain: string; tenantId: string; owner: string; admin: string; staff: string; variantId: string };

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* reused by prisma db push */
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
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
});

const handle = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signIn(subdomain: string, email: string) {
  const res = await app.inject({ method: "POST", url: "/v1/auth/merchant/login", payload: { email, password: PASSWORD, tenantSlug: subdomain } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function newStore(prefix: string, stock = 10): Promise<Store> {
  const subdomain = handle(prefix);
  const email = `owner@${subdomain}.example`;
  const res = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: bearer(SERVICE_TOKEN),
    payload: { tenantId: `tid_${subdomain}`, subdomain, displayName: `Store ${subdomain}`, seed: "default", adminStaff: { email, displayName: "Owner", role: "owner", password: PASSWORD } },
  });
  assert.equal(res.statusCode, 201, res.body);
  const tenantId = res.json().tenantId as string;
  const { hashPassword } = await import("../../apps/ecommerceos-api/src/lib/crypto.ts");
  for (const role of ["admin", "staff"]) {
    await prisma.staffMember.create({ data: { tenantId, email: `${role}@${subdomain}.example`, displayName: role, role, passwordHash: hashPassword(PASSWORD) } });
  }
  const owner = await signIn(subdomain, email);
  const created = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: bearer(owner),
    payload: { title: "Synthetic Rice", variants: [{ sku: handle("SKU"), priceMinor: 500_000, inventoryCount: stock, weightGrams: 1000 }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  return {
    subdomain,
    tenantId,
    owner,
    admin: await signIn(subdomain, `admin@${subdomain}.example`),
    staff: await signIn(subdomain, `staff@${subdomain}.example`),
    variantId: created.json().variants[0].id,
  };
}

const settings = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: "/v1/store/payment-settings", headers: bearer(token), payload });

async function acceptBoth(store: Store) {
  const res = await settings(store.owner, {
    payOnDeliveryEnabled: true,
    bankTransferEnabled: true,
    bankName: "Synthetic Bank",
    bankAccountName: "Synthetic Store Ltd",
    bankAccountNumber: SYNTHETIC_ACCOUNT,
  });
  assert.equal(res.statusCode, 200, res.body);
}

function buyerOf(store: Store) {
  return { authorization: `Bearer TD-BUYER-${handle("b")}`, "x-tenant-id": store.tenantId };
}

async function placeOrder(store: Store, buyer: Record<string, string>, paymentMethod: string | undefined, quantity = 2) {
  const cart = await app.inject({ method: "POST", url: "/v1/cart/items", headers: buyer, payload: { variantId: store.variantId, quantity } });
  assert.equal(cart.statusCode, 201, cart.body);
  return app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyer,
    payload: {
      buyerName: "Synthetic Buyer",
      shipping: { addressLine1: "1 Test Road", city: "Lagos", country: "NG", lat: 6.45, lng: 3.39 },
      ...(paymentMethod ? { paymentMethod } : {}),
    },
  });
}

const merchantCall = (token: string, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: bearer(token), payload });
const verify = (token: string, id: string, amountReceivedMinor: number) =>
  merchantCall(token, `/v1/orders/${id}/payment/verify`, { amountReceivedMinor, merchantReference: "STMT-001" });
const report = (buyer: Record<string, string>, id: string, reference: string) =>
  app.inject({ method: "POST", url: `/v1/orders/${id}/payment-notification`, headers: buyer, payload: { reference, payerName: "Synthetic Buyer" } });
const variant = (store: Store) => prisma.productVariant.findUniqueOrThrow({ where: { id: store.variantId } });

test("only owners change where customers pay; admins can read; staff cannot; the audit never holds the full account", async () => {
  const store = await newStore("settings");
  assert.equal((await app.inject({ method: "GET", url: "/v1/store/payment-settings", headers: bearer(store.staff) })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/v1/store/payment-settings", headers: bearer(store.admin) })).statusCode, 200);
  assert.equal((await settings(store.admin, { payOnDeliveryEnabled: true })).statusCode, 403, "admins cannot change payment settings");
  assert.equal((await settings(store.owner, { bankTransferEnabled: true })).json().error, "bank_details_required");
  assert.equal((await settings(store.owner, { bankAccountNumber: "12-34" })).json().error, "invalid_account_number");
  await acceptBoth(store);
  const front = await app.inject({ method: "GET", url: "/v1/storefront", headers: { "x-tenant-id": store.tenantId } });
  assert.deepEqual(front.json().checkout.methods, { payOnDelivery: true, bankTransfer: true });
  assert.ok(!front.body.includes(SYNTHETIC_ACCOUNT), "bank details are not published on the storefront");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: store.tenantId, action: "store.payment_settings_updated" } });
  assert.ok(!JSON.stringify(audit.metadata).includes(SYNTHETIC_ACCOUNT));
  assert.equal((audit.metadata as Record<string, unknown>).accountLast4, "2345");

  const plain = await newStore("settings-off");
  const refused = await placeOrder(plain, buyerOf(plain), "bank_transfer");
  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(refused.json().error, "payment_method_unavailable");
});

test("bank transfer: a customer's report never marks the order paid; the merchant verifies exactly once", async () => {
  const store = await newStore("transfer");
  await acceptBoth(store);
  const buyer = buyerOf(store);
  const placed = await placeOrder(store, buyer, "bank_transfer");
  assert.equal(placed.statusCode, 201, placed.body);
  const order = placed.json();
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(order.paymentStatus, "awaiting_transfer");
  assert.equal(order.paymentVerified, false);
  assert.equal(order.payment.bankAccountNumber, SYNTHETIC_ACCOUNT, "the customer sees where to pay");
  const hours = (new Date(order.paymentExpiresAt).getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 47 && hours <= 48, `held for 48 hours, got ${hours.toFixed(2)}`);

  const reported = await report(buyer, order.id, "TRF 0001");
  assert.equal(reported.statusCode, 200, reported.body);
  assert.equal(reported.json().status, "PENDING_PAYMENT", "still not paid");
  assert.equal(reported.json().paymentStatus, "customer_reported");
  assert.equal(reported.json().paymentVerified, false);
  assert.equal((await report(buyer, order.id, "trf0001")).statusCode, 200, "the same report again is a no-op");
  assert.equal((await report(buyer, order.id, "TRF 9999")).json().error, "already_reported");
  assert.equal((await report(buyerOf(store), order.id, "TRF 0001")).statusCode, 403, "another customer cannot report");

  // Neither the timeout nor the merchant cancels an order whose payment is being checked.
  await prisma.order.update({ where: { id: order.id }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } });
  const sweep = await app.inject({ method: "POST", url: "/internal/jobs/sweep-unpaid-orders", headers: bearer(SERVICE_TOKEN) });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "PENDING_PAYMENT");
  assert.equal((await merchantCall(store.owner, `/v1/orders/${order.id}/cancel`, { reason: "Changed mind" })).json().error, "payment_report_pending");

  // Who can verify, and what.
  assert.equal((await verify(store.staff, order.id, order.totalMinor)).statusCode, 403, "staff cannot verify payments");
  assert.equal((await app.inject({ method: "POST", url: `/v1/orders/${order.id}/payment/verify`, headers: buyer, payload: { amountReceivedMinor: order.totalMinor } })).statusCode, 401);
  const other = await newStore("transfer-other");
  assert.equal((await verify(other.owner, order.id, order.totalMinor)).statusCode, 404, "another store cannot see it");
  assert.equal((await verify(store.owner, order.id, order.totalMinor - 1)).json().error, "amount_mismatch");

  const race = await Promise.all([store.owner, store.admin, store.owner, store.admin].map((t) => verify(t, order.id, order.totalMinor)));
  const codes = race.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 409, 409, 409], race.map((r) => r.body).join(" | "));
  const confirmed = race.find((r) => r.statusCode === 200)!.json();
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(confirmed.paymentStatus, "verified");
  assert.equal(confirmed.paymentVerified, true);
  assert.equal(await prisma.auditLog.count({ where: { resourceId: order.id, action: "order.payment_verified" } }), 1);
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(row.escrowPaymentId, null, "the former payment stub is never used");
  assert.equal(row.paidAt, null);

  const buyerView = await app.inject({ method: "GET", url: `/v1/orders/${order.id}`, headers: buyer });
  assert.equal(buyerView.json().paymentVerified, true);
  assert.equal(buyerView.json().payment.bankAccountNumber, undefined, "bank details are hidden once paid");

  // Fulfilment: any staff dispatches; only owners/admins record delivery. Stock leaves on delivery.
  assert.equal((await merchantCall(store.staff, `/v1/orders/${order.id}/fulfilment`, { action: "dispatch" })).json().status, "IN_TRANSIT");
  assert.equal((await merchantCall(store.staff, `/v1/orders/${order.id}/fulfilment`, { action: "deliver" })).statusCode, 403);
  assert.equal((await variant(store)).reservedCount, 2);
  const delivered = await merchantCall(store.admin, `/v1/orders/${order.id}/fulfilment`, { action: "deliver" });
  assert.equal(delivered.json().status, "DELIVERED", delivered.body);
  assert.deepEqual([(await variant(store)).inventoryCount, (await variant(store)).reservedCount], [8, 0]);
  assert.equal((await merchantCall(store.owner, `/v1/orders/${order.id}/fulfilment`, { action: "complete" })).json().status, "COMPLETED");
  assert.equal((await merchantCall(store.owner, `/v1/orders/${order.id}/fulfilment`, { action: "complete" })).statusCode, 409);
});

test("bank transfer: a rejected report can be sent again; an unreported, expired order is released", async () => {
  const store = await newStore("reject");
  await acceptBoth(store);
  const buyer = buyerOf(store);
  const order = (await placeOrder(store, buyer, "bank_transfer")).json();
  assert.equal((await merchantCall(store.owner, `/v1/orders/${order.id}/payment/reject`, { reason: "No report yet" })).json().error, "no_payment_report");
  await report(buyer, order.id, "TRF-A");
  const rejected = await merchantCall(store.admin, `/v1/orders/${order.id}/payment/reject`, { reason: "Not in our statement" });
  assert.equal(rejected.json().paymentStatus, "rejected", rejected.body);
  const again = await report(buyer, order.id, "TRF-B");
  assert.equal(again.json().paymentStatus, "customer_reported", again.body);
  assert.equal(again.json().payment.rejectedReason, "Not in our statement");

  const lapsed = (await placeOrder(store, buyerOf(store), "bank_transfer", 1)).json();
  await prisma.order.update({ where: { id: lapsed.id }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } });
  await app.inject({ method: "POST", url: "/internal/jobs/sweep-unpaid-orders", headers: bearer(SERVICE_TOKEN) });
  const released = await prisma.order.findUniqueOrThrow({ where: { id: lapsed.id }, include: { payment: true } });
  assert.equal(released.status, "CANCELLED");
  assert.equal(released.payment?.status, "void");
  assert.equal((await variant(store)).reservedCount, 2, "only the reported order still holds stock");
});

test("pay on delivery: confirmed at once, paid only when the merchant records the cash, exactly once", async () => {
  const store = await newStore("cod");
  await acceptBoth(store);
  const buyer = buyerOf(store);
  const order = (await placeOrder(store, buyer, "pay_on_delivery")).json();
  assert.equal(order.status, "CONFIRMED");
  assert.equal(order.paymentStatus, "due_on_delivery");
  assert.equal(order.paymentVerified, false);
  assert.equal(order.payment.bankAccountNumber, undefined);
  assert.equal((await report(buyer, order.id, "CASH")).json().error, "not_bank_transfer");

  const deliver = (token: string, amountCollectedMinor?: number) =>
    merchantCall(token, `/v1/orders/${order.id}/fulfilment`, { action: "deliver", ...(amountCollectedMinor === undefined ? {} : { amountCollectedMinor }) });
  assert.equal((await deliver(store.owner)).json().error, "amount_mismatch");
  assert.equal((await deliver(store.owner, order.totalMinor - 100)).json().error, "amount_mismatch");
  const race = await Promise.all([1, 2, 3].map(() => deliver(store.owner, order.totalMinor)));
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 409, 409], race.map((r) => r.body).join(" | "));
  const done = race.find((r) => r.statusCode === 200)!.json();
  assert.equal(done.status, "DELIVERED");
  assert.equal(done.paymentStatus, "collected");
  assert.equal(done.paymentVerified, true);
  assert.deepEqual([(await variant(store)).inventoryCount, (await variant(store)).reservedCount], [8, 0], "stock consumed once");
  assert.equal(await prisma.auditLog.count({ where: { resourceId: order.id, action: "order.delivered" } }), 1);
});

test("cancelling confirmed orders: pay on delivery voids; a paid transfer needs the owner and a refund reference", async () => {
  const store = await newStore("cancel");
  await acceptBoth(store);
  const cod = (await placeOrder(store, buyerOf(store), "pay_on_delivery", 1)).json();
  const voided = await merchantCall(store.admin, `/v1/orders/${cod.id}/cancel`, { reason: "Out of stock" });
  assert.equal(voided.json().status, "CANCELLED", voided.body);
  assert.equal(voided.json().paymentStatus, "void");

  const paid = (await placeOrder(store, buyerOf(store), "bank_transfer", 1)).json();
  assert.equal((await verify(store.owner, paid.id, paid.totalMinor)).statusCode, 200);
  assert.equal((await merchantCall(store.admin, `/v1/orders/${paid.id}/cancel`, { reason: "Out of stock", refundReference: "RFD-1" })).statusCode, 403);
  assert.equal((await merchantCall(store.owner, `/v1/orders/${paid.id}/cancel`, { reason: "Out of stock" })).json().error, "refund_reference_required");
  const refunded = await merchantCall(store.owner, `/v1/orders/${paid.id}/cancel`, { reason: "Out of stock", refundReference: "RFD-1" });
  assert.equal(refunded.json().paymentStatus, "refunded_offline", refunded.body);
  assert.equal(refunded.json().payment.refundReference, "RFD-1");
  assert.deepEqual([(await variant(store)).inventoryCount, (await variant(store)).reservedCount], [10, 0], "stock released");
  assert.equal((await merchantCall(store.owner, `/v1/orders/${paid.id}/fulfilment`, { action: "dispatch" })).statusCode, 409);
});

test("orders from the disabled online checkout keep the old behaviour and cannot be fulfilled here", async () => {
  const store = await newStore("online");
  const order = (await placeOrder(store, buyerOf(store), undefined, 1)).json();
  assert.equal(order.status, "PENDING_PAYMENT");
  assert.equal(order.paymentStatus, "unpaid");
  assert.equal(order.payment, undefined);
  assert.equal((await merchantCall(store.owner, `/v1/orders/${order.id}/payment/verify`, { amountReceivedMinor: order.totalMinor })).json().error, "not_bank_transfer");
  assert.equal((await merchantCall(store.owner, `/v1/orders/${order.id}/fulfilment`, { action: "dispatch" })).json().error, "not_offline_order");
});
