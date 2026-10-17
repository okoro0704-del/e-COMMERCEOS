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

test("the API boots in production with a safe config", () => {
  const run = bootInProduction({ INTERNAL_PROVISION_TOKEN: STRONG_TOKEN, DATABASE_URL: "file:./unused.db" });
  assert.equal(run.status, 0, run.stderr);
});
