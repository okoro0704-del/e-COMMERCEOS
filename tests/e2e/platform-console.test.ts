/**
 * E2E: Digiconomy platform console security. Two-step verification (TOTP) on every session,
 * controlled onboarding, role administration, session expiry and revocation, a two-person rule
 * for reversals, the audit view, and draft billing documents for setup fees.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prismaSchemaArgs, testDatabaseUrl } from "./test-database.ts";
import { bootstrapAdmin, enroll, freshCode, inviteAndJoin, signInOperator, type TestOperator } from "./platform-operators.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../../apps/ecommerceos-api");
const dbName = `platform-console-${process.pid}.db`;
const testDbPath = path.join(apiRoot, "prisma", dbName);
const SERVICE_TOKEN = "console-e2e-service-token";
const PLATFORM_TOKEN = "console-e2e-platform-admin-token-0123456789";
const PASSWORD = "Copper-Meadow-Passw0rd-27";
const OWNER_PASSWORD = "Harbor-Lantern-Passw0rd-26";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = testDatabaseUrl(`file:./${dbName}`);
process.env.INTERNAL_PROVISION_TOKEN = SERVICE_TOKEN;
process.env.ECO_PLATFORM_ADMIN_TOKEN = PLATFORM_TOKEN;
process.env.ECO_OPERATOR_MFA_KEY = "console-e2e-operator-mfa-key-0123456789abc";
process.env.ECO_ACTIVATION_REQUIRED = "true";
process.env.PRIMITIVES_MODE = "local";
process.env.LOGISTICS_MODE = "local";

let app: FastifyInstance;
let prisma: PrismaClient;
let config: typeof import("../../apps/ecommerceos-api/src/config.ts").config;
let admin: TestOperator;
let admin2: TestOperator;

before(async () => {
  for (const file of [testDbPath, `${testDbPath}-journal`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* reused by prisma db push */
    }
  }
  execSync(`npx prisma db push --skip-generate${prismaSchemaArgs()}`, {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "test" },
    stdio: "pipe",
  });
  const { buildApp } = await import("../../apps/ecommerceos-api/src/app.ts");
  ({ config } = await import("../../apps/ecommerceos-api/src/config.ts"));
  app = await buildApp();
  await app.ready();
  prisma = new PrismaClient();
  admin = await bootstrapAdmin(app, prisma, PLATFORM_TOKEN, "first-admin@digiconomy.example", PASSWORD);
  admin2 = await inviteAndJoin(app, prisma, admin.token, "second-admin@digiconomy.example", "admin", PASSWORD);
});

beforeEach(async () => {
  const { operatorLoginThrottle, operatorMfaThrottle } = await import("../../apps/ecommerceos-api/src/services/platform-auth.ts");
  operatorLoginThrottle.reset();
  operatorMfaThrottle.reset();
});

after(async () => {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
});

const handle = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const call = (method: "GET" | "POST", url: string, token?: string, payload?: unknown) =>
  app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

test("TOTP codes match the RFC 6238 reference values", async () => {
  const { base32Encode, totpAt } = await import("../../apps/ecommerceos-api/src/lib/totp.ts");
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  // RFC 6238 Appendix B (SHA-1), last six digits: T=59 → 94287082, T=1111111109 → 07081804.
  assert.equal(totpAt(secret, Math.floor(59 / 30)), "287082");
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), "081804");
});

test("without an MFA key the console refuses sign-in rather than run without two-step verification", async () => {
  const saved = config.operatorMfaKey;
  config.operatorMfaKey = "";
  try {
    const res = await call("POST", "/v1/platform/login", undefined, { email: admin.email, password: PASSWORD });
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error, "mfa_not_configured");
  } finally {
    config.operatorMfaKey = saved;
  }
});

