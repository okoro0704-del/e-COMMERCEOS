/**
 * E2E: store-scoped merchant sign-in, leaked-password refusal, rate limits, logout,
 * forced replacement of temporary passwords, Portal admin handoff (recovery path),
 * owner-bound idempotent provisioning, role limits and buyer credential privacy.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const dbName = `merchant-auth-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);

/** Stands in for a password that has leaked publicly; denied through the operator hash list. */
const LEAKED_PASSWORD = "Leaked-Example-Passw0rd";
const GOOD_PASSWORD = "Harbor-Lantern-Passw0rd-26";
const SERVICE = { authorization: "Bearer auth-e2e-token" };

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./${dbName}`;
process.env.INTERNAL_PROVISION_TOKEN = "auth-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_COMPROMISED_PASSWORD_SHA256 = createHash("sha256").update(LEAKED_PASSWORD).digest("hex");

let app: FastifyInstance;
let prisma: PrismaClient;

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* reused by prisma db push */
    }
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:./${dbName}`, NODE_ENV: "test" },
    stdio: "pipe",
  });
  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  app = await buildApp();
  await app.ready();
  prisma = new PrismaClient();
});

beforeEach(async () => {
  const { accountLoginThrottle } = await import("../../apps/ecommerceos-api/src/services/staff-auth.ts");
  const { credentialIpThrottle } = await import("../../apps/ecommerceos-api/src/routes/auth.ts");
  accountLoginThrottle.reset();
  credentialIpThrottle.reset();
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
});

function handle(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

async function provision(opts: {
  subdomain: string;
  email: string;
  password?: string;
  temporaryPassword?: boolean;
  ownerSubject?: string;
}) {
  return app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: SERVICE,
    payload: {
      tenantId: `tid_${opts.subdomain}`,
      subdomain: opts.subdomain,
      displayName: `Store ${opts.subdomain}`,
      seed: "default",
      verticalId: "delivery",
      adminStaff: {
        email: opts.email,
        displayName: "Owner",
        role: "owner",
        ...(opts.password ? { password: opts.password } : {}),
        ...(opts.temporaryPassword ? { temporaryPassword: true } : {}),
      },
      ...(opts.ownerSubject ? { owner: { subject: opts.ownerSubject } } : {}),
    },
  });
}

function login(email: string, password: string, tenantSlug?: string) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/merchant/login",
    payload: { email, password, ...(tenantSlug ? { tenantSlug } : {}) },
  });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

test("sign-in is scoped to the store handle", async () => {
  const email = "shared-owner@example.com";
  const a = handle("scope-a");
  const b = handle("scope-b");
  assert.equal((await provision({ subdomain: a, email, password: GOOD_PASSWORD })).statusCode, 201);
  assert.equal((await provision({ subdomain: b, email, password: "Other-Store-Passw0rd-2026" })).statusCode, 201);

  const noStore = await login(email, GOOD_PASSWORD);
  assert.equal(noStore.statusCode, 400, noStore.body);
  assert.equal(noStore.json().error, "store_required");

  const ok = await login(email, GOOD_PASSWORD, a);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().staff.tenantSlug, a);

  const viaHeader = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/login",
    headers: { "x-store-subdomain": a },
    payload: { email, password: GOOD_PASSWORD },
  });
  assert.equal(viaHeader.statusCode, 200, viaHeader.body);

  const wrongStore = await login(email, GOOD_PASSWORD, b);
  assert.equal(wrongStore.statusCode, 401, wrongStore.body);
});

test("publicly known passwords never sign in and are never stored", async () => {
  const sub = handle("leak");
  const email = `owner@${sub}.example`;
  const res = await provision({ subdomain: sub, email, password: LEAKED_PASSWORD });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().credentialSetup, "portal_handoff");
  assert.equal(res.json().temporaryAdminPassword, undefined);

  const attempt = await login(email, LEAKED_PASSWORD, sub);
  assert.equal(attempt.statusCode, 401, attempt.body);
  assert.equal(attempt.json().error, "password_not_accepted");

  const weak = await provision({ subdomain: handle("weak"), email: "weak@example.com", password: "Short-Pw1" });
  assert.equal(weak.statusCode, 201, weak.body);
  assert.equal(weak.json().credentialSetup, "portal_handoff");
});

