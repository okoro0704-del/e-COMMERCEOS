/**
 * LifeOS public catalogue feed + business media publications.
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
const testDbPath = path.join(apiRoot, "prisma", `lifeos-public-feed-${process.pid}.db`);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./lifeos-public-feed-${process.pid}.db`;
process.env.INTERNAL_PROVISION_TOKEN = "portal-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";
process.env.ECOMMERCEOS_PUBLIC_API_URL = "https://api.example.test";

const PASSWORD = "Password123!";

let app: FastifyInstance;
let prisma: PrismaClient;

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`, `${testDbPath}-wal`, `${testDbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: `file:./lifeos-public-feed-${process.pid}.db`, NODE_ENV: "test" },
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
  email?: string;
  password?: string;
}) {
  const res = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer portal-e2e-token" },
    payload: {
      tenantId: `tid_${input.subdomain}`,
      subdomain: input.subdomain,
      displayName: input.displayName,
      verticalId: "delivery",
      seed: "default",
      adminStaff: {
        email: input.email ?? `owner@${input.subdomain}.example`,
        displayName: "Owner",
        role: "owner",
        password: input.password ?? PASSWORD,
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { tenantId: string; slug: string };
}

async function login(email: string) {
  // Sign-in is store-scoped; these owners use owner@<subdomain>.example.
  const tenantSlug = email.split("@")[1]?.replace(/\.example$/, "");
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/login",
    payload: { email, password: PASSWORD, tenantSlug },
  });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { token: string }).token;
}

async function createActiveProduct(token: string, title: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title,
      description: `${title} description`,
      variants: [{ sku: `sku-${title.replace(/\s+/g, "-").toLowerCase()}`, title, priceMinor: 2500, inventoryCount: 5 }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; title: string };
}

async function createMediaAsset(tenantId: string, opts?: { url?: string; contentType?: string }) {
  return prisma.mediaAsset.create({
    data: {
      tenantId,
      namespace: tenantId,
      driveKey: `test/${Date.now()}-${Math.random().toString(36).slice(2)}`,
      contentType: opts?.contentType ?? "image/jpeg",
      sizeBytes: 12,
      url: opts?.url ?? "https://cdn.example.test/photo.jpg",
    },
  });
}

test("feed returns products from active tenants", async () => {
  const stamp = Date.now().toString(36);
  const store = await provision({
    subdomain: `feed-a-${stamp}`,
    displayName: "Feed Active Store",
    email: `owner@feed-a-${stamp}.example`,
  });
  const token = await login(`owner@feed-a-${stamp}.example`);
  const product = await createActiveProduct(token, `Feed Product ${stamp}`);

  const res = await app.inject({
    method: "GET",
    url: "/v1/public/lifeos/feed?kind=product&limit=50",
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    items: Array<{ canonicalItemId: string; itemType: string; tenant: { slug: string } }>;
  };
  const match = body.items.find((item) => item.canonicalItemId === product.id);
  assert.ok(match, "expected product in public feed");
  assert.equal(match.itemType, "PRODUCT");
  assert.equal(match.tenant.slug, store.slug);
});

test("draft publication is excluded from feed", async () => {
  const stamp = Date.now().toString(36);
  const store = await provision({
    subdomain: `feed-draft-${stamp}`,
    displayName: "Draft Pub Store",
    email: `owner@feed-draft-${stamp}.example`,
  });
  const asset = await createMediaAsset(store.tenantId);
  const draft = await prisma.businessPublication.create({
    data: {
      tenantId: store.tenantId,
      type: "PHOTO",
      title: "Draft only",
      caption: "should not appear",
      status: "draft",
      audience: "public",
      mediaAssetIds: [asset.id],
      publishedAt: null,
    },
  });

  const res = await app.inject({
    method: "GET",
    url: "/v1/public/lifeos/feed?kind=publication&limit=50",
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { items: Array<{ canonicalItemId: string }> };
  assert.equal(
    body.items.some((item) => item.canonicalItemId === draft.id),
    false,
  );
});

test("suspended tenant is excluded from feed", async () => {
  const stamp = Date.now().toString(36);
  const store = await provision({
    subdomain: `feed-susp-${stamp}`,
    displayName: "Suspended Store",
    email: `owner@feed-susp-${stamp}.example`,
  });
  const token = await login(`owner@feed-susp-${stamp}.example`);
  const product = await createActiveProduct(token, `Suspended Product ${stamp}`);
  const asset = await createMediaAsset(store.tenantId);
  const pub = await prisma.businessPublication.create({
    data: {
      tenantId: store.tenantId,
      type: "PHOTO",
      title: "Live then suspended",
      caption: "hidden after suspend",
      status: "published",
      audience: "public",
      mediaAssetIds: [asset.id],
      publishedAt: new Date(),
    },
  });

  await prisma.tenant.update({ where: { id: store.tenantId }, data: { status: "suspended" } });

  const res = await app.inject({
    method: "GET",
    url: "/v1/public/lifeos/feed?kind=all&limit=50",
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { items: Array<{ canonicalItemId: string }> };
  assert.equal(body.items.some((item) => item.canonicalItemId === product.id), false);
  assert.equal(body.items.some((item) => item.canonicalItemId === pub.id), false);
});

test("feed pagination returns nextCursor", async () => {
  const stamp = Date.now().toString(36);
  const store = await provision({
    subdomain: `feed-page-${stamp}`,
    displayName: "Pagination Store",
    email: `owner@feed-page-${stamp}.example`,
  });
  const token = await login(`owner@feed-page-${stamp}.example`);
  for (let i = 0; i < 3; i += 1) {
    await createActiveProduct(token, `Page Product ${stamp}-${i}`);
  }

  const first = await app.inject({
    method: "GET",
    url: "/v1/public/lifeos/feed?kind=product&limit=1",
  });
  assert.equal(first.statusCode, 200, first.body);
  const page1 = first.json() as { items: Array<{ canonicalItemId: string }>; nextCursor: string | null; count: number };
  assert.equal(page1.count, 1);
  assert.ok(page1.nextCursor, "expected nextCursor when more items remain");

  const second = await app.inject({
    method: "GET",
    url: `/v1/public/lifeos/feed?kind=product&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
  });
  assert.equal(second.statusCode, 200, second.body);
  const page2 = second.json() as { items: Array<{ canonicalItemId: string }>; nextCursor: string | null };
  assert.equal(page2.items.length, 1);
  assert.notEqual(page2.items[0]?.canonicalItemId, page1.items[0]?.canonicalItemId);
});

test("createBusinessPublication rejects other-tenant media", async () => {
  const stamp = Date.now().toString(36);
  const a = await provision({
    subdomain: `pub-a-${stamp}`,
    displayName: "Pub A",
    email: `owner@pub-a-${stamp}.example`,
  });
  const b = await provision({
    subdomain: `pub-b-${stamp}`,
    displayName: "Pub B",
    email: `owner@pub-b-${stamp}.example`,
  });
  const foreignAsset = await createMediaAsset(b.tenantId);

  const { createBusinessPublication } = await import(
    "../../apps/ecommerceos-api/src/services/business-publications.ts"
  );

  await assert.rejects(
    () =>
      createBusinessPublication(a.tenantId, {
        type: "PHOTO",
        title: "Stolen media",
        mediaAssetIds: [foreignAsset.id],
        status: "published",
      }),
    (err: unknown) => {
      const e = err as { statusCode?: number; code?: string };
      return e.statusCode === 400 && e.code === "invalid_media";
    },
  );
});
