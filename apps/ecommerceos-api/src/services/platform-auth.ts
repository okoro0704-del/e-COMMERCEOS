import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { hashPassword, hashToken, httpError, verifyPassword } from "../lib/crypto.js";
import { passwordProblem } from "../lib/password-policy.js";
import { createFailureThrottle } from "../lib/login-throttle.js";
import { readBearer } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Digiconomy platform operators: staff who verify setup payments and manage marketing partners.
 * Separate from store accounts; their session tokens never authenticate a store admin.
 */
export const PLATFORM_ROLES = ["verifier", "admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type OperatorAuth = {
  operatorId: string;
  sessionId: string;
  email: string;
  displayName: string;
  role: PlatformRole;
};

const SESSION_PREFIX = "plat_";
export const operatorLoginThrottle = createFailureThrottle({ limit: 5, windowMs: 15 * 60 * 1000 });

/** The bootstrap route is open only with ECO_PLATFORM_ADMIN_TOKEN, never the Portal service token. */
export function platformAdminTokenMatches(authHeader: string | undefined): boolean {
  const expected = config.platformAdminToken.trim();
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createOperator(opts: { email: string; displayName: string; role: PlatformRole; password: string }) {
  const email = opts.email.trim().toLowerCase();
  const problem = passwordProblem(opts.password, email);
  if (problem) throw httpError(400, "weak_password", problem);
  const existing = await prisma.platformOperator.findUnique({ where: { email } });
  if (existing) throw httpError(409, "conflict", "An operator with this email already exists.");
  const operator = await prisma.platformOperator.create({
    data: { email, displayName: opts.displayName.trim(), role: opts.role, passwordHash: hashPassword(opts.password) },
  });
  await writeAudit({
    actorKind: "system",
    action: "platform.operator_created",
    resource: "platform_operator",
    resourceId: operator.id,
    metadata: { role: operator.role },
  });
  return { id: operator.id, email: operator.email, displayName: operator.displayName, role: operator.role };
}

export async function operatorLogin(opts: { email: string; password: string }) {
  const email = opts.email.trim().toLowerCase();
  if (operatorLoginThrottle.blocked(email)) {
    throw httpError(429, "too_many_attempts", "Too many failed sign-in attempts. Try again in 15 minutes.");
  }
  const operator = await prisma.platformOperator.findUnique({ where: { email } });
  if (!operator || operator.status !== "active" || !verifyPassword(opts.password, operator.passwordHash)) {
    operatorLoginThrottle.fail(email);
    throw httpError(401, "unauthorized", "Invalid credentials");
  }
  operatorLoginThrottle.clear(email);
  const token = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + config.platformSessionTtlHours * 60 * 60 * 1000);
  await prisma.platformSession.create({ data: { operatorId: operator.id, tokenHash: hashToken(token), expiresAt } });
  await writeAudit({
    actorKind: "platform_operator",
    actorId: operator.id,
    action: "platform.login",
    resource: "platform_operator",
    resourceId: operator.id,
  });
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    operator: { id: operator.id, email: operator.email, displayName: operator.displayName, role: operator.role },
  };
}

export async function operatorLogout(token: string) {
  await prisma.platformSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function resolveOperator(req: FastifyRequest): Promise<OperatorAuth | null> {
  const token = readBearer(req);
  if (!token || !token.startsWith(SESSION_PREFIX)) return null;
  const session = await prisma.platformSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { operator: true },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.operator.status !== "active") return null;
  return {
    operatorId: session.operatorId,
    sessionId: session.id,
    email: session.operator.email,
    displayName: session.operator.displayName,
    role: session.operator.role as PlatformRole,
  };
}

export async function requireOperator(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { roles?: readonly PlatformRole[] } = {},
): Promise<OperatorAuth | void> {
  const auth = await resolveOperator(req);
  if (!auth) {
    reply.code(401).send({ error: "unauthorized", message: "Platform operator session required" });
    return;
  }
  if (opts.roles && !opts.roles.includes(auth.role)) {
    reply.code(403).send({ error: "forbidden", message: "Your platform role cannot perform this action." });
    return;
  }
  return auth;
}
