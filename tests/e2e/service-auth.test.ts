/**
 * E2E: the eCommerceOS side of the Portal ↔ eCommerceOS contract v2, in "signed" mode.
 * - Portal → eCommerceOS calls carry digiconomy-service+jwt (Ed25519) tokens; the shared token is
 *   refused on those routes; permissions come from eCommerceOS's configuration only.
 * - Provisioning is idempotent per Portal install, bound to install, business and owner.
 * - Seller registrations to Portal are signed, recorded and backfilled without duplicates.
 * LifeOS Portal is NOT involved: seller-install goes to a local stub that follows Portal's written
 * semantics (201 created, 200 replayed, 409 conflict). Synthetic data only.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prismaSchemaArgs, testDatabaseUrl } from "./test-database.ts";
import { bootstrapAdmin } from "./platform-operators.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const dbName = `service-auth-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);
const SHARED = "service-auth-e2e-shared-token";
const PLATFORM_TOKEN = "service-auth-e2e-platform-admin-token-0123456789";
const PASSWORD = "Copper-Meadow-Passw0rd-27";

// Synthetic identities: "lifeos-portal" with the three store permissions, a read-only service,
// and eCommerceOS's own signing key (which Portal, here the stub, trusts).
const portalKey = generateKeyPairSync("ed25519");
const readerKey = generateKeyPairSync("ed25519");
const ecoKey = generateKeyPairSync("ed25519");
const rawX = (k: KeyObject) => (k.export({ format: "jwk" }) as { x: string }).x;

let app: FastifyInstance;
let prisma: PrismaClient;
let sign: typeof import("../../apps/ecommerceos-api/src/lib/service-token.ts").signServiceToken;
type StubEvent = { eventId: string; version: number; tenantId: string; installId: string | null; businessId: string | null; subdomain: string; status: string; cause: string };
let stub: {
  server: http.Server;
  port: number;
  installs: Map<string, string>;
  calls: Array<{ status: number; replay: boolean }>;
  mode: "ok" | "fail-after-record";
  /** Portal's activation receiver, by its agreed rules: apply only a higher version per store. */
  activations: { events: Map<string, StubEvent>; byTenant: Map<string, { version: number; status: string }>; mode: "ok" | "fail" | "conflict" };
};
let operatorToken: string;

function startStub() {
  return new Promise<typeof stub>((resolve) => {
    const installs = new Map<string, string>();
    const calls: Array<{ status: number; replay: boolean }> = [];
    const state = { mode: "ok" as "ok" | "fail-after-record" };
    const activations = { events: new Map<string, StubEvent>(), byTenant: new Map<string, { version: number; status: string }>(), mode: "ok" as "ok" | "fail" | "conflict" };
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const { verifyServiceToken, parseTrustedServices } = await import("../../apps/ecommerceos-api/src/lib/service-token.ts");
      const used = (globalThis as { __stubJti?: Set<string> }).__stubJti ?? ((globalThis as { __stubJti?: Set<string> }).__stubJti = new Set());
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const path = (req.url ?? "").split("?")[0]!;
      const isActivation = path === "/internal/ecommerceos/activation-events";
      try {
        await verifyServiceToken({
          authorization: req.headers.authorization,
          idempotencyKey: req.headers["idempotency-key"] as string | undefined,
          method: req.method ?? "",
          path,
          body,
          audience: "lifeos-portal",
          permission: isActivation ? "activation:report" : "marketplace:seller-install",
          trusted: parseTrustedServices(JSON.stringify({ ecommerceos: { permissions: ["marketplace:seller-install", "activation:report"], keys: { "eco-test-1": rawX(ecoKey.publicKey) } } })),
          production: false,
          consumeJti: async (i, j) => (used.has(i + j) ? false : (used.add(i + j), true)),
        });
      } catch (err) {
        return reply((err as { statusCode?: number }).statusCode ?? 401, { error: (err as Error).message });
      }
      if (isActivation) {
        const ev = JSON.parse(body.toString()) as StubEvent;
        if (req.headers["idempotency-key"] !== `eco-activation:${ev.eventId}`) return reply(422, { error: "idempotency_key_mismatch" });
        if (activations.mode === "fail") return reply(503, { error: "unavailable" });
        if (activations.mode === "conflict") return reply(409, { error: "activation_conflict" });
        if (activations.events.has(ev.eventId)) return reply(200, { ok: true, replayed: true });
        const current = activations.byTenant.get(ev.tenantId);
        if (current && current.version === ev.version && current.status !== ev.status) return reply(409, { error: "activation_conflict" });
        activations.events.set(ev.eventId, ev);
        if (!current || ev.version > current.version) {
          activations.byTenant.set(ev.tenantId, { version: ev.version, status: ev.status });
          return reply(200, { ok: true, applied: true });
        }
        return reply(200, { ok: true, applied: false });
      }
      const parsed = JSON.parse(body.toString()) as { applicationId: string };
      if (req.headers["idempotency-key"] !== `eco-seller:${parsed.applicationId}`) return reply(422, { error: "idempotency_key_mismatch" });
      const prior = installs.get(parsed.applicationId);
      if (prior !== undefined && prior !== body.toString()) return reply(409, { error: "idempotency_conflict" });
      const replay = prior !== undefined;
      installs.set(parsed.applicationId, body.toString());
      calls.push({ status: replay ? 200 : 201, replay });
      if (stub.mode === "fail-after-record") return reply(500, { error: "lost_response" }); // recorded, answer lost
      reply(replay ? 200 : 201, { ok: true, ...(replay ? { replayed: true } : {}), install: { id: parsed.applicationId } });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, installs, calls, activations, get mode() { return state.mode; }, set mode(v) { state.mode = v; } } as typeof stub);
    });
  });
}

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* reused by prisma db push */
    }
  }
  stub = await startStub();
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = testDatabaseUrl(`file:./${dbName}`);
  process.env.INTERNAL_PROVISION_TOKEN = SHARED;
  process.env.PORTAL_INTERNAL_TOKEN = SHARED;
  process.env.PRIMITIVES_MODE = "local";
  process.env.LOGISTICS_MODE = "local";
  process.env.ECO_PLATFORM_ADMIN_TOKEN = PLATFORM_TOKEN;
  process.env.ECO_OPERATOR_MFA_KEY = "service-auth-e2e-operator-mfa-key-0123456789";
  process.env.ECO_SERVICE_AUTH_MODE = "signed";
  process.env.ECO_TRUSTED_SERVICES = JSON.stringify({
    "lifeos-portal": { permissions: ["stores:provision", "stores:admin-handoff", "stores:read", "stores:bind-business"], keys: { "portal-test-1": rawX(portalKey.publicKey) } },
    "status-reader": { permissions: ["stores:read"], keys: { "reader-test-1": rawX(readerKey.publicKey) } },
  });
  process.env.ECO_SERVICE_SIGNING_KEY = (ecoKey.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64url");
  process.env.ECO_SERVICE_SIGNING_KID = "eco-test-1";
  process.env.PORTAL_API_URL = `http://127.0.0.1:${stub.port}`;
  delete process.env.ECO_ACTIVATION_REQUIRED;
  execSync(`npx prisma db push --skip-generate${prismaSchemaArgs()}`, {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "test" },
    stdio: "pipe",
  });
  ({ signServiceToken: sign } = await import("../../apps/ecommerceos-api/src/lib/service-token.ts"));
  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  app = await buildApp();
  await app.ready();
  prisma = new PrismaClient();
  operatorToken = (await bootstrapAdmin(app, prisma, PLATFORM_TOKEN, "ops-admin@digiconomy.example", PASSWORD)).token;
});

