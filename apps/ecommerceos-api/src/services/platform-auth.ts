import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { hashPassword, hashToken, httpError, verifyPassword } from "../lib/crypto.js";
import { passwordProblem } from "../lib/password-policy.js";
import { createFailureThrottle } from "../lib/login-throttle.js";
import { readBearer } from "../lib/auth.js";
import { writeAudit } from "../lib/audit.js";
import { decryptSecret, encryptSecret, generateTotpSecret, matchTotp, otpauthUrl } from "../lib/totp.js";

/**
 * Digiconomy platform operators: staff who verify setup payments and manage marketing partners.
 * Separate from store accounts; their session tokens never authenticate a store admin.
 *
 * Every console session is MFA-verified: a correct password only yields a short-lived session
 * that can enrol or answer a TOTP challenge. Operators join by an admin's invitation; the
 * bootstrap token can create only the first admin, and only while no active admin exists.
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
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
export const operatorLoginThrottle = createFailureThrottle({ limit: 5, windowMs: 15 * 60 * 1000 });
export const operatorMfaThrottle = createFailureThrottle({ limit: 5, windowMs: 15 * 60 * 1000 });

function requireMfaKey() {
  if (config.operatorMfaKey.trim().length < 32) {
    throw httpError(503, "mfa_not_configured", "The platform console is not configured for two-step verification.");
  }
  return config.operatorMfaKey;
}

function presentOperator(o: { id: string; email: string; displayName: string; role: string }) {
  return { id: o.id, email: o.email, displayName: o.displayName, role: o.role };
}

async function issueSession(operatorId: string, kind: "full" | "mfa_challenge" | "mfa_enrollment") {
  const token = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
  const ttl = kind === "full" ? config.platformSessionTtlHours * 60 * 60 * 1000 : kind === "mfa_challenge" ? CHALLENGE_TTL_MS : ENROLLMENT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  await prisma.platformSession.create({ data: { operatorId, tokenHash: hashToken(token), expiresAt, kind, lastSeenAt: new Date() } });
  return { token, expiresAt: expiresAt.toISOString() };
}

async function revokeSessions(operatorId: string, exceptSessionId?: string) {
  const res = await prisma.platformSession.updateMany({
    where: { operatorId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

/** The session behind a short-lived MFA token, or null. */
async function pendingSession(token: string, kind: "mfa_challenge" | "mfa_enrollment") {
  if (!token.startsWith(SESSION_PREFIX)) return null;
  const session = await prisma.platformSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { operator: true } });
  if (!session || session.kind !== kind || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.operator.status !== "active") return null;
  return session;
}

// ---- Bootstrap and onboarding ----------------------------------------------------------------

