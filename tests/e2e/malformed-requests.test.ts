/**
 * Malformed request targets (fastify advisory GHSA-p68q-wchp-6fh7 class): raw requests a client library
 * would refuse to send must never reach a handler, succeed, or return a store's data, and protected
 * routes must still require authentication.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const dbName = `malformed-requests-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./${dbName}`;
process.env.INTERNAL_PROVISION_TOKEN = "malformed-e2e-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";

let app: FastifyInstance;
let port: number;
const secret = { tenantId: "", storeName: `Probe Store ${Date.now().toString(36)}` };

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // reused by prisma db push
    }
  }
  execSync("npx prisma db push --skip-generate", { cwd: apiRoot, env: { ...process.env, NODE_ENV: "test" }, stdio: "pipe" });
  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as net.AddressInfo).port;
  const subdomain = `probe-${Date.now().toString(36)}`;
  const prov = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer malformed-e2e-token" },
    payload: { tenantId: `tid_${subdomain}`, subdomain, displayName: secret.storeName, seed: "default" },
  });
  assert.equal(prov.statusCode, 201, prov.body);
  secret.tenantId = prov.json().tenantId;
  assert.ok(secret.tenantId, "the probe store exists, so a leak would be visible");
});

after(async () => {
  if (app) await app.close();
});

/** Sends a raw request target exactly as written, as an attacker's client would. */
function raw(requestLine: string, headers: string[] = []): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(5000, () => { socket.destroy(); resolve({ status: 0, body: "timeout" }); });
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve({ status: Number(data.split(" ")[1] ?? 0), body: data }));
    socket.on("close", () => resolve({ status: Number(data.split(" ")[1] ?? 0), body: data }));
    socket.on("error", reject);
    socket.write(`${requestLine} HTTP/1.1\r\nHost: probe.example\r\nConnection: close\r\n${headers.map((h) => h + "\r\n").join("")}\r\n`);
  });
}

test("protected routes still require authentication (control)", async () => {
  for (const url of ["/v1/orders", "/v1/products", "/v1/platform/stores", "/internal/distributor/provision"]) {
    const method = url.startsWith("/internal") ? "POST" : "GET";
    const res = await raw(`${method} ${url}`);
    assert.ok([401, 403, 404].includes(res.status), `${method} ${url}: ${res.status}`);
  }
});

test("malformed request targets never succeed and never return a store's data", async () => {
  const targets = [
    "GET /v1/orders%",
    "GET /v1/%zz",
    "GET /%E0%A4%A",
    "PROPFIND /v1/orders%",
    "PATCH /v1/%zz/orders",
    "DELETE /v1/products%c0%af",
    "GET //v1/orders",
    "GET /v1/./orders",
    "GET /v1/%2e%2e/v1/orders",
    "GET /v1/orders/..%2f..%2fproducts",
    "POST /internal/distributor/provision%",
    "POST /internal/%2e%2e/internal/distributor/provision",
    `GET /v1/${"a".repeat(9000)}`,
    "GET /v1/products?%",
  ];
  for (const t of targets) {
    const res = await raw(t);
    assert.ok(res.status === 0 || res.status >= 400, `${t.slice(0, 60)} answered ${res.status}`);
    assert.ok(!res.body.includes(secret.tenantId) && !res.body.includes(secret.storeName), `${t.slice(0, 60)} leaked store data`);
  }
});