beforeEach(async () => {
  const { accountLoginThrottle } = await import("../../apps/ecommerceos-api/src/services/staff-auth.ts");
  accountLoginThrottle.reset();
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
  stub?.server.close();
});

const handle = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** A Portal-style signed call: exact body bytes, Idempotency-Key in header and claim. */
function signedCall(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  opts: { idk?: string; key?: KeyObject; kid?: string; iss?: string; aud?: string; path?: string; now?: number; token?: string; bodyOverride?: string } = {},
) {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  const token =
    opts.token ??
    sign({
      issuer: opts.iss ?? "lifeos-portal",
      kid: opts.kid ?? "portal-test-1",
      key: opts.key ?? portalKey.privateKey,
      audience: opts.aud ?? "ecommerceos",
      method,
      path: opts.path ?? url.split("?")[0]!,
      body: bytes,
      idempotencyKey: opts.idk,
      now: opts.now,
    });
  return {
    token,
    res: app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(opts.idk ? { "idempotency-key": opts.idk } : {}), ...(bytes ? { "content-type": "application/json" } : {}) },
      ...(bytes ? { payload: opts.bodyOverride ?? bytes } : {}),
    }),
  };
}

function provisionBody(installId: string, subdomain: string, ownerSubject: string) {
  return {
    tenantId: `tid_${subdomain}_x1`,
    installId,
    subdomain,
    displayName: `Store ${subdomain}`,
    seed: "default",
    trustId: { businessPublicId: `biz_${installId}` },
    owner: { subject: ownerSubject },
    adminStaff: { email: `owner@${subdomain}.example`, displayName: "Owner", role: "owner" },
  };
}

test("Portal-signed provisioning creates exactly one store, bound to install, business and owner; status returns the bindings", async () => {
  const installId = handle("ins");
  const subdomain = handle("bind");
  const created = await signedCall("POST", "/internal/distributor/provision", provisionBody(installId, subdomain, "trustid:owner-1"), { idk: `portal-install:${installId}` }).res;
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().installId, installId);
  assert.equal(created.json().businessId, `biz_${installId}`);
  assert.equal(created.json().credentialSetup, "portal_handoff", "no owner password crosses the boundary");
  assert.equal(await prisma.tenant.count({ where: { portalInstall: { is: { installId } } } }), 1);

  const status = await signedCall("GET", `/internal/ecommerceos/stores/${subdomain}`, undefined).res;
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(
    { installId: status.json().installId, businessId: status.json().businessId, ownerSubject: status.json().ownerSubject, tenantId: status.json().tenantId },
    { installId, businessId: `biz_${installId}`, ownerSubject: "trustid:owner-1", tenantId: created.json().tenantId },
  );
  const { updatedAt, ...activation } = status.json().activation;
  assert.deepEqual(activation, { required: false, status: "legacy", storeOpen: true, version: 1 });
  assert.equal(typeof updatedAt, "string");
});