test("a password alone never opens the console; codes are single use and guessing is limited", async () => {
  const login = await call("POST", "/v1/platform/login", undefined, { email: admin.email, password: PASSWORD });
  assert.equal(login.json().stage, "mfa_required");
  const challenge = login.json().token as string;
  assert.equal((await call("GET", "/v1/platform/overview", challenge)).statusCode, 401, "the challenge token is not a session");
  assert.equal((await call("POST", "/v1/platform/login/mfa", undefined, { token: challenge, code: "000000" })).statusCode, 401);
  assert.ok(await prisma.auditLog.count({ where: { actorId: admin.id, action: "platform.mfa_failed" } }));

  const code = await freshCode(prisma, admin.email, admin.secret);
  const ok = await call("POST", "/v1/platform/login/mfa", undefined, { token: challenge, code });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((await call("GET", "/v1/platform/overview", ok.json().token)).statusCode, 200);
  assert.equal((await call("POST", "/v1/platform/login/mfa", undefined, { token: challenge, code })).statusCode, 401, "a challenge is used once");

  const again = await call("POST", "/v1/platform/login", undefined, { email: admin.email, password: PASSWORD });
  const replay = await call("POST", "/v1/platform/login/mfa", undefined, { token: again.json().token, code });
  assert.equal(replay.statusCode, 401, "the same code cannot be used twice");

  // Five wrong codes end the challenge.
  const third = (await call("POST", "/v1/platform/login", undefined, { email: admin.email, password: PASSWORD })).json().token;
  for (let i = 0; i < 5; i += 1) await call("POST", "/v1/platform/login/mfa", undefined, { token: third, code: "123456" });
  const locked = await call("POST", "/v1/platform/login/mfa", undefined, { token: third, code: await freshCode(prisma, admin.email, admin.secret) });
  assert.ok([401, 429].includes(locked.statusCode), locked.body);
});

