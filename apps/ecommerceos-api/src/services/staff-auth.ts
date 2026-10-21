import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { config } from "../config.js";
import {
  generateSessionToken,
  hashPassword,
  hashToken,
  httpError,
  isPasswordSet,
  isTemporaryPasswordHash,
  verifyPassword,
} from "../lib/crypto.js";
import { isCompromisedPassword, passwordProblem } from "../lib/password-policy.js";
import { createFailureThrottle } from "../lib/login-throttle.js";
import { installIdOf } from "./store-identity.js";
import { writeAudit } from "../lib/audit.js";

/** Single-use Portal → store admin handoff codes and password reset grants live as short StaffSession rows. */
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const RESET_GRANT_TTL_MS = 15 * 60 * 1000;
const HANDOFF_PREFIX = "handoff:";
const RESET_PREFIX = "reset:";

export const accountLoginThrottle = createFailureThrottle({ limit: 10, windowMs: 15 * 60 * 1000 });

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

type StaffWithTenant = {
  id: string;
  tenantId: string;
  displayName: string;
  email: string;
  role: string;
  passwordHash: string;
  tenant: { slug: string };
};

async function issueStaffSession(staff: { id: string; tenantId: string }) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.staffSessionTtlHours * 60 * 60 * 1000);
  await prisma.staffSession.create({
    data: { tenantId: staff.tenantId, staffId: staff.id, tokenHash: hashToken(token), expiresAt },
  });
  return { token, expiresAt };
}

function sessionResponse(token: string, expiresAt: Date, staff: StaffWithTenant) {
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    passwordSet: isPasswordSet(staff.passwordHash),
    mustChangePassword: isTemporaryPasswordHash(staff.passwordHash),
    staff: {
      id: staff.id,
      displayName: staff.displayName,
      email: staff.email,
      role: staff.role,
      tenantId: staff.tenantId,
      tenantSlug: staff.tenant.slug,
    },
  };
}

/**
 * Consume a one-time grant row: valid, unexpired and not yet used, exactly once. When the grant
 * must belong to a given staff member, anyone else presenting it neither uses nor burns it.
 */
async function consumeGrant(prefix: string, secret: string, expectedStaffId?: string) {
  const row = await prisma.staffSession.findUnique({
    where: { tokenHash: hashToken(`${prefix}${secret}`) },
    include: { staff: { include: { tenant: true } } },
  });
  if (!row || row.revokedAt || row.expiresAt < new Date() || row.staff.status !== "active") return null;
  if (expectedStaffId && row.staffId !== expectedStaffId) return null;
  const used = await prisma.staffSession.updateMany({
    where: { id: row.id, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date() },
  });
  return used.count === 1 ? row : null;
}

/** A store admin signs in to one store: the store handle scopes the account. */
export async function merchantLogin(opts: { email: string; password: string; tenantSlug: string }) {
  const tenantSlug = opts.tenantSlug.trim().toLowerCase();
  const email = normalizeEmail(opts.email);
  const key = `${tenantSlug}:${email}`;
  if (accountLoginThrottle.blocked(key)) {
    throw httpError(429, "too_many_attempts", "Too many failed sign-in attempts for this account. Try again in 15 minutes.");
  }
  if (isCompromisedPassword(opts.password)) {
    accountLoginThrottle.fail(key);
    throw httpError(
      401,
      "password_not_accepted",
      "This password is no longer accepted. Open your store admin from LifeOS Portal to set a new one.",
    );
  }

  const staff = await prisma.staffMember.findFirst({
    where: {
      email: { in: [...new Set([email, opts.email.trim()])] },
      status: "active",
      tenant: { slug: tenantSlug },
    },
    include: { tenant: true },
  });
  if (!staff || !verifyPassword(opts.password, staff.passwordHash)) {
    accountLoginThrottle.fail(key);
    throw httpError(401, "unauthorized", "Invalid credentials");
  }
  accountLoginThrottle.clear(key);

  const { token, expiresAt } = await issueStaffSession(staff);
  await writeAudit({
    tenantId: staff.tenantId,
    actorKind: "merchant",
    actorId: staff.id,
    action: "staff.login",
    resource: "staff",
    resourceId: staff.id,
    metadata: { method: "password" },
  });
  return sessionResponse(token, expiresAt, staff);
}