test("duplicate setup requests create no duplicate store, sequentially or concurrently; a timed-out request is reconciled by replay", async () => {
  const installId = handle("ins");
  const body = provisionBody(installId, handle("dup"), "trustid:owner-2");
  const idk = `portal-install:${installId}`;
  const all = await Promise.all([1, 2, 3, 4].map(() => signedCall("POST", "/internal/distributor/provision", body, { idk }).res));
  const codes = all.map((r) => r.statusCode);
  assert.ok(codes.includes(201) && codes.every((c) => [201, 200, 503].includes(c)), all.map((r) => `${r.statusCode} ${r.json().error ?? ""} ${r.json().message ?? ""}`).join(" | "));
  assert.equal(await prisma.tenant.count({ where: { portalInstall: { is: { installId } } } }), 1, "one store for the install");
  // The response was "lost": the identical request returns the same store as a replay.
  const replay = await signedCall("POST", "/internal/distributor/provision", body, { idk }).res;
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().tenantId, all.find((r) => r.statusCode === 201)!.json().tenantId);
});

test("concurrent duplicates of one install never get a terminal conflict (a request can find the store by subdomain before its owner exists)", async () => {
  for (let round = 0; round < 10; round += 1) {
    const installId = handle("ins");
    const body = provisionBody(installId, handle("race"), `trustid:race-${round}`);
    const all = await Promise.all([1, 2, 3, 4, 5, 6].map(() => signedCall("POST", "/internal/distributor/provision", body, { idk: `portal-install:${installId}` }).res));
    const outcomes = all.map((r) => `${r.statusCode} ${r.json().error ?? ""}`.trim());
    assert.ok(outcomes.every((o) => o === "201" || o === "200" || o === "503 provision_in_progress"), outcomes.join(" | "));
    assert.equal(await prisma.tenant.count({ where: { portalInstall: { is: { installId } } } }), 1);
  }
});

test("the same key for another request, a key naming another install, and another owner's subdomain claim are refused", async () => {
  const installId = handle("ins");
  const subdomain = handle("claim");
  const body = provisionBody(installId, subdomain, "trustid:owner-3");
  assert.equal((await signedCall("POST", "/internal/distributor/provision", body, { idk: `portal-install:${installId}` }).res).statusCode, 201);
  const changed = await signedCall("POST", "/internal/distributor/provision", { ...body, displayName: "Changed" }, { idk: `portal-install:${installId}` }).res;
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json().error, "idempotency_conflict");
  const wrongKey = await signedCall("POST", "/internal/distributor/provision", body, { idk: "portal-install:someone-else" }).res;
  assert.equal(wrongKey.json().error, "idempotency_key_mismatch");

  const rival = handle("ins");
  const takeover = await signedCall("POST", "/internal/distributor/provision", provisionBody(rival, subdomain, "trustid:intruder"), { idk: `portal-install:${rival}` }).res;
  assert.equal(takeover.statusCode, 409, takeover.body);
  assert.equal(takeover.json().error, "conflict");
  const sameOwnerOtherInstall = await signedCall("POST", "/internal/distributor/provision", provisionBody(rival, subdomain, "trustid:owner-3"), { idk: `portal-install:${rival}` }).res;
  assert.equal(sameOwnerOtherInstall.statusCode, 409, "a second install cannot claim the first install's store");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: subdomain }, include: { staff: true, portalInstall: true } });
  assert.equal(tenant.portalInstall?.installId, installId, "the original install keeps its store");
  assert.equal(tenant.staff.find((s) => s.role === "owner")?.trustId, "trustid:owner-3");
});

test("failed provisioning keeps nothing; the identical signed request then succeeds", async () => {
  const installId = handle("ins");
  const subdomain = handle("recover");
  const blocker = await prisma.tenant.create({ data: { slug: `blocker-${subdomain}`, name: "Blocker", settings: {} } });
  await prisma.storeConfig.create({
    data: { tenantId: blocker.id, storeName: "Blocker", subdomain, pickupAddressLine1: "1 Test Road", pickupCity: "Lagos", pickupCountry: "NG", pickupLat: 6.45, pickupLng: 3.39 },
  });
  const body = provisionBody(installId, subdomain, "trustid:owner-4");
  const idk = `portal-install:${installId}`;
  const failed = await signedCall("POST", "/internal/distributor/provision", body, { idk }).res;
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal(failed.json().error, "provision_failed");
  assert.equal(await prisma.tenant.count({ where: { portalInstall: { is: { installId } } } }), 0, "nothing kept");
  assert.equal(await prisma.portalInstall.count({ where: { installId } }), 0, "the install and its key are free again");
  await prisma.tenant.delete({ where: { id: blocker.id } });
  assert.equal((await signedCall("POST", "/internal/distributor/provision", body, { idk }).res).statusCode, 201);
});

