/**
 * Portal provisioning E2E — POST /internal/distributor/provision seeds a store from ECommerceOSManifest.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  ECOMMERCEOS_DEFAULT_MODULES,
  ECOMMERCEOS_DEFAULT_SEED,
} from "../../packages/shared/src/manifest/ecommerceos.manifest.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const testDbPath = path.join(apiRoot, "prisma", `portal-provision-${process.pid}.db`);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./portal-provision-${process.pid}.db`;
process.env.INTERNAL_PROVISION_TOKEN = "portal-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";

let app: FastifyInstance;
let prisma: PrismaClient;

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
    env: { ...process.env, DATABASE_URL: `file:./portal-provision-${process.pid}.db`, NODE_ENV: "test" },
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

test("LifeOS 6 primitives are bound at boot", async () => {
  const { getRegisteredLifeOsPrimitives } = await import(
    "../../apps/ecommerceos-api/src/services/register-primitives.ts"
  );
  const c = getRegisteredLifeOsPrimitives();
  assert.equal(c.trustId.primitiveId, "trust-id");
  assert.equal(c.messaging.primitiveId, "elfcom");
  assert.equal(c.storage.primitiveId, "sovereign-drive");
  assert.equal(c.jobs.primitiveId, "platform-jobs");
  assert.equal(c.distributor.primitiveId, "master-distributor");
  assert.equal(c.wallet.primitiveId, "fundzman");
  assert.ok(c.trustId.bound && c.wallet.bound);
});

test("POST /internal/distributor/provision rejects missing bearer", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    payload: {
      tenantId: "tid_noauth",
      subdomain: "noauth-store",
      displayName: "No Auth Store",
    },
  });
  assert.equal(res.statusCode, 401);
});

test("POST /internal/distributor/provision seeds store from ECommerceOSManifest", async () => {
  const subdomain = `harbor-${Date.now().toString(36)}`;
  const res = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      tenantId: `tid_${subdomain}`,
      subdomain,
      displayName: "Harbor Market",
      brand: { primaryColor: "#1D4ED8" },
      oauthDestinations: [
        `https://${subdomain}.lifeos.app`,
        `https://${subdomain}.lifeos.app/admin`,
      ],
      seed: "default",
      trustId: { audience: "ecommerceos", businessPublicId: `biz_${subdomain}` },
      adminStaff: {
        email: `owner@${subdomain}.example`,
        displayName: "Store Owner",
        role: "owner",
        password: "Fixture-Str0ng-Pw-7",
      },
    },
  });

  assert.equal(res.statusCode, 201, res.body);
  const body = res.json() as {
    ok: boolean;
    tenantId: string;
    storefrontUrl: string;
    adminConsoleUrl: string;
    modulesEnabled: string[];
    seedApplied: boolean;
    primitiveBindings: Record<string, { bound: boolean }>;
  };

  assert.equal(body.ok, true);
  assert.ok(body.tenantId);
  assert.equal(body.seedApplied, true);
  assert.match(body.storefrontUrl, new RegExp(subdomain));
  assert.match(body.adminConsoleUrl, /\/admin/);
  for (const m of ECOMMERCEOS_DEFAULT_MODULES) {
    assert.ok(body.modulesEnabled.includes(m), `missing module ${m}`);
  }
  assert.equal(body.primitiveBindings["trust-id"]?.bound, true);
  assert.equal(body.primitiveBindings.fundzman?.bound, true);
  assert.equal(body.primitiveBindings.elfcom?.bound, true);
  assert.equal(body.primitiveBindings["sovereign-drive"]?.bound, true);
  assert.equal(body.primitiveBindings["platform-jobs"]?.bound, true);
  assert.equal(body.primitiveBindings["master-distributor"]?.bound, true);

  const tenant = await prisma.tenant.findUnique({ where: { id: body.tenantId } });
  assert.ok(tenant);
  assert.equal(tenant!.lifeosBusinessId, `biz_${subdomain}`);
  assert.equal(tenant!.primaryColor, "#1D4ED8");

  const store = await prisma.storeConfig.findUnique({ where: { tenantId: body.tenantId } });
  assert.ok(store);
  assert.equal(store!.subdomain, subdomain);
  assert.equal(store!.defaultCurrency, ECOMMERCEOS_DEFAULT_SEED.store.defaultCurrency);
  assert.equal(store!.deliveryRadiusKm, ECOMMERCEOS_DEFAULT_SEED.store.deliveryRadiusKm);
  assert.equal(store!.pickupCity, ECOMMERCEOS_DEFAULT_SEED.store.pickupCity);

  const categories = await prisma.productCategory.findMany({ where: { tenantId: body.tenantId } });
  assert.equal(categories.length, ECOMMERCEOS_DEFAULT_SEED.categories.length);
  assert.ok(categories.some((c) => c.code === "GROCERY"));
  assert.ok(categories.some((c) => c.code === "ELECTRONICS"));

  const modules = await prisma.tenantModule.findMany({ where: { tenantId: body.tenantId } });
  assert.equal(modules.filter((m) => m.enabled).length, ECOMMERCEOS_DEFAULT_MODULES.length);

  const staff = await prisma.staffMember.findFirst({ where: { tenantId: body.tenantId } });
  assert.ok(staff);
  assert.equal(staff!.role, "owner");
  assert.equal(staff!.email, `owner@${subdomain}.example`);
});

test("supermarket and shopping centre presets seed distinct operating models", async () => {
  const supermarketSub = `super-${Date.now().toString(36)}`;
  const centreSub = `centre-${Date.now().toString(36)}`;
  const supermarket = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      tenantId: `tid_${supermarketSub}`,
      subdomain: supermarketSub,
      displayName: "Harbor Fresh",
      verticalId: "supermarket",
      seed: "default",
      adminStaff: {
        email: `owner@${supermarketSub}.example`,
        displayName: "Operator",
        role: "owner",
        password: "Fixture-Str0ng-Pw-7",
      },
    },
  });
  const centre = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      tenantId: `tid_${centreSub}`,
      subdomain: centreSub,
      displayName: "Marina Centre",
      verticalId: "shopping_centre",
      seed: "default",
      adminStaff: {
        email: `owner@${centreSub}.example`,
        displayName: "Operator",
        role: "owner",
        password: "Fixture-Str0ng-Pw-7",
      },
    },
  });
  assert.equal(supermarket.statusCode, 201, supermarket.body);
  assert.equal(centre.statusCode, 201, centre.body);
  const superBody = supermarket.json() as { tenantId: string; verticalId: string; operatingModel: string };
  const centreBody = centre.json() as { tenantId: string; verticalId: string; operatingModel: string };
  assert.equal(superBody.verticalId, "supermarket");
  assert.equal(superBody.operatingModel, "supermarket");
  assert.equal(centreBody.verticalId, "shopping_centre");
  assert.equal(centreBody.operatingModel, "destination");

  const superCats = await prisma.productCategory.findMany({ where: { tenantId: superBody.tenantId } });
  const centreCats = await prisma.productCategory.findMany({ where: { tenantId: centreBody.tenantId } });
  assert.ok(superCats.some((c) => c.code === "PRODUCE"));
  assert.ok(centreCats.some((c) => c.code === "FOOD"));
  assert.ok(!centreCats.some((c) => c.code === "PRODUCE"));

  const superTenant = await prisma.tenant.findUnique({ where: { id: superBody.tenantId } });
  const centreTenant = await prisma.tenant.findUnique({ where: { id: centreBody.tenantId } });
  const superSettings = superTenant?.settings as { operatingModel?: string; destinationOccupants?: unknown[] };
  const centreSettings = centreTenant?.settings as { operatingModel?: string; destinationOccupants?: unknown[] };
  assert.equal(superSettings.operatingModel, "supermarket");
  assert.ok((centreSettings.destinationOccupants?.length ?? 0) >= 1);
});

