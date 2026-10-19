/**
 * E2E: business-owner dashboard. Store branding, cancelling unpaid orders (paid or fulfilled
 * orders are never touched here) and the low-stock inventory view.
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
const dbName = `merchant-dashboard-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);
const SERVICE_TOKEN = "dashboard-e2e-service-token";
const PASSWORD = "Harbor-Lantern-Passw0rd-26";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl(`file:./${dbName}`);
process.env.INTERNAL_PROVISION_TOKEN = SERVICE_TOKEN;
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
delete process.env.ECO_ACTIVATION_REQUIRED;

let app: FastifyInstance;
let prisma: PrismaClient;
type Store = { subdomain: string; tenantId: string; owner: string };

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

async function newStore(prefix: string): Promise<Store> {
  const subdomain = handle(prefix);
  const email = `owner@${subdomain}.example`;
  const res = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: bearer(SERVICE_TOKEN),
    payload: { tenantId: `tid_${subdomain}`, subdomain, displayName: `Store ${subdomain}`, seed: "default", adminStaff: { email, displayName: "Owner", role: "owner", password: PASSWORD } },
  });
  assert.equal(res.statusCode, 201, res.body);
  const login = await app.inject({ method: "POST", url: "/v1/auth/merchant/login", payload: { email, password: PASSWORD, tenantSlug: subdomain } });
  assert.equal(login.statusCode, 200, login.body);
  return { subdomain, tenantId: res.json().tenantId, owner: login.json().token };
}

async function staffToken(store: Store) {
  const { hashPassword } = await import("../../apps/ecommerceos-api/src/lib/crypto.ts");
  const email = `staff@${store.subdomain}.example`;
  await prisma.staffMember.create({ data: { tenantId: store.tenantId, email, displayName: "Staff", role: "staff", passwordHash: hashPassword(PASSWORD) } });
  const login = await app.inject({ method: "POST", url: "/v1/auth/merchant/login", payload: { email, password: PASSWORD, tenantSlug: store.subdomain } });
  return login.json().token as string;
}

async function stockedVariant(store: Store, inventoryCount: number) {
  const created = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: bearer(store.owner),
    payload: { title: "Synthetic Rice", variants: [{ sku: handle("SKU"), priceMinor: 850_000, inventoryCount, weightGrams: 1000 }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  return created.json().variants[0].id as string;
}

async function unpaidOrder(store: Store, variantId: string, quantity: number) {
  const buyer = { authorization: `Bearer TD-BUYER-${handle("b")}`, "x-tenant-id": store.tenantId };
  const cart = await app.inject({ method: "POST", url: "/v1/cart/items", headers: buyer, payload: { variantId, quantity } });
  assert.equal(cart.statusCode, 201, cart.body);
  const order = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyer,
    payload: { buyerName: "Ada Buyer", shipping: { addressLine1: "12 Marina", city: "Lagos", country: "NG", lat: 6.45, lng: 3.39 } },
  });
  assert.equal(order.statusCode, 201, order.body);
  return order.json().id as string;
}

const cancel = (token: string, id: string, reason = "Customer asked to cancel") =>
  app.inject({ method: "POST", url: `/v1/orders/${id}/cancel`, headers: bearer(token), payload: { reason } });

test("store admins set the storefront name, tagline, colour and logo; the storefront shows them", async () => {
  const store = await newStore("brand");
  const bad = await app.inject({ method: "PATCH", url: "/v1/store/branding", headers: bearer(store.owner), payload: { primaryColor: "blue" } });
  assert.equal(bad.statusCode, 400, bad.body);
  const notImage = await app.inject({ method: "PATCH", url: "/v1/store/branding", headers: bearer(store.owner), payload: { logoAssetId: "no-such-asset" } });
  assert.equal(notImage.json().error, "invalid_logo");

  const upload = await app.inject({
    method: "POST",
    url: "/v1/media/upload",
    headers: bearer(store.owner),
    payload: { filename: "logo.png", contentType: "image/png", body: Buffer.from("png-bytes").toString("base64"), encoding: "base64" },
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const saved = await app.inject({
    method: "PATCH",
    url: "/v1/store/branding",
    headers: bearer(store.owner),
    payload: { storeName: "Harbor Fresh", tagline: "Fresh food, delivered", primaryColor: "#aa3311", logoAssetId: upload.json().id },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(
    { ...saved.json(), logoUrl: undefined },
    { storeName: "Harbor Fresh", tagline: "Fresh food, delivered", primaryColor: "#AA3311", logoUrl: undefined, logoAssetId: upload.json().id },
  );
  const front = await app.inject({ method: "GET", url: "/v1/storefront", headers: { "x-store-subdomain": store.subdomain } });
  assert.equal(front.json().storeName, "Harbor Fresh");
  assert.equal(front.json().tagline, "Fresh food, delivered");
  assert.equal(front.json().primaryColor, "#AA3311");
  assert.equal(front.json().logoAssetId, upload.json().id);

  const other = await newStore("brand-other");
  const foreign = await app.inject({ method: "PATCH", url: "/v1/store/branding", headers: bearer(other.owner), payload: { logoAssetId: upload.json().id } });
  assert.equal(foreign.json().error, "invalid_logo", "another store's upload cannot be used");
  const staff = await staffToken(store);
  assert.equal((await app.inject({ method: "PATCH", url: "/v1/store/branding", headers: bearer(staff), payload: { tagline: "x" } })).statusCode, 403);
  assert.equal(await prisma.auditLog.count({ where: { tenantId: store.tenantId, action: "store.branding_updated" } }), 1);
});

test("store admins cancel unpaid orders once, releasing reserved stock; nothing else is touched", async () => {
  const store = await newStore("cancel");
  const variantId = await stockedVariant(store, 10);
  const orderId = await unpaidOrder(store, variantId, 3);
  assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).reservedCount, 3);

  const staff = await staffToken(store);
  assert.equal((await cancel(staff, orderId)).statusCode, 403, "staff cannot cancel");
  const other = await newStore("cancel-other");
  assert.equal((await cancel(other.owner, orderId)).statusCode, 404, "another store cannot see the order");
  assert.equal((await cancel(store.owner, orderId, "x")).statusCode, 400, "a reason is required");

  const results = await Promise.all([1, 2, 3].map(() => cancel(store.owner, orderId)));
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409], results.map((r) => r.body).join(" | "));
  const order = results.find((r) => r.statusCode === 200)!.json();
  assert.equal(order.status, "CANCELLED");
  assert.equal(order.cancelReason, "merchant: Customer asked to cancel");
  assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).reservedCount, 0, "stock released once");
  assert.equal(await prisma.orderEvent.count({ where: { orderId, toStatus: "CANCELLED", source: "merchant" } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { resourceId: orderId, action: "order.cancelled" } }), 1);

  // An order past payment is refused (set directly: checkout cannot pay in this build).
  const other2 = await unpaidOrder(store, variantId, 1);
  await prisma.order.update({ where: { id: other2 }, data: { status: "DISPATCH_PENDING" } });
  const refused = await cancel(store.owner, other2);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error, "not_cancellable");
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: other2 } })).status, "DISPATCH_PENDING");
});

test("the inventory view lists low-stock variants", async () => {
  const store = await newStore("stock");
  const low = await stockedVariant(store, 2);
  const plenty = await stockedVariant(store, 50);
  const res = await app.inject({ method: "GET", url: "/v1/inventory?lowStock=true&threshold=5", headers: bearer(store.owner) });
  assert.equal(res.statusCode, 200, res.body);
  const ids = (res.json() as Array<{ variantId: string }>).map((r) => r.variantId);
  assert.ok(ids.includes(low));
  assert.ok(!ids.includes(plenty));
});

test("the admin is told plainly when DigiPedia is not available, never 'Internal server error'", async () => {
  const store = await newStore("digipedia");
  const res = await app.inject({ method: "GET", url: "/v1/admin/digipedia", headers: bearer(store.owner) });
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(res.json().error, "digipedia_unconfigured");
  assert.equal(res.json().message, "DigiPedia is not available for this store yet.");
  assert.doesNotMatch(res.body, /internal server error/i);
});