test("the merchant reaches only their own dashboard: handoff is bound to install and owner", async () => {
  const installId = handle("ins");
  const subdomain = handle("handoff");
  await signedCall("POST", "/internal/distributor/provision", provisionBody(installId, subdomain, "trustid:owner-5"), { idk: `portal-install:${installId}` }).res;
  const wrongInstall = await signedCall("POST", "/internal/ecommerceos/admin-handoff", { subdomain, ownerSubject: "trustid:owner-5", installId: "ins_other" }).res;
  assert.equal(wrongInstall.statusCode, 403, wrongInstall.body);
  assert.equal(wrongInstall.json().error, "install_mismatch");
  const wrongOwner = await signedCall("POST", "/internal/ecommerceos/admin-handoff", { subdomain, ownerSubject: "trustid:intruder", installId }).res;
  assert.equal(wrongOwner.statusCode, 403, wrongOwner.body);
  const ok = await signedCall("POST", "/internal/ecommerceos/admin-handoff", { subdomain, ownerSubject: "trustid:owner-5", installId }).res;
  assert.equal(ok.statusCode, 201, ok.body);
  const code = decodeURIComponent((ok.json().url as string).split("#handoff=")[1]!);
  const session = await app.inject({ method: "POST", url: "/v1/auth/merchant/handoff/exchange", payload: { code } });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().staff.tenantSlug, subdomain, "the session is for this store only");
  const otherStore = handle("other");
  await signedCall("POST", "/internal/distributor/provision", provisionBody(handle("ins"), otherStore, "trustid:owner-6"), {}).res;
  const crossOrders = await app.inject({ method: "GET", url: `/v1/storefront`, headers: { "x-store-subdomain": otherStore } });
  assert.equal(crossOrders.json().subdomain, otherStore, "each storefront answers only for its own store");
});

