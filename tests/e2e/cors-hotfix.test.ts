/**
 * CORS containment hotfix: only the origins in CORS_ORIGINS get a CORS grant ("*" and localhost
 * are development only), and browsers may send every method the web app uses. Calls without an
 * Origin header (server-to-server, e.g. LifeOS Portal) are unaffected.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const dbName = `cors-hotfix-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);
const PRODUCTION_ORIGINS = ["https://e-commerce.getlifeos.app", "https://e-commerceos.netlify.app"];
// What the deployed web sends on a preflight (lib/api.ts request()).
const WEB_HEADERS = "authorization,content-type,x-store-subdomain";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./${dbName}`;
process.env.INTERNAL_PROVISION_TOKEN = "cors-hotfix-service-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";

let app: FastifyInstance;
let config: typeof import("../../apps/ecommerceos-api/src/config.ts").config;

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
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "test" },
    stdio: "pipe",
  });
  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  ({ config } = await import("../../apps/ecommerceos-api/src/config.ts"));
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
});

/** Evaluates requests as production would, with the proposed production CORS_ORIGINS. */
async function asProduction<T>(origins: string[], work: () => Promise<T>) {
  const saved = { env: config.env, corsOrigins: config.corsOrigins };
  Object.assign(config, { env: "production", corsOrigins: origins });
  try {
    return await work();
  } finally {
    Object.assign(config, saved);
  }
}

const preflight = (origin: string, method: string, url = "/v1/cart/items/any") =>
  app.inject({
    method: "OPTIONS",
    url,
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": WEB_HEADERS },
  });

test("the production rules: exact origins only; no wildcard, shared hosting, http or localhost", async () => {
  const { originAllowed } = await import("../../apps/ecommerceos-api/src/lib/cors.ts");
  for (const origin of PRODUCTION_ORIGINS) assert.equal(originAllowed(origin, PRODUCTION_ORIGINS, "production"), true, origin);
  for (const origin of [
    "https://evil.example",
    "https://attacker.netlify.app",
    "https://e-commerce.getlifeos.app.attacker.example",
    "http://e-commerce.getlifeos.app",
    "https://e-commerce.getlifeos.app:8443",
    "http://localhost:5190",
    "null",
  ]) {
    assert.equal(originAllowed(origin, PRODUCTION_ORIGINS, "production"), false, origin);
  }
  assert.equal(originAllowed("https://evil.example", ["*"], "production"), false, "the wildcard is ignored in production");
  assert.equal(originAllowed("http://localhost:5173", [], "development"), true, "local development still works");
});

test("the deployed web's own preflights pass for every method it uses, from both production origins", async () => {
  await asProduction(PRODUCTION_ORIGINS, async () => {
    for (const origin of PRODUCTION_ORIGINS) {
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
        const res = await preflight(origin, method);
        assert.equal(res.statusCode, 204, `${origin} ${method}`);
        assert.equal(res.headers["access-control-allow-origin"], origin);
        assert.equal(res.headers["access-control-allow-credentials"], "true");
        assert.match(String(res.headers["access-control-allow-methods"]), new RegExp(`\\b${method}\\b`), method);
        assert.equal(String(res.headers["access-control-allow-headers"]), WEB_HEADERS);
      }
    }
  });
});

test("any other origin gets no CORS grant, on public, merchant and internal routes alike", async () => {
  await asProduction(PRODUCTION_ORIGINS, async () => {
    for (const url of ["/health", "/v1/storefront", "/v1/auth/merchant/me", "/internal/distributor/provision"]) {
      for (const origin of ["https://evil.example", "https://attacker.netlify.app"]) {
        const pre = await preflight(origin, "POST", url);
        assert.equal(pre.headers["access-control-allow-origin"], undefined, `${origin} preflight ${url}`);
        const get = await app.inject({ method: "GET", url, headers: { origin } });
        assert.equal(get.headers["access-control-allow-origin"], undefined, `${origin} GET ${url}`);
      }
    }
  });
});

test("a leftover CORS_ORIGINS=* grants nothing in production (set the exact list before deploying)", async () => {
  await asProduction(["*"], async () => {
    const res = await preflight("https://e-commerce.getlifeos.app", "GET");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});

test("server-to-server calls without an Origin header are unchanged", async () => {
  await asProduction(PRODUCTION_ORIGINS, async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["access-control-allow-origin"], undefined);
    const provision = await app.inject({ method: "POST", url: "/internal/distributor/provision", payload: {} });
    assert.equal(provision.statusCode, 401, "internal routes still need the service token");
  });
});
