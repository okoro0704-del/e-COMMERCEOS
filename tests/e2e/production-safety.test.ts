/**
 * Production configuration fails closed: no protected checkout without a verified provider,
 * and no internal routes guarded by a missing or publicly known token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  productionSafetyIssues,
  productionSafetyWarnings,
  type SafetyConfig,
} from "../../apps/ecommerceos-api/src/lib/production-safety.ts";
import { originAllowed, unsafeProductionOrigins } from "../../apps/ecommerceos-api/src/lib/cors.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STRONG_TOKEN = "t".repeat(48);

const safeProduction: SafetyConfig = {
  env: "production",
  protectedCheckoutEnabled: false,
  internalProvisionToken: STRONG_TOKEN,
  primitivesMode: "local",
  logisticsMode: "local",
};

test("a safe production config has no blocking issues but warns about local stand-ins", () => {
  assert.deepEqual(productionSafetyIssues(safeProduction), []);
  const warnings = productionSafetyWarnings(safeProduction);
  assert.ok(warnings.some((w) => w.includes("PRIMITIVES_MODE=local")));
});

test("protected checkout is refused in production", () => {
  const issues = productionSafetyIssues({ ...safeProduction, protectedCheckoutEnabled: true });
  assert.deepEqual(
    issues.map((i) => i.key),
    ["ECO_PROTECTED_CHECKOUT_ENABLED"],
  );
});

test("a missing or development internal token is refused in production", () => {
  for (const token of ["", "  ", "dev-primitives-token"]) {
    const issues = productionSafetyIssues({ ...safeProduction, internalProvisionToken: token });
    assert.deepEqual(
      issues.map((i) => i.key),
      ["INTERNAL_PROVISION_TOKEN"],
      `token ${JSON.stringify(token)}`,
    );
  }
});

test("a platform admin token, when set, must be strong and not the Portal service token", () => {
  assert.deepEqual(productionSafetyIssues({ ...safeProduction, platformAdminToken: "p".repeat(40) }), []);
  for (const platformAdminToken of ["short-token", "dev-primitives-token", STRONG_TOKEN]) {
    const issues = productionSafetyIssues({ ...safeProduction, platformAdminToken });
    assert.deepEqual(issues.map((i) => i.key), ["ECO_PLATFORM_ADMIN_TOKEN"], platformAdminToken);
  }
});

test("production CORS allows only the origins it names", () => {
  const allowed = ["https://e-commerce.getlifeos.app", "https://*.getlifeos.app"];
  for (const origin of ["https://e-commerce.getlifeos.app", "https://store-1.getlifeos.app"]) {
    assert.equal(originAllowed(origin, allowed, "production"), true, origin);
  }
  for (const origin of [
    "https://attacker.netlify.app",
    "http://store-1.getlifeos.app",
    "https://getlifeos.app.attacker.example",
    "https://attackergetlifeos.app",
    "https://store-1.getlifeos.app:8443",
    "http://localhost:5190",
    "not a url",
  ]) {
    assert.equal(originAllowed(origin, allowed, "production"), false, origin);
  }
  assert.equal(originAllowed("https://anything.example", ["*"], "production"), false, "no wildcard in production");
  assert.equal(originAllowed("https://anything.example", ["*"], "development"), true);
  assert.equal(originAllowed("http://localhost:5173", [], "development"), true, "local development needs no list");
});

test("unsafe CORS_ORIGINS entries block a production boot", () => {
  assert.deepEqual(
    unsafeProductionOrigins(["*", "https://*.netlify.app", "http://shop.example", "http://localhost:5190", "https://e-commerce.getlifeos.app", "https://*.getlifeos.app", "https://ecommerceos-staging-052577.netlify.app"]),
    ["*", "https://*.netlify.app", "http://shop.example", "http://localhost:5190"],
  );
  const issues = productionSafetyIssues({ ...safeProduction, corsOrigins: ["*"] });
  assert.deepEqual(issues.map((i) => i.key), ["CORS_ORIGINS"]);
});

test("non-production environments are not blocked", () => {
  assert.deepEqual(
    productionSafetyIssues({
      ...safeProduction,
      env: "development",
      protectedCheckoutEnabled: true,
      internalProvisionToken: "dev-primitives-token",
    }),
    [],
  );
});

function bootInProduction(extraEnv: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", ECO_ENV: "production" };
  delete env.INTERNAL_PROVISION_TOKEN;
  delete env.PRIMITIVES_SERVICE_TOKEN;
  delete env.ECO_PROTECTED_CHECKOUT_ENABLED;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const script =
    'import("./apps/ecommerceos-api/src/app.ts").then((m) => m.buildApp()).then(' +
    "(app) => app.close().then(() => process.exit(0)), (err) => { console.error(err.message); process.exit(3); })";
  return spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("the API refuses to boot in production with protected checkout enabled", () => {
  const run = bootInProduction({ INTERNAL_PROVISION_TOKEN: STRONG_TOKEN, ECO_PROTECTED_CHECKOUT_ENABLED: "true" });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /ECO_PROTECTED_CHECKOUT_ENABLED/);
});

test("the API refuses to boot in production without an internal token", () => {
  const run = bootInProduction({});
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /INTERNAL_PROVISION_TOKEN/);
});

test("the API refuses to boot in production with wildcard CORS", () => {
  const run = bootInProduction({ INTERNAL_PROVISION_TOKEN: STRONG_TOKEN, CORS_ORIGINS: "*" });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stderr, /CORS_ORIGINS/);
});

test("the API boots in production with a safe config", () => {
  const run = bootInProduction({
    INTERNAL_PROVISION_TOKEN: STRONG_TOKEN,
    DATABASE_URL: "file:./unused.db",
    CORS_ORIGINS: "https://e-commerce.getlifeos.app",
  });
  assert.equal(run.status, 0, run.stderr);
});
