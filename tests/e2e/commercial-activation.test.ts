/**
 * E2E: paid brand setup. A new store stays closed to buyers until platform staff verify its
 * manual setup payment; a referring marketing partner earns 5% of that payment once, never of
 * customer orders; duplicates, races and reversals cannot credit twice. No payment is collected.
 */
import { after, before, beforeEach, test } from "node:test";
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
const dbName = `commercial-activation-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);

const SERVICE_TOKEN = "commercial-e2e-service-token";
const PLATFORM_TOKEN = "commercial-e2e-platform-admin-token-0123456789";
const OWNER_PASSWORD = "Harbor-Lantern-Passw0rd-26";
const OPERATOR_PASSWORD = "Copper-Meadow-Passw0rd-27";
const BUYER_TOKEN = "TD-BUYER-COMMERCE";
const STANDARD = { amountMinor: 3_000_000, currency: "NGN" };

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl(`file:./${dbName}`);
process.env.INTERNAL_PROVISION_TOKEN = SERVICE_TOKEN;
process.env.ECO_PLATFORM_ADMIN_TOKEN = PLATFORM_TOKEN;
process.env.ECO_ACTIVATION_REQUIRED = "true";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
delete process.env.ECO_EARLY_ADOPTER_ENABLED;

let app: FastifyInstance;
let prisma: PrismaClient;
let config: typeof import("../../apps/ecommerceos-api/src/config.ts").config;
let verifier: string;
let admin: string;

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
  ({ config } = await import("../../apps/ecommerceos-api/src/config.ts"));
  app = await buildApp();
  await app.ready();
  prisma = new PrismaClient();
  verifier = await operator("verifier");
  admin = await operator("admin");
});

beforeEach(async () => {
  const { accountLoginThrottle } = await import("../../apps/ecommerceos-api/src/services/staff-auth.ts");
  const { operatorLoginThrottle } = await import("../../apps/ecommerceos-api/src/services/platform-auth.ts");
  accountLoginThrottle.reset();
  operatorLoginThrottle.reset();
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
});

function handle(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

function call(method: "GET" | "POST", url: string, opts: { token?: string; payload?: unknown; headers?: Record<string, string> } = {}) {
  return app.inject({
    method,
    url,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
  });
}

async function operator(role: "verifier" | "admin") {
  const email = `${role}-${handle("op")}@digiconomy.example`;
  const created = await call("POST", "/internal/platform/operators", {
    token: PLATFORM_TOKEN,
    payload: { email, displayName: `Test ${role}`, role, password: OPERATOR_PASSWORD },
  });
  assert.equal(created.statusCode, 201, created.body);
  const login = await call("POST", "/v1/platform/login", { payload: { email, password: OPERATOR_PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  return login.json().token as string;
}

async function newStore(prefix: string): Promise<Store> {
  const subdomain = handle(prefix);
  const email = `owner@${subdomain}.example`;
  const res = await call("POST", "/internal/distributor/provision", {
    token: SERVICE_TOKEN,
    payload: {
      tenantId: `tid_${subdomain}`,
      subdomain,
      displayName: `Store ${subdomain}`,
      seed: "default",
      adminStaff: { email, displayName: "Owner", role: "owner", password: OWNER_PASSWORD },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const login = await call("POST", "/v1/auth/merchant/login", { payload: { email, password: OWNER_PASSWORD, tenantSlug: subdomain } });
  assert.equal(login.statusCode, 200, login.body);
  return { subdomain, tenantId: res.json().tenantId as string, owner: login.json().token as string };
}

function submit(store: Store, body: Record<string, unknown>) {
  return call("POST", "/v1/activation/submit", {
    token: store.owner,
    payload: { plan: "standard", payerName: "Ada Owner", ...body },
  });
}

function verify(id: string, token = verifier, amount = STANDARD) {
  return call("POST", `/v1/platform/activations/${id}/verify`, {
    token,
    payload: { amountReceivedMinor: amount.amountMinor, currency: amount.currency },
  });
}

async function partner(code: string) {
  const res = await call("POST", "/v1/platform/partners", {
    token: admin,
    payload: { code, name: `Partner ${code}`, email: `${code.toLowerCase()}@partners.example` },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; code: string };
}

/** Submit and verify a setup payment; returns the activation id. */
async function activate(store: Store, reference: string, partnerCode?: string) {
  const sub = await submit(store, { paymentReference: reference, ...(partnerCode ? { partnerCode } : {}) });
  assert.equal(sub.statusCode, 201, sub.body);
  const ok = await verify(sub.json().id);
  assert.equal(ok.statusCode, 200, ok.body);
  return sub.json().id as string;
}

async function addProduct(store: Store) {
  const categories = await call("GET", "/v1/categories", { token: store.owner });
  const category = (categories.json() as Array<{ id: string }>)[0]!;
  const created = await call("POST", "/v1/products", {
    token: store.owner,
    payload: {
      title: "Synthetic Rice",
      categoryId: category.id,
      images: ["drive://demo/rice.jpg"],
      variants: [{ sku: `RICE-${handle("s")}`, priceMinor: 850_000, inventoryCount: 10, weightGrams: 5000 }],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  return created.json().variants[0].id as string;
}

function buyer(store: Store) {
  return { authorization: `Bearer ${BUYER_TOKEN}`, "x-tenant-id": store.tenantId };
}

async function placeOrder(store: Store, variantId: string) {
  const cart = await app.inject({ method: "POST", url: "/v1/cart/items", headers: buyer(store), payload: { variantId, quantity: 1 } });
  const order = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyer(store),
    payload: { buyerName: "Ada Buyer", shipping: { addressLine1: "12 Marina", city: "Lagos", country: "NG", lat: 6.45, lng: 3.39 } },
  });
  return { cart, order };
}

const storefront = (store: Store, url = "/v1/storefront") => app.inject({ method: "GET", url, headers: { "x-store-subdomain": store.subdomain } });

test("operators are created only with the platform admin token, and sessions do not cross over", async () => {
  const body = { email: `x-${handle("op")}@digiconomy.example`, displayName: "X", role: "admin", password: OPERATOR_PASSWORD };
  assert.equal((await call("POST", "/internal/platform/operators", { payload: body })).statusCode, 401);
  assert.equal((await call("POST", "/internal/platform/operators", { token: SERVICE_TOKEN, payload: body })).statusCode, 401, "the Portal service token cannot create operators");
  const weak = await call("POST", "/internal/platform/operators", { token: PLATFORM_TOKEN, payload: { ...body, password: "short" } });
  assert.equal(weak.statusCode, 400, weak.body);
  assert.equal((await call("POST", "/internal/platform/operators", { token: PLATFORM_TOKEN, payload: body })).statusCode, 201);
  assert.equal((await call("POST", "/internal/platform/operators", { token: PLATFORM_TOKEN, payload: body })).statusCode, 409);
  assert.equal((await call("POST", "/v1/platform/login", { payload: { email: body.email, password: "Wrong-Passw0rd-123" } })).statusCode, 401);

  const store = await newStore("cross");
  assert.equal((await call("GET", "/v1/platform/activations", { token: store.owner })).statusCode, 401, "a store session is not an operator");
  assert.equal((await call("GET", "/v1/platform/activations")).statusCode, 401);
  assert.equal((await call("GET", "/v1/activation", { token: admin })).statusCode, 401, "an operator session is not a store session");
  assert.equal((await call("POST", "/v1/platform/partners", { token: verifier, payload: { code: "NOPE1", name: "n", email: "n@x.example" } })).statusCode, 403);
});

test("the standard setup fee is ₦30,000 and the early-adopter price is off until confirmed", async () => {
  const store = await newStore("pricing");
  const view = await call("GET", "/v1/activation", { token: store.owner });
  assert.equal(view.statusCode, 200, view.body);
  const body = view.json();
  assert.equal(body.required, true);
  assert.equal(body.status, "pending");
  assert.equal(body.storeOpen, false);
  assert.deepEqual(body.offers[0], { plan: "standard", amountMinor: 3_000_000, currency: "NGN", available: true });
  assert.equal(body.offers[1].plan, "early_adopter");
  assert.equal(body.offers[1].available, false);
  assert.equal(body.offers[1].reason, "not_enabled");

  const early = await submit(store, { plan: "early_adopter", paymentReference: handle("EA") });
  assert.equal(early.statusCode, 400, early.body);
  assert.equal(early.json().error, "offer_unavailable");
  // The amount is the server's, whatever the client sends.
  const sub = await submit(store, { paymentReference: handle("TRF"), amountMinor: 1 });
  assert.equal(sub.statusCode, 201, sub.body);
  assert.equal(sub.json().amountMinor, 3_000_000);
  assert.equal(sub.json().currency, "NGN");
});

test("a new store stays closed to buyers until its setup payment is verified", async () => {
  const store = await newStore("gate");
  const variantId = await addProduct(store); // the owner can prepare the store while it is closed

  const closed = await storefront(store);
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().activation.open, false);
  assert.equal(closed.json().storeName, `Store ${store.subdomain}`);
  for (const url of ["/v1/storefront/products", "/v1/storefront/categories", "/v1/storefront/publications"]) {
    const res = await storefront(store, url);
    assert.equal(res.statusCode, 403, `${url} ${res.body}`);
    assert.equal(res.json().error, "store_not_active");
  }
  const blocked = await placeOrder(store, variantId);
  assert.equal(blocked.cart.statusCode, 403, blocked.cart.body);
  assert.equal(blocked.order.statusCode, 403, blocked.order.body);
  const feed = await app.inject({ method: "GET", url: "/v1/public/lifeos/feed?kind=product&limit=50" });
  assert.ok(!feed.body.includes(store.subdomain), "a closed store is not in the public feed");

  await activate(store, handle("TRF"));
  assert.equal((await storefront(store)).json().activation.open, true);
  assert.equal((await storefront(store, "/v1/storefront/products")).statusCode, 200);
  const listed = await app.inject({ method: "GET", url: "/v1/public/lifeos/feed?kind=product&limit=50" });
  assert.ok(listed.body.includes(store.subdomain), "once open, the store is in the public feed");
  const bought = await placeOrder(store, variantId);
  assert.equal(bought.cart.statusCode, 201, bought.cart.body);
  assert.equal(bought.order.statusCode, 201, bought.order.body);
  const view = (await call("GET", "/v1/activation", { token: store.owner })).json();
  assert.equal(view.status, "active");
  assert.equal(view.storeOpen, true);
});

test("a verified referral credits the partner 5% of the setup fee, exactly once, with an audit trail", async () => {
  const p = await partner(`REF-${Date.now().toString(36).toUpperCase()}`);
  const store = await newStore("referral");
  const sub = await submit(store, { paymentReference: handle("TRF"), partnerCode: p.code.toLowerCase() });
  assert.equal(sub.statusCode, 201, sub.body);
  assert.equal(sub.json().partner.code, p.code);
  const id = sub.json().id as string;

  const short = await verify(id, verifier, { amountMinor: 2_999_999, currency: "NGN" });
  assert.equal(short.statusCode, 400, short.body);
  assert.equal(short.json().error, "amount_mismatch");
  const wrongCurrency = await verify(id, verifier, { amountMinor: 3_000_000, currency: "USD" });
  assert.equal(wrongCurrency.json().error, "amount_mismatch");

  const ok = await verify(id);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().commission, { amountMinor: 150_000, currency: "NGN", rateBps: 500, status: "accrued" });
  const again = await verify(id);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(await prisma.partnerCommission.count({ where: { partnerId: p.id } }), 1);

  const owner = (await call("GET", "/v1/activation", { token: store.owner })).json();
  assert.equal(owner.submissions[0].partner.code, p.code);
  assert.equal(owner.submissions[0].commission, null, "owners do not see the partner's commission");

  const partners = (await call("GET", "/v1/platform/partners", { token: verifier })).json().partners as Array<Record<string, unknown>>;
  const row = partners.find((x) => x.id === p.id)!;
  assert.deepEqual(row.commissionAccruedMinor, { NGN: 150_000 });
  assert.equal(row.verifiedReferrals, 1);
  const actions = (await prisma.auditLog.findMany({ where: { resourceId: id } })).map((a) => a.action).sort();
  assert.deepEqual(actions, ["activation.submitted", "activation.verified"]);
  const overview = await call("GET", "/v1/platform/overview", { token: verifier });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.ok(overview.json().verifiedSetupFeesMinor.NGN >= 3_000_000);
});

test("concurrent verifications of one submission open the store and credit the partner once", async () => {
  const p = await partner(`RACE-${Date.now().toString(36).toUpperCase()}`);
  const store = await newStore("race");
  const sub = await submit(store, { paymentReference: handle("TRF"), partnerCode: p.code });
  const id = sub.json().id as string;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => verify(id, i % 2 ? admin : verifier)));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 1, codes.join(","));
  assert.ok(codes.every((c) => c === 200 || c === 409), codes.join(","));
  assert.equal(await prisma.partnerCommission.count({ where: { activationId: id } }), 1);
  assert.equal(await prisma.auditLog.count({ where: { resourceId: id, action: "activation.verified" } }), 1);
});

test("one payment reference activates one store, and a store has one open submission", async () => {
  const a = await newStore("dup-a");
  const b = await newStore("dup-b");
  const reference = `TRF ${Date.now()}`;
  assert.equal((await submit(a, { paymentReference: reference })).statusCode, 201);
  const reused = await submit(b, { paymentReference: reference.toLowerCase().replace(" ", "") });
  assert.equal(reused.statusCode, 409, reused.body);
  assert.equal(reused.json().error, "duplicate_reference");
  const second = await submit(a, { paymentReference: handle("OTHER") });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, "submission_pending");

  const c = await newStore("dup-c");
  const both = await Promise.all([submit(c, { paymentReference: handle("X1") }), submit(c, { paymentReference: handle("X2") })]);
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [201, 409], both.map((r) => r.body).join(" | "));
});

test("a rejected submission releases its reference for a resubmission", async () => {
  const store = await newStore("reject");
  const reference = handle("TRF");
  const sub = await submit(store, { paymentReference: reference });
  const rejected = await call("POST", `/v1/platform/activations/${sub.json().id}/reject`, {
    token: verifier,
    payload: { reason: "Transfer not received yet" },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().status, "rejected");
  assert.equal((await verify(sub.json().id)).statusCode, 409, "a rejected submission cannot be verified");
  assert.equal((await storefront(store)).json().activation.open, false);

  const view = (await call("GET", "/v1/activation", { token: store.owner })).json();
  assert.equal(view.submissions[0].rejectedReason, "Transfer not received yet");
  await activate(store, reference);
  assert.equal((await storefront(store)).json().activation.open, true);
});

test("a reversal closes the store, reverses the commission once, and keeps the reference claimed", async () => {
  const p = await partner(`REV-${Date.now().toString(36).toUpperCase()}`);
  const store = await newStore("reverse");
  const reference = handle("TRF");
  const id = await activate(store, reference, p.code);

  const byVerifier = await call("POST", `/v1/platform/activations/${id}/reverse`, { token: verifier, payload: { reason: "Transfer recalled" } });
  assert.equal(byVerifier.statusCode, 403, "only platform admins reverse");
  const results = await Promise.all(
    [1, 2, 3].map(() => call("POST", `/v1/platform/activations/${id}/reverse`, { token: admin, payload: { reason: "Transfer recalled" } })),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409], results.map((r) => r.body).join(" | "));
  const commission = await prisma.partnerCommission.findUniqueOrThrow({ where: { activationId: id } });
  assert.equal(commission.status, "reversed");
  assert.ok(commission.reversedAt);
  assert.equal((await storefront(store)).json().activation.open, false, "the store closes again");
  assert.equal(await prisma.auditLog.count({ where: { resourceId: id, action: "activation.reversed" } }), 1);

  const reuse = await submit(store, { paymentReference: reference });
  assert.equal(reuse.statusCode, 409, reuse.body);
  assert.equal(reuse.json().error, "duplicate_reference", "a recalled transfer cannot activate again");
  await activate(store, handle("TRF2"), p.code);
  const row = ((await call("GET", "/v1/platform/partners", { token: admin })).json().partners as Array<Record<string, unknown>>).find((x) => x.id === p.id)!;
  assert.deepEqual(row.commissionAccruedMinor, { NGN: 150_000 });
  assert.deepEqual(row.commissionReversedMinor, { NGN: 150_000 });
});

test("unknown or suspended partners earn nothing", async () => {
  const store = await newStore("partner");
  const unknown = await submit(store, { paymentReference: handle("TRF"), partnerCode: "NO-SUCH-CODE" });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.equal(unknown.json().error, "invalid_partner_code");

  const p = await partner(`SUS-${Date.now().toString(36).toUpperCase()}`);
  const sub = await submit(store, { paymentReference: handle("TRF"), partnerCode: p.code });
  assert.equal(sub.statusCode, 201, sub.body);
  assert.equal((await call("POST", `/v1/platform/partners/${p.id}/suspend`, { token: admin })).json().status, "suspended");
  const ok = await verify(sub.json().id);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().commission, null, "suspended at verification: no commission");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: sub.json().id, action: "activation.verified" } });
  assert.equal((audit.metadata as Record<string, unknown>).commissionSkipped, "partner_suspended");

  const other = await newStore("partner-2");
  const refused = await submit(other, { paymentReference: handle("TRF"), partnerCode: p.code });
  assert.equal(refused.json().error, "invalid_partner_code", "a suspended code is refused");
});

test("customer orders never create partner commission", async () => {
  const p = await partner(`ORD-${Date.now().toString(36).toUpperCase()}`);
  const store = await newStore("orders");
  const variantId = await addProduct(store);
  await activate(store, handle("TRF"), p.code);
  const before = await prisma.partnerCommission.count();
  for (let i = 0; i < 3; i += 1) {
    const { order } = await placeOrder(store, variantId);
    assert.equal(order.statusCode, 201, order.body);
  }
  assert.equal(await prisma.partnerCommission.count(), before);
  assert.equal(await prisma.partnerCommission.count({ where: { partnerId: p.id } }), 1, "only the setup activation");
});

test("stores created before paid activation stay open, and the gate is off unless required", async () => {
  const legacy = await newStore("legacy");
  await prisma.tenant.update({ where: { id: legacy.tenantId }, data: { activationStatus: "legacy" } });
  assert.equal((await storefront(legacy)).json().activation.open, true);
  assert.equal((await storefront(legacy, "/v1/storefront/products")).statusCode, 200);

  const pending = await newStore("flag");
  assert.equal((await storefront(pending)).json().activation.open, false);
  config.activationRequired = false;
  try {
    assert.equal((await storefront(pending)).json().activation.open, true);
    assert.equal((await storefront(pending, "/v1/storefront/products")).statusCode, 200);
    const later = await newStore("unrequired");
    assert.equal((await prisma.tenant.findUniqueOrThrow({ where: { id: later.tenantId } })).activationStatus, "legacy");
  } finally {
    config.activationRequired = true;
  }
});

test("the early-adopter price applies only when enabled, and within its limit", async () => {
  const saved = { ...config.earlyAdopter };
  const used = await prisma.activation.count({ where: { plan: "early_adopter", status: "verified" } });
  Object.assign(config.earlyAdopter, { enabled: true, amountMinor: 2000, currency: "USD", until: "", limit: used + 1 });
  try {
    const p = await partner(`EA-${Date.now().toString(36).toUpperCase()}`);
    const store = await newStore("early");
    const offer = (await call("GET", "/v1/activation", { token: store.owner })).json().offers[1];
    assert.deepEqual(offer, { plan: "early_adopter", amountMinor: 2000, currency: "USD", available: true });
    const sub = await submit(store, { plan: "early_adopter", paymentReference: handle("EA"), partnerCode: p.code });
    assert.equal(sub.statusCode, 201, sub.body);
    const ok = await verify(sub.json().id, verifier, { amountMinor: 2000, currency: "USD" });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json().commission, { amountMinor: 100, currency: "USD", rateBps: 500, status: "accrued" });

    const late = await newStore("early-full");
    const full = await submit(late, { plan: "early_adopter", paymentReference: handle("EA") });
    assert.equal(full.json().error, "offer_unavailable", "the limit is reached");
    config.earlyAdopter.limit = 0;
    config.earlyAdopter.until = "2020-01-01T00:00:00Z";
    assert.equal((await submit(late, { plan: "early_adopter", paymentReference: handle("EA") })).json().error, "offer_unavailable", "the offer ended");
  } finally {
    Object.assign(config.earlyAdopter, saved);
  }
});

test("only store owners submit setup payments", async () => {
  const store = await newStore("roles");
  const { hashPassword } = await import("../../apps/ecommerceos-api/src/lib/crypto.ts");
  const email = `staff@${store.subdomain}.example`;
  await prisma.staffMember.create({
    data: { tenantId: store.tenantId, email, displayName: "Staff", role: "staff", passwordHash: hashPassword(OWNER_PASSWORD) },
  });
  const login = await call("POST", "/v1/auth/merchant/login", { payload: { email, password: OWNER_PASSWORD, tenantSlug: store.subdomain } });
  assert.equal(login.statusCode, 200, login.body);
  const staff = { ...store, owner: login.json().token as string };
  assert.equal((await submit(staff, { paymentReference: handle("TRF") })).statusCode, 403);
  assert.equal((await call("GET", "/v1/activation", { token: staff.owner })).statusCode, 200, "staff can see the status");
  assert.equal((await call("POST", "/v1/activation/submit", { payload: { paymentReference: "X", payerName: "Y" } })).statusCode, 401);
});