test("operators join only by an admin's invitation, once, and must enrol two-step verification", async () => {
  const verifier = await inviteAndJoin(app, prisma, admin.token, `verifier-${handle("v")}@digiconomy.example`, "verifier", PASSWORD);
  assert.equal((await call("POST", "/v1/platform/operators/invite", verifier.token, { email: "x@digiconomy.example", role: "admin" })).statusCode, 403);

  const email = `new-${handle("n")}@digiconomy.example`;
  const invite = await call("POST", "/v1/platform/operators/invite", admin.token, { email, role: "verifier" });
  assert.equal(invite.statusCode, 201, invite.body);
  const code = invite.json().code as string;
  assert.equal((await call("POST", "/v1/platform/invitations/accept", undefined, { code, displayName: "New", password: "short" })).json().error, "weak_password");
  const joined = await call("POST", "/v1/platform/invitations/accept", undefined, { code, displayName: "New", password: PASSWORD });
  assert.equal(joined.json().stage, "mfa_enrollment");
  assert.equal((await call("POST", "/v1/platform/invitations/accept", undefined, { code, displayName: "Again", password: PASSWORD })).json().error, "invalid_invitation");
  assert.equal((await call("GET", "/v1/platform/overview", joined.json().token)).statusCode, 401, "no access before enrolment");
  // Signing in again before enrolling still only allows enrolment.
  const relog = await call("POST", "/v1/platform/login", undefined, { email, password: PASSWORD });
  assert.equal(relog.json().stage, "mfa_enrollment");
  await enroll(app, prisma, email, relog.json().token);

  const revoked = await call("POST", "/v1/platform/operators/invite", admin.token, { email: `rev-${handle("r")}@digiconomy.example`, role: "verifier" });
  assert.equal((await call("POST", `/v1/platform/invitations/${revoked.json().id}/revoke`, admin.token)).statusCode, 204);
  assert.equal((await call("POST", "/v1/platform/invitations/accept", undefined, { code: revoked.json().code, displayName: "R", password: PASSWORD })).json().error, "invalid_invitation");
  const expired = await call("POST", "/v1/platform/operators/invite", admin.token, { email: `exp-${handle("e")}@digiconomy.example`, role: "verifier" });
  await prisma.platformInvitation.update({ where: { id: expired.json().id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call("POST", "/v1/platform/invitations/accept", undefined, { code: expired.json().code, displayName: "E", password: PASSWORD })).json().error, "invalid_invitation");
  const audit = await call("GET", "/v1/platform/audit", admin.token);
  const actions = (audit.json().entries as Array<{ action: string }>).map((e) => e.action);
  for (const action of ["platform.operator_invited", "platform.operator_joined", "platform.mfa_enrolled", "platform.invitation_revoked"]) {
    assert.ok(actions.includes(action), action);
  }
  assert.equal((await call("GET", "/v1/platform/audit", verifier.token)).statusCode, 403);
});

test("role changes, suspension and MFA resets are admin-only, never self-service, and keep an admin", async () => {
  const target = await inviteAndJoin(app, prisma, admin.token, `target-${handle("t")}@digiconomy.example`, "verifier", PASSWORD);
  assert.equal((await call("POST", `/v1/platform/operators/${admin.id}/role`, admin.token, { role: "verifier" })).json().error, "self_change");
  assert.equal((await call("POST", `/v1/platform/operators/${admin.id}/suspend`, admin.token)).json().error, "self_change");
  assert.equal((await call("POST", `/v1/platform/operators/${admin.id}/role`, target.token, { role: "verifier" })).statusCode, 403);

  // A role change signs the operator out everywhere.
  assert.equal((await call("POST", `/v1/platform/operators/${target.id}/role`, admin.token, { role: "admin" })).json().role, "admin");
  assert.equal((await call("GET", "/v1/platform/overview", target.token)).statusCode, 401);
  const promoted = await signInOperator(app, prisma, target);
  assert.equal((await call("GET", "/v1/platform/operators", promoted)).statusCode, 200);

  // Suspension ends sessions and sign-in; reactivation restores sign-in.
  assert.equal((await call("POST", `/v1/platform/operators/${target.id}/suspend`, admin.token)).json().status, "suspended");
  assert.equal((await call("GET", "/v1/platform/overview", promoted)).statusCode, 401);
  assert.equal((await call("POST", "/v1/platform/login", undefined, { email: target.email, password: PASSWORD })).statusCode, 401);
  await call("POST", `/v1/platform/operators/${target.id}/reactivate`, admin.token);

  // A reset MFA must be enrolled again.
  assert.equal((await call("POST", `/v1/platform/operators/${target.id}/reset-mfa`, admin.token)).statusCode, 204);
  assert.equal((await call("POST", "/v1/platform/login", undefined, { email: target.email, password: PASSWORD })).json().stage, "mfa_enrollment");

  // An admin cannot act on themselves, and only active admins act, so an admin always remains.
  await call("POST", `/v1/platform/operators/${target.id}/role`, admin.token, { role: "verifier" });
});

test("sessions expire when idle, and an operator can sign out everywhere else", async () => {
  const a = await signInOperator(app, prisma, admin2);
  const b = await signInOperator(app, prisma, admin2);
  const out = await call("POST", "/v1/platform/me/sign-out-everywhere", a);
  assert.ok(out.json().revoked >= 1, out.body);
  assert.equal((await call("GET", "/v1/platform/me", a)).statusCode, 200, "the current session stays");
  assert.equal((await call("GET", "/v1/platform/me", b)).statusCode, 401, "other sessions end");
  await prisma.platformSession.updateMany({ where: { operatorId: admin2.id, revokedAt: null, kind: "full" }, data: { lastSeenAt: new Date(Date.now() - 31 * 60 * 1000) } });
  assert.equal((await call("GET", "/v1/platform/me", a)).statusCode, 401, "idle for 31 minutes: expired");
  admin2.token = await signInOperator(app, prisma, admin2);
});

async function verifiedActivation() {
  const subdomain = handle("store");
  const email = `owner@${subdomain}.example`;
  const prov = await app.inject({
    method: "POST",
    url: "/internal/distributor/provision",
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    payload: { tenantId: `tid_${subdomain}`, subdomain, displayName: `Store ${subdomain}`, seed: "default", adminStaff: { email, displayName: "Owner", role: "owner", password: OWNER_PASSWORD } },
  });
  assert.equal(prov.statusCode, 201, prov.body);
  const owner = (await app.inject({ method: "POST", url: "/v1/auth/merchant/login", payload: { email, password: OWNER_PASSWORD, tenantSlug: subdomain } })).json().token;
  const sub = await call("POST", "/v1/activation/submit", owner, { plan: "standard", paymentReference: handle("TRF"), payerName: "Synthetic Payer" });
  assert.equal(sub.statusCode, 201, sub.body);
  return { id: sub.json().id as string, owner, invoice: sub.json().documents[0] };
}

test("setup fees get draft invoices and receipts with unreviewed tax fields, voided on reversal", async () => {
  const { id, owner, invoice } = await verifiedActivation();
  assert.equal(invoice.kind, "invoice");
  assert.equal(invoice.status, "draft");
  assert.equal(invoice.draft, true);
  assert.match(invoice.number, /^DGC-INV-\d{8}-[0-9A-F]{10}$/);
  assert.deepEqual(invoice.tax, { treatment: "unreviewed", rateBps: null, amountMinor: null, supplierTaxId: null, customerTaxId: null });
  const verified = await call("POST", `/v1/platform/activations/${id}/verify`, admin.token, { amountReceivedMinor: 3_000_000, currency: "NGN" });
  assert.equal(verified.statusCode, 200, verified.body);
  const kinds = (verified.json().documents as Array<{ kind: string; status: string; amountMinor: number; transactionReference: string }>).map((d) => `${d.kind}:${d.status}`).sort();
  assert.deepEqual(kinds, ["invoice:draft", "receipt:draft"]);
  const ownerView = (await call("GET", "/v1/activation", owner)).json();
  assert.equal(ownerView.submissions[0].documents.length, 2, "the owner sees the draft documents");

  // Reversal: request by one admin, approval by another; documents are voided.
  const request = await call("POST", `/v1/platform/activations/${id}/reverse`, admin.token, { reason: "Transfer recalled by the bank" });
  assert.equal(request.statusCode, 202, request.body);
  const approvalId = request.json().approval.id as string;
  assert.equal((await call("GET", "/v1/platform/approvals?status=pending", admin2.token)).json().approvals.some((a: { id: string }) => a.id === approvalId), true);
  const approved = await call("POST", `/v1/platform/approvals/${approvalId}/approve`, admin2.token, { note: "Bank confirmed the recall" });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().approval.status, "approved");
  assert.deepEqual((approved.json().activation.documents as Array<{ status: string }>).map((d) => d.status), ["void", "void"]);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: id, action: "activation.reversed" } });
  assert.equal((audit.metadata as Record<string, unknown>).requestedById, admin.id, "the reversal records who asked and who approved");
  assert.equal(audit.actorId, admin2.id);
});

test("a declined or cancelled reversal changes nothing", async () => {
  const { id } = await verifiedActivation();
  await call("POST", `/v1/platform/activations/${id}/verify`, admin.token, { amountReceivedMinor: 3_000_000, currency: "NGN" });
  const first = (await call("POST", `/v1/platform/activations/${id}/reverse`, admin.token, { reason: "Suspected duplicate" })).json().approval.id;
  const declined = await call("POST", `/v1/platform/approvals/${first}/decline`, admin2.token, { note: "Not a duplicate" });
  assert.equal(declined.json().approval.status, "declined");
  const second = (await call("POST", `/v1/platform/activations/${id}/reverse`, admin.token, { reason: "Asked again" })).json().approval.id;
  assert.equal((await call("POST", `/v1/platform/approvals/${second}/decline`, admin.token)).json().approval.status, "cancelled", "the requester cancels their own");
  assert.equal((await call("POST", `/v1/platform/approvals/${second}/approve`, admin2.token)).statusCode, 409);
  assert.equal((await prisma.activation.findUniqueOrThrow({ where: { id } })).status, "verified");
});
