/**
 * Online Marketplace operator mode — create canonical Online Stores, project catalogues,
 * suspend without deleting, and refuse unauthorized store attachment.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { ECOMMERCEOS_VERTICAL_PRESETS, isOnlineMarketplaceOperator } from "../../packages/shared/src/verticals.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const testDbPath = path.join(apiRoot, "prisma", `online-marketplace-${process.pid}.db`);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./online-marketplace-${process.pid}.db`;
process.env.INTERNAL_PROVISION_TOKEN = "portal-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";

const OPERATOR_PASSWORD = "Fixture-Str0ng-Pw-7";

let app: FastifyInstance;
let prisma: PrismaClient;

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore locked leftover files
    }
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:./online-marketplace-${process.pid}.db`, NODE_ENV: "test" },
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

async function provision(input: {
  subdomain: string;
  displayName: string;
  verticalId?: string;
  tenantId?: string;
  organizationSlug?: string;
  email?: string;
  password?: string;
}) {
  const res = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      tenantId: input.tenantId ?? `tid_${input.subdomain}`,
      subdomain: input.subdomain,
      displayName: input.displayName,
      verticalId: input.verticalId,
      seed: "default",
      organization: input.organizationSlug
        ? { slug: input.organizationSlug, name: input.displayName }
        : undefined,
      adminStaff: {
        email: input.email ?? `owner@${input.subdomain}.example`,
        displayName: "Operator",
        role: "owner",
        password: input.password ?? OPERATOR_PASSWORD,
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as {
    tenantId: string;
    slug: string;
    storefrontUrl: string;
    adminConsoleUrl: string;
    verticalId: string;
    operatingModel: string;
  };
}

async function login(email: string, password = OPERATOR_PASSWORD) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/login",
    payload: { email, password },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { token: string }).token;
}

test("marketplace ID remains a compatibility operating model, not a deleted vertical", () => {
  assert.equal(ECOMMERCEOS_VERTICAL_PRESETS.marketplace.id, "marketplace");
  assert.equal(ECOMMERCEOS_VERTICAL_PRESETS.delivery.displayName, "Online Store");
  assert.equal(isOnlineMarketplaceOperator({ operatingModel: "marketplace" }), true);
  assert.equal(isOnlineMarketplaceOperator({ onlineMarketplace: true, verticalId: "delivery" }), true);
  assert.equal(isOnlineMarketplaceOperator({ verticalId: "delivery", operatingModel: "store" }), false);
});

test("marketplace operator creates three independent Online Stores and projects catalogues", async () => {
  const stamp = Date.now().toString(36);
  const marketplace = await provision({
    subdomain: `mp-${stamp}`,
    displayName: "Acceptance Marketplace",
    verticalId: "marketplace",
    organizationSlug: `mp-org-${stamp}`,
    email: `ops@mp-${stamp}.example`,
  });
  assert.equal(marketplace.verticalId, "marketplace");
  assert.equal(marketplace.operatingModel, "marketplace");

  const operatorToken = await login(`ops@mp-${stamp}.example`);
  const created = [];
  for (const name of [
    "Marketplace Acceptance Store A",
    "Marketplace Acceptance Store B",
    "Marketplace Acceptance Store C",
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/marketplace/sellers/stores",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { displayName: name, city: "Lagos", country: "NG" },
    });
    assert.equal(res.statusCode, 201, res.body);
    created.push(
      res.json() as {
        membership: { id: string; sellerTenantId: string; sellerApplicationId: string; status: string };
        store: {
          applicationId: string;
          tenantId: string;
          slug: string;
          verticalId: string;
          publicUrl: string;
          adminUrl: string;
        };
        temporaryAdminPassword: string;
        adminEmail: string;
      },
    );
  }

  const [storeA, storeB, storeC] = created;
  assert.ok(storeA && storeB && storeC);
  assert.equal(storeA.store.verticalId, "delivery");
  assert.equal(storeB.store.verticalId, "delivery");
  assert.equal(storeC.store.verticalId, "delivery");
  assert.notEqual(storeA.store.applicationId, storeB.store.applicationId);
  assert.notEqual(storeB.store.applicationId, storeC.store.applicationId);
  assert.notEqual(storeA.store.tenantId, storeB.store.tenantId);
  assert.notEqual(marketplace.tenantId, storeA.store.tenantId);
  assert.notEqual(marketplace.tenantId, storeB.store.tenantId);
  assert.notEqual(marketplace.tenantId, storeC.store.tenantId);
  assert.match(storeA.store.applicationId, /^ins_/);
  assert.match(storeA.store.publicUrl, new RegExp(storeA.store.slug));
  assert.match(storeA.store.adminUrl, /\/admin/);

  const tokenA = await login(storeA.adminEmail, storeA.temporaryAdminPassword);
  const tokenB = await login(storeB.adminEmail, storeB.temporaryAdminPassword);

  const productA = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      title: "Ankara Wrap Dress",
      description: "Store A canonical item",
      variants: [{ sku: `A-${stamp}`, title: "Ankara Wrap Dress", priceMinor: 1500000, inventoryCount: 8 }],
    },
  });
  assert.equal(productA.statusCode, 201, productA.body);
  const itemA = productA.json() as { id: string; tenantId: string; title: string };

  const productB = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: { authorization: `Bearer ${tokenB}` },
    payload: {
      title: "Portable Radio",
      description: "Store B canonical item",
      variants: [{ sku: `B-${stamp}`, title: "Portable Radio", priceMinor: 890000, inventoryCount: 4 }],
    },
  });
  assert.equal(productB.statusCode, 201, productB.body);
  const itemB = productB.json() as { id: string; tenantId: string; title: string };

  assert.equal(itemA.tenantId, storeA.store.tenantId);
  assert.equal(itemB.tenantId, storeB.store.tenantId);
  assert.notEqual(itemA.id, itemB.id);

  const hijack = await app.inject({
    method: "PATCH",
    url: `/v1/products/${itemA.id}`,
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: { title: "Stolen title" },
  });
  assert.equal(hijack.statusCode, 404);

  const projected = await app.inject({
    method: "GET",
    url: "/v1/storefront/marketplace/products",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  assert.equal(projected.statusCode, 200, projected.body);
  const catalog = projected.json() as {
    products: Array<{ title: string; sellerName: string; presentationId: string }>;
  };
  assert.equal(catalog.products.some((row) => row.title === "Ankara Wrap Dress"), true);
  assert.equal(catalog.products.some((row) => row.title === "Portable Radio"), true);
  assert.equal(catalog.products.some((row) => row.sellerName === "Marketplace Acceptance Store A"), true);
  assert.equal(catalog.products.some((row) => row.sellerName === "Marketplace Acceptance Store B"), true);

  const marketplaceOwned = await prisma.product.count({ where: { tenantId: marketplace.tenantId } });
  assert.equal(marketplaceOwned, 0);

  const stores = await app.inject({
    method: "GET",
    url: "/v1/storefront/marketplace/stores",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  const storeRows = stores.json() as Array<{ name: string }>;
  assert.equal(storeRows.length, 3);

  const updated = await app.inject({
    method: "PATCH",
    url: `/v1/products/${itemA.id}`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { title: "Ankara Wrap Dress — Updated" },
  });
  assert.equal(updated.statusCode, 200, updated.body);

  const afterUpdate = await app.inject({
    method: "GET",
    url: "/v1/storefront/marketplace/products",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  const updatedCatalog = afterUpdate.json() as { products: Array<{ title: string }> };
  assert.equal(updatedCatalog.products.some((row) => row.title === "Ankara Wrap Dress — Updated"), true);
  assert.equal(updatedCatalog.products.some((row) => row.title === "Ankara Wrap Dress"), false);

  const suspend = await app.inject({
    method: "PATCH",
    url: `/v1/marketplace/sellers/${storeB.membership.id}`,
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: { status: "suspended" },
  });
  assert.equal(suspend.statusCode, 200, suspend.body);
  const suspendBody = suspend.json() as { storeDeleted: boolean; storeStillExists: boolean; catalogueCount: number };
  assert.equal(suspendBody.storeDeleted, false);
  assert.equal(suspendBody.storeStillExists, true);
  assert.ok(suspendBody.catalogueCount >= 1);

  const afterSuspend = await app.inject({
    method: "GET",
    url: "/v1/storefront/marketplace/products",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  const suspendedCatalog = afterSuspend.json() as { products: Array<{ title: string; sellerName: string }> };
  assert.equal(suspendedCatalog.products.some((row) => row.sellerName === "Marketplace Acceptance Store B"), false);
  assert.equal(suspendedCatalog.products.some((row) => row.title === "Ankara Wrap Dress — Updated"), true);

  const storeBTenant = await prisma.tenant.findUnique({ where: { id: storeB.store.tenantId } });
  assert.ok(storeBTenant);
  assert.equal(storeBTenant!.status, "active");
  const storeBProducts = await prisma.product.count({ where: { tenantId: storeB.store.tenantId } });
  assert.equal(storeBProducts, 1);

  const reactivate = await app.inject({
    method: "PATCH",
    url: `/v1/marketplace/sellers/${storeB.membership.id}`,
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: { status: "active" },
  });
  assert.equal(reactivate.statusCode, 200, reactivate.body);
  const afterReactivate = await app.inject({
    method: "GET",
    url: "/v1/storefront/marketplace/products",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  assert.equal(
    (afterReactivate.json() as { products: Array<{ sellerName: string }> }).products.some(
      (row) => row.sellerName === "Marketplace Acceptance Store B",
    ),
    true,
  );

  const search = await app.inject({
    method: "GET",
    url: "/v1/storefront/marketplace/search?q=Radio",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  assert.equal(search.statusCode, 200, search.body);
  const searchBody = search.json() as { products: Array<{ title: string }> };
  assert.equal(searchBody.products.some((row) => row.title === "Portable Radio"), true);
  assert.equal(searchBody.products.some((row) => row.title.includes("Ankara")), false);

  const outsider = await provision({
    subdomain: `mp-out-${stamp}`,
    displayName: "Other Marketplace",
    verticalId: "marketplace",
    organizationSlug: `mp-out-org-${stamp}`,
    email: `ops@out-${stamp}.example`,
  });
  const outsiderToken = await login(`ops@out-${stamp}.example`);
  const attach = await app.inject({
    method: "POST",
    url: "/v1/marketplace/sellers/connect",
    headers: { authorization: `Bearer ${outsiderToken}` },
    payload: { sellerTenantId: storeA.store.tenantId },
  });
  assert.equal(attach.statusCode, 403, attach.body);
  assert.match(attach.json().message as string, /AUTHORIZATION CONTRACT REQUIRED/);

  const detail = await app.inject({
    method: "GET",
    url: `/v1/storefront/marketplace/products/${storeA.membership.id}/${itemA.id}`,
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const detailBody = detail.json() as { title: string; seller: { name: string }; tenantId?: string };
  assert.equal(detailBody.title, "Ankara Wrap Dress — Updated");
  assert.equal(detailBody.seller.name, "Marketplace Acceptance Store A");
  assert.equal(detailBody.tenantId, undefined);

  const publicStorefront = await app.inject({
    method: "GET",
    url: "/v1/storefront",
    headers: { "x-tenant-id": marketplace.tenantId },
  });
  const publicBody = publicStorefront.json() as {
    onlineMarketplace: boolean;
    marketplaceSellers: Array<Record<string, unknown>>;
  };
  assert.equal(publicBody.onlineMarketplace, true);
  assert.equal(publicBody.marketplaceSellers.some((row) => "sellerTenantId" in row && row.sellerTenantId), false);

  const tenants = await prisma.tenant.findMany({
    where: { id: { in: [marketplace.tenantId, storeA.store.tenantId, storeB.store.tenantId, storeC.store.tenantId, outsider.tenantId] } },
  });
  assert.equal(tenants.length, 5);
  assert.equal(new Set(tenants.map((row) => row.id)).size, 5);

  console.log(
    "ONLINE_MARKETPLACE_ACCEPTANCE",
    JSON.stringify({
      marketplace: {
        tenantId: marketplace.tenantId,
        slug: marketplace.slug,
        publicUrl: marketplace.storefrontUrl,
        adminUrl: marketplace.adminConsoleUrl,
      },
      storeA: storeA.store,
      storeB: storeB.store,
      storeC: storeC.store,
      itemA: "Ankara Wrap Dress — Updated",
      itemB: "Portable Radio",
    }),
  );
});

test("Online Store can enable marketplace operator mode without a second vertical purchase", async () => {
  const stamp = Date.now().toString(36);
  const store = await provision({
    subdomain: `onl-${stamp}`,
    displayName: "Operator Online Store",
    verticalId: "delivery",
    email: `owner@onl-${stamp}.example`,
  });
  const token = await login(`owner@onl-${stamp}.example`);
  const denied = await app.inject({
    method: "GET",
    url: "/v1/marketplace",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(denied.statusCode, 403);

  const enabled = await app.inject({
    method: "POST",
    url: "/v1/marketplace/enable",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal((enabled.json() as { operator: { verticalId: string } }).operator.verticalId, "delivery");

  const create = await app.inject({
    method: "POST",
    url: "/v1/marketplace/sellers/stores",
    headers: { authorization: `Bearer ${token}` },
    payload: { displayName: "Enabled Operator Child Store" },
  });
  assert.equal(create.statusCode, 201, create.body);
  const child = create.json() as { store: { applicationId: string; tenantId: string; verticalId: string } };
  assert.equal(child.store.verticalId, "delivery");
  assert.notEqual(child.store.tenantId, store.tenantId);
  assert.notEqual(child.store.applicationId, store.tenantId);
});

test("public News publications project active products and drop unpublished ones", async () => {
  const stamp = Date.now().toString(36);
  const store = await provision({
    subdomain: `news-${stamp}`,
    displayName: "News Adapter Store",
    verticalId: "delivery",
    email: `owner@news-${stamp}.example`,
  });
  const token = await login(`owner@news-${stamp}.example`);
  const created = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: "Public store update",
      description: "A legitimate EcommerceOS catalog update.",
      variants: [{ sku: `N-${stamp}`, title: "Public store update", priceMinor: 1000, inventoryCount: 2 }],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const product = created.json() as { id: string; status: string };

  const publicNews = await app.inject({
    method: "GET",
    url: "/v1/storefront/publications",
    headers: { "x-store-subdomain": store.slug },
  });
  assert.equal(publicNews.statusCode, 200, publicNews.body);
  const body = publicNews.json() as {
    publications: Array<{
      publicationId: string;
      publisherEntityId: string;
      subjectEntityIds: string[];
      publishedAt: string;
      status: string;
      audience: string;
      title: string | null;
      canonicalUrl: string;
    }>;
  };
  assert.equal(body.publications.length, 1);
  assert.equal(body.publications[0]?.publicationId, `ecommerceos:product:${product.id}`);
  assert.equal(body.publications[0]?.publisherEntityId, store.slug);
  assert.deepEqual(body.publications[0]?.subjectEntityIds, [store.slug]);
  assert.equal(body.publications[0]?.status, "published");
  assert.equal(body.publications[0]?.audience, "public");
  assert.equal(body.publications[0]?.title, "Public store update");
  assert.match(body.publications[0]?.publishedAt ?? "", /^20\d{2}-/);
  assert.equal(body.publications[0]?.canonicalUrl, `https://${store.slug}.getlifeos.app/product/${product.id}`);
  assert.equal(JSON.stringify(body).includes("inventoryCount"), false);
  assert.equal(JSON.stringify(body).includes("password"), false);

  const hide = await app.inject({
    method: "PATCH",
    url: `/v1/products/${product.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: "archived" },
  });
  assert.equal(hide.statusCode, 200, hide.body);
  const after = await app.inject({
    method: "GET",
    url: "/v1/storefront/publications",
    headers: { "x-store-subdomain": store.slug },
  });
  assert.equal((after.json() as { publications: unknown[] }).publications.length, 0);
});

