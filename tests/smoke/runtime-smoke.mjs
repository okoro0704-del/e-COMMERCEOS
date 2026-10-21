/**
 * Runtime smoke for the production start path (`npm run start:api`: the boot-time `prisma db push`,
 * then the compiled server). CI runs it against a throwaway PostgreSQL with synthetic data only.
 *   node tests/smoke/runtime-smoke.mjs wait            until /health answers (90 s at most)
 *   node tests/smoke/runtime-smoke.mjs seed            one synthetic store, its owner and a product
 *   node tests/smoke/runtime-smoke.mjs check <label>   the store's data, owner sign-in, authentication, malformed targets
 * SMOKE_API is the local API's base URL; INTERNAL_PROVISION_TOKEN is that API's per-run token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const api = new URL(process.env.SMOKE_API ?? "http://127.0.0.1:8900");
if (api.hostname !== "127.0.0.1") throw new Error("the runtime smoke only runs against a local API");
const stateFile = "runtime-smoke.json";
const [mode, label = "check"] = process.argv.slice(2);

async function call(method, url, { headers = {}, body } = {}) {
  const res = await fetch(new URL(url, api), {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text };
}

/** Sends a raw request target exactly as written, as an attacker's client would. */
function raw(requestLine) {
  return new Promise((resolve) => {
    const socket = net.connect(Number(api.port), api.hostname);
    let data = "";
    const done = () => resolve({ status: Number(data.split(" ")[1] ?? 0), body: data });
    socket.setTimeout(5000, () => { socket.destroy(); resolve({ status: 0, body: "timeout" }); });
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", done);
    socket.on("close", done);
    socket.on("error", () => resolve({ status: -1, body: "" }));
    socket.write(`${requestLine} HTTP/1.1\r\nHost: ${api.host}\r\nConnection: close\r\n\r\n`);
  });
}

if (mode === "wait") {
  for (let i = 0; i < 90; i += 1) {
    if (await fetch(new URL("/health", api)).then((r) => r.ok, () => false)) process.exit(0);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("the API was not healthy within 90 s");
  process.exit(1);
}

if (mode === "seed") {
  const run = Date.now().toString(36);
  const subdomain = `smoke-${run}`;
  const state = {
    subdomain,
    email: `owner-${subdomain}@example.test`,
    password: `Smoke-${crypto.randomBytes(12).toString("hex")}`,
    productTitle: `Smoke Rice ${run}`,
  };
  const prov = await call("POST", "/internal/distributor/provision", {
    headers: { authorization: `Bearer ${process.env.INTERNAL_PROVISION_TOKEN}` },
    body: {
      tenantId: `tid_${subdomain}`,
      subdomain,
      displayName: `Smoke Store ${run}`,
      seed: "default",
      adminStaff: { email: state.email, displayName: "Owner", role: "owner", password: state.password },
    },
  });
  if (prov.status !== 201) throw new Error(`provision answered ${prov.status}: ${prov.text.slice(0, 200)}`);
  state.tenantId = prov.json.tenantId;
  const login = await call("POST", "/v1/auth/merchant/login", { body: { email: state.email, password: state.password, tenantSlug: subdomain } });
  const auth = { authorization: `Bearer ${login.json?.token}` };
  const categories = (await call("GET", "/v1/categories", { headers: auth })).json;
  const product = await call("POST", "/v1/products", {
    headers: auth,
    body: {
      title: state.productTitle,
      categoryId: Array.isArray(categories) ? categories[0]?.id : undefined,
      variants: [{ sku: `SMOKE-${run}`, priceMinor: 850000, inventoryCount: 10 }],
    },
  });
  state.productId = product.json?.id;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log(`seed: provision ${prov.status}, sign-in ${login.status}, product ${product.status}`);
  process.exit(login.status === 200 && product.status === 201 ? 0 : 1);
}

if (mode !== "check") throw new Error("mode: wait | seed | check <label>");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  [${label}] ${name}${detail ? ` (${detail})` : ""}`);
};
const store = { "x-store-subdomain": state.subdomain };

check("health", (await call("GET", "/health")).status === 200);
check("storefront served", (await call("GET", "/v1/storefront", { headers: store })).status === 200);
const products = (await call("GET", "/v1/storefront/products", { headers: store })).json;
const list = Array.isArray(products) ? products : products?.items ?? products?.products ?? [];
check("seeded product listed", list.some((p) => p.id === state.productId), `${list.length} product(s)`);
const login = await call("POST", "/v1/auth/merchant/login", { body: { email: state.email, password: state.password, tenantSlug: state.subdomain } });
check("owner signs in", login.status === 200, `HTTP ${login.status}`);
const read = await call("GET", "/v1/products", { headers: { authorization: `Bearer ${login.json?.token}` } });
check("owner's authenticated read", read.status === 200, `HTTP ${read.status}`);
const wrong = await call("POST", "/v1/auth/merchant/login", { body: { email: state.email, password: "wrong", tenantSlug: state.subdomain } });
check("wrong password refused", wrong.status >= 400 && wrong.status < 500, `HTTP ${wrong.status}`);
for (const [method, url] of [["GET", "/v1/orders"], ["GET", "/v1/products"], ["POST", "/internal/distributor/provision"]]) {
  const r = await call(method, url, method === "POST" ? { body: {} } : {});
  check(`unauthenticated ${method} ${url} refused`, [401, 403].includes(r.status), `HTTP ${r.status}`);
}

// The fastify advisory class (GHSA-p68q-wchp-6fh7): the same targets as tests/e2e/malformed-requests.test.ts,
// here through the compiled server on PostgreSQL.
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
  const r = await raw(t);
  const leaked = r.body.includes(state.tenantId) || r.body.includes(state.productTitle);
  check(`malformed ${JSON.stringify(t.slice(0, 40))} refused, nothing leaked`, (r.status <= 0 || r.status >= 400) && !leaked, `HTTP ${r.status}`);
}

const failed = results.filter((ok) => !ok).length;
console.log(`${label}: ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
