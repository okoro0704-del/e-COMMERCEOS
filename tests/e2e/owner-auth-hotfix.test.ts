/**
 * P0 owner-account hotfix: synthetic multi-store acceptance for the shared-owner-password takeover.
 * Synthetic data only; no real credential value appears here. The "known default" is a synthetic
 * string whose SHA-256 is loaded into the deny list through ECO_COMPROMISED_PASSWORD_SHA256, exactly
 * as an operator would add a newly disclosed password in production.
 *
 * Covers the joint security-acceptance checks:
 *  - a known default password cannot authenticate, at any store;
 *  - sign-in is store-scoped (email alone is not enough; the wrong store is refused);
 *  - provisioning cannot store a compromised password;
 *  - failed sign-ins are throttled per account, and one account cannot lock out another;
 *  - a password change (and logout) revokes other sessions;
 *  - all three owner credential flows recover safely (self-set, operator temporary, no-password).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const dbFile = `owner-auth-hotfix-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbFile);

// A synthetic "leaked default". Only its hash is given to the app; the preimage stays in this test.
const LEAKED_DEFAULT = "synthetic-leaked-default-value-0000";
const LEAKED_SHA256 = createHash("sha256").update(LEAKED_DEFAULT).digest("hex");
// Policy rejects a password that contains the email's local-part, so these must not contain the
// local-parts used below ("boss", "chef", "host").
const STRONG = "Str0ng-Access-Code-11";
const STRONG_2 = "Second-Access-Code-22";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:./${dbFile}`;
process.env.INTERNAL_PROVISION_TOKEN = "owner-auth-hotfix-token";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";
process.env.ECO_SKIP_PRODUCTION_ASSERT = "true";
process.env.ECO_COMPROMISED_PASSWORD_SHA256 = LEAKED_SHA256;

let app: FastifyInstance;
let accountThrottle: { reset: () => void };
let ipThrottle: { reset: () => void };

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
    env: { ...process.env, DATABASE_URL: `file:./${dbFile}`, NODE_ENV: "test" },
    stdio: "pipe",
  });
  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  app = await buildApp();
  await app.ready();
  ({ accountLoginThrottle: accountThrottle } = await import("../../apps/ecommerceos-api/src/services/staff-auth.ts"));
  ({ credentialIpThrottle: ipThrottle } = await import("../../apps/ecommerceos-api/src/routes/auth.ts"));
});

after(async () => {
  if (app) await app.close();
});

function resetThrottles() {
  accountThrottle.reset();
  ipThrottle.reset();
}

async function provision(opts: {
  subdomain: string;
  email: string;
  password?: string;
  temporaryPassword?: boolean;
}) {
  return app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: "Bearer owner-auth-hotfix-token" },
    payload: {
      tenantId: `tid_${opts.subdomain}`,
      subdomain: opts.subdomain,
      displayName: `Store ${opts.subdomain}`,
      verticalId: "delivery",
      seed: "default",
      adminStaff: {
        email: opts.email,
        displayName: "Owner",
        role: "owner",
        ...(opts.password ? { password: opts.password } : {}),
        ...(opts.temporaryPassword ? { temporaryPassword: true } : {}),
      },
    },
  });
}

function login(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/v1/auth/merchant/login", headers, payload: body });
}

test("sign-in requires the store handle (email alone is refused)", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `ha-${stamp}`;
  const email = `boss@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: STRONG })).statusCode, 201);

  const noHandle = await login({ email, password: STRONG });
  assert.equal(noHandle.statusCode, 400, noHandle.body);
  assert.equal(noHandle.json().error, "store_required");

  const withHandle = await login({ email, password: STRONG, tenantSlug: sub });
  assert.equal(withHandle.statusCode, 200, withHandle.body);

  // The x-store-subdomain header is an accepted handle too.
  const viaHeader = await login({ email, password: STRONG }, { "x-store-subdomain": sub });
  assert.equal(viaHeader.statusCode, 200, viaHeader.body);
});

test("a known default password cannot authenticate, and is not even looked up", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `def-${stamp}`;
  const email = `boss@${sub}.example`;
  // Provision with a strong password; the owner is real, but the leaked default must still be refused.
  assert.equal((await provision({ subdomain: sub, email, password: STRONG })).statusCode, 201);

  const attempt = await login({ email, password: LEAKED_DEFAULT, tenantSlug: sub });
  assert.equal(attempt.statusCode, 401, attempt.body);
  assert.equal(attempt.json().error, "password_not_accepted");
});

test("cross-store: the same owner email in two stores stays scoped to its own store", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const email = `boss@shared-${stamp}.example`;
  const subA = `xa-${stamp}`;
  const subB = `xb-${stamp}`;
  assert.equal((await provision({ subdomain: subA, email, password: STRONG })).statusCode, 201);
  assert.equal((await provision({ subdomain: subB, email, password: STRONG_2 })).statusCode, 201);

  const a = await login({ email, password: STRONG, tenantSlug: subA });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().staff.tenantSlug, subA);

  // A's password must not authenticate against store B, even with the same email.
  const crossed = await login({ email, password: STRONG, tenantSlug: subB });
  assert.equal(crossed.statusCode, 401, crossed.body);

  const b = await login({ email, password: STRONG_2, tenantSlug: subB });
  assert.equal(b.statusCode, 200, b.body);
  assert.equal(b.json().staff.tenantSlug, subB);
});

test("provisioning cannot store a compromised password (account left without one)", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `prov-${stamp}`;
  const email = `boss@${sub}.example`;
  const res = await provision({ subdomain: sub, email, password: LEAKED_DEFAULT });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().temporaryAdminPassword, undefined, "no usable password is returned or stored");

  // Neither the leaked default nor anything else can sign this owner in.
  assert.equal((await login({ email, password: LEAKED_DEFAULT, tenantSlug: sub })).statusCode, 401);
  assert.equal((await login({ email, password: STRONG, tenantSlug: sub })).statusCode, 401);
});

test("failed sign-ins are throttled per account, without locking out other accounts", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const subV = `thrv-${stamp}`;
  const subO = `thro-${stamp}`;
  const victim = `boss@${subV}.example`;
  const other = `chef@${subO}.example`;
  assert.equal((await provision({ subdomain: subV, email: victim, password: STRONG })).statusCode, 201);
  assert.equal((await provision({ subdomain: subO, email: other, password: STRONG_2 })).statusCode, 201);

  let sawThrottle = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await login({ email: victim, password: "wrong-but-not-leaked", tenantSlug: subV });
    if (r.statusCode === 429) {
      sawThrottle = true;
      assert.equal(r.json().error, "too_many_attempts");
      break;
    }
    assert.equal(r.statusCode, 401, r.body);
  }
  assert.ok(sawThrottle, "the account should be throttled after repeated failures");

  // A different owner (different store) is unaffected: the throttle key is per account, not per IP.
  const otherOk = await login({ email: other, password: STRONG_2, tenantSlug: subO });
  assert.equal(otherOk.statusCode, 200, otherOk.body);

  // The correct password still works once the throttle window is cleared (success also clears the key).
  resetThrottles();
  assert.equal((await login({ email: victim, password: STRONG, tenantSlug: subV })).statusCode, 200);
});

test("password change and logout revoke other sessions", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `rev-${stamp}`;
  const email = `boss@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: STRONG })).statusCode, 201);

  const first = (await login({ email, password: STRONG, tenantSlug: sub })).json().token as string;
  const second = (await login({ email, password: STRONG, tenantSlug: sub })).json().token as string;

  const me = (t: string) => app.inject({ method: "GET", url: "/v1/auth/merchant/me", headers: { authorization: `Bearer ${t}` } });
  assert.equal((await me(first)).statusCode, 200);
  assert.equal((await me(second)).statusCode, 200);

  // Change the password using the SECOND session; the first (other) session is revoked.
  const changed = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/password",
    headers: { authorization: `Bearer ${second}` },
    payload: { currentPassword: STRONG, newPassword: STRONG_2 },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal((await me(first)).statusCode, 401, "the other session is revoked after a password change");
  assert.equal((await me(second)).statusCode, 200, "the session that changed the password stays valid");

  // Logout revokes the remaining session.
  await app.inject({ method: "POST", url: "/v1/auth/merchant/logout", headers: { authorization: `Bearer ${second}` } });
  assert.equal((await me(second)).statusCode, 401);

  // The old password no longer works; the new one does.
  assert.equal((await login({ email, password: STRONG, tenantSlug: sub })).statusCode, 401);
  assert.equal((await login({ email, password: STRONG_2, tenantSlug: sub })).statusCode, 200);
});

test("owner flow 1 — self-set password: full access immediately", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `f1-${stamp}`;
  const email = `boss@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: STRONG })).statusCode, 201);
  const res = await login({ email, password: STRONG, tenantSlug: sub });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().mustChangePassword, false);
  const token = res.json().token as string;
  const products = await app.inject({ method: "GET", url: "/v1/products", headers: { authorization: `Bearer ${token}` } });
  assert.equal(products.statusCode, 200, "a fully set-up owner can use normal routes");
});

test("owner flow 2 — operator temporary password: must change before normal access", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `f2-${stamp}`;
  const email = `boss@${sub}.example`;
  // An operator issues a temporary password (temporaryPassword:true).
  assert.equal((await provision({ subdomain: sub, email, password: STRONG, temporaryPassword: true })).statusCode, 201);

  const res = await login({ email, password: STRONG, tenantSlug: sub });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().mustChangePassword, true);
  const token = res.json().token as string;

  // Normal routes are closed until the owner sets their own password.
  const blocked = await app.inject({ method: "GET", url: "/v1/products", headers: { authorization: `Bearer ${token}` } });
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().error, "password_change_required");

  const changed = await app.inject({
    method: "POST",
    url: "/v1/auth/merchant/password",
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword: STRONG, newPassword: STRONG_2 },
  });
  assert.equal(changed.statusCode, 200, changed.body);

  const after = await login({ email, password: STRONG_2, tenantSlug: sub });
  assert.equal(after.json().mustChangePassword, false);
  const ok = await app.inject({ method: "GET", url: "/v1/products", headers: { authorization: `Bearer ${after.json().token}` } });
  assert.equal(ok.statusCode, 200);
});

test("owner flow 3 — no usable password: a compromised default leaves recovery as the only path", async () => {
  resetThrottles();
  const stamp = Date.now().toString(36);
  const sub = `f3-${stamp}`;
  const email = `boss@${sub}.example`;
  assert.equal((await provision({ subdomain: sub, email, password: LEAKED_DEFAULT })).statusCode, 201);
  // No password authenticates this owner; recovery (operator reset / Portal handoff) is required.
  assert.equal((await login({ email, password: LEAKED_DEFAULT, tenantSlug: sub })).statusCode, 401);
  assert.equal((await login({ email, password: STRONG, tenantSlug: sub })).statusCode, 401);
});
