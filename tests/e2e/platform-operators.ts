/**
 * Test helpers that onboard Digiconomy platform operators the way the console does: the first
 * admin through the bootstrap token, everyone else by invitation, all with TOTP enrollment.
 */
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { currentStep, totpAt } from "../../apps/ecommerceos-api/src/lib/totp.ts";

export type TestOperator = { email: string; password: string; secret: string; token: string; id: string };

/**
 * A valid code for a time step this operator has not used yet (codes are single use). When the
 * accepted window is spent, waits for the next 30-second step, as a person would.
 */
export async function freshCode(prisma: PrismaClient, email: string, secret: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const op = await prisma.platformOperator.findUniqueOrThrow({ where: { email } });
    const now = currentStep();
    for (const step of [now - 1, now, now + 1]) {
      if (op.mfaLastStep === null || step > op.mfaLastStep) return totpAt(secret, step);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000 - (Date.now() % 30_000) + 50));
  }
  throw new Error("no unused TOTP step in the accepted window");
}

async function post(app: FastifyInstance, url: string, payload: unknown, token?: string) {
  return app.inject({ method: "POST", url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

/** From an enrollment token to a full session: shows the secret, confirms a code. */
export async function enroll(app: FastifyInstance, prisma: PrismaClient, email: string, enrollmentToken: string) {
  const start = await post(app, "/v1/platform/mfa/enroll/start", { token: enrollmentToken });
  assert.equal(start.statusCode, 200, start.body);
  const secret = start.json().secret as string;
  const done = await post(app, "/v1/platform/mfa/enroll/confirm", { token: enrollmentToken, code: await freshCode(prisma, email, secret) });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().stage, "complete");
  return { secret, token: done.json().token as string, id: done.json().operator.id as string };
}

export async function bootstrapAdmin(app: FastifyInstance, prisma: PrismaClient, platformToken: string, email: string, password: string) {
  const created = await post(app, "/internal/platform/operators", { email, displayName: "First admin", password }, platformToken);
  assert.equal(created.statusCode, 201, created.body);
  const login = await post(app, "/v1/platform/login", { email, password });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().stage, "mfa_enrollment");
  return { email, password, ...(await enroll(app, prisma, email, login.json().token)) } satisfies TestOperator;
}

export async function inviteAndJoin(
  app: FastifyInstance,
  prisma: PrismaClient,
  adminToken: string,
  email: string,
  role: "verifier" | "admin",
  password: string,
) {
  const invite = await post(app, "/v1/platform/operators/invite", { email, role }, adminToken);
  assert.equal(invite.statusCode, 201, invite.body);
  const joined = await post(app, "/v1/platform/invitations/accept", { code: invite.json().code, displayName: `Test ${role}`, password });
  assert.equal(joined.statusCode, 200, joined.body);
  return { email, password, ...(await enroll(app, prisma, email, joined.json().token)) } satisfies TestOperator;
}

/** Password, then a fresh TOTP code: returns a full session token. */
export async function signInOperator(app: FastifyInstance, prisma: PrismaClient, op: Pick<TestOperator, "email" | "password" | "secret">) {
  const login = await post(app, "/v1/platform/login", { email: op.email, password: op.password });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().stage, "mfa_required");
  const done = await post(app, "/v1/platform/login/mfa", { token: login.json().token, code: await freshCode(prisma, op.email, op.secret) });
  assert.equal(done.statusCode, 200, done.body);
  return done.json().token as string;
}