export async function merchantLogout(token: string) {
  await prisma.staffSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Set a new password. Requires the current password, or a reset grant issued by a
 * Portal handoff (the recovery path). Other sessions are revoked.
 */
export async function changeStaffPassword(opts: {
  staffId: string;
  sessionId: string;
  newPassword: string;
  currentPassword?: string;
  resetGrant?: string;
}) {
  const staff = await prisma.staffMember.findUnique({ where: { id: opts.staffId } });
  if (!staff || staff.status !== "active") throw httpError(401, "unauthorized", "Merchant session required");

  const refusal =
    passwordProblem(opts.newPassword, staff.email) ??
    (isPasswordSet(staff.passwordHash) && verifyPassword(opts.newPassword, staff.passwordHash)
      ? "Choose a password different from the current one."
      : null);

  if (opts.resetGrant) {
    // Refuse the new password before spending the single-use grant: a rejected choice must not
    // send the owner back to LifeOS Portal for a new handoff.
    if (refusal) throw httpError(400, "weak_password", refusal);
    const grant = await consumeGrant(RESET_PREFIX, opts.resetGrant, staff.id);
    if (!grant) {
      throw httpError(400, "invalid_reset_grant", "This reset link has expired. Open your store admin from LifeOS Portal again.");
    }
  } else if (isPasswordSet(staff.passwordHash)) {
    if (!opts.currentPassword || !verifyPassword(opts.currentPassword, staff.passwordHash)) {
      throw httpError(401, "invalid_current_password", "Current password is incorrect.");
    }
  }

  if (refusal) throw httpError(400, "weak_password", refusal);

  await prisma.$transaction([
    prisma.staffMember.update({ where: { id: staff.id }, data: { passwordHash: hashPassword(opts.newPassword) } }),
    prisma.staffSession.updateMany({
      where: { staffId: staff.id, revokedAt: null, id: { not: opts.sessionId } },
      data: { revokedAt: new Date() },
    }),
  ]);
  await writeAudit({
    tenantId: staff.tenantId,
    actorKind: "merchant",
    actorId: staff.id,
    action: "staff.password_change",
    resource: "staff",
    resourceId: staff.id,
    metadata: { via: opts.resetGrant ? "portal_handoff" : "current_password" },
  });
  return { ok: true as const, passwordSet: true, mustChangePassword: false };
}

/**
 * Binds a not-yet-claimed store owner to the Portal identity that proved the owner email.
 * The caller's read is only a snapshot, so the claim itself is conditional at write time: the row is
 * updated only while it still has no identity, and exactly one claimant can change it. A repeat by
 * the identity that already won is the same claim. Any other claimant is refused and never
 * overwrites the bound owner.
 */
async function claimLegacyOwner(tenantId: string, staffId: string, ownerSubject: string) {
  const claimed = await prisma.staffMember.updateMany({
    where: { id: staffId, tenantId, trustId: null },
    data: { trustId: ownerSubject },
  });
  if (claimed.count !== 1) {
    const current = await prisma.staffMember.findUnique({ where: { id: staffId } });
    if (current?.trustId !== ownerSubject) {
      throw httpError(403, "owner_mismatch", "This Portal account does not own this store.");
    }
    return current;
  }
  // One identity per store: a concurrent claim on another unbound owner row loses here and is undone.
  const rival = await prisma.staffMember.findFirst({
    where: { tenantId, trustId: { not: null }, NOT: { trustId: ownerSubject } },
  });
  if (rival) {
    await prisma.staffMember.updateMany({ where: { id: staffId, trustId: ownerSubject }, data: { trustId: null } });
    throw httpError(403, "owner_mismatch", "This Portal account does not own this store.");
  }
  const staff = await prisma.staffMember.findUniqueOrThrow({ where: { id: staffId } });
  await writeAudit({
    tenantId,
    actorKind: "system",
    action: "staff.owner_bound",
    resource: "staff",
    resourceId: staff.id,
    metadata: { via: "portal_handoff_email_match" },
  });
  return staff;
}

/**
 * Called by LifeOS Portal (service token) for a signed-in Portal owner. Binds the store's
 * owner account to the Portal identity on first use (legacy stores match by owner email)
 * and returns a single-use code the browser exchanges for a store admin session.
 */
export async function createAdminHandoff(opts: {
  subdomain: string;
  tenantId?: string;
  ownerSubject: string;
  ownerEmail?: string;
  installId?: string;
}) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: opts.subdomain.trim().toLowerCase() },
    include: { staff: true, portalInstall: true },
  });
  if (!tenant || tenant.status !== "active") throw httpError(404, "not_found", "Store not found");
  if (opts.tenantId && opts.tenantId !== tenant.id) throw httpError(409, "tenant_mismatch", "Store does not match");
  if (opts.installId) {
    if (installIdOf(tenant) !== opts.installId) throw httpError(403, "install_mismatch", "This store belongs to another install.");
  }

  const owners = tenant.staff.filter((s) => s.role === "owner" && s.status === "active");
  let staff = owners.find((s) => s.trustId === opts.ownerSubject);
  if (!staff) {
    const alreadyBound = tenant.staff.some((s) => Boolean(s.trustId));
    const email = opts.ownerEmail ? normalizeEmail(opts.ownerEmail) : null;
    const legacy = !alreadyBound && email ? owners.find((s) => normalizeEmail(s.email) === email) : undefined;
    if (!legacy) throw httpError(403, "owner_mismatch", "This Portal account does not own this store.");
    staff = await claimLegacyOwner(tenant.id, legacy.id, opts.ownerSubject);
  }

  const code = randomBytes(32).toString("base64url");
  await prisma.staffSession.create({
    data: {
      tenantId: tenant.id,
      staffId: staff.id,
      tokenHash: hashToken(`${HANDOFF_PREFIX}${code}`),
      expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    },
  });
  await writeAudit({
    tenantId: tenant.id,
    actorKind: "system",
    action: "staff.handoff_issued",
    resource: "staff",
    resourceId: staff.id,
  });
  return { code, expiresInSec: HANDOFF_TTL_MS / 1000 };
}

export async function exchangeAdminHandoff(code: string) {
  const row = await consumeGrant(HANDOFF_PREFIX, code);
  if (!row) throw httpError(400, "invalid_handoff", "This sign-in link has expired. Open your store admin from LifeOS Portal again.");

  const { token, expiresAt } = await issueStaffSession(row.staff);
  const resetGrant = randomBytes(32).toString("base64url");
  await prisma.staffSession.create({
    data: {
      tenantId: row.tenantId,
      staffId: row.staffId,
      tokenHash: hashToken(`${RESET_PREFIX}${resetGrant}`),
      expiresAt: new Date(Date.now() + RESET_GRANT_TTL_MS),
    },
  });
  await writeAudit({
    tenantId: row.tenantId,
    actorKind: "merchant",
    actorId: row.staffId,
    action: "staff.login",
    resource: "staff",
    resourceId: row.staffId,
    metadata: { method: "portal_handoff" },
  });
  return { ...sessionResponse(token, expiresAt, row.staff), resetGrant };
}