/** The bootstrap route is open only with ECO_PLATFORM_ADMIN_TOKEN, never the Portal service token. */
export function platformAdminTokenMatches(authHeader: string | undefined): boolean {
  const expected = config.platformAdminToken.trim();
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Creates the first platform admin. Refused once any active admin exists, so the bootstrap token
 * is not a standing way in; everyone after that is invited from the console.
 */
export async function bootstrapFirstAdmin(opts: { email: string; displayName: string; password: string }) {
  const email = opts.email.trim().toLowerCase();
  const problem = passwordProblem(opts.password, email);
  if (problem) throw httpError(400, "weak_password", problem);
  if (await prisma.platformOperator.count({ where: { role: "admin", status: "active" } })) {
    throw httpError(409, "bootstrap_closed", "A platform admin already exists. Invite new operators from the console.");
  }
  if (await prisma.platformOperator.findUnique({ where: { email } })) {
    throw httpError(409, "conflict", "An operator with this email already exists.");
  }
  const operator = await prisma.platformOperator.create({
    data: { email, displayName: opts.displayName.trim(), role: "admin", passwordHash: hashPassword(opts.password) },
  });
  await writeAudit({
    actorKind: "system",
    action: "platform.bootstrap_admin_created",
    resource: "platform_operator",
    resourceId: operator.id,
  });
  return presentOperator(operator);
}

export async function inviteOperator(admin: OperatorAuth, opts: { email: string; role: PlatformRole }) {
  const email = opts.email.trim().toLowerCase();
  if (await prisma.platformOperator.findUnique({ where: { email } })) {
    throw httpError(409, "conflict", "An operator with this email already exists.");
  }
  await prisma.platformInvitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const code = randomBytes(24).toString("base64url");
  const invitation = await prisma.platformInvitation.create({
    data: { email, role: opts.role, tokenHash: hashToken(`invite:${code}`), invitedById: admin.operatorId, expiresAt: new Date(Date.now() + INVITATION_TTL_MS) },
  });
  await writeAudit({
    actorKind: "platform_operator",
    actorId: admin.operatorId,
    action: "platform.operator_invited",
    resource: "platform_invitation",
    resourceId: invitation.id,
    metadata: { role: opts.role },
  });
  // The code is shown once, to the inviting admin, who passes it to the new operator.
  return { id: invitation.id, email, role: opts.role, code, expiresAt: invitation.expiresAt.toISOString() };
}

export async function revokeInvitation(admin: OperatorAuth, id: string) {
  const res = await prisma.platformInvitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (res.count !== 1) throw httpError(409, "not_pending", "This invitation is not pending.");
  await writeAudit({ actorKind: "platform_operator", actorId: admin.operatorId, action: "platform.invitation_revoked", resource: "platform_invitation", resourceId: id });
}

export async function listInvitations() {
  const rows = await prisma.platformInvitation.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  return {
    invitations: rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.acceptedAt ? "accepted" : r.revokedAt ? "revoked" : r.expiresAt < new Date() ? "expired" : "pending",
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** The invited person sets a password; they must then enrol two-step verification. */
export async function acceptInvitation(opts: { code: string; displayName: string; password: string }) {
  requireMfaKey();
  const invitation = await prisma.platformInvitation.findUnique({ where: { tokenHash: hashToken(`invite:${opts.code}`) } });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt < new Date()) {
    throw httpError(400, "invalid_invitation", "This invitation has expired or was already used.");
  }
  const problem = passwordProblem(opts.password, invitation.email);
  if (problem) throw httpError(400, "weak_password", problem);
  const claimed = await prisma.platformInvitation.updateMany({
    where: { id: invitation.id, acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date() },
  });
  if (claimed.count !== 1) throw httpError(400, "invalid_invitation", "This invitation has expired or was already used.");
  const operator = await prisma.platformOperator.create({
    data: {
      email: invitation.email,
      displayName: opts.displayName.trim(),
      role: invitation.role,
      passwordHash: hashPassword(opts.password),
      createdById: invitation.invitedById,
    },
  });
  await writeAudit({
    actorKind: "platform_operator",
    actorId: operator.id,
    action: "platform.operator_joined",
    resource: "platform_operator",
    resourceId: operator.id,
    metadata: { role: operator.role, invitedById: invitation.invitedById },
  });
  return { stage: "mfa_enrollment" as const, ...(await issueSession(operator.id, "mfa_enrollment")) };
}

// ---- Sign-in with two-step verification -----------------------------------------------------

export async function operatorLogin(opts: { email: string; password: string }) {
  requireMfaKey();
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
  if (!operator.mfaEnabledAt) return { stage: "mfa_enrollment" as const, ...(await issueSession(operator.id, "mfa_enrollment")) };
  return { stage: "mfa_required" as const, ...(await issueSession(operator.id, "mfa_challenge")) };
}

/** Shows a new TOTP secret once, while enrolling. */
export async function startMfaEnrollment(token: string) {
  const key = requireMfaKey();
  const session = await pendingSession(token, "mfa_enrollment");
  if (!session) throw httpError(401, "unauthorized", "Sign in again to set up two-step verification.");
  if (session.operator.mfaEnabledAt) throw httpError(409, "mfa_already_enabled", "Two-step verification is already set up.");
  const secret = generateTotpSecret();
  await prisma.platformOperator.update({ where: { id: session.operatorId }, data: { mfaSecretEnc: encryptSecret(secret, key) } });
  return { secret, otpauthUrl: otpauthUrl(secret, session.operator.email) };
}

/** Accepts a code for the given step only if no later or equal step was used: no replays. */
async function acceptStep(operatorId: string, step: number) {
  const used = await prisma.platformOperator.updateMany({
    where: { id: operatorId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
    data: { mfaLastStep: step },
  });
  return used.count === 1;
}

function codeStep(secretEnc: string | null, code: string, key: string) {
  if (!secretEnc) return null;
  return matchTotp(decryptSecret(secretEnc, key), code);
}

async function failMfa(operatorId: string, sessionId: string) {
  operatorMfaThrottle.fail(operatorId);
  await writeAudit({ actorKind: "platform_operator", actorId: operatorId, action: "platform.mfa_failed", resource: "platform_operator", resourceId: operatorId });
  if (operatorMfaThrottle.blocked(operatorId)) {
    await prisma.platformSession.updateMany({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }
  throw httpError(401, "invalid_code", "That code is not valid. Use the current code from your authenticator app.");
}

export async function confirmMfaEnrollment(token: string, code: string) {
  const key = requireMfaKey();
  const session = await pendingSession(token, "mfa_enrollment");
  if (!session) throw httpError(401, "unauthorized", "Sign in again to set up two-step verification.");
  if (operatorMfaThrottle.blocked(session.operatorId)) throw httpError(429, "too_many_attempts", "Too many wrong codes. Try again later.");
  const step = codeStep(session.operator.mfaSecretEnc, code, key);
  if (step === null || !(await acceptStep(session.operatorId, step))) return failMfa(session.operatorId, session.id);
  await prisma.platformOperator.update({ where: { id: session.operatorId }, data: { mfaEnabledAt: new Date() } });
  await prisma.platformSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  operatorMfaThrottle.clear(session.operatorId);
  await writeAudit({ actorKind: "platform_operator", actorId: session.operatorId, action: "platform.mfa_enrolled", resource: "platform_operator", resourceId: session.operatorId });
  await writeAudit({ actorKind: "platform_operator", actorId: session.operatorId, action: "platform.login", resource: "platform_operator", resourceId: session.operatorId, metadata: { mfa: true } });
  return { stage: "complete" as const, ...(await issueSession(session.operatorId, "full")), operator: presentOperator(session.operator) };
}

export async function verifyMfaChallenge(token: string, code: string) {
  const key = requireMfaKey();
  const session = await pendingSession(token, "mfa_challenge");
  if (!session) throw httpError(401, "unauthorized", "Sign in again.");
  if (operatorMfaThrottle.blocked(session.operatorId)) throw httpError(429, "too_many_attempts", "Too many wrong codes. Try again later.");
  const step = codeStep(session.operator.mfaSecretEnc, code, key);
  if (step === null || !(await acceptStep(session.operatorId, step))) return failMfa(session.operatorId, session.id);
  const consumed = await prisma.platformSession.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (consumed.count !== 1) throw httpError(401, "unauthorized", "Sign in again.");
  operatorMfaThrottle.clear(session.operatorId);
  await writeAudit({ actorKind: "platform_operator", actorId: session.operatorId, action: "platform.login", resource: "platform_operator", resourceId: session.operatorId, metadata: { mfa: true } });
  return { stage: "complete" as const, ...(await issueSession(session.operatorId, "full")), operator: presentOperator(session.operator) };
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
  if (!session || session.kind !== "full" || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.operator.status !== "active" || !session.operator.mfaEnabledAt) return null;
  const lastSeen = (session.lastSeenAt ?? session.createdAt).getTime();
  if (Date.now() - lastSeen > config.platformIdleTimeoutMinutes * 60 * 1000) {
    await prisma.platformSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return null;
  }
  if (Date.now() - lastSeen > 60 * 1000) {
    await prisma.platformSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
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

// ---- Operator administration (admins) --------------------------------------------------------

export async function listOperators() {
  const rows = await prisma.platformOperator.findMany({ orderBy: { createdAt: "asc" } });
  return {
    operators: rows.map((o) => ({
      ...presentOperator(o),
      status: o.status,
      mfaEnabled: Boolean(o.mfaEnabledAt),
      createdAt: o.createdAt.toISOString(),
    })),
  };
}

async function targetOperator(admin: OperatorAuth, id: string) {
  if (id === admin.operatorId) throw httpError(409, "self_change", "Ask another admin to change your own account.");
  const operator = await prisma.platformOperator.findUnique({ where: { id } });
  if (!operator) throw httpError(404, "not_found", "Operator not found");
  return operator;
}

/** At least one other active admin must remain when an admin is demoted or suspended. */
async function keepAnAdmin(operator: { id: string; role: string; status: string }) {
  if (operator.role !== "admin" || operator.status !== "active") return;
  const others = await prisma.platformOperator.count({ where: { role: "admin", status: "active", id: { not: operator.id } } });
  if (!others) throw httpError(409, "last_admin", "There must always be at least one active admin.");
}

export async function setOperatorRole(admin: OperatorAuth, id: string, role: PlatformRole) {
  const operator = await targetOperator(admin, id);
  if (operator.role === role) return presentOperator(operator);
  if (role !== "admin") await keepAnAdmin(operator);
  const updated = await prisma.platformOperator.update({ where: { id }, data: { role } });
  const revoked = await revokeSessions(id);
  await writeAudit({ actorKind: "platform_operator", actorId: admin.operatorId, action: "platform.operator_role_changed", resource: "platform_operator", resourceId: id, metadata: { from: operator.role, to: role, sessionsRevoked: revoked } });
  return presentOperator(updated);
}

export async function setOperatorStatus(admin: OperatorAuth, id: string, status: "active" | "suspended") {
  const operator = await targetOperator(admin, id);
  if (operator.status === status) return { ...presentOperator(operator), status };
  if (status === "suspended") await keepAnAdmin(operator);
  const updated = await prisma.platformOperator.update({ where: { id }, data: { status } });
  const revoked = status === "suspended" ? await revokeSessions(id) : 0;
  await writeAudit({ actorKind: "platform_operator", actorId: admin.operatorId, action: status === "suspended" ? "platform.operator_suspended" : "platform.operator_reactivated", resource: "platform_operator", resourceId: id, metadata: { sessionsRevoked: revoked } });
  return { ...presentOperator(updated), status };
}

/** For a lost authenticator: the operator must enrol again at next sign-in. */
export async function resetOperatorMfa(admin: OperatorAuth, id: string) {
  await targetOperator(admin, id);
  await prisma.platformOperator.update({ where: { id }, data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null } });
  const revoked = await revokeSessions(id);
  await writeAudit({ actorKind: "platform_operator", actorId: admin.operatorId, action: "platform.operator_mfa_reset", resource: "platform_operator", resourceId: id, metadata: { sessionsRevoked: revoked } });
}

export async function revokeOperatorSessions(admin: OperatorAuth, id: string) {
  const self = id === admin.operatorId;
  const revoked = await revokeSessions(id, self ? admin.sessionId : undefined);
  await writeAudit({ actorKind: "platform_operator", actorId: admin.operatorId, action: "platform.sessions_revoked", resource: "platform_operator", resourceId: id, metadata: { sessionsRevoked: revoked, self } });
  return { revoked };
}

export async function platformAuditLog(limit = 200) {
  const rows = await prisma.auditLog.findMany({
    where: {
      OR: [
        { actorKind: "platform_operator" },
        { action: { startsWith: "platform." } },
        { action: { startsWith: "activation." } },
        { action: { startsWith: "partner." } },
        // Calls from other Digiconomy services (Portal's reads and writes) and seller registrations.
        { action: { startsWith: "service." } },
        { action: { startsWith: "portal." } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });
  return {
    entries: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      actorKind: r.actorKind,
      actorId: r.actorId,
      action: r.action,
      resource: r.resource,
      resourceId: r.resourceId,
      tenantId: r.tenantId,
      metadata: r.metadata,
    })),
  };
}