test("repeated failures lock the account and the client", async () => {
  const sub = handle("throttle");
  const email = `owner@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: GOOD_PASSWORD })).statusCode, 201);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await login(email, "Wrong-Passw0rd-xx", sub)).statusCode, 401);
  }
  const locked = await login(email, GOOD_PASSWORD, sub);
  assert.equal(locked.statusCode, 429, locked.body);
  assert.equal(locked.json().error, "too_many_attempts");
});

test("logout revokes the session on the server", async () => {
  const sub = handle("logout");
  const email = `owner@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: GOOD_PASSWORD })).statusCode, 201);
  const token = (await login(email, GOOD_PASSWORD, sub)).json().token as string;
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/merchant/me", headers: bearer(token) })).statusCode, 200);
  const out = await app.inject({ method: "POST", url: "/v1/auth/merchant/logout", headers: bearer(token) });
  assert.equal(out.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/merchant/me", headers: bearer(token) })).statusCode, 401);
});

test("a temporary password must be replaced before the store can be managed", async () => {
  const sub = handle("temp");
  const email = `owner@${sub}.example`;
  const temp = "Operator-Issued-Passw0rd";
  const res = await provision({ subdomain: sub, email, password: temp, temporaryPassword: true });
  assert.equal(res.json().credentialSetup, "temporary_password");

  const first = await login(email, temp, sub);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().mustChangePassword, true);
  const token = first.json().token as string;
  const otherDevice = (await login(email, temp, sub)).json().token as string;

  const blocked = await app.inject({ method: "GET", url: "/v1/products", headers: bearer(token) });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, "password_change_required");
  const ordersBlocked = await app.inject({ method: "GET", url: "/v1/orders", headers: bearer(token) });
  assert.equal(ordersBlocked.statusCode, 403);

  const leaked = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/password",
    headers: bearer(token),
    payload: { currentPassword: temp, newPassword: LEAKED_PASSWORD },
  });
  assert.equal(leaked.statusCode, 400, leaked.body);
  assert.equal(leaked.json().error, "weak_password");

  const changed = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/password",
    headers: bearer(token),
    payload: { currentPassword: temp, newPassword: GOOD_PASSWORD },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await app.inject({ method: "GET", url: "/v1/products", headers: bearer(token) })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/auth/merchant/me", headers: bearer(otherDevice) })).statusCode,
    401,
    "other sessions are revoked",
  );
  assert.equal((await login(email, temp, sub)).statusCode, 401);
  assert.equal((await login(email, GOOD_PASSWORD, sub)).statusCode, 200);
});

test("Portal handoff opens the owner's store once, then lets the owner set a password", async () => {
  const sub = handle("handoff");
  const email = `owner@${sub}.example`;
  const subject = "local:portal-user-1";
  const res = await provision({ subdomain: sub, email, ownerSubject: subject });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().credentialSetup, "portal_handoff");

  const noToken = await app.inject({
    method: "POST",
    url: "/internal/ecommerceos/admin-handoff",
    payload: { subdomain: sub, ownerSubject: subject },
  });
  assert.equal(noToken.statusCode, 401);

  const stranger = await app.inject({
    method: "POST",
    url: "/internal/ecommerceos/admin-handoff",
    headers: SERVICE,
    payload: { subdomain: sub, ownerSubject: "local:someone-else", ownerEmail: email },
  });
  assert.equal(stranger.statusCode, 403, stranger.body);
  assert.equal(stranger.json().error, "owner_mismatch");

  const issued = await app.inject({
    method: "POST",
    url: "/internal/ecommerceos/admin-handoff",
    headers: SERVICE,
    payload: { subdomain: sub, ownerSubject: subject },
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const url = issued.json().url as string;
  assert.match(url, new RegExp(`${sub}.*/admin#handoff=`));
  const code = decodeURIComponent(url.split("#handoff=")[1]!);

  const asBearer = await app.inject({ method: "GET", url: "/v1/auth/merchant/me", headers: bearer(code) });
  assert.equal(asBearer.statusCode, 401, "a handoff code is not a session");

  const exchanged = await app.inject({ method: "POST", url: "/v1/auth/merchant/handoff/exchange", payload: { code } });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  const { token, resetGrant, passwordSet } = exchanged.json() as { token: string; resetGrant: string; passwordSet: boolean };
  assert.equal(passwordSet, false);

  const replay = await app.inject({ method: "POST", url: "/v1/auth/merchant/handoff/exchange", payload: { code } });
  assert.equal(replay.statusCode, 400, "single use");

  const set = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/password",
    headers: bearer(token),
    payload: { resetGrant, newPassword: GOOD_PASSWORD },
  });
  assert.equal(set.statusCode, 200, set.body);
  const reuse = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/password",
    headers: bearer(token),
    payload: { resetGrant, newPassword: "Another-Passw0rd-2026" },
  });
  assert.equal(reuse.statusCode, 400, "reset grant is single use");
  assert.equal((await login(email, GOOD_PASSWORD, sub)).statusCode, 200);
});