test("wrong issuer, key, audience, route, body, idempotency key, permission, lifetime or a replay are refused", async () => {
  const installId = handle("ins");
  const body = provisionBody(installId, handle("neg"), "trustid:owner-7");
  const idk = `portal-install:${installId}`;
  const url = "/internal/distributor/provision";
  const cases: Array<[string, Parameters<typeof signedCall>[3], number, string]> = [
    ["unknown issuer", { idk, iss: "master-distributor", kid: "portal-test-1" }, 401, "unknown_service_key"],
    ["eCommerceOS's own key is not a Portal key", { idk, iss: "ecommerceos", kid: "eco-test-1", key: ecoKey.privateKey }, 401, "unknown_service_key"],
    ["key signed by someone else", { idk, key: readerKey.privateKey }, 401, "bad_signature"],
    ["wrong audience", { idk, aud: "lifeos-portal" }, 401, "wrong_audience"],
    ["bound to another route", { idk, path: "/internal/ecommerceos/admin-handoff" }, 401, "token_bound_to_other_route"],
    ["body changed after signing", { idk, bodyOverride: JSON.stringify({ ...body, displayName: "Tampered" }) }, 401, "body_mismatch"],
    ["expired", { idk, now: Date.now() - 10 * 60 * 1000 }, 401, "token_expired"],
    ["service without the permission", { idk, iss: "status-reader", kid: "reader-test-1", key: readerKey.privateKey }, 403, "permission_denied"],
  ];
  for (const [label, opts, status, code] of cases) {
    const res = await signedCall("POST", url, body, opts).res;
    assert.equal(res.statusCode, status, `${label}: ${res.body}`);
    assert.equal(res.json().error, code, label);
  }
  const mismatch = sign({ issuer: "lifeos-portal", kid: "portal-test-1", key: portalKey.privateKey, audience: "ecommerceos", method: "POST", path: url, body: JSON.stringify(body), idempotencyKey: "portal-install:other" });
  const idkRes = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${mismatch}`, "idempotency-key": idk, "content-type": "application/json" }, payload: JSON.stringify(body) });
  assert.equal(idkRes.json().error, "idempotency_key_mismatch");
  const first = signedCall("POST", url, body, { idk });
  assert.equal((await first.res).statusCode, 201);
  const replayed = await signedCall("POST", url, body, { idk, token: first.token }).res;
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().error, "token_replayed", "the same token never works twice");
  assert.ok(await prisma.auditLog.count({ where: { action: "service.call_refused" } }), "refusals are audited");
});

test("a signed call may not set an owner password or a payout account; nothing is created", async () => {
  for (const [field, extra] of [
    ["adminStaff.password", { adminStaff: { email: "owner@pw.example", displayName: "Owner", role: "owner", password: PASSWORD } }],
    ["walletPayoutAccount", { walletPayoutAccount: "0123456789" }],
  ] as const) {
    const installId = handle("ins");
    const subdomain = handle("fields");
    const res = await signedCall("POST", "/internal/distributor/provision", { ...provisionBody(installId, subdomain, "trustid:owner-fields"), ...extra }, { idk: `portal-install:${installId}` }).res;
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, "field_not_allowed");
    assert.deepEqual(res.json().fields, [field]);
    assert.ok(!res.body.includes(PASSWORD) && !res.body.includes("0123456789"), "values are never echoed");
    assert.equal(await prisma.tenant.count({ where: { slug: subdomain } }), 0, "nothing created");
  }
});

test("while provisioning is paused nothing is created and status reads still answer; the same request succeeds afterwards", async () => {
  const { config } = await import("../../apps/ecommerceos-api/src/config.ts");
  const installId = handle("ins");
  const subdomain = handle("paused");
  const body = provisionBody(installId, subdomain, "trustid:owner-paused");
  const idk = `portal-install:${installId}`;
  config.provisioningPaused = true;
  try {
    const paused = await signedCall("POST", "/internal/distributor/provision", body, { idk }).res;
    assert.equal(paused.statusCode, 503, paused.body);
    assert.equal(paused.json().error, "provisioning_paused");
    assert.equal(await prisma.tenant.count({ where: { slug: subdomain } }), 0, "nothing created");
    assert.equal(await prisma.portalInstall.count({ where: { installId } }), 0, "no install claimed");
    const status = await signedCall("GET", `/internal/ecommerceos/stores/${subdomain}`, undefined).res;
    assert.equal(status.statusCode, 404, "status still answers");
    assert.equal(status.json().provisioningPaused, true, "a 404 says no provisioning can still create the store");
  } finally {
    config.provisioningPaused = false;
  }
  assert.equal((await signedCall("POST", "/internal/distributor/provision", body, { idk }).res).statusCode, 201);
});

test("each service call is in the operator audit log with its caller, route and correlation id", async () => {
  const installId = handle("ins");
  const subdomain = handle("audit");
  const idk = `portal-install:${installId}`;
  assert.equal((await signedCall("POST", "/internal/distributor/provision", provisionBody(installId, subdomain, "trustid:owner-audit"), { idk }).res).statusCode, 201);
  const url = `/internal/ecommerceos/stores/${subdomain}`;
  const token = sign({ issuer: "status-reader", kid: "reader-test-1", key: readerKey.privateKey, audience: "ecommerceos", method: "GET", path: url, body: "" });
  const read = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, "x-request-id": `recon-run-1-${installId}` } });
  assert.equal(read.statusCode, 200, read.body);
  const audit = await app.inject({ method: "GET", url: "/v1/platform/audit?limit=500", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(audit.statusCode, 200, audit.body);
  const rows = (audit.json().entries as Array<{ action: string; actorId: string | null; resourceId: string | null; metadata: { correlationId?: string; permission?: string } }>).filter((e) => e.metadata?.correlationId === `recon-run-1-${installId}`);
  assert.equal(rows.length, 1, "exactly one audit row for the read");
  assert.deepEqual([rows[0]!.action, rows[0]!.actorId, rows[0]!.resourceId, rows[0]!.metadata.permission], ["service.call_authorized", "status-reader", `GET ${url}`, "stores:read"]);
});

test("in signed mode the shared token is refused on Portal routes, and Portal tokens open no other internal route", async () => {
  const shared = await app.inject({ method: "POST", url: "/internal/distributor/provision", headers: { authorization: `Bearer ${SHARED}` }, payload: provisionBody(handle("ins"), handle("shared"), "trustid:x") });
  assert.equal(shared.statusCode, 401, shared.body);
  assert.equal(shared.json().error, "service_token_required");
  for (const url of ["/internal/jobs/sweep-unpaid-orders", "/internal/ecommerce/webhooks/logistics-update", "/internal/platform/operators"]) {
    const res = await signedCall("POST", url, {}).res;
    assert.equal(res.statusCode, 401, `${url}: ${res.body}`);
  }
  const jobs = await app.inject({ method: "POST", url: "/internal/jobs/sweep-unpaid-orders", headers: { authorization: `Bearer ${SHARED}` } });
  assert.equal(jobs.statusCode, 200, "internal jobs keep their own (shared) credential");
});

async function marketplaceOperatorToken() {
  const subdomain = handle("mkt");
  const installId = handle("ins");
  // As in production: Portal provisions without a password, and the owner arrives through the handoff.
  const prov = await signedCall("POST", "/internal/distributor/provision", provisionBody(installId, subdomain, `trustid:${subdomain}`), { idk: `portal-install:${installId}` }).res;
  assert.equal(prov.statusCode, 201, prov.body);
  const handoff = await signedCall("POST", "/internal/ecommerceos/admin-handoff", { subdomain, ownerSubject: `trustid:${subdomain}`, installId }).res;
  assert.equal(handoff.statusCode, 201, handoff.body);
  const code = decodeURIComponent((handoff.json().url as string).split("#handoff=")[1]!);
  const session = await app.inject({ method: "POST", url: "/v1/auth/merchant/handoff/exchange", payload: { code } });
  assert.equal(session.statusCode, 200, session.body);
  const token = session.json().token as string;
  await app.inject({ method: "POST", url: "/v1/marketplace/enable", headers: { authorization: `Bearer ${token}` } });
  return token;
}

const createSeller = (token: string, name: string) =>
  app.inject({ method: "POST", url: "/v1/marketplace/sellers/stores", headers: { authorization: `Bearer ${token}` }, payload: { displayName: name, adminPassword: `${PASSWORD}-${name.length}` } });

test("seller registrations reach Portal signed and exactly once; failures are recorded honestly; backfill adds no duplicates", async () => {
  const mkt = await marketplaceOperatorToken();
  const first = await createSeller(mkt, "Seller One");
  assert.equal(first.statusCode, 201, first.body);
  const firstApp = first.json().store.applicationId as string;
  assert.equal((await prisma.portalSellerRegistration.findUniqueOrThrow({ where: { applicationId: firstApp } })).status, "registered");
  assert.equal(stub.installs.size, 1);
  assert.equal(stub.calls.length, 1, "one signed call");

  // Portal unavailable: the seller store is still created; the registration is recorded as failed.
  stub.server.close();
  await new Promise((r) => setTimeout(r, 100));
  const second = await createSeller(mkt, "Seller Two");
  assert.equal(second.statusCode, 201, second.body);
  const secondApp = second.json().store.applicationId as string;
  const down = await prisma.portalSellerRegistration.findUniqueOrThrow({ where: { applicationId: secondApp } });
  assert.equal(down.status, "failed");
  assert.equal(down.lastError, "portal_unreachable", "no fabricated success");

  // Portal back, but the first answer is lost after Portal recorded it.
  await new Promise<void>((resolve) => stub.server.listen(stub.port, "127.0.0.1", () => resolve()));
  stub.mode = "fail-after-record";
  const backfill1 = await app.inject({ method: "POST", url: "/v1/platform/portal/seller-registrations/backfill", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(backfill1.statusCode, 200, backfill1.body);
  assert.equal(backfill1.json().attempted, 1, "only the missing registration is sent");
  assert.equal((await prisma.portalSellerRegistration.findUniqueOrThrow({ where: { applicationId: secondApp } })).status, "failed");
  stub.mode = "ok";
  const backfill2 = await app.inject({ method: "POST", url: "/v1/platform/portal/seller-registrations/backfill", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(backfill2.json().registered, 1, backfill2.body);
  assert.equal(stub.calls.at(-1)?.replay, true, "Portal saw the identical request again: a replay, not a new install");
  assert.equal(stub.installs.size, 2, "two sellers, two installs: nothing duplicated");
  const backfill3 = await app.inject({ method: "POST", url: "/v1/platform/portal/seller-registrations/backfill", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(backfill3.json().attempted, 0, "nothing left to send");
  assert.equal((await app.inject({ method: "POST", url: "/v1/platform/portal/seller-registrations/backfill" })).statusCode, 401, "backfill needs an operator session");
  assert.equal(await prisma.auditLog.count({ where: { action: "platform.seller_registration_backfill" } }), 3);
});

// ---- Activation sync and the stable business id -------------------------------------------------

async function delivered(tenantId: string, version: number) {
  for (let i = 0; i < 50; i += 1) {
    const row = await prisma.activationEvent.findUnique({ where: { tenantId_version: { tenantId, version } } });
    if (row && row.delivery !== "pending") return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return prisma.activationEvent.findUnique({ where: { tenantId_version: { tenantId, version } } });
}

test("a new store reports its activation to Portal as version 1, signed, and never as paid", async () => {
  const installId = handle("ins");
  const subdomain = handle("act");
  const created = await signedCall("POST", "/internal/distributor/provision", provisionBody(installId, subdomain, "trustid:owner-act"), { idk: `portal-install:${installId}` }).res;
  assert.equal(created.statusCode, 201, created.body);
  const tenantId = created.json().tenantId as string;
  const row = await delivered(tenantId, 1);
  assert.equal(row?.delivery, "delivered", row?.lastError ?? "");
  const ev = stub.activations.events.get(row!.id)!;
  assert.deepEqual(
    { version: ev.version, tenantId: ev.tenantId, installId: ev.installId, businessId: ev.businessId, subdomain: ev.subdomain, status: ev.status, cause: ev.cause },
    { version: 1, tenantId, installId, businessId: `biz_${installId}`, subdomain, status: "legacy", cause: "created" },
  );
  assert.notEqual(ev.status, "active", "creating a store never reports it as paid");
  const status = await signedCall("GET", `/internal/ecommerceos/stores/${subdomain}`, undefined).res;
  assert.equal(status.json().activation.version, 1);
  assert.equal(typeof status.json().activation.updatedAt, "string");
});

test("each activation change takes the next version with it; failed deliveries are honest and re-sent in order; a conflict waits for an operator", async () => {
  const { changeActivationStatus, sendActivationEvent } = await import("../../apps/ecommerceos-api/src/services/activation-events.ts");
  const installId = handle("ins");
  const subdomain = handle("actv");
  const created = await signedCall("POST", "/internal/distributor/provision", provisionBody(installId, subdomain, "trustid:owner-actv"), { idk: `portal-install:${installId}` }).res;
  const tenantId = created.json().tenantId as string;
  assert.equal((await delivered(tenantId, 1))?.delivery, "delivered");

  stub.activations.mode = "fail";
  const v2 = await prisma.$transaction((tx) => changeActivationStatus(tx, tenantId, "active", "verified"));
  const v3 = await prisma.$transaction((tx) => changeActivationStatus(tx, tenantId, "legacy", "reversed", "active"));
  const notActive = await prisma.$transaction((tx) => changeActivationStatus(tx, tenantId, "legacy", "reversed", "active"));
  assert.equal(notActive, null, "a guarded change that does not apply records nothing");
  assert.equal(await sendActivationEvent(v3!), "failed", "Portal unavailable: recorded as failed, not delivered");
  assert.equal(await sendActivationEvent(v2!), "failed");
  const rows = await prisma.activationEvent.findMany({ where: { tenantId }, orderBy: { version: "asc" } });
  assert.deepEqual(rows.map((r) => [r.version, r.status, r.cause]), [[1, "legacy", "created"], [2, "active", "verified"], [3, "legacy", "reversed"]]);
  assert.equal((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).activationVersion, 3);

  stub.activations.mode = "ok";
  const resend = await app.inject({ method: "POST", url: "/v1/platform/portal/activation-events/resend", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(resend.statusCode, 200, resend.body);
  assert.ok(resend.json().delivered >= 2, resend.body);
  assert.deepEqual(stub.activations.byTenant.get(tenantId), { version: 3, status: "legacy" }, "Portal ends on the latest version");
  const again = await app.inject({ method: "POST", url: "/v1/platform/portal/activation-events/resend", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal((await prisma.activationEvent.findUniqueOrThrow({ where: { id: v2! } })).attempts, 2, `delivered events are not re-sent: ${again.body}`);

  stub.activations.mode = "conflict";
  const v4 = await prisma.$transaction((tx) => changeActivationStatus(tx, tenantId, "active", "verified"));
  assert.equal(await sendActivationEvent(v4!), "conflict");
  stub.activations.mode = "ok";
  await app.inject({ method: "POST", url: "/v1/platform/portal/activation-events/resend", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal((await prisma.activationEvent.findUniqueOrThrow({ where: { id: v4! } })).attempts, 1, "a conflict is left for an operator");
  // Refused by Portal (for example before its receiver existed): not re-sent until asked.
  stub.activations.mode = "fail";
  const v5Status = await prisma.$transaction((tx) => changeActivationStatus(tx, tenantId, "legacy", "reversed", "active"));
  stub.server.close();
  await new Promise((r) => setTimeout(r, 100));
  await new Promise<void>((resolve) => stub.server.listen(stub.port, "127.0.0.1", () => resolve()));
  stub.activations.mode = "ok";
  await prisma.activationEvent.update({ where: { id: v5Status! }, data: { delivery: "rejected", httpStatus: 403, lastError: "permission_denied" } });
  await app.inject({ method: "POST", url: "/v1/platform/portal/activation-events/resend", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal((await prisma.activationEvent.findUniqueOrThrow({ where: { id: v5Status! } })).delivery, "rejected", "a rejected event is not re-sent by default");
  const withRejected = await app.inject({ method: "POST", url: "/v1/platform/portal/activation-events/resend?include=rejected", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(withRejected.json().includeRejected, true, withRejected.body);
  assert.equal((await prisma.activationEvent.findUniqueOrThrow({ where: { id: v5Status! } })).delivery, "delivered", "re-sent once asked");
  assert.equal((await prisma.activationEvent.findUniqueOrThrow({ where: { id: v4! } })).delivery, "conflict", "a conflict is still left for an operator");
  const list = await app.inject({ method: "GET", url: "/v1/platform/portal/activation-events", headers: { authorization: `Bearer ${operatorToken}` } });
  assert.ok((list.json().events as Array<{ eventId: string; delivery: string }>).some((e) => e.eventId === v4 && e.delivery === "conflict"));
});

test("the business id is Portal's, stored verbatim, never derived; an older store binds its stable id once", async () => {
  const bindUrl = (sub: string) => `/internal/ecommerceos/stores/${sub}/business`;
  // Explicit and stable.
  const i1 = handle("ins");
  const s1 = handle("biz");
  const { trustId: _alias, ...withoutAlias } = provisionBody(i1, s1, "trustid:owner-b1");
  const stable = await signedCall("POST", "/internal/distributor/provision", { ...withoutAlias, businessId: "bus_stable_1" }, { idk: `portal-install:${i1}` }).res;
  assert.equal(stable.statusCode, 201, stable.body);
  assert.equal(stable.json().businessId, "bus_stable_1");
  assert.equal((await signedCall("GET", `/internal/ecommerceos/stores/${s1}`, undefined).res).json().businessId, "bus_stable_1");
  // The older alias may not contradict it.
  const i2 = handle("ins");
  const mismatch = await signedCall("POST", "/internal/distributor/provision", { ...provisionBody(i2, handle("biz"), "trustid:owner-b2"), businessId: "bus_other" }, { idk: `portal-install:${i2}` }).res;
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal(mismatch.json().error, "business_id_mismatch");
  // Older stores: a subdomain-derived value is not a business id, and can be bound once.
  const i3 = handle("ins");
  const s3 = handle("biz");
  const owner3 = "trustid:owner-b3";
  const legacy = await signedCall("POST", "/internal/distributor/provision", { ...provisionBody(i3, s3, owner3), trustId: { businessPublicId: `biz_${s3}` } }, { idk: `portal-install:${i3}` }).res;
  assert.equal(legacy.statusCode, 201, legacy.body);
  assert.equal(legacy.json().businessId, null);
  const bindBody = JSON.stringify({ businessId: "bus_stable_3", installId: i3, ownerSubject: owner3 });
  const readerToken = sign({ issuer: "status-reader", kid: "reader-test-1", key: readerKey.privateKey, audience: "ecommerceos", method: "POST", path: bindUrl(s3), body: bindBody });
  const asReader = await app.inject({ method: "POST", url: bindUrl(s3), headers: { authorization: `Bearer ${readerToken}`, "content-type": "application/json" }, payload: bindBody });
  assert.equal(asReader.statusCode, 403, "binding needs stores:bind-business");
  assert.equal((await signedCall("POST", bindUrl(s3), { businessId: "bus_stable_3", installId: "ins_other", ownerSubject: owner3 }).res).json().error, "install_mismatch");
  assert.equal((await signedCall("POST", bindUrl(s3), { businessId: "bus_stable_3", installId: i3, ownerSubject: "trustid:intruder" }).res).json().error, "owner_mismatch");
  const bound = await signedCall("POST", bindUrl(s3), { businessId: "bus_stable_3", installId: i3, ownerSubject: owner3 }).res;
  assert.equal(bound.statusCode, 200, bound.body);
  assert.equal(bound.json().bound, true);
  assert.equal((await signedCall("GET", `/internal/ecommerceos/stores/${s3}`, undefined).res).json().businessId, "bus_stable_3");
  assert.equal((await signedCall("POST", bindUrl(s3), { businessId: "bus_stable_3", installId: i3, ownerSubject: owner3 }).res).json().replayed, true);
  const rebind = await signedCall("POST", bindUrl(s3), { businessId: "bus_other", installId: i3, ownerSubject: owner3 }).res;
  assert.equal(rebind.statusCode, 409);
  assert.equal(rebind.json().error, "business_id_conflict", "a bound business id never changes");
  assert.equal((await signedCall("POST", bindUrl(s1), { businessId: "bus_other", installId: i1, ownerSubject: "trustid:owner-b1" }).res).statusCode, 409);
  // A store from before install binding, whose install id was stored as its business id.
  const s4 = handle("biz");
  const old = await signedCall("POST", "/internal/distributor/provision", { ...withoutAlias, tenantId: `tid_${s4}`, installId: undefined, subdomain: s4, owner: { subject: "trustid:owner-b4" } }).res;
  assert.equal(old.statusCode, 201, old.body);
  await prisma.tenant.update({ where: { id: old.json().tenantId }, data: { lifeosBusinessId: `tid_${s4}` } });
  assert.equal((await signedCall("GET", `/internal/ecommerceos/stores/${s4}`, undefined).res).json().businessId, null);
  assert.equal((await signedCall("POST", bindUrl(s4), { businessId: "bus_stable_4", installId: `tid_${s4}`, ownerSubject: "trustid:owner-b4" }).res).statusCode, 200);
  const audit = await app.inject({ method: "GET", url: "/v1/platform/audit?limit=500", headers: { authorization: `Bearer ${operatorToken}` } });
  const entries = audit.json().entries as Array<{ action: string; metadata: { reason?: string; previous?: string } }>;
  assert.deepEqual(entries.filter((e) => e.action === "portal.business_bound").map((e) => e.metadata.previous).sort(), ["install-copy", "subdomain-derived"]);
  const refused = entries.filter((e) => e.action === "portal.business_bind_refused").map((e) => e.metadata.reason).sort();
  assert.deepEqual(refused, ["business_id_conflict", "business_id_conflict", "install_mismatch", "owner_mismatch"], "every refused bind is audited with its reason");
  for (const e of entries.filter((x) => x.action === "portal.business_bind_refused" || x.action === "portal.business_bound")) {
    assert.deepEqual(Object.keys(e.metadata).sort().filter((k) => /token|secret|password|authorization|subject/i.test(k)), [], "audit rows carry no credentials or owner subjects");
  }
});

test("a business bind commits only with its audit row: if the audit cannot be written, the store stays unbound", async () => {
  const installId = handle("ins");
  const subdomain = handle("bizaudit");
  const ownerSubject = "trustid:owner-bizaudit";
  const created = await signedCall("POST", "/internal/distributor/provision", { ...provisionBody(installId, subdomain, ownerSubject), trustId: { businessPublicId: `biz_${subdomain}` } }, { idk: `portal-install:${installId}` }).res;
  assert.equal(created.statusCode, 201, created.body);
  const url = `/internal/ecommerceos/stores/${subdomain}/business`;
  const bind = { businessId: "bus_audit_policy", installId, ownerSubject };
  const postgres = String(process.env.DATABASE_URL).startsWith("postgres");
  // Make audit inserts for binds fail, as if the audit store were unavailable.
  if (postgres) {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION e2e_fail_bind_audit() RETURNS trigger AS $ BEGIN RAISE EXCEPTION 'audit unavailable'; END; $ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER e2e_fail_bind_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.action = 'portal.business_bound') EXECUTE FUNCTION e2e_fail_bind_audit()`);
  } else {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER e2e_fail_bind_audit BEFORE INSERT ON "AuditLog" WHEN NEW.action = 'portal.business_bound' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  }
  try {
    const failed = await signedCall("POST", url, bind).res;
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal((await signedCall("GET", `/internal/ecommerceos/stores/${subdomain}`, undefined).res).json().businessId, null, "no bind without its audit row");
  } finally {
    await prisma.$executeRawUnsafe(postgres ? `DROP TRIGGER IF EXISTS e2e_fail_bind_audit ON "AuditLog"` : `DROP TRIGGER IF EXISTS e2e_fail_bind_audit`);
  }
  const retried = await signedCall("POST", url, bind).res;
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().bound, true, "the retry performs the bind, not a misleading replay");
  const again = await signedCall("POST", url, bind).res;
  assert.equal(again.json().replayed, true);
  const rows = await prisma.auditLog.count({ where: { action: "portal.business_bound", resourceId: created.json().tenantId } });
  assert.equal(rows, 1, "exactly one bind audit row: replays add none");
});