test("a legacy store is claimed once by its owner email, then only by that Portal identity", async () => {
  const sub = handle("legacy");
  const email = `Owner@${sub}.example`;
  const res = await provision({ subdomain: sub, email, password: LEAKED_PASSWORD });
  assert.equal(res.statusCode, 201, res.body);

  const claim = await app.inject({
    method: "POST",
    url: "/internal/ecommerceos/admin-handoff",
    headers: SERVICE,
    payload: { subdomain: sub, ownerSubject: "local:legacy-owner", ownerEmail: email.toLowerCase() },
  });
  assert.equal(claim.statusCode, 201, claim.body);

  const takeover = await app.inject({
    method: "POST",
    url: "/internal/ecommerceos/admin-handoff",
    headers: SERVICE,
    payload: { subdomain: sub, ownerSubject: "local:attacker", ownerEmail: email },
  });
  assert.equal(takeover.statusCode, 403, takeover.body);
});

test("concurrent claims on an unclaimed store bind exactly one owner, and the binding holds", async () => {
  const claimFor = (sub: string, ownerSubject: string, ownerEmail: string) =>
    app.inject({
      method: "POST",
      url: "/internal/ecommerceos/admin-handoff",
      headers: SERVICE,
      payload: { subdomain: sub, ownerSubject, ownerEmail },
    });
  const ownerOf = async (sub: string) =>
    (await prisma.staffMember.findFirst({ where: { tenant: { slug: sub }, role: "owner" } }))?.trustId;

  // Distinct Portal identities race for the same unclaimed store: one wins, the rest are refused.
  const sub = handle("claim-race");
  const email = `owner@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: LEAKED_PASSWORD })).statusCode, 201);
  const claimants = Array.from({ length: 8 }, (_, i) => `local:claimant-${i}`);
  const results = await Promise.all(claimants.map((subject) => claimFor(sub, subject, email)));
  const winners = claimants.filter((_, i) => results[i]!.statusCode === 201);
  assert.equal(winners.length, 1, `statuses ${results.map((r) => r.statusCode).join(",")}`);
  for (const res of results.filter((r) => r.statusCode !== 201)) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().error, "owner_mismatch");
  }
  const winner = winners[0]!;
  assert.equal(await ownerOf(sub), winner, "the bound owner is the identity that won");

  // Later attempts by losers, including a different email case, never overwrite the owner.
  for (const subject of claimants.filter((c) => c !== winner)) {
    assert.equal((await claimFor(sub, subject, email.toUpperCase())).statusCode, 403);
  }
  assert.equal(await ownerOf(sub), winner);

  // The winner can open the store again (a replay of its own claim), and the binding is unchanged.
  const again = await claimFor(sub, winner, email);
  assert.equal(again.statusCode, 201, again.body);
  const code = decodeURIComponent((again.json().url as string).split("#handoff=")[1]!);
  const exchanged = await app.inject({ method: "POST", url: "/v1/auth/merchant/handoff/exchange", payload: { code } });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal(await ownerOf(sub), winner);
  const tenantId = (await prisma.tenant.findUnique({ where: { slug: sub } }))!.id;
  assert.equal(await prisma.auditLog.count({ where: { tenantId, action: "staff.owner_bound" } }), 1, "bound exactly once");

  // The same identity double-submitting its first claim is one claim, not a conflict.
  const twin = handle("claim-twin");
  const twinEmail = `owner@${twin}.example`;
  assert.equal((await provision({ subdomain: twin, email: twinEmail, password: LEAKED_PASSWORD })).statusCode, 201);
  const both = await Promise.all([claimFor(twin, "local:twin", twinEmail), claimFor(twin, "local:twin", twinEmail)]);
  assert.deepEqual(both.map((r) => r.statusCode), [201, 201], both.map((r) => r.body).join(" | "));
  assert.equal(await ownerOf(twin), "local:twin");
});

test("provisioning replays for the same owner and refuses anyone else", async () => {
  const sub = handle("idem");
  const email = `owner@${sub}.example`;
  const first = await provision({ subdomain: sub, email, ownerSubject: "local:idem-owner" });
  assert.equal(first.statusCode, 201, first.body);
  const again = await provision({ subdomain: sub, email, ownerSubject: "local:idem-owner" });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().replayed, true);
  assert.equal(again.json().tenantId, first.json().tenantId);
  const other = await provision({ subdomain: sub, email, ownerSubject: "local:other-owner" });
  assert.equal(other.statusCode, 409, other.body);
  assert.equal(await prisma.tenant.count({ where: { slug: sub } }), 1);
});

test("only owners and admins can spawn marketplace stores", async () => {
  const sub = handle("roles");
  const res = await provision({ subdomain: sub, email: `owner@${sub}.example`, password: GOOD_PASSWORD });
  const tenantId = res.json().tenantId as string;
  const { hashPassword } = await import("../../apps/ecommerceos-api/src/lib/crypto.ts");
  await prisma.staffMember.create({
    data: {
      tenantId,
      displayName: "Clerk",
      email: `clerk@${sub}.example`,
      passwordHash: hashPassword(GOOD_PASSWORD),
      role: "clerk",
    },
  });
  const clerk = (await login(`clerk@${sub}.example`, GOOD_PASSWORD, sub)).json().token as string;
  const enable = await app.inject({ method: "POST", url: "/v1/marketplace/enable", headers: bearer(clerk) });
  assert.equal(enable.statusCode, 403, enable.body);
  const products = await app.inject({ method: "GET", url: "/v1/products", headers: bearer(clerk) });
  assert.equal(products.statusCode, 200, "clerks still manage the catalogue");
});

test("merchants never see a buyer's credential", async () => {
  const sub = handle("privacy");
  const email = `owner@${sub}.example`;
  const res = await provision({ subdomain: sub, email, password: GOOD_PASSWORD });
  const tenantId = res.json().tenantId as string;
  const token = (await login(email, GOOD_PASSWORD, sub)).json().token as string;
  const product = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: bearer(token),
    payload: { title: "Tea", variants: [{ sku: `TEA-${sub}`, priceMinor: 50000, inventoryCount: 5 }] },
  });
  assert.equal(product.statusCode, 201, product.body);
  const variantId = product.json().variants[0].id as string;

  const buyerSecret = "TD-buyer-very-secret-token-123";
  const buyer = { authorization: `Bearer ${buyerSecret}`, "x-tenant-id": tenantId };
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/cart/items", headers: buyer, payload: { variantId, quantity: 1 } }))
      .statusCode,
    201,
  );
  const placed = await app.inject({
    method: "POST",
    url: "/v1/orders",
    headers: buyer,
    payload: {
      buyerName: "Bisi",
      shipping: { addressLine1: "1 Road", city: "Lagos", country: "NG", lat: 6.5, lng: 3.4 },
    },
  });
  assert.equal(placed.statusCode, 201, placed.body);

  const list = await app.inject({ method: "GET", url: "/v1/orders", headers: bearer(token) });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.body.includes(buyerSecret), false);
  assert.equal("buyerTrustId" in (list.json() as Array<Record<string, unknown>>)[0]!, false);
  const stored = await prisma.order.findUnique({ where: { id: placed.json().id } });
  assert.equal(stored!.buyerTrustId.includes(buyerSecret), false);
});
